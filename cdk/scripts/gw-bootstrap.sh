#!/bin/bash -xe

# Fail the stack fast (don't wait for the CreationPolicy timeout) if any
# command below errors. Under `set -e` a failing command trips this ERR trap,
# which signals CREATE failure so the ASG rolls back / replaces. Prefer letting
# a check fail naturally over `exit 1` (a bare `exit` does NOT fire an ERR trap).
trap '/opt/aws/bin/cfn-signal -e 1 --stack ${AWS::StackId} --resource ${AsgLogicalId} --region ${AWS::Region}' ERR

# The helper scripts and unit files this bootstrap writes live as real, editable
# files under scripts/gw-files/. A line of the form `#@include gw-files/<name>`
# (always the sole body of a heredoc here) is replaced with that file's verbatim
# contents at synth time by assembleBootstrap() in cdk/lib/vpc-public-private-setup.ts,
# before the whole script is wrapped in Fn::Sub. The result is one user-data blob,
# so `${...}` still resolves as CloudFormation substitutions everywhere below.

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
#@include gw-files/99-custom-gw.conf
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
# Forwarding firewall
##
# A systemd oneshot programs the FORWARD rules, not just this user-data, because
# cloud-init runs once per instance and a reboot would otherwise drop them. It
# reprograms itself on every boot, and in VPN mode it is ordered before OpenVPN so
# DROP is in force before any packet can be forwarded.
#
# The rules are scoped by interface and branch on VpnEnabled. In VPN mode this is a
# fail-closed kill switch: the only forwarding paths are LAN->tun0 and tun0->LAN for
# established replies, so when the tunnel is down every forwarded packet hits DROP
# and there is no LAN-side SNAT to leak past it. In NAT-instance mode (VpnEnabled
# false) it forwards LAN traffic out the primary NIC to the internet gateway and NATs
# it, which is a plain NAT instance and NOT fail-closed. The LAN NIC name varies by
# instance type (eth0 / ens5 / enX0), so detect it once and persist it for the
# firewall and tunnel scripts to read.
LAN_IF=$(ip route show default | awk '{print $5; exit}')
echo "$LAN_IF" > /etc/gw-lan-if

cat > /usr/local/sbin/gw-killswitch.sh <<'KILLSWITCH'
#@include gw-files/gw-killswitch.sh
KILLSWITCH
chmod 0755 /usr/local/sbin/gw-killswitch.sh

cat > /etc/systemd/system/gw-killswitch.service <<'UNIT'
#@include gw-files/gw-killswitch.service
UNIT

systemctl daemon-reload
systemctl enable --now gw-killswitch.service

#################################
# VPN tunnel (VPN mode only)
##
# In NAT-instance mode (VpnEnabled=false) there is no tunnel, so skip the profile
# pull, the OpenVPN config, and the tunnel bring-up. /run/gw-vpn-configured is then
# never created, so the watchdog checks only the route and the firewall above
# forwards straight out the primary NIC.
if [ "${VpnEnabled}" = "true" ]; then

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
#@include gw-files/openvpn-overrides.conf
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
#@include gw-files/tun-up.sh
TUNUP
  chmod 0755 /etc/openvpn/client/tun-up.sh

  cat > /etc/openvpn/client/tun-down.sh <<'TUNDOWN'
#@include gw-files/tun-down.sh
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
fi # VpnEnabled = true

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
#@include gw-files/gw-healthcheck.sh
GWHC
chmod 0755 /usr/local/sbin/gw-healthcheck.sh

cat > /etc/systemd/system/gw-healthcheck.service <<'UNIT'
#@include gw-files/gw-healthcheck.service
UNIT

cat > /etc/systemd/system/gw-healthcheck.timer <<'UNIT'
#@include gw-files/gw-healthcheck.timer
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
