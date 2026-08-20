#!/bin/bash -xe

# Fail the stack fast (don't wait for the CreationPolicy timeout) if any
# command below errors. Under `set -e` a failing command trips this ERR trap,
# which signals CREATE failure so the ASG rolls back / replaces. Prefer letting
# a check fail naturally over `exit 1` (a bare `exit` does NOT fire an ERR trap).
trap '/opt/aws/bin/cfn-signal -e 1 --stack ${AWS::StackId} --resource ${AsgLogicalId} --region ${AWS::Region}' ERR

#################################
# Metadata and interface
##
# IMDSv2 identity. A long token TTL covers the whole boot (package installs plus
# tunnel bring-up can exceed the default 5 minutes).
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
          -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
          http://169.254.169.254/latest/meta-data/instance-id)

#################################
# Prerequisites
##
# Amazon Linux 2023 provides the iptables command backed by nftables, and it
# carries OpenVPN in its own repos (the amzn2023-tagged build), so a plain dnf
# install needs no third-party repo. If OpenVPN is somehow missing afterward,
# the bare check below fails, the ERR trap fires, and the instance never comes
# up leaky.
dnf install -y iptables openvpn
command -v openvpn >/dev/null
# Convenience tooling for operators. Best-effort so it never blocks boot.
dnf install -y htop || true

#################################
# Kernel network settings
##
# ip_forward turns the box into a router. rp_filter is loose (2) on purpose. Once
# the tunnel-up script adds its policy route, strict reverse-path filtering would
# quietly drop every return packet, because the reverse lookup for a public source
# resolves to eth0 rather than tun0. IPv6 forwarding stays off so a future IPv6
# CIDR can't slip past the switch.
cat > /etc/sysctl.d/99-custom-gw.conf <<'SYSCTL'
net.ipv4.ip_forward = 1
net.ipv4.conf.all.rp_filter = 2
net.ipv4.conf.default.rp_filter = 2
net.ipv6.conf.all.forwarding = 0
SYSCTL
sysctl -p /etc/sysctl.d/99-custom-gw.conf

#################################
# Router prerequisites
##
# Disable this instance's source/dest check so it can forward packets that are
# not addressed to it.
aws ec2 modify-instance-attribute --region ${AWS::Region} \
  --instance-id "$IID" --no-source-dest-check

#################################
# Stable egress IP
##
# Re-associate the stack's Elastic IP with THIS instance (--allow-reassociation
# steals it from a terminated predecessor). Done before the tunnel starts so the
# OpenVPN control channel to the peer always originates from the same address a
# peer-side allowlist can trust. Wait until IMDS reflects the EIP before moving on.
EIP=$(aws ec2 describe-addresses --region ${AWS::Region} \
  --allocation-ids ${CustomGwEipAllocId} \
  --query 'Addresses[0].PublicIp' --output text)
aws ec2 associate-address --region ${AWS::Region} \
  --instance-id "$IID" --allocation-id ${CustomGwEipAllocId} --allow-reassociation
for i in $(seq 1 15); do
  CUR=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
          http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  [ "$CUR" = "$EIP" ] && break
  sleep 2
done

#################################
# Kill switch (fail-closed firewall)
##
# The real leak guarantee. A systemd oneshot programs it, not just this user-data,
# because cloud-init runs once per instance and a reboot would otherwise drop the
# rules. The unit is ordered before OpenVPN, so DROP is in force before any packet
# can be forwarded, and it reprograms itself on every boot.
#
# The rules are scoped by interface, which is stricter and clearer than matching IP
# ranges. Forwarded traffic only ever crosses between the LAN NIC and tun0, so the
# two allowed paths are LAN->tun0 outbound and tun0->LAN for established replies.
# Anything else hits DROP, and there is no LAN-side SNAT, so an unmatched packet
# leaves un-NATed and the internet gateway discards it. The LAN NIC name varies by
# instance type (eth0 / ens5 / enX0), so detect it once and persist it for the kill
# switch and tunnel scripts to read.
LAN_IF=$(ip route show default | awk '{print $5; exit}')
echo "$LAN_IF" > /etc/gw-lan-if

cat > /usr/local/sbin/gw-killswitch.sh <<'KILLSWITCH'
#!/bin/bash
set -e
LAN_IF=$(cat /etc/gw-lan-if)
iptables -F FORWARD
iptables -t nat -F POSTROUTING
iptables -t mangle -F FORWARD

iptables -P FORWARD DROP
# outbound, only traffic forwarded from the LAN NIC into the tunnel
iptables -A FORWARD -i "$LAN_IF" -o tun0 -j ACCEPT
# return, only established replies coming back from the tunnel to the LAN NIC
iptables -A FORWARD -i tun0 -o "$LAN_IF" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# NAT everything leaving the tunnel to the tunnel's address
iptables -t nat -A POSTROUTING -o tun0 -j MASQUERADE
# clamp MSS to the tunnel's lower path MTU so large TCP segments don't blackhole
iptables -t mangle -A FORWARD -p tcp --syn -o tun0 -j TCPMSS --clamp-mss-to-pmtu
# IPv6 has no forwarding path here. Fail closed if a v6 CIDR ever appears.
ip6tables -P FORWARD DROP 2>/dev/null || true
KILLSWITCH
chmod 0755 /usr/local/sbin/gw-killswitch.sh

