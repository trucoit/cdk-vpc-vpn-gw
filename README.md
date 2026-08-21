# cdk-vpc-vpn-gw

| Branch | Build                            |
| :----: | :------------------------------: |
| `main` | [![main][main-badge]][workflow]  |
| `dev`  | [![dev][dev-badge]][workflow]    |

[workflow]: https://github.com/trucoit/cdk-vpc-vpn-gw/actions/workflows/synth-template.yml
[main-badge]: https://github.com/trucoit/cdk-vpc-vpn-gw/actions/workflows/synth-template.yml/badge.svg?branch=main&event=push
[dev-badge]: https://github.com/trucoit/cdk-vpc-vpn-gw/actions/workflows/synth-template.yml/badge.svg?branch=dev&event=push

A CloudFormation template for a VPC with three public subnets across three Availability Zones and, optionally, three private subnets. `NetworkMode` picks how private egress works. Private subnets exit through a managed NAT gateway, or through a self-healing EC2 Spot instance you can turn into a VPN router.

Generated from a TypeScript CDK app under [`cdk/`](cdk/). The synth output, `cdk-vpc-vpn-gw.yaml`, is the deployable artifact.

Deep dive on the custom gateway and the operational caveats live in [docs/architecture.md](docs/architecture.md).

## Contents

