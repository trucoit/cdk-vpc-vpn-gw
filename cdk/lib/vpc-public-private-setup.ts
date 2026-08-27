import { readFileSync } from 'fs';
import { join } from 'path';
import { CfnCondition, CfnMapping, CfnOutput, CfnParameter, CfnResource, Fn, Lazy, Stack, Token } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';

/**
 * Dual-purpose VPC construct.
 *
 * - **Standalone template.** With no config props it recreates the parametric
 *   CloudFormation template: `CfnParameter` + `CfnCondition` + `CfnMapping`, every
 *   resource present, deploy-time `NetworkMode` switch. `VpcPublicPrivateSetupStack`
 *   uses this path and rewrites logical IDs to be unhashed.
 * - **Composable module.** Given config props it resolves values at synth time,
 *   builds only the selected layout, injects no CloudFormation parameters, and can
 *   be dropped into any stack (multiple times, with distinct `resourcesPrefixName`).
 *
 * One set of resource definitions serves both, via `gated()`: a gate is a `boolean`
 * (props mode -> create or skip) or a `CfnCondition` (parameter mode -> create and
 * attach the condition). Cross-resource references always use the `Fn::Sub`
 * variables map / attribute tokens, so they resolve regardless of ID hashing.
 */

type Gate = boolean | CfnCondition;

/** Create via `make()` and, for a CfnCondition gate, attach it. Skip on `false`. */
function gated<T extends CfnResource>(gate: Gate, make: () => T): T | undefined {
  if (typeof gate === 'boolean') {
    return gate ? make() : undefined;
  }
  const resource = make();
  resource.cfnOptions.condition = gate;
  return resource;
}

/** Same as `gated`, for `CfnOutput` (carries `.condition`, not `cfnOptions`). */
function gatedOutput(gate: Gate, make: () => CfnOutput): CfnOutput | undefined {
  if (typeof gate === 'boolean') {
    return gate ? make() : undefined;
  }
  const output = make();
  output.condition = gate;
  return output;
}

const PUBLIC_SUBNET_SPECS = [
  { id: 'PublicSubnet1', cidr: '10.0.1.0/24', az: 0, suffix: 'A' },
  { id: 'PublicSubnet2', cidr: '10.0.2.0/24', az: 1, suffix: 'B' },
  { id: 'PublicSubnet3', cidr: '10.0.3.0/24', az: 2, suffix: 'C' },
];
const PRIVATE_SUBNET_SPECS = [
  { id: 'PrivateSubnet1', cidr: '10.0.4.0/24', az: 0, suffix: 'A' },
  { id: 'PrivateSubnet2', cidr: '10.0.5.0/24', az: 1, suffix: 'B' },
  { id: 'PrivateSubnet3', cidr: '10.0.6.0/24', az: 2, suffix: 'C' },
];

// GatewayCapacityMode -> the two MixedInstancesPolicy fields. Used directly in
// props mode; emitted as a CfnMapping (CFN key casing) in parameter mode.
const CAPACITY_MODES: Record<string, { onDemandPercentage: number; spotStrategy: string }> = {
  SpotLowestPrice: { onDemandPercentage: 0, spotStrategy: 'lowest-price' },
  SpotCapacityOptimized: { onDemandPercentage: 0, spotStrategy: 'price-capacity-optimized' },
  OnDemand: { onDemandPercentage: 100, spotStrategy: 'lowest-price' },
};
const CAPACITY_MODES_CFN = {
  SpotLowestPrice: { OnDemandPercentage: 0, SpotStrategy: 'lowest-price' },
  SpotCapacityOptimized: { OnDemandPercentage: 0, SpotStrategy: 'price-capacity-optimized' },
  OnDemand: { OnDemandPercentage: 100, SpotStrategy: 'lowest-price' },
};

export type NetworkMode = 'PublicOnly' | 'PublicPrivate' | 'PublicPrivateCustomRouting';
export type GatewayCapacityMode = 'SpotLowestPrice' | 'SpotCapacityOptimized' | 'OnDemand';

/**
 * Props for {@link VpcPublicPrivateSetup}. Passing any config field switches the
 * construct into props mode (synth-time, no CloudFormation parameters). Passing
 * none reproduces the parametric template.
 */