cat > /etc/systemd/system/gw-killswitch.service <<'UNIT'
[Unit]
Description=Custom gateway fail-closed firewall (kill switch)
After=network-pre.target
Before=openvpn-client@tun-vpn.service
Wants=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/gw-killswitch.sh
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now gw-killswitch.service

#################################
# VPN client files
##
# Pull whatever is in the stack-created bucket into /etc/vpn. The bucket starts
# empty (you upload the .ovpn later), so this is a no-op until then. Best-effort
# so an empty bucket never blocks boot.
mkdir -p /etc/vpn
aws s3 cp --recursive "s3://${CustomGwVpnBucket}/" /etc/vpn/ || true

#################################
# OpenVPN client config
##
# Find an uploaded profile. When none exists yet the box still comes up, but
# fail-closed, so the kill switch drops all private egress until someone uploads a
# profile and refreshes the instance. That way the first deploy against an empty
# bucket succeeds without ever leaking. The /run/gw-vpn-configured sentinel gates
# the tunnel steps and the watchdog's tunnel checks.
SRC=$(ls /etc/vpn/*.ovpn /etc/vpn/*.conf 2>/dev/null | head -n 1 || true)
if [ -n "$SRC" ]; then
  install -d -m 0700 /etc/openvpn/client

  # Strip any directive that could re-hijack the main routing table or rename the
  # interface, then append our own fixed settings.
  grep -viE '^[[:space:]]*(dev|dev-type|redirect-gateway|route|route-nopull)([[:space:]]|$)' \
    "$SRC" > /etc/openvpn/client/tun-vpn.conf || true
  cat >> /etc/openvpn/client/tun-vpn.conf <<'OVPN'

# Managed by gw-bootstrap.sh, do not edit
dev tun0
dev-type tun
nobind
persist-tun
route-nopull
script-security 2
up   /etc/openvpn/client/tun-up.sh
down /etc/openvpn/client/tun-down.sh
mssfix 1360
OVPN

  # Username/password profiles (NordVPN and similar) carry a bare auth-user-pass
  # line, which makes OpenVPN block on an interactive prompt under systemd and
  # time out the boot. When a credentials file was uploaded (two lines, the
  # service username then the password), point the directive at it so bring-up
  # stays non-interactive. Lock the file down first, since it holds a secret.
  if [ -f /etc/vpn/credentials.txt ]; then
    chmod 600 /etc/vpn/credentials.txt
    sed -i 's#^[[:space:]]*auth-user-pass[[:space:]]*$#auth-user-pass /etc/vpn/credentials.txt#' \
      /etc/openvpn/client/tun-vpn.conf
  fi

  # The up-script sends forwarded traffic into the tunnel while the box's own
  # traffic (SSM, S3, EC2 API) stays on the main table. It matches the INGRESS
  # interface, not the source: forwarded client packets arrive on the LAN NIC,
  # whereas the gateway's own packets are locally generated and share the
  # 10.0.0.0/16 source range, so a "from 10.0.0.0/16" rule would wrongly divert
  # the box's own traffic into the tunnel and cut its control plane. Runs on
  # every reconnect. OpenVPN gives up/down scripts a minimal PATH that omits
  # /usr/sbin (where ip lives), so set PATH. set -e leaves the sentinel untouched
  # on failure, so the boot wait fails closed instead of coming up broken.
  cat > /etc/openvpn/client/tun-up.sh <<'TUNUP'
#!/bin/bash
set -e
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
LAN_IF=$(cat /etc/gw-lan-if)
ip route replace default dev "$dev" table 100
ip rule add iif "$LAN_IF" lookup 100 priority 100 2>/dev/null || true
touch /run/gw-tunnel-up
TUNUP
  chmod 0755 /etc/openvpn/client/tun-up.sh

  cat > /etc/openvpn/client/tun-down.sh <<'TUNDOWN'
#!/bin/bash
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
LAN_IF=$(cat /etc/gw-lan-if)
ip rule del iif "$LAN_IF" lookup 100 priority 100 2>/dev/null || true
rm -f /run/gw-tunnel-up
TUNDOWN
  chmod 0755 /etc/openvpn/client/tun-down.sh

  touch /run/gw-vpn-configured
fi

#################################
# Bring up the tunnel
##
if [ -f /run/gw-vpn-configured ]; then
  systemctl enable --now openvpn-client@tun-vpn

  #################################
  # Wait for tunnel
  ##
  # Poll for the up-script sentinel + a live tun0. On timeout, fail the check so
  # the ERR trap replaces the instance rather than leaving it up without a tunnel.
  TUN_UP=0
  for i in $(seq 1 60); do
    if [ -f /run/gw-tunnel-up ] && ip link show tun0 up >/dev/null 2>&1; then
      TUN_UP=1
      break
    fi
    sleep 2
  done
  test "$TUN_UP" = 1

  #################################
  # Verify egress
  ##
  # The policy route the up-script installs is what sends forwarded client traffic
  # into the tunnel. Confirm it is actually there, since a curl bound to tun0 would
  # pass even without it and hide a broken forwarded path.
  ip rule | grep -q 'lookup 100'
  ip route show table 100 | grep -q '^default'
  # Confirm traffic actually leaves through the tunnel. The exit IP seen over tun0
  # must be non-empty and differ from this box's own public IP, which is the EIP.
  TUNIP=$(curl -s --interface tun0 --max-time 5 https://checkip.amazonaws.com || true)
  test -n "$TUNIP"
  test "$TUNIP" != "$EIP"
fi

#################################
# Claim the private default route
##
# Point the private route table's default at this instance. Done AFTER the tunnel
# is verified so, during a rolling replacement, the route stays blackholed at the
# old (dead) instance instead of delivering traffic before egress works.
aws ec2 replace-route --region ${AWS::Region} \
  --route-table-id ${PrivateRouteTable} \
  --destination-cidr-block 0.0.0.0/0 --instance-id "$IID" 2>/dev/null \
|| aws ec2 create-route --region ${AWS::Region} \
  --route-table-id ${PrivateRouteTable} \
  --destination-cidr-block 0.0.0.0/0 --instance-id "$IID"

#################################
# Health watchdog
##
# Marks the instance Unhealthy (so the ASG replaces it) when the route or the
# tunnel is broken. Gated on /run/gw-boot-complete to avoid racing the tunnel
# bring-up window, requires 5 consecutive failures, and tries one self-heal
# restart before escalating. Tunnel checks only apply once a profile exists.
cat > /usr/local/sbin/gw-healthcheck.sh <<'GWHC'
#!/bin/bash
# Don't judge health until boot finished (prevents a replacement loop).
[ -f /run/gw-boot-complete ] || exit 0

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
          -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
IID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
          http://169.254.169.254/latest/meta-data/instance-id)
PUBIP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
          http://169.254.169.254/latest/meta-data/public-ipv4)
OK=1

# The private default route must still target THIS instance.
TARGET=$(aws ec2 describe-route-tables --region ${AWS::Region} \
  --route-table-ids ${PrivateRouteTable} \
  --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0'].InstanceId | [0]" \
  --output text 2>/dev/null)
[ "$TARGET" = "$IID" ] || OK=0

# When a VPN profile is configured, the tunnel must be up and egress must
# actually leave through it (exit IP differs from our own public IP / EIP).
if [ -f /run/gw-vpn-configured ]; then
  ip link show tun0 up >/dev/null 2>&1 || OK=0
  TUNIP=$(curl -s --interface tun0 --max-time 5 https://checkip.amazonaws.com 2>/dev/null)
  { [ -n "$TUNIP" ] && [ "$TUNIP" != "$PUBIP" ]; } || OK=0
fi

if [ "$OK" -ne 1 ]; then
  # One bounded self-heal attempt before escalating.
  systemctl restart openvpn-client@tun-vpn 2>/dev/null || true
  sleep 15
  RETRY=$(curl -s --interface tun0 --max-time 5 https://checkip.amazonaws.com 2>/dev/null)
  if ip link show tun0 up >/dev/null 2>&1 \
     && [ -n "$RETRY" ] && [ "$RETRY" != "$PUBIP" ] && [ "$TARGET" = "$IID" ]; then
    rm -f /run/gw-fail-count
    exit 0
  fi
  N=$(( $(cat /run/gw-fail-count 2>/dev/null || echo 0) + 1 ))
  echo "$N" > /run/gw-fail-count
  if [ "$N" -ge 5 ]; then
    aws autoscaling set-instance-health --region ${AWS::Region} \
      --instance-id "$IID" --health-status Unhealthy
  fi
else
  rm -f /run/gw-fail-count
fi
GWHC
chmod 0755 /usr/local/sbin/gw-healthcheck.sh

cat > /etc/systemd/system/gw-healthcheck.service <<'UNIT'
[Unit]
Description=Custom gateway route/tunnel health watchdog
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/gw-healthcheck.sh
UNIT

cat > /etc/systemd/system/gw-healthcheck.timer <<'UNIT'
[Unit]
Description=Run the custom gateway health watchdog periodically
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now gw-healthcheck.timer

# Boot finished, so let the watchdog start judging health.
touch /run/gw-boot-complete

#################################
# Signal success
##
# Last, so the CreationPolicy only succeeds once the kill switch is in force and
# (when a profile exists) the tunnel is verified up.
/opt/aws/bin/cfn-signal -e 0 --stack ${AWS::StackId} --resource ${AsgLogicalId} --region ${AWS::Region}