- [Deploy](#deploy)
  - [Deploy with the CDK](#deploy-with-the-cdk)
- [Turn on the VPN](#turn-on-the-vpn)
- [Build](#build)
- [Network modes](#network-modes)
- [Parameters](#parameters)
- [Outputs](#outputs)
- [Use as a CDK construct](#use-as-a-cdk-construct)
- [Docs](#docs)

## Deploy

The committed `cdk-vpc-vpn-gw.yaml` deploys with plain CloudFormation. No CDK bootstrap.

Managed NAT gateway, public plus private:

```bash
aws cloudformation deploy \
  --stack-name my-vpc \
  --template-file cdk-vpc-vpn-gw.yaml \
  --parameter-overrides NetworkMode=PublicPrivate
```

Custom Spot gateway, ready for a VPN, with flow logs:

```bash
aws cloudformation deploy \
  --stack-name my-vpc \
  --template-file cdk-vpc-vpn-gw.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    NetworkMode=PublicPrivateCustomRouting \
    GatewayCapacityMode=SpotCapacityOptimized \
    EnableFlowLogs=true
```

`CAPABILITY_IAM` is required only in custom mode, for the gateway's instance role. There is no transform, so no `CAPABILITY_AUTO_EXPAND`.

Custom mode comes up fail-closed. Private egress stays dropped until you upload a VPN profile and refresh the gateway. See [Turn on the VPN](#turn-on-the-vpn).

### Deploy with the CDK

`make deploy` wraps `cdk deploy`. Pass stack parameters and cdk flags through `CDK_ARGS`, one `--parameters` per value. A full custom-mode example:

```bash
cd cdk
make deploy CDK_ARGS="\
  --parameters NetworkMode=PublicPrivateCustomRouting \
  --parameters GatewayCapacityMode=SpotCapacityOptimized \
  --parameters GatewayInstanceType=t3.micro \
  --parameters EnableFlowLogs=true \
  --parameters TrafficType=ALL \
  --parameters RetentionInDays=30 \
  --parameters EnableSsmEndpoints=true \
  --parameters ResourcesPrefixName=my-net \
  --require-approval never"
```

`--require-approval never` skips the IAM confirmation prompt custom mode raises. Drop any `--parameters` line to take that parameter's default.

Confirm the private default route points at the running gateway after a custom deploy:

```bash
aws ec2 describe-route-tables --route-table-ids <PrivateRouteTableId> \
  --query "RouteTables[0].Routes[?DestinationCidrBlock=='0.0.0.0/0']"
```

Reach the instance through SSM Session Manager. It carries `AmazonSSMManagedInstanceCore` and has no open inbound ports.

For example, for building a simple custom Gateway setup:

```bash
cd cdk
make deploy CDK_ARGS="\
  --parameters NetworkMode=PublicPrivateCustomRouting \
  --parameters GatewayCapacityMode=SpotCapacityOptimized \
  --parameters GatewayInstanceType=t3.micro \
  --parameters EnableFlowLogs=false \
  --parameters EnableSsmEndpoints=false \
  --parameters ResourcesPrefixName=custom-gw-net \
  --require-approval never"
```

## Turn on the VPN

Custom mode is a fail-closed VPN router. It creates a private, encrypted S3 bucket for the OpenVPN client files, and until a valid profile is there the gateway drops all private egress. Routing private traffic through your VPN is the point of this mode, so this is the step that makes it work.

Get the bucket name from the `CustomGatewayVpnBucket` output, upload one profile, then refresh the gateway to pull it:

```bash
BUCKET=$(aws cloudformation describe-stacks --stack-name my-vpc \
  --query "Stacks[0].Outputs[?OutputKey=='CustomGatewayVpnBucket'].OutputValue" --output text)

aws s3 cp client.ovpn "s3://$BUCKET/"

# Username/password providers (NordVPN and similar) also need credentials.txt,
# username on line 1, password on line 2:
printf '%s\n%s\n' 'SERVICE_USERNAME' 'SERVICE_PASSWORD' > credentials.txt
aws s3 cp credentials.txt "s3://$BUCKET/"
```

The gateway reads the bucket only at boot, so terminate the instance (the Auto Scaling group relaunches it) or start an instance refresh to apply. Upload exactly one `.ovpn`/`.conf` profile with its certs and keys embedded inline.

Full procedure, the profile format, and the warnings are in [docs/vpn-setup.md](docs/vpn-setup.md).

## Build

A Makefile in `cdk/` regenerates the template from the CDK app:

```bash
cd cdk
make synth      # write ../cdk-vpc-vpn-gw.yaml from the CDK app
make deploy     # deploy with cdk deploy (see above)
make build      # compile the construct to dist/
make lint       # eslint + prettier check (make lint-fix to auto-fix)
make test       # lint, then jest (unit tests + cdk-nag AwsSolutions checks)
make compare    # structural diff against a local reference backup
make clean      # remove node_modules and cdk.out
```

`make test` is the full gate. It runs ESLint, Prettier, the Jest suite, and cdk-nag's AwsSolutions best-practice and security checks. `make synth` and `make deploy` install dependencies first. The stack synthesizes with `CliCredentialsStackSynthesizer`, so the output carries no bootstrap parameters. A GitHub Actions workflow runs `make test` on every push and pull request, then on pushes to `main` or `dev` re-runs the synth and commits the regenerated YAML back, so the committed template always matches `cdk/`. After editing CDK source locally, run `make synth` and commit the result.

## Network modes

| NetworkMode | What you get |
|-------------|--------------|
| `PublicOnly` (default) | Three public subnets, an internet gateway, one public route table. No private subnets. |
| `PublicPrivate` | Adds three private subnets and one managed NAT gateway in the first public subnet. All private subnets share one route table whose default route points at the NAT. |
| `PublicPrivateCustomRouting` | Adds the three private subnets, but replaces the NAT gateway with a size-1 Spot Auto Scaling group that routes and NATs private egress and can carry a VPN. |

`PublicPrivate` reproduces the AWS-managed NAT path. `PublicPrivateCustomRouting` trades it for an instance you control, which is what lets you route private egress through a VPN. Flow logs work in any mode via `EnableFlowLogs=true`.

## Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| `NetworkMode` | `PublicOnly` | `PublicOnly`, `PublicPrivate`, or `PublicPrivateCustomRouting`. |
| `ResourcesPrefixName` | `auto-networking` | Prefix for generated resource Name tags. |
| `EnableFlowLogs` | `false` | VPC flow logs to CloudWatch Logs. Any mode. |
| `TrafficType` | `REJECT` | `ACCEPT`, `REJECT`, or `ALL`. Flow logs only. |
| `RetentionInDays` | `14` | Flow log retention. Flow logs only. |
| `GatewayInstanceType` | `t3.micro` | Gateway instance type and first Spot override. Custom mode only. |
| `GatewayCapacityMode` | `SpotLowestPrice` | `SpotLowestPrice`, `SpotCapacityOptimized`, or `OnDemand`. Custom mode only. |
| `EnableSsmEndpoints` | `false` | SSM interface endpoints so private instances stay reachable when the tunnel is down. Custom mode only. Bills ~$22/month (three endpoints, one AZ). |

Custom mode also creates a private S3 bucket for VPN files. It has no parameter. The bucket name comes back as an output.

## Outputs

- `PubPrivateVPCID` and the six subnet ids. The private subnet ids export only when private subnets exist.
- `LogGroupARN` when flow logs are on.
- `CustomGatewayASGName`, `PrivateRouteTableId`, `CustomGatewayEip`, and `CustomGatewayVpnBucket` in custom mode. The route table id shows which instance the default route points at. The bucket name is where you upload VPN client files.

## Use as a CDK construct

The same code is an importable construct. `VpcPublicPrivateSetup` (from [`cdk/lib/index.ts`](cdk/lib/index.ts)) builds the network inside your own stack, resolving everything at synth time. It builds only the layout you ask for, adds no CloudFormation parameters or conditions, and uses hashed logical IDs so you can create more than one.

```ts
import { VpcPublicPrivateSetup } from 'vpc-public-private-setup-cdk';

new VpcPublicPrivateSetup(this, 'Network', {
  networkMode: 'PublicPrivate',
  resourcesPrefixName: 'prod-net',
  enableFlowLogs: true,
});
```

Props are optional and mirror the [parameters](#parameters) above (`networkMode`, `resourcesPrefixName`, `enableFlowLogs`, `trafficType`, `retentionInDays`, `gatewayInstanceType`, `gatewayCapacityMode`). Omitting a field uses its default. Passing no props reproduces the parametric standalone template, which is what the bundled stack does.

The construct exposes its resources as public fields (`vpc`, `publicSubnets`, `privateSubnets`, `privateRouteTable`, `natGateway`, `vpnBucket`, `gatewayAsg`, `logGroup`, `flowLog`) so you can wire other resources to them. The private-tier fields are `undefined` in modes that don't build them. Give each instance a distinct `resourcesPrefixName` when you create more than one in a stack, since the Auto Scaling group name and Name tags derive from it.

Run `make build` to compile to `dist/`. The package stays `private`, so npm publishing is not set up yet.

## Docs

- [Architecture and how the custom gateway works](docs/architecture.md)
- [VPN profile setup](docs/vpn-setup.md). Upload the `.ovpn` to the bucket, the required format, and the warnings.
- [Operations runbook](docs/operations.md). Connect over SSM and check the kill switch, tunnel, watchdog, and routing.
- [Things to know](docs/architecture.md#things-to-know)