export interface VpcPublicPrivateSetupProps {
  readonly networkMode?: NetworkMode;
  readonly resourcesPrefixName?: string;
  readonly enableFlowLogs?: boolean;
  readonly trafficType?: 'ACCEPT' | 'REJECT' | 'ALL';
  readonly retentionInDays?: number;
  readonly gatewayInstanceType?: string;
  readonly gatewayCapacityMode?: GatewayCapacityMode;
  /**
   * Create SSM interface endpoints (ssm, ssmmessages, ec2messages) so private
   * instances stay reachable over Session Manager when the tunnel is down.
   * Custom gateway only. Defaults to false, because these endpoints bill per
   * hour whether used or not (roughly $22/month for the three in one AZ). Set
   * true when you need SSM access to private instances that does not depend on
   * the gateway's tunnel being up.
   */
  readonly enableSsmEndpoints?: boolean;
  /**
   * Run the custom gateway as a real OpenVPN router (true, the default) or as a
   * plain NAT instance (false). Custom gateway only.
   *
   * When true the gateway is fail-closed: it forwards the private tier only
   * through the tunnel and drops all egress until a VPN profile is uploaded.
   * When false it is a self-healing Spot NAT instance that NATs the private tier
   * straight out to the internet through the internet gateway. That is cheaper
   * than a managed NAT gateway, but it is NOT fail-closed: egress rides the open
   * internet, no tunnel and no kill switch.
   */
  readonly enableVpn?: boolean;
}

/** Resolved configuration shared by the build methods. */
interface Cfg {
  parametric: boolean;
  prefixName: (suffix: string) => string;
  hasPrivate: Gate;
  useNat: Gate;
  useCustom: Gate;
  ssmEndpointsOn: Gate;
  vpnEnabled: string;
  flowLogsOn: Gate;
  trafficType: string;
  retentionInDays: number;
  gatewayInstanceType: string;
  onDemandPercentage: number;
  spotStrategy: string;
}

export class VpcPublicPrivateSetup extends Construct {
  public vpc!: ec2.CfnVPC;
  public readonly publicSubnets: ec2.CfnSubnet[] = [];
  public readonly privateSubnets: ec2.CfnSubnet[] = [];
  public publicRouteTable!: ec2.CfnRouteTable;
  public privateRouteTable?: ec2.CfnRouteTable;
  public natGateway?: ec2.CfnNatGateway;
  public vpnBucket?: s3.CfnBucket;
  public customGwEip?: ec2.CfnEIP;
  public readonly ssmEndpoints: ec2.CfnVPCEndpoint[] = [];
  public gatewayAsg?: autoscaling.CfnAutoScalingGroup;
  public logGroup?: logs.CfnLogGroup;
  public flowLog?: ec2.CfnFlowLog;

  constructor(scope: Construct, id: string, props: VpcPublicPrivateSetupProps = {}) {
    super(scope, id);

    const cfg = this.resolveConfig(props);
    this.createCoreNetwork(cfg); // always-on: VPC, public subnets, IGW, public routing
    this.createPrivateRouting(cfg); // gated: hasPrivate
    this.createNatGateway(cfg); // gated: useNat
    this.createCustomGateway(cfg); // gated: useCustom
    this.createFlowLogs(cfg); // gated: flowLogsOn
    this.createOutputs(cfg);
  }

  // ---------------------------------------------------------------------------
  // Config resolution: parameters+conditions (no props) OR literals+booleans.
  // ---------------------------------------------------------------------------
  private resolveConfig(props: VpcPublicPrivateSetupProps): Cfg {
    const parametric =
      props.networkMode === undefined &&
      props.resourcesPrefixName === undefined &&
      props.enableFlowLogs === undefined &&
      props.trafficType === undefined &&
      props.retentionInDays === undefined &&
      props.gatewayInstanceType === undefined &&
      props.gatewayCapacityMode === undefined &&
      props.enableSsmEndpoints === undefined &&
      props.enableVpn === undefined;

    return parametric ? this.parametricConfig() : this.literalConfig(props);
  }

