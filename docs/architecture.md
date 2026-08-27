# Architecture

The deployable template is `cdk-vpc-vpn-gw.yaml`, generated from the CDK app in [`../cdk/`](../cdk/). This document covers the custom-routing mode in depth, since the other two modes are ordinary VPC plumbing. For deploy commands and parameters, see the [README](../README.md).

## Contents

- [Topology](#topology)
- [How the custom gateway works](#how-the-custom-gateway-works)
  - [One roaming instance, not a fixed ENI](#one-roaming-instance-not-a-fixed-eni)
  - [Packet flow and the kill switch](#packet-flow-and-the-kill-switch)
  - [Capacity mode](#capacity-mode)
  - [The health watchdog](#the-health-watchdog)
  - [Turn on the VPN](#turn-on-the-vpn)
- [Things to know](#things-to-know)

## Topology

All three modes build the same shell. A `10.0.0.0/16` VPC, three public subnets across three Availability Zones, and an internet gateway. `PublicPrivate` and `PublicPrivateCustomRouting` add three private subnets on top. Public subnets are `10.0.1.0/24` through `10.0.3.0/24`, private subnets `10.0.4.0/24` through `10.0.6.0/24`, one per zone.

In custom mode a single EC2 instance in a size-1 Spot Auto Scaling group replaces the managed NAT gateway. The Auto Scaling group spans all three public subnets, so the gateway can land in any zone.

```
                          Internet
                             │
                        ┌────┴────┐
                        │   IGW   │
                        └────┬────┘
  VPC 10.0.0.0/16            │
  ┌────────────────────────────────────────────────────────────┐
  │   AZ-a             AZ-b             AZ-c                   │
  │ ┌──────────┐    ┌──────────┐    ┌──────────┐  public RT    │
  │ │ public   │    │ public   │    │ public   │  0.0.0.0/0    │
  │ │10.0.1/24 │    │10.0.2/24 │    │10.0.3/24 │    → IGW      │
  │ │ ┌──────┐ │    │          │    │          │               │
  │ │ │  GW  │ │    │          │    │          │               │
  │ │ └───▲──┘ │    │          │    │          │               │
  │ └─────┼────┘    └──────────┘    └──────────┘               │
  │       │  ASG places one gateway wherever                   │
  │       │           Spot has capacity                        │
  │ ┌─────┼────┐    ┌──────────┐    ┌──────────┐  private RT   │
  │ │ private  │    │ private  │    │ private  │  0.0.0.0/0    │
  │ │10.0.4/24 │    │10.0.5/24 │    │10.0.6/24 │  → GW inst id │
  │ └──────────┘    └──────────┘    └──────────┘               │
  └────────────────────────────────────────────────────────────┘
```

All three private subnets share one route table. Its `0.0.0.0/0` targets the gateway's instance id, so a private subnet in one zone can route to a gateway in another. That single shared table is the difference from a per-AZ design, which would need one table and one gateway per zone.

## How the custom gateway works

The custom gateway borrows the pattern from the sibling `ec2-spot-bastion` template, cut to one job. Amazon Linux 2023 only, no data volume, one size-1 Spot group that relaunches the instance when Spot reclaims it.

The instance lives in the public subnets, because it needs the internet gateway to reach whatever the private tier egresses to. The private subnets route through it. That is the same placement a managed NAT gateway uses.

At boot the instance turns itself into a fail-closed VPN router, in this order:

1. Turn on IPv4 forwarding and disable the source/destination check, so it can forward packets not addressed to it.
2. Associate the stack's Elastic IP, for a stable egress address a VPN peer can allowlist.
3. Install the kill-switch firewall, a systemd unit that default-drops the FORWARD chain and allows forwarding only out `tun0`.
4. Bring up an OpenVPN tunnel from the profile in `/etc/vpn` and confirm traffic leaves through it.
5. Only then point the private route table's `0.0.0.0/0` at its own instance id.

`EnableVpn=false` turns off steps 3 (kill switch) and 4 (tunnel). The firewall instead forwards the private tier out the primary NIC and NATs it to the internet gateway, so the same box becomes a plain self-healing NAT instance. That is a cheaper alternative to the managed NAT gateway, but it is NOT fail-closed: egress rides the open internet with no tunnel. The route claim, EIP, and watchdog still apply, and the watchdog checks only the route since there is no tunnel.

With no profile uploaded, the box still boots, but the kill switch drops all private egress until you add one. The first deploy against an empty bucket succeeds without ever leaking.

### One roaming instance, not a fixed ENI

The route target is the instance id, a VPC-wide value rather than something pinned to a zone. A private subnet in AZ-b can route to a gateway sitting in AZ-a. That is what lets the Auto Scaling group span all three public subnets and place the instance wherever Spot has capacity.

When Spot reclaims the instance, a replacement takes over and rewrites the route:

```
  t0  Spot reclaims GW-1     private 0.0.0.0/0 → GW-1 (gone) = blackhole, egress stops
  t1  ASG launches GW-2      new instance id, maybe a different zone
  t2  GW-2 boots             kill switch → EIP → tunnel up → egress verified
  t3  GW-2 ReplaceRoute      private 0.0.0.0/0 → GW-2, egress restored
      └──────────── egress gap  t0..t3  ≈ 1 to 3 min ────────────────┘
```

The route table id is baked into the boot script through `!Ref PrivateRouteTable` and stays stable across replacements. Only the target instance changes, and every boot rewrites it (`ReplaceRoute`, falling back to `CreateRoute` on first boot), so a new zone or ENI never breaks routing.

The cost is that egress gap for the length of a replacement boot. Cross-AZ traffic can also occur when the gateway and a private subnet sit in different zones, the same behavior as one NAT gateway serving three subnets. Zero-gap failover would mean one gateway per zone at three times the instance cost. This template does not do that.

### Packet flow and the kill switch

Forwarded traffic reaches the internet through the VPN server, not through the gateway's own public path.

```
  private instance                gateway                        VPN peer
  (10.0.5.x)                (public subnet, any AZ)              → Internet
        │                                                            ▲
        │ default route → GW instance id                             │
        └─────────────► LAN NIC ─► FORWARD (DROP by default)         │
                        eth0/ensX      │                             │
                                       │ allow LAN→tun0 only         │
                                       ▼                             │
                                     tun0 ─► OpenVPN ─► encrypted ───┘
                                                        tunnel

  tunnel down → the packet hits DROP → no fallback to the IGW (fail closed)
```

A policy-routing rule keyed on the ingress interface sends only traffic forwarded in from the private tier into `tun0`. The rule is `ip rule add iif <lan-nic> lookup 100`, where table 100 holds `default dev tun0`. The gateway's own traffic (SSM, S3, the EC2 and Auto Scaling APIs) is locally generated, does not match the rule, and stays on the main table, so the control plane keeps working whether or not the tunnel is up. Matching the ingress interface rather than the `10.0.0.0/16` source is deliberate, because the gateway's own address sits in that range too and a source-based rule would divert its control-plane traffic into the tunnel.

The kill switch is the FORWARD chain, scoped by interface. Default policy DROP. The only two accepted paths are outbound from the LAN NIC into `tun0` and established replies coming back from `tun0` to the LAN NIC. When the tunnel drops, `tun0` carries nothing and every forwarded packet dies at the DROP policy, so nothing falls back to the public path. There is no SNAT on the LAN side, so even an unmatched packet leaves un-NAT'd and the internet gateway discards it.

The LAN NIC name varies by instance type (`eth0`, `ens5`, `enX0`), so the boot script detects it once and writes it to `/etc/gw-lan-if`. A reboot reprograms the rules from `gw-killswitch.service`, ordered before OpenVPN, so the switch is never open even for a moment.

### Capacity mode

`GatewayCapacityMode` sets the purchase model through the `CapacityModeMap` mapping, with no extra conditions.

| GatewayCapacityMode | Behavior |
|---------------------|----------|
| `SpotLowestPrice` (default) | 100% Spot, cheapest zone and type. Most interruptions. |
| `SpotCapacityOptimized` | 100% Spot, `price-capacity-optimized`. Fewer interruptions, so fewer egress gaps. |
| `OnDemand` | No Spot. The single instance is On-Demand. No reclaim gaps, highest cost. |

Because the group is size 1, `OnDemand` resolves to an always-On-Demand instance. The group lists a few small instance types as overrides (`GatewayInstanceType` plus `t3a.small` and `t2.small`) so the Spot strategies have real choices. Move one row up the list when availability matters more than cost.

### The health watchdog

An Auto Scaling group only checks EC2 and system status. An instance can boot fine, then lose its route or its egress, and the group would leave it in service black-holing traffic.

A systemd timer runs a check about once a minute. It confirms the private route still targets this instance, that `tun0` is up, and that the exit IP over the tunnel differs from the box's own address, so a leaking or tunnel-down box reads as unhealthy. It tries one OpenVPN restart before escalating, and marks the instance Unhealthy only after five failures in a row, so a booting instance or a brief blip does not trigger a replacement. The check stays quiet until boot finishes, to avoid racing the tunnel bring-up.

### Turn on the VPN

Custom mode runs a real OpenVPN client. The stack creates a private, encrypted S3 bucket for the VPN files, whose name comes back as the `CustomGatewayVpnBucket` output. For the full upload procedure, the profile format, and the warnings, see [vpn-setup.md](vpn-setup.md). The short version:

1. Upload an OpenVPN profile to the bucket, for example `aws s3 cp client.ovpn s3://<CustomGatewayVpnBucket>/`. Certs and keys can be embedded in the file.
2. For a username/password profile (NordVPN and most commercial providers), also upload a `credentials.txt` with the username on line 1 and the password on line 2, with `printf '%s\n%s\n' USER PASS > credentials.txt && aws s3 cp credentials.txt s3://<CustomGatewayVpnBucket>/`. The boot script points the profile's bare `auth-user-pass` at it and locks the file to `0600`, so the tunnel comes up without a prompt. With NordVPN use the service credentials from the dashboard, not your account login.
3. Refresh the gateway, either by terminating the instance or triggering an Auto Scaling instance refresh. The replacement pulls the files into `/etc/vpn`, strips any `redirect-gateway`, `route`, or `dev` lines that would fight the routing, and starts `openvpn-client@tun-vpn`.

OpenVPN comes from the AL2023 repos, installed with a plain `dnf install` and no third-party repo. The gateway carries the stack's Elastic IP (`CustomGatewayEip` output), re-associated on every launch, so the tunnel's source address stays stable across Spot replacements. Allowlist that address on your VPN peer. The instance role's `s3:GetObject` and `s3:ListBucket` are scoped to this one bucket, so uploading needs no permission change.

## Things to know

- **The default route is instance-managed in custom mode.** CloudFormation does not own the `0.0.0.0/0` route there. The instance writes it at boot. Do not add a static route to the private table in that mode.
- **Egress gaps on replacement.** A Spot reclaim drops private egress until the replacement finishes booting. Use `OnDemand` or `SpotCapacityOptimized` to reduce how often that happens.
- **Single gateway, single point of failure.** One instance carries the whole private tier's egress. An AZ loss takes it down until the group launches elsewhere. Per-AZ redundancy is out of scope here.
- **The firewall reasserts itself on every boot.** The kill switch lives in `gw-killswitch.service`, ordered before OpenVPN, not only in the one-time user-data. A reboot reprograms the DROP policy and the tunnel-only rules before any forwarding can happen.
- **Permissions are scoped to what this stack creates.** The gateway role can re-point only its own private route table, set health only on its own Auto Scaling group, and read only its own VPN bucket. Disabling the source/dest check is limited to instances tagged as this gateway, and associating the Elastic IP is scoped to the stack's own allocation. The exceptions AWS will not let you scope to one resource are `ec2:DescribeRouteTables`, `ec2:DescribeAddresses`, and the `AmazonSSMManagedInstanceCore` managed policy.
- **The VPN bucket blocks stack deletion if it holds files.** S3 refuses to delete a bucket that still has objects, so empty it before you tear the stack down. There is no auto-delete on it.
- **The CIDR is fixed at 10.0.0.0/16.** The security groups derive their ingress CIDR from the VPC's `CidrBlock` attribute, and the gateway's firewall and NAT rules match by interface rather than CIDR, so those follow automatically. The subnet CIDRs are still literals, so change them together if you re-CIDR.
