# vpc-public-private-setup

A CloudFormation template for a VPC with three public subnets across three Availability Zones and, optionally, three private subnets. The `NetworkMode` parameter picks how private egress works. Private subnets exit through a managed NAT gateway, or through a self-healing EC2 Spot instance you can turn into a VPN router.

The template is generated from a TypeScript CDK app under [`cdk/`](cdk/). See [Build (CDK)](#build-cdk).

## Contents

- [Network modes](#network-modes)
- [How the custom gateway works](#how-the-custom-gateway-works)
  - [One roaming instance, not a fixed ENI](#one-roaming-instance-not-a-fixed-eni)
  - [Capacity mode](#capacity-mode)
  - [The health watchdog](#the-health-watchdog)
  - [The VPN and the kill switch](#the-vpn-and-the-kill-switch)
- [Parameters](#parameters)
- [Outputs](#outputs)
- [Deploy](#deploy)
- [Build (CDK)](#build-cdk)
- [Use as a CDK construct](#use-as-a-cdk-construct)
- [Things to know](#things-to-know)

## Network modes

`NetworkMode` chooses one of three layouts.

| NetworkMode | What you get |
|-------------|--------------|
| `PublicOnly` (default) | Three public subnets, an internet gateway, one public route table. No private subnets. |
| `PublicPrivate` | Adds three private subnets and one managed NAT gateway in the first public subnet. All private subnets share one route table whose default route points at the NAT. |
| `PublicPrivateCustomRouting` | Adds the three private subnets, but replaces the NAT gateway with a size-1 Spot Auto Scaling group. The instance routes and NATs private egress and re-points the private route table at itself. A VPN client can layer on top. |

`PublicPrivate` reproduces the AWS-managed NAT path. `PublicPrivateCustomRouting` trades that managed service for an instance you control, which is what lets you route private egress through a VPN.

Flow logs are independent of the mode. Set `EnableFlowLogs=true` in any mode.

## How the custom gateway works

The custom gateway borrows the pattern from the sibling `ec2-spot-bastion` template, cut down to one job (Amazon Linux 2023 only, no data volume). What stays is the size-1 Spot Auto Scaling group that relaunches the instance when Spot reclaims it.

The instance lives in the **public** subnets, because it needs a path to the internet gateway to reach whatever the private tier egresses to. The private subnets route through it. This is the same placement the managed NAT gateway uses.

At boot the instance sets itself up as a fail-closed VPN router. It turns on IPv4 forwarding, disables its own source/destination check so it can forward packets not addressed to it, and associates the stack's Elastic IP for a stable egress address. It then installs the kill-switch firewall (a systemd unit that default-drops the `FORWARD` chain and allows forwarding only out `tun0`), brings up an OpenVPN tunnel from the profile in `/etc/vpn`, and confirms traffic leaves through it. Only then does it point the private route table's `0.0.0.0/0` at itself. With no profile uploaded yet, the box still comes up, but the kill switch drops all private egress until you add one.

### One roaming instance, not a fixed ENI

The route target is the **instance id**, a VPC-wide value rather than something pinned to an Availability Zone. A private subnet in the second AZ can route to a gateway in the first. That matters because the Auto Scaling group spans all three public subnets and lets Spot place the instance wherever it has capacity.

When Spot reclaims the instance:

1. The group terminates it. The `0.0.0.0/0` entry now points at a gone instance and becomes a blackhole, so private egress stops.
2. The group launches a replacement in whichever public subnet has capacity, with a new instance id and ENI.
3. The replacement's boot script re-points the route (`ReplaceRoute`, falling back to `CreateRoute` on first boot) at its own instance id and disables its source/destination check again.

The route table id is baked into the boot script through `!Ref PrivateRouteTable` and is stable across replacements. Only the target instance changes, and every boot rewrites it, so a new AZ or ENI never breaks routing.

A single roaming instance costs an egress gap for the length of a replacement boot, roughly one to three minutes. Cross-AZ traffic can occur when the gateway and a private subnet sit in different zones, the same behavior as one NAT gateway serving three private subnets. Zero-gap failover would mean one gateway per AZ at three times the instance cost. This template does not do that.

### Capacity mode

`GatewayCapacityMode` sets the purchase model through the `CapacityModeMap` mapping, with no extra conditions.

| GatewayCapacityMode | Behavior |
|---------------------|----------|
| `SpotLowestPrice` (default) | 100% Spot, cheapest AZ and type. Most interruptions. |
| `SpotCapacityOptimized` | 100% Spot, `price-capacity-optimized`. Fewer interruptions, so fewer egress gaps. |
| `OnDemand` | No Spot. The single instance is On-Demand. No reclaim gaps, highest cost. |

Because the group is size 1, `OnDemand` resolves to an always-On-Demand instance. The default keeps the bastion-style Spot behavior. Move one parameter up the list when availability matters more than cost.

The Auto Scaling group lists a few small instance types as overrides (`GatewayInstanceType` plus `t3a.small` and `t2.small`) so the Spot strategies have real choices.

### The health watchdog

An Auto Scaling group only checks EC2 and system status. An instance can boot fine, then fail to set its route or lose egress, and the group would leave it in service black-holing traffic.

A systemd timer runs a check about once a minute. It confirms the private route still targets this instance, that `tun0` is up, and that the exit IP over the tunnel differs from the box's own address, so a leaking or tunnel-down box reads as unhealthy. It tries one OpenVPN restart before escalating, and calls `set-instance-health --health-status Unhealthy` only after five failures in a row, so a booting instance or a brief blip does not trigger a replacement. The check stays quiet until boot finishes to avoid racing the tunnel bring-up.

### The VPN and the kill switch

Custom mode runs a real OpenVPN client and makes private egress fail-closed. The stack creates a private, encrypted S3 bucket for the VPN files, whose name comes back as the `CustomGatewayVpnBucket` output. To turn the tunnel on:

1. Upload an OpenVPN profile to the bucket, for example `aws s3 cp client.ovpn s3://<CustomGatewayVpnBucket>/`. Certs and keys can be embedded in the file.
2. For a username/password profile (NordVPN and most commercial providers), also upload a `credentials.txt` with the username on line 1 and the password on line 2 (`printf '%s\n%s\n' USER PASS > credentials.txt && aws s3 cp credentials.txt s3://<CustomGatewayVpnBucket>/`). The boot script points the profile's bare `auth-user-pass` at it and locks the file to `0600`, so the tunnel comes up without an interactive prompt. With NordVPN, use the **service credentials** from the Nord dashboard (Nord Account, Services, NordVPN, "Set up NordVPN manually"), not your account login.
3. Refresh the gateway (terminate the instance, or trigger an Auto Scaling instance refresh). The replacement pulls the files into `/etc/vpn`, strips any `redirect-gateway`, `route`, or `dev` lines that would fight the routing below, and starts `openvpn-client@tun-vpn`.

Forwarded traffic reaches the internet through the VPN server, not the gateway. A policy-routing rule keyed on the ingress interface (`ip rule add iif <lan-nic> lookup 100`, where table 100 is `default dev tun0`) sends only traffic forwarded in from the private tier into `tun0`. The gateway's own traffic (SSM, S3, the EC2 and Auto Scaling APIs) is locally generated, does not match the rule, and stays on the main table, which keeps the box's control plane working regardless of the tunnel. Matching the ingress interface rather than the `10.0.0.0/16` source is deliberate, because the gateway's own address is in that range too and a source-based rule would divert its control-plane traffic into the tunnel.

The kill switch is the `FORWARD` chain, scoped by interface. The default policy is DROP, and the only two paths that match are outbound from the LAN NIC into `tun0` and established replies coming back from `tun0` to the LAN NIC. When the tunnel drops, `tun0` carries nothing and every forwarded packet dies at the DROP policy, so no traffic falls back to the public path. There is no SNAT on the LAN side, so even an unmatched packet leaves un-NAT'd and the internet gateway discards it. The LAN NIC name varies by instance type (`eth0`, `ens5`, `enX0`), so it is detected once at boot and persisted to `/etc/gw-lan-if`. A reboot reprograms all of this from `gw-killswitch.service`, ordered before OpenVPN, so the switch is never briefly open.

The gateway carries the stack's Elastic IP (`CustomGatewayEip` output), re-associated on every launch, so the tunnel's source address stays stable across Spot replacements. Allowlist that address on your VPN peer.

OpenVPN comes from the AL2023 repos (the `amzn2023`-tagged build), so the boot script installs it with a plain `dnf install` and no third-party repo. The instance role's `s3:GetObject` and `s3:ListBucket` are already scoped to this one bucket, so uploading needs no permission change.

## Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `NetworkMode` | `PublicOnly` | `PublicOnly`, `PublicPrivate`, or `PublicPrivateCustomRouting`. |
| `ResourcesPrefixName` | `auto-networking` | Prefix for generated resource Name tags. |
| `EnableFlowLogs` | `false` | VPC flow logs to CloudWatch Logs. Works in any mode. |
| `TrafficType` | `REJECT` | `ACCEPT`, `REJECT`, or `ALL`. Used only with flow logs. |
| `RetentionInDays` | `14` | Flow log retention. Used only with flow logs. |
| `GatewayInstanceType` | `t3.micro` | Custom gateway instance type and first Spot override. Custom mode only. |
| `GatewayCapacityMode` | `SpotLowestPrice` | `SpotLowestPrice`, `SpotCapacityOptimized`, or `OnDemand`. Custom mode only. |
| `EnableSsmEndpoints` | `false` | Create SSM interface endpoints so private instances stay reachable when the tunnel is down. Custom mode only. Bills ~$22/month (three endpoints, one AZ) whether used or not. |

Custom mode also creates a private S3 bucket for VPN files. It has no parameter. The bucket name comes back as an output.

## Outputs

- `PubPrivateVPCID` and the six subnet ids. The three private subnet ids export only when private subnets exist.
- `LogGroupARN` when flow logs are on.
- `CustomGatewayASGName`, `PrivateRouteTableId`, and `CustomGatewayVpnBucket` in custom mode. The route table id shows which instance the default route points at. The bucket name is where you upload VPN client files.

## Deploy

Public and private with the managed NAT gateway:

```bash
aws cloudformation deploy \
  --stack-name my-vpc \
  --template-file vpc-public-private-setup.yaml \
  --parameter-overrides NetworkMode=PublicPrivate
```

Custom routing gateway on Spot, ready for a VPN, with flow logs:

```bash
aws cloudformation deploy \
  --stack-name my-vpc \
  --template-file vpc-public-private-setup.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    NetworkMode=PublicPrivateCustomRouting \
    GatewayCapacityMode=SpotCapacityOptimized \
    EnableFlowLogs=true
```

`CAPABILITY_IAM` is required in custom mode for the gateway's instance role. The other modes need no capabilities. There is no `AWS::LanguageExtensions` transform, so no `CAPABILITY_AUTO_EXPAND` either.

After a custom-mode deploy, confirm the routing took hold:

```bash
aws ec2 describe-route-tables --route-table-ids <PrivateRouteTableId> \
  --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0']"
```

The `InstanceId` field should hold the running gateway. Reach the instance through SSM Session Manager, since it carries `AmazonSSMManagedInstanceCore` and has no open inbound ports.

## Build (CDK)

The template is generated from the CDK app under [`cdk/`](cdk/). `vpc-public-private-setup.yaml` is the synth output and the deployable artifact.

The CDK app is a one-to-one, L1-only re-authoring. It keeps `NetworkMode` and the Conditions, so one synthesized template still selects the layout at deploy time and preserves every logical ID and export name. The boot script lives as a real file at [`cdk/scripts/gw-bootstrap.sh`](cdk/scripts/gw-bootstrap.sh) and is inlined into the launch-template UserData at synth. It is an `Fn::Sub` template, so `${AWS::Region}`, `${PrivateRouteTable}`, and the other placeholders resolve at deploy time, which is why shellcheck flags those lines.

A Makefile drives the build:

```bash
cd cdk
make synth      # write ../vpc-public-private-setup.yaml from the CDK app
make deploy     # deploy with cdk deploy (pass CDK_ARGS="--parameters NetworkMode=...")
make compare    # structural diff against a local reference backup (skipped if absent)
make prechecks  # verify node, npm, and the AWS CLI are present
make clean      # remove node_modules and cdk.out
```

`make synth` and `make deploy` install dependencies first. The stack synthesizes with `CliCredentialsStackSynthesizer`, so the output carries no CDK bootstrap parameters and deploys with either `cdk deploy` or the plain `aws cloudformation deploy` commands above. After editing the CDK source, run `make synth` and commit the regenerated YAML.

## Use as a CDK construct

The same code doubles as an importable construct. `VpcPublicPrivateSetup` (exported from [`cdk/lib/index.ts`](cdk/lib/index.ts)) builds the network directly inside your own stack. Pass it props and it resolves everything at synth time. It builds only the layout you asked for, adds no CloudFormation parameters or conditions, and uses CDK's hashed logical IDs so you can create more than one.

```ts
import { VpcPublicPrivateSetup } from 'vpc-public-private-setup-cdk';

new VpcPublicPrivateSetup(this, 'Network', {
  networkMode: 'PublicPrivate',
  resourcesPrefixName: 'prod-net',
  enableFlowLogs: true,
});
```

Props are all optional. Omitting a field uses the default shown.

| Prop | Default | Notes |
|------|---------|-------|
| `networkMode` | `PublicOnly` | `PublicOnly`, `PublicPrivate`, or `PublicPrivateCustomRouting`. Drives which resources are built. |
| `resourcesPrefixName` | `auto-networking` | Prefix for `Name` tags. Use a distinct value per instance when you create more than one in a stack. |
| `enableFlowLogs` | `false` | Adds the flow-logs log group, role, and flow log. |
| `trafficType` | `REJECT` | `ACCEPT`, `REJECT`, or `ALL`. Flow logs only. |
| `retentionInDays` | `14` | Flow-log retention in days. |
| `gatewayInstanceType` | `t3.micro` | Custom gateway instance type. Custom-routing mode only. |
| `gatewayCapacityMode` | `SpotLowestPrice` | `SpotLowestPrice`, `SpotCapacityOptimized`, or `OnDemand`. Custom-routing mode only. |

The construct exposes its resources as public fields (`vpc`, `publicSubnets`, `privateSubnets`, `privateRouteTable`, `natGateway`, `vpnBucket`, `gatewayAsg`, `logGroup`, `flowLog`) so you can wire other resources to them. The private-tier fields are `undefined` in modes that don't create them.

Two things to know:

- **Props mode injects no parameters.** That is the difference from the standalone template, which keeps `NetworkMode` and the rest as deploy-time parameters. Passing no props at all makes the construct reproduce that parametric behavior, which is what the bundled stack uses.
- **Multiple instances in one stack each need a distinct `resourcesPrefixName`.** Logical IDs are hashed and unique automatically, but the Auto Scaling group name comes from the stack name and the instance `Name` tag comes from the prefix. The common shape is one instance per stack.

To consume it, run `make build` to compile to `dist/`. Within this repo another package can reference it with a relative or workspace dependency. Publishing to npm is not set up yet (the package stays `private`), so a scoped npm publish or a GitHub-install path is the next step for external consumers.

## Things to know

- **The default route is instance-managed in custom mode.** CloudFormation does not own the `0.0.0.0/0` route there. The instance writes it at boot. Do not add a static route to the private table in that mode.
- **Egress gaps on replacement.** A Spot reclaim drops private egress until the replacement finishes booting. Use `OnDemand` or `SpotCapacityOptimized` to reduce how often that happens.
- **Single gateway, single point of failure.** One instance carries the whole private tier's egress. An AZ loss takes it down until the group launches elsewhere. Per-AZ redundancy is out of scope here.
- **The firewall reasserts itself on every boot.** The kill switch lives in `gw-killswitch.service`, ordered before OpenVPN, not only in the one-time user-data. A reboot reprograms the DROP policy and the tunnel-only rules before any forwarding can happen, so it never opens the switch even for a moment.
- **Permissions are scoped to what this stack creates.** The gateway role can re-point only its own private route table, set health only on its own Auto Scaling group, and read only its own VPN bucket. Disabling the source/dest check is limited to instances tagged as this gateway, and associating the Elastic IP is scoped to the stack's own allocation. The exceptions AWS will not let you scope to a single resource are `ec2:DescribeRouteTables`, `ec2:DescribeAddresses`, and the `AmazonSSMManagedInstanceCore` managed policy.
- **The VPN bucket blocks stack deletion if it holds files.** S3 refuses to delete a bucket that still has objects, so empty it before you tear the stack down. There is no auto-delete on it.
- **The CIDR is fixed at 10.0.0.0/16.** Subnets are carved from it (`10.0.1.0/24` through `10.0.6.0/24`). The security groups derive their ingress CIDR from the VPC's `CidrBlock` attribute, and the gateway's firewall and NAT rules match by interface rather than CIDR, so those follow automatically. The subnet CIDRs are still literals, so change them together if you re-CIDR.