  /** Deploy-time behavior: CfnParameters, CfnConditions, CfnMapping. */
  private parametricConfig(): Cfg {
    new CfnParameter(this, 'ResourcesPrefixName', {
      description: 'Prefix name for all the auto generated resources',
      type: 'String',
      default: 'auto-networking',
    });

    new CfnParameter(this, 'RetentionInDays', {
      description: 'Specifies the number of days you want to retain log events.',
      type: 'Number',
      default: 14,
      // Number parameter: keep AllowedValues as numbers (matches the original and
      // satisfies cfn-lint). The prop is typed string[], so cast through unknown.
      allowedValues: [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653] as unknown as string[],
    });

    new CfnParameter(this, 'TrafficType', {
      description: 'The type of traffic to log.',
      type: 'String',
      default: 'REJECT',
      allowedValues: ['ACCEPT', 'REJECT', 'ALL'],
    });

    const enableFlowLogs = new CfnParameter(this, 'EnableFlowLogs', {
      description: 'Enable VPC Flow Logs',
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
    });

    const networkMode = new CfnParameter(this, 'NetworkMode', {
      description: [
        'Network layout to deploy.',
        '- PublicOnly: public subnets, IGW, public route table only.',
        '- PublicPrivate: also private subnets behind a managed NAT gateway.',
        '- PublicPrivateCustomRouting: private subnets behind a self-healing EC2',
        '  Spot gateway that re-points the private route at itself and NATs egress',
        '  (a VPN client can be layered on top). See the custom-gateway parameters.',
      ].join('\n'),
      type: 'String',
      default: 'PublicOnly',
      allowedValues: ['PublicOnly', 'PublicPrivate', 'PublicPrivateCustomRouting'],
    });

    new CfnParameter(this, 'GatewayInstanceType', {
      description: [
        'Instance type for the custom routing gateway. Used only when',
        'NetworkMode=PublicPrivateCustomRouting. Also the first entry in the Auto',
        "Scaling group's instance-type overrides (alongside a couple of small",
        'alternates) so the Spot capacity strategy has choices.',
      ].join('\n'),
      type: 'String',
      default: 't3.micro',
    });

    new CfnParameter(this, 'GatewayCapacityMode', {
      description: [
        'Purchase model for the custom routing gateway. Used only when',
        'NetworkMode=PublicPrivateCustomRouting.',
        '- SpotLowestPrice: 100% Spot, cheapest AZ/type (most interruptions).',
        '- SpotCapacityOptimized: 100% Spot, price-capacity-optimized (fewer',
        '  interruptions, better availability).',
        '- OnDemand: no Spot; the single instance is On-Demand (best availability,',
        '  highest cost).',
      ].join('\n'),
      type: 'String',
      default: 'SpotLowestPrice',
      allowedValues: ['SpotLowestPrice', 'SpotCapacityOptimized', 'OnDemand'],
    });

    const enableSsmEndpoints = new CfnParameter(this, 'EnableSsmEndpoints', {
      description: [
        'Create SSM interface endpoints (ssm, ssmmessages, ec2messages) so private',
        'instances stay reachable over Session Manager when the gateway tunnel is',
        'down. Used only when NetworkMode=PublicPrivateCustomRouting.',
        'COST: these bill per hour whether used or not, roughly $22/month for the',
        'three endpoints in one AZ. Leave false unless you need tunnel-independent',
        'SSM access to private instances.',
      ].join('\n'),
      type: 'String',
      default: 'false',
      allowedValues: ['true', 'false'],
    });

    const enableVpn = new CfnParameter(this, 'EnableVpn', {
      description: [
        'Run the custom gateway as an OpenVPN router (true) or a plain NAT instance',
        '(false). Used only when NetworkMode=PublicPrivateCustomRouting.',
        'true is fail-closed: the private tier egresses only through the tunnel and',
        'stays dropped until a VPN profile is uploaded. false is a cheap self-healing',
        'NAT instance that egresses straight to the internet, and is NOT fail-closed.',
      ].join('\n'),
      type: 'String',
      default: 'true',
      allowedValues: ['true', 'false'],
    });

    // Interface groups our parameters. Stack-level, so set it on the stack.
    Stack.of(this).templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          { Label: { default: 'Network layout ...' }, Parameters: ['NetworkMode', 'ResourcesPrefixName'] },
          {
            Label: { default: 'Flow logs (optional) ...' },
            Parameters: ['EnableFlowLogs', 'TrafficType', 'RetentionInDays'],
          },
          {
            Label: { default: 'Custom routing gateway (NetworkMode=PublicPrivateCustomRouting) ...' },
            Parameters: ['GatewayInstanceType', 'GatewayCapacityMode', 'EnableVpn', 'EnableSsmEndpoints'],
          },
        ],
      },
    };

    const capacityModeMap = new CfnMapping(this, 'CapacityModeMap', { mapping: CAPACITY_MODES_CFN });

    return {
      parametric: true,
      prefixName: (suffix) => Fn.sub(`\${ResourcesPrefixName}-${suffix}`),
      hasPrivate: new CfnCondition(this, 'HasPrivateSubnets', {
        expression: Fn.conditionNot(Fn.conditionEquals(networkMode.valueAsString, 'PublicOnly')),
      }),
      useNat: new CfnCondition(this, 'UseNatGateway', {
        expression: Fn.conditionEquals(networkMode.valueAsString, 'PublicPrivate'),
      }),
      useCustom: new CfnCondition(this, 'UseCustomGateway', {
        expression: Fn.conditionEquals(networkMode.valueAsString, 'PublicPrivateCustomRouting'),
      }),
      ssmEndpointsOn: new CfnCondition(this, 'EnableSsmEndpointsCondition', {
        expression: Fn.conditionAnd(
          Fn.conditionEquals(networkMode.valueAsString, 'PublicPrivateCustomRouting'),
          Fn.conditionEquals(enableSsmEndpoints.valueAsString, 'true'),
        ),
      }),
      vpnEnabled: enableVpn.valueAsString,
      flowLogsOn: new CfnCondition(this, 'EnableFlowLogsCondition', {
        expression: Fn.conditionEquals(enableFlowLogs.valueAsString, 'true'),
      }),
      trafficType: Fn.ref('TrafficType'),
      retentionInDays: Token.asNumber(Fn.ref('RetentionInDays')),
      gatewayInstanceType: Fn.ref('GatewayInstanceType'),
      onDemandPercentage: Token.asNumber(
        capacityModeMap.findInMap(Fn.ref('GatewayCapacityMode'), 'OnDemandPercentage'),
      ),
      spotStrategy: capacityModeMap.findInMap(Fn.ref('GatewayCapacityMode'), 'SpotStrategy'),
    };
  }

  /** Props mode: everything resolved to literals now; gates become booleans. */
  private literalConfig(props: VpcPublicPrivateSetupProps): Cfg {
    const prefix = props.resourcesPrefixName ?? 'auto-networking';
    const mode = props.networkMode ?? 'PublicOnly';
    const capacity = CAPACITY_MODES[props.gatewayCapacityMode ?? 'SpotLowestPrice'];

    return {
      parametric: false,
      prefixName: (suffix) => `${prefix}-${suffix}`,
      hasPrivate: mode !== 'PublicOnly',
      useNat: mode === 'PublicPrivate',
      useCustom: mode === 'PublicPrivateCustomRouting',
      ssmEndpointsOn: mode === 'PublicPrivateCustomRouting' && (props.enableSsmEndpoints ?? false),
      vpnEnabled: String(props.enableVpn ?? true),
      flowLogsOn: props.enableFlowLogs ?? false,
      trafficType: props.trafficType ?? 'REJECT',
      retentionInDays: props.retentionInDays ?? 14,
      gatewayInstanceType: props.gatewayInstanceType ?? 't3.micro',
      onDemandPercentage: capacity.onDemandPercentage,
      spotStrategy: capacity.spotStrategy,
    };
  }

  // ---------------------------------------------------------------------------
  // Build methods
  // ---------------------------------------------------------------------------
  private createCoreNetwork(cfg: Cfg) {
    this.vpc = new ec2.CfnVPC(this, 'PubPrivateVPC', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: [{ key: 'Name', value: cfg.prefixName('vpc') }],
    });

    for (const s of PUBLIC_SUBNET_SPECS) {
      this.publicSubnets.push(
        new ec2.CfnSubnet(this, s.id, {
          vpcId: this.vpc.ref,
          availabilityZone: Fn.select(s.az, Fn.getAzs('')),
          cidrBlock: s.cidr,
          mapPublicIpOnLaunch: true,
          tags: [{ key: 'Name', value: cfg.prefixName(`public-subnet-${s.suffix}`) }],
        }),
      );
    }

    const internetGateway = new ec2.CfnInternetGateway(this, 'InternetGateway', {
      tags: [{ key: 'Name', value: cfg.prefixName('igw') }],
    });
    const gatewayToInternet = new ec2.CfnVPCGatewayAttachment(this, 'GatewayToInternet', {
      vpcId: this.vpc.ref,
      internetGatewayId: internetGateway.ref,
    });

    this.publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: this.vpc.ref,
      tags: [{ key: 'Name', value: cfg.prefixName('PublicRouteTable') }],
    });
    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', {
      routeTableId: this.publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: internetGateway.ref,
    });
    publicRoute.addResourceDependency(gatewayToInternet);

    this.publicSubnets.forEach((subnet, i) => {
      new ec2.CfnSubnetRouteTableAssociation(this, `PublicSubnet${i + 1}RouteTableAssociation`, {
        subnetId: subnet.ref,
        routeTableId: this.publicRouteTable.ref,
      });
    });
  }

  private createPrivateRouting(cfg: Cfg) {
    this.privateRouteTable = gated(
      cfg.hasPrivate,
      () =>
        new ec2.CfnRouteTable(this, 'PrivateRouteTable', {
          vpcId: this.vpc.ref,
          tags: [{ key: 'Name', value: cfg.prefixName('PrivateRouteTable') }],
        }),
    );

    PRIVATE_SUBNET_SPECS.forEach((s, i) => {
      const subnet = gated(
        cfg.hasPrivate,
        () =>
          new ec2.CfnSubnet(this, s.id, {
            vpcId: this.vpc.ref,
            availabilityZone: Fn.select(s.az, Fn.getAzs('')),
            cidrBlock: s.cidr,
            mapPublicIpOnLaunch: false,
            tags: [{ key: 'Name', value: cfg.prefixName(`private-subnet-${s.suffix}`) }],
          }),
      );
      if (!subnet) return;
      this.privateSubnets.push(subnet);
      gated(
        cfg.hasPrivate,
        () =>
          new ec2.CfnSubnetRouteTableAssociation(this, `PrivateSubnet${i + 1}RouteTableAssociation`, {
            subnetId: subnet.ref,
            routeTableId: this.privateRouteTable!.ref,
          }),
      );
    });
  }

  private createNatGateway(cfg: Cfg) {
    const natPublicIp = gated(cfg.useNat, () => new ec2.CfnEIP(this, 'NatPublicIP', { domain: 'vpc' }));
    natPublicIp?.addResourceDependency(this.vpc);

    this.natGateway = gated(
      cfg.useNat,
      () =>
        new ec2.CfnNatGateway(this, 'NatGateway', {
          allocationId: natPublicIp!.attrAllocationId,
          subnetId: this.publicSubnets[0].ref,
          tags: [{ key: 'Name', value: cfg.prefixName('NatGateway') }],
        }),
    );

    // Managed NAT layout only. In custom-routing mode the gateway instance writes
    // this route at boot instead (see the boot script).
    gated(
      cfg.useNat,
      () =>
        new ec2.CfnRoute(this, 'PrivateRoute', {
          routeTableId: this.privateRouteTable!.ref,
          destinationCidrBlock: '0.0.0.0/0',
          natGatewayId: this.natGateway!.ref,
        }),
    );
  }

  private createCustomGateway(cfg: Cfg) {
    this.vpnBucket = gated(
      cfg.useCustom,
      () =>
        new s3.CfnBucket(this, 'CustomGwVpnBucket', {
          bucketEncryption: {
            serverSideEncryptionConfiguration: [{ serverSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
          },
          publicAccessBlockConfiguration: {
            blockPublicAcls: true,
            blockPublicPolicy: true,
            ignorePublicAcls: true,
            restrictPublicBuckets: true,
          },
          tags: [{ key: 'Name', value: cfg.prefixName('custom-gw-vpn') }],
        }),
    );

    // Refuse any non-TLS request to the VPN bucket. The files it holds (the
    // .ovpn profile and credentials.txt) are secrets, so reads must ride HTTPS.
    gated(cfg.useCustom, () => {
      const bucketArn = this.vpnBucket!.attrArn;
      return new s3.CfnBucketPolicy(this, 'CustomGwVpnBucketPolicy', {
        bucket: this.vpnBucket!.ref,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'DenyInsecureTransport',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [bucketArn, Fn.join('', [bucketArn, '/*'])],
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            },
          ],
        },
      });
    });

    // Stack-owned Elastic IP: it outlives instance replacement, and each booting
    // instance re-associates it (see gw-bootstrap.sh) so the VPN tunnel's source
    // IP is stable and a peer-side IP allowlist keeps working across Spot churn.
    this.customGwEip = gated(
      cfg.useCustom,
      () =>
        new ec2.CfnEIP(this, 'CustomGwEip', {
          domain: 'vpc',
          tags: [{ key: 'Name', value: cfg.prefixName('custom-gw-eip') }],
        }),
    );

    const securityGroup = gated(
      cfg.useCustom,
      () =>
        new ec2.CfnSecurityGroup(this, 'CustomGwSecurityGroup', {
          groupDescription: 'Custom routing gateway - allow all traffic from within the VPC',
          vpcId: this.vpc.ref,
          // Forwards private-subnet traffic, so it must accept it. Egress is allow-all
          // by default. No world-facing ingress; manage the box via SSM.
          securityGroupIngress: [{ ipProtocol: '-1', cidrIp: this.vpc.attrCidrBlock }],
          tags: [{ key: 'Name', value: cfg.prefixName('custom-gw-sg') }],
        }),
    );

    const role = gated(cfg.useCustom, () => {
      // Cross-resource refs go through the Fn::Sub variables map so they resolve
      // regardless of logical-ID hashing (standalone clean IDs or module hashed
      // IDs). Computed here so they only dereference when the gateway is built.
      // The ASG name is stack-scoped, so its ARN uses ${AWS::StackName} directly.
      const routeTableArn = Fn.sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:route-table/${rt}', {
        rt: this.privateRouteTable!.ref,
      });
      const bucketObjectsArn = Fn.sub('${arn}/*', { arn: this.vpnBucket!.attrArn });

      return new iam.CfnRole(this, 'CustomGwInstanceRole', {
        assumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: { Service: ['ec2.amazonaws.com'] }, Action: 'sts:AssumeRole' }],
        },
        path: '/',
        // SSM Session Manager access (keyless); egress works once the gateway
        // routes itself out via the public subnet.
        managedPolicyArns: ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'],
        policies: [
          {
            policyName: 'custom-gw',
            policyDocument: {
              Version: '2012-10-17',
              Statement: [
                // Create/re-point the private default route to this instance.
                {
                  Sid: 'ManageDefaultRoute',
                  Effect: 'Allow',
                  Action: ['ec2:CreateRoute', 'ec2:ReplaceRoute'],
                  Resource: routeTableArn,
                },
                // Disable this instance's source/dest check. Scoped by the gateway tag.
                {
                  Sid: 'DisableSourceDestCheck',
                  Effect: 'Allow',
                  Action: 'ec2:ModifyInstanceAttribute',
                  Resource: Fn.sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*'),
                  Condition: { StringEquals: { 'aws:ResourceTag/Name': cfg.prefixName('custom-gw') } },
                },
                // Associate the stack's Elastic IP with this instance at boot so the
                // VPN tunnel egresses from a stable address. AssociateAddress authorizes
                // against the instance, the EIP, and the ENI at once, so all three must
                // be granted. The EIP is scoped to this stack's allocation; a tag
                // condition can't be used here because it would fail on the untagged ENI.
                {
                  Sid: 'AssociateEip',
                  Effect: 'Allow',
                  Action: 'ec2:AssociateAddress',
                  Resource: [
                    Fn.sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:elastic-ip/${id}', {
                      id: this.customGwEip!.attrAllocationId,
                    }),
                    Fn.sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*'),
                    Fn.sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:network-interface/*'),
                  ],
                },
                // EC2 Describe* cannot be resource-scoped, so these must be '*'.
                {
                  Sid: 'DescribeForRouteAndEip',
                  Effect: 'Allow',
                  Action: ['ec2:DescribeRouteTables', 'ec2:DescribeAddresses'],
                  Resource: '*',
                },
                // Watchdog marks this ASG's instance unhealthy. Scoped by the ASG name,
                // which is stack-scoped (matches the AutoScalingGroupName below).
                {
                  Sid: 'WatchdogHealth',
                  Effect: 'Allow',
                  Action: 'autoscaling:SetInstanceHealth',
                  Resource: Fn.sub(
                    'arn:${AWS::Partition}:autoscaling:${AWS::Region}:${AWS::AccountId}:autoScalingGroup:*:autoScalingGroupName/${AWS::StackName}-custom-gw',
                  ),
                },
                // Pull VPN client files from the stack's bucket only.
                {
                  Sid: 'VpnFiles',
                  Effect: 'Allow',
                  Action: ['s3:GetObject', 's3:ListBucket'],
                  Resource: [this.vpnBucket!.attrArn, bucketObjectsArn],
                },
              ],
            },
          },
        ],
      });
    });

    const instanceProfile = gated(
      cfg.useCustom,
      () => new iam.CfnInstanceProfile(this, 'CustomGwInstanceProfile', { path: '/', roles: [role!.ref] }),
    );

    // Boot script is a real .sh file, inlined here. It is an Fn::Sub template.
    // ${AWS::StackId}/${AWS::Region} resolve as pseudo-parameters; the resource
    // refs and the ASG logical id are supplied through the variables map.
    const bootScript = readFileSync(join(__dirname, '..', 'scripts', 'gw-bootstrap.sh'), 'utf8');
    // Lazy so it resolves after the ASG (and any logical-ID rewrite) exists.
    // Use the element's `.logicalId` getter, which honors overrideLogicalId
    // (Stack.getLogicalId returns the pre-override allocated id).
    const asgLogicalId = Lazy.string({ produce: () => this.gatewayAsg!.logicalId });

    const launchTemplate = gated(
      cfg.useCustom,
      () =>
        new ec2.CfnLaunchTemplate(this, 'CustomGwLaunchTemplate', {
          launchTemplateData: {
            // Latest region-appropriate Amazon Linux 2023 AMI, resolved at deploy time.
            imageId: '{{resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64}}',
            instanceType: cfg.gatewayInstanceType,
            securityGroupIds: [securityGroup!.ref],
            iamInstanceProfile: { name: instanceProfile!.ref },
            metadataOptions: { httpTokens: 'required' },
            userData: Fn.base64(
              Fn.sub(bootScript, {
                AsgLogicalId: asgLogicalId,
                PrivateRouteTable: this.privateRouteTable!.ref,
                CustomGwVpnBucket: this.vpnBucket!.ref,
                CustomGwEipAllocId: this.customGwEip!.attrAllocationId,
                VpnEnabled: cfg.vpnEnabled,
              }),
            ),
            tagSpecifications: [
              { resourceType: 'instance', tags: [{ key: 'Name', value: cfg.prefixName('custom-gw') }] },
            ],
          },
        }),
    );

    this.gatewayAsg = gated(cfg.useCustom, () => {
      const asg = new autoscaling.CfnAutoScalingGroup(this, 'CustomGwASG', {
        // Stack-scoped name so the role's WatchdogHealth policy can scope to this
        // ASG without a circular reference, and so instances in different stacks
        // never collide.
        autoScalingGroupName: Fn.sub('${AWS::StackName}-custom-gw'),
        minSize: '1',
        maxSize: '1',
        desiredCapacity: '1',
        // Span all public subnets so Spot can place in whichever AZ has capacity.
        vpcZoneIdentifier: this.publicSubnets.map((s) => s.ref),
        mixedInstancesPolicy: {
          instancesDistribution: {
            onDemandBaseCapacity: 0,
            onDemandPercentageAboveBaseCapacity: cfg.onDemandPercentage,
            spotAllocationStrategy: cfg.spotStrategy,
          },
          launchTemplate: {
            launchTemplateSpecification: {
              launchTemplateId: launchTemplate!.ref,
              version: launchTemplate!.attrLatestVersionNumber,
            },
            overrides: [
              { instanceType: cfg.gatewayInstanceType },
              { instanceType: 't3a.small' },
              { instanceType: 't2.small' },
            ],
          },
        },
        tags: [{ key: 'Name', value: cfg.prefixName('custom-gw'), propagateAtLaunch: true }],
      });
      // Wait for the instance's cfn-signal before CREATE_COMPLETE.
      asg.cfnOptions.creationPolicy = {
        autoScalingCreationPolicy: { minSuccessfulInstancesPercent: 100 },
        resourceSignal: { count: 1, timeout: 'PT15M' },
      };
      asg.cfnOptions.updatePolicy = {
        autoScalingRollingUpdate: {
          maxBatchSize: 1,
          minInstancesInService: 0,
          minSuccessfulInstancesPercent: 100,
          pauseTime: 'PT15M',
          waitOnResourceSignals: true,
        },
      };
      return asg;
    });

    // Optional SSM Session Manager access for private-subnet instances,
    // independent of the gateway. Without these, SSM to a private instance rides
    // the gateway's internet egress, so a down tunnel also means no way in to fix
    // it. Three interface endpoints (ssm, ssmmessages, ec2messages) plus private
    // DNS keep the SSM control path inside the VPC.
    //
    // COST: interface endpoints bill per ENI-hour whether used or not. These sit
    // in ONE private subnet (one AZ), so three ENIs, roughly $22/month plus a
    // little data processing. Off by default (see enableSsmEndpoints); putting
    // them in all three AZs would triple that, and the gateway is a single
    // instance anyway, so one AZ matches the rest of the design.
    const ssmEndpointSg = gated(
      cfg.ssmEndpointsOn,
      () =>
        new ec2.CfnSecurityGroup(this, 'SsmEndpointSecurityGroup', {
          groupDescription: 'HTTPS from the VPC to the SSM interface endpoints',
          vpcId: this.vpc.ref,
          securityGroupIngress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, cidrIp: this.vpc.attrCidrBlock }],
          tags: [{ key: 'Name', value: cfg.prefixName('ssm-endpoint-sg') }],
        }),
    );

    for (const svc of [
      { key: 'ssm', id: 'SsmEndpoint' },
      { key: 'ssmmessages', id: 'SsmMessagesEndpoint' },
      { key: 'ec2messages', id: 'Ec2MessagesEndpoint' },
    ]) {
      const endpoint = gated(
        cfg.ssmEndpointsOn,
        () =>
          new ec2.CfnVPCEndpoint(this, svc.id, {
            vpcId: this.vpc.ref,
            serviceName: Fn.sub(`com.amazonaws.\${AWS::Region}.${svc.key}`),
            vpcEndpointType: 'Interface',
            privateDnsEnabled: true,
            // One AZ only, to keep the per-ENI cost down (see the note above).
            subnetIds: [this.privateSubnets[0].ref],
            securityGroupIds: [ssmEndpointSg!.ref],
          }),
      );
      if (endpoint) this.ssmEndpoints.push(endpoint);
    }
  }

  private createFlowLogs(cfg: Cfg) {
    this.logGroup = gated(
      cfg.flowLogsOn,
      () =>
        // No explicit LogGroupName: CloudFormation auto-generates a unique one, so
        // multiple instances never collide.
        new logs.CfnLogGroup(this, 'LogGroup', { retentionInDays: cfg.retentionInDays }),
    );

    const role = gated(
      cfg.flowLogsOn,
      () =>
        new iam.CfnRole(this, 'Role', {
          assumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Principal: { Service: ['vpc-flow-logs.amazonaws.com'] }, Action: 'sts:AssumeRole' },
            ],
          },
          policies: [
            {
              policyName: 'flowlogs-policy',
              policyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: [
                      'logs:CreateLogStream',
                      'logs:PutLogEvents',
                      'logs:DescribeLogGroups',
                      'logs:DescribeLogStreams',
                    ],
                    Resource: this.logGroup!.attrArn,
                  },
                ],
              },
            },
          ],
        }),
    );

    this.flowLog = gated(
      cfg.flowLogsOn,
      () =>
        new ec2.CfnFlowLog(this, 'FlowLog', {
          deliverLogsPermissionArn: role!.attrArn,
          logGroupName: this.logGroup!.ref,
          resourceId: this.vpc.ref,
          resourceType: 'VPC',
          trafficType: cfg.trafficType,
        }),
    );
  }

  private createOutputs(cfg: Cfg) {
    new CfnOutput(this, 'PubPrivateVPCID', {
      description: 'VPC ID',
      value: this.vpc.ref,
      exportName: Fn.sub('${AWS::StackName}-VPCId'),
    });

    this.privateSubnets.forEach((subnet, i) => {
      gatedOutput(
        cfg.hasPrivate,
        () =>
          new CfnOutput(this, `PrivateSubnet${i + 1}ID`, {
            description: `Private Subnet ${PRIVATE_SUBNET_SPECS[i].suffix} ID`,
            value: subnet.ref,
            exportName: Fn.sub(`\${AWS::StackName}-privateSubnetID${i + 1}`),
          }),
      );
    });

    this.publicSubnets.forEach((subnet, i) => {
      new CfnOutput(this, `PublicSubnet${i + 1}ID`, {
        description: `Public Subnet ${PUBLIC_SUBNET_SPECS[i].suffix} ID`,
        value: subnet.ref,
        exportName: Fn.sub(`\${AWS::StackName}-publicSubnetID${i + 1}`),
      });
    });

    gatedOutput(
      cfg.flowLogsOn,
      () =>
        new CfnOutput(this, 'LogGroupARN', {
          description: 'The name of the CloudWatch Logs log group where the flow logs will be published.',
          value: this.logGroup!.attrArn,
        }),
    );

    gatedOutput(
      cfg.useCustom,
      () =>
        new CfnOutput(this, 'CustomGatewayASGName', {
          description: 'Auto Scaling group name of the custom routing gateway.',
          value: this.gatewayAsg!.ref,
        }),
    );

    gatedOutput(
      cfg.useCustom,
      () =>
        new CfnOutput(this, 'CustomGatewayVpnBucket', {
          description:
            'Bucket the gateway reads VPN client files from. Upload your config here, then wire the TODO block in the gateway UserData.',
          value: this.vpnBucket!.ref,
          exportName: Fn.sub('${AWS::StackName}-customGwVpnBucket'),
        }),
    );

    gatedOutput(
      cfg.useCustom,
      () =>
        new CfnOutput(this, 'CustomGatewayEip', {
          description:
            "The gateway's stable Elastic IP. This is the VPN tunnel's source address; allowlist it on the VPN peer.",
          value: this.customGwEip!.ref,
          exportName: Fn.sub('${AWS::StackName}-customGwEip'),
        }),
    );

    gatedOutput(
      cfg.useCustom,
      () =>
        new CfnOutput(this, 'PrivateRouteTableId', {
          description:
            'Private route table id. Its 0.0.0.0/0 route is managed by the custom gateway instance at boot; handy for confirming the route target.',
          value: this.privateRouteTable!.ref,
          exportName: Fn.sub('${AWS::StackName}-privateRouteTableId'),
        }),
    );
  }
}
