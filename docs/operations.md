# Operations runbook (custom gateway)

Everything here applies to `PublicPrivateCustomRouting` mode, where a Spot instance
routes and NATs the private tier through an OpenVPN tunnel. It covers connecting to
the gateway and checking each component the boot script installs, the kill switch,
the tunnel, the policy routing, and the health watchdog. For how these pieces fit
together, see [architecture.md](architecture.md).

## Contents

- [Connect to the gateway](#connect-to-the-gateway)
- [One-shot health snapshot](#one-shot-health-snapshot)
- [Boot log](#boot-log)
- [Kill switch (firewall)](#kill-switch-firewall)
- [VPN tunnel](#vpn-tunnel)
- [Policy routing](#policy-routing)
- [Health watchdog](#health-watchdog)
- [Egress verification](#egress-verification)
- [Kernel forwarding settings](#kernel-forwarding-settings)
- [AWS-side checks (route and EIP)](#aws-side-checks-route-and-eip)
- [State files reference](#state-files-reference)
- [Failure signatures](#failure-signatures)

## Connect to the gateway

The instance has no inbound ports. Reach it over SSM Session Manager, which needs
the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
installed locally.

Find the running instance by its Name tag (`<ResourcesPrefixName>-custom-gw`, default
prefix `auto-networking`) or through the Auto Scaling group (`<StackName>-custom-gw`):

```bash
# By Name tag
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=auto-networking-custom-gw" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" --output text

# Or via the Auto Scaling group
aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names <StackName>-custom-gw \
  --query "AutoScalingGroups[0].Instances[].InstanceId" --output text
```

Start a shell and become root (Session Manager lands you as `ssm-user`):

```bash
aws ssm start-session --target <instance-id>
sudo -i
```

## One-shot health snapshot

Paste this as root for a quick all-green check:

```bash
echo "== units =="
systemctl is-active gw-killswitch.service openvpn-client@tun-vpn gw-healthcheck.timer
echo "== tunnel =="
ip link show tun0 >/dev/null 2>&1 && echo "tun0 present" || echo "tun0 MISSING"
echo "== policy route =="
ip rule | grep -q 'lookup 100' && echo "ip rule ok" || echo "ip rule MISSING"
ip route show table 100 | grep -q '^default' && echo "table 100 ok" || echo "table 100 MISSING"
echo "== state =="
ls -1 /run/gw-vpn-configured /run/gw-tunnel-up /run/gw-boot-complete 2>/dev/null
echo "fail count: $(cat /run/gw-fail-count 2>/dev/null || echo 0)"
echo "== egress (should differ from own IP) =="
echo "own: $(curl -s --max-time 5 https://checkip.amazonaws.com)"
echo "tun: $(curl -s --interface tun0 --max-time 5 https://checkip.amazonaws.com)"
```

If a VPN profile has not been uploaded yet, `openvpn-client@tun-vpn` and `tun0` are
expected to be absent, and the kill switch drops all forwarded traffic by design.

## Boot log

The user-data script runs with tracing on, so its full output is the first stop for
any boot or bring-up problem:

```bash
cat /var/log/cloud-init-output.log        # full boot trace
grep -nE 'FORWARD|openvpn|tun0|lookup 100|ReplaceRoute|associate-address' \
  /var/log/cloud-init-output.log          # jump to the interesting steps
```

## Kill switch (firewall)

The fail-closed firewall is a systemd oneshot that reprograms itself on every boot.
The script lives at `/usr/local/sbin/gw-killswitch.sh`.

```bash
systemctl status gw-killswitch.service
iptables -S FORWARD                 # policy DROP, allow LAN<->tun0 only
iptables -t nat -S POSTROUTING      # MASQUERADE out tun0
iptables -t mangle -S FORWARD       # TCPMSS clamp on tun0
ip6tables -S FORWARD                # policy DROP (no v6 forwarding path)
cat /etc/gw-lan-if                  # detected LAN NIC name (eth0/ens5/enX0)
```

A healthy `FORWARD` chain has policy DROP with exactly two ACCEPT rules, `-i <lan> -o
tun0` and `-i tun0 -o <lan>` for established replies. Re-run the programming by hand
with `systemctl restart gw-killswitch.service`.

In NAT-instance mode (`EnableVpn=false`) the same service programs a different, non
fail-closed rule set: it forwards from the LAN NIC and MASQUERADEs out the LAN NIC
(`-o <lan>`) instead of `tun0`, and there is no tunnel. Check with `iptables -S FORWARD`
and `iptables -t nat -S POSTROUTING`. The VPN tunnel and policy-routing sections below
do not apply in that mode.

## VPN tunnel

OpenVPN runs as `openvpn-client@tun-vpn`. Its config is assembled at boot from the
uploaded profile.

```bash
systemctl status openvpn-client@tun-vpn
journalctl -u openvpn-client@tun-vpn -n 100 --no-pager   # connection log
ip addr show tun0                                        # tunnel address
cat /etc/openvpn/client/tun-vpn.conf                     # assembled config
ls -l /etc/vpn/                                          # files pulled from the bucket
```

Restart the tunnel with `systemctl restart openvpn-client@tun-vpn`. To pick up new
files from the bucket, refresh the instance (terminate it, or trigger an Auto Scaling
instance refresh) so the boot script re-pulls `/etc/vpn`.

## Policy routing

Forwarded traffic is steered into the tunnel by an ingress-interface rule and route
table 100, installed by the tunnel up-script `/etc/openvpn/client/tun-up.sh`.

```bash
ip rule                        # expect: iif <lan> lookup 100 priority 100
ip route show table 100        # expect: default dev tun0
```

If the rule or the table 100 default is missing while `tun0` is up, the tunnel came
up but the up-script did not run cleanly. Check the OpenVPN journal above.

## Health watchdog

A timer runs the watchdog about once a minute. It marks the instance Unhealthy (so
the Auto Scaling group replaces it) only after five consecutive failures.

```bash
systemctl status gw-healthcheck.timer
systemctl list-timers 'gw-healthcheck*' --no-pager
journalctl -u gw-healthcheck.service -n 100 --no-pager
cat /run/gw-fail-count 2>/dev/null || echo "0 (no failures recorded)"
```

To see what the watchdog sees right now, run it by hand. Note it will try one OpenVPN
restart on failure and bump `/run/gw-fail-count`, so prefer the journal for passive
inspection:

```bash
/usr/local/sbin/gw-healthcheck.sh; echo "exit=$?"
```

## Egress verification

The gateway's own traffic leaves on the main table (the EIP). Forwarded traffic
leaves through `tun0`. The two exit addresses must differ, otherwise traffic is
leaking past the tunnel.

```bash
curl -s https://checkip.amazonaws.com                    # own egress, equals the EIP
curl -s --interface tun0 https://checkip.amazonaws.com   # tunnel egress, the VPN peer
```

## Kernel forwarding settings

```bash
sysctl net.ipv4.ip_forward net.ipv4.conf.all.rp_filter net.ipv6.conf.all.forwarding
cat /etc/sysctl.d/99-custom-gw.conf
```

Expected values are `ip_forward = 1`, `rp_filter = 2` (loose, so tunnel return packets
are not dropped), and IPv6 forwarding `= 0`.

## AWS-side checks (route and EIP)

Run these from your workstation, not the instance.

```bash
# The private default route must target THIS instance
aws ec2 describe-route-tables --route-table-ids <PrivateRouteTableId> \
  --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0']"

# The stack EIP must be associated with the running gateway
aws ec2 describe-addresses \
  --query "Addresses[?Tags[?Value=='auto-networking-custom-gw-eip']]"

# Source/dest check must be disabled so the box can forward
aws ec2 describe-instances --instance-ids <instance-id> \
  --query "Reservations[].Instances[].SourceDestCheck"
```

`PrivateRouteTableId` and the EIP come back as stack outputs (`PrivateRouteTableId`,
`CustomGatewayEip`). `SourceDestCheck` should read `false`.

## State files reference

| File | Meaning |
|------|---------|
| `/run/gw-vpn-configured` | A VPN profile was found and the tunnel config was written. Absent means no profile uploaded yet. |
| `/run/gw-tunnel-up` | The tunnel up-script ran and installed the policy route. |
| `/run/gw-boot-complete` | Boot finished. The watchdog stays quiet until this exists. |
| `/run/gw-fail-count` | Consecutive watchdog failures. Reaches 5 before a replacement is triggered. |
| `/etc/gw-lan-if` | The detected LAN NIC name, read by the kill switch and tunnel scripts. |
| `/etc/vpn/` | Files pulled from the VPN bucket, including `credentials.txt`. |

## Failure signatures

| Symptom | First check |
|---------|-------------|
| Private instances have no internet | `ip link show tun0`, then the OpenVPN journal. Tunnel down means the kill switch is dropping egress by design. |
| Egress works but leaks past the VPN | `ip rule` and `ip route show table 100`. A missing rule sends traffic out the wrong table. |
| Instance keeps getting replaced | `journalctl -u gw-healthcheck.service` and `/run/gw-fail-count`. A peer that stays down loops replacements (see the repo issues). |
| Own IP and tunnel IP are equal | Tunnel is not carrying forwarded traffic. Check `POSTROUTING` MASQUERADE and the policy route. |
| Route did not repoint after a Spot swap | `describe-route-tables` for the private default target, and `cloud-init-output.log` for the `ReplaceRoute` step. |
