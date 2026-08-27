import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { VpcPublicPrivateSetup } from '../lib/vpc-public-private-setup';
import { VpcPublicPrivateSetupStack } from '../lib/vpc-public-private-setup-stack';

describe('standalone stack (parametric path)', () => {
  const app = new App();
  const stack = new VpcPublicPrivateSetupStack(app, 'Standalone');
  const json = Template.fromStack(stack).toJSON();

  test('exposes the deploy-time parameters', () => {
    expect(Object.keys(json.Parameters ?? {})).toEqual(
      expect.arrayContaining([
        'NetworkMode',
        'ResourcesPrefixName',
        'RetentionInDays',
        'TrafficType',
        'EnableFlowLogs',
        'GatewayInstanceType',
        'GatewayCapacityMode',
        'EnableVpn',
        'EnableSsmEndpoints',
      ]),
    );
  });

  test('keeps the conditions', () => {
    expect(Object.keys(json.Conditions ?? {})).toEqual(
      expect.arrayContaining(['HasPrivateSubnets', 'UseNatGateway', 'UseCustomGateway', 'EnableFlowLogsCondition']),
    );
  });

  test('uses unhashed logical IDs', () => {
    expect(json.Resources.PubPrivateVPC).toBeDefined();
    expect(json.Resources.PrivateRouteTable).toBeDefined();
    expect(json.Resources.CustomGwASG).toBeDefined();
  });
});

describe('module use with props (PublicPrivate)', () => {
  const app = new App();
  const stack = new Stack(app, 'Consumer');
  new VpcPublicPrivateSetup(stack, 'Net', { networkMode: 'PublicPrivate' });
  const template = Template.fromStack(stack);
  const json = template.toJSON();

  test('injects none of its own parameters or conditions', () => {
    // The consumer stack may carry a synthesizer BootstrapVersion parameter; what
    // matters is that the construct adds none of ITS parameters/conditions.
    const params = Object.keys(json.Parameters ?? {});
    const conditions = Object.keys(json.Conditions ?? {});
    for (const p of [
      'NetworkMode',
      'ResourcesPrefixName',
      'RetentionInDays',
      'TrafficType',
      'EnableFlowLogs',
      'GatewayInstanceType',
      'GatewayCapacityMode',
      'EnableVpn',
      'EnableSsmEndpoints',
    ]) {
      expect(params).not.toContain(p);
    }
    for (const c of ['HasPrivateSubnets', 'UseNatGateway', 'UseCustomGateway', 'EnableFlowLogsCondition']) {
      expect(conditions).not.toContain(c);
    }
  });

  test('builds only the selected layout', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::Subnet', 6);
    template.resourceCountIs('AWS::S3::Bucket', 0); // custom-gateway block absent
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 0);
  });

  test('uses hashed logical IDs (not the bare construct id)', () => {
    expect(json.Resources.PubPrivateVPC).toBeUndefined();
    expect(Object.keys(json.Resources).some((k) => /^Net.*VPC/.test(k))).toBe(true);
  });
});

describe('module use with props (PublicOnly prunes private tier)', () => {
  const app = new App();
  const stack = new Stack(app, 'PublicOnly');
  new VpcPublicPrivateSetup(stack, 'Net', { networkMode: 'PublicOnly' });
  const template = Template.fromStack(stack);

  test('has only public subnets and no NAT', () => {
    template.resourceCountIs('AWS::EC2::Subnet', 3);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
  });
});

describe('custom gateway (PublicPrivateCustomRouting)', () => {
  const app = new App();
  const stack = new Stack(app, 'CustomGw');
  new VpcPublicPrivateSetup(stack, 'Net', { networkMode: 'PublicPrivateCustomRouting' });
  const template = Template.fromStack(stack);
  const raw = JSON.stringify(template.toJSON());

  test('allocates a stable Elastic IP for the gateway', () => {
    template.resourceCountIs('AWS::EC2::EIP', 1);
  });

  test('boot script is fail-closed and drives OpenVPN', () => {
    // Guard against silent regression of the kill switch / tunnel wiring in UserData.
    expect(raw).toContain('iptables -P FORWARD DROP');
    expect(raw).toContain('openvpn-client@tun-vpn');
    expect(raw).toContain('rp_filter');
    expect(raw).toContain('associate-address');
  });

  test('runs the gateway in VPN mode by default', () => {
    // The boot script branches on this Fn::Sub variable.
    expect(raw).toContain('"VpnEnabled":"true"');
  });

  test('creates no SSM endpoints by default (cost opt-in)', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 0);
  });
});

describe('custom gateway as a plain NAT instance (enableVpn false)', () => {
  const app = new App();
  const stack = new Stack(app, 'CustomGwNat');
  new VpcPublicPrivateSetup(stack, 'Net', {
    networkMode: 'PublicPrivateCustomRouting',
    enableVpn: false,
  });
  const template = Template.fromStack(stack);
  const raw = JSON.stringify(template.toJSON());

  test('binds VpnEnabled false so the boot script takes the NAT branch', () => {
    expect(raw).toContain('"VpnEnabled":"false"');
  });

  test('boot script still carries the NAT-instance firewall branch', () => {
    // NOT fail-closed: forwards out the LAN NIC. Both branches live in the script;
    // the VpnEnabled flag picks one at boot.
    expect(raw).toContain('Plain NAT instance (NOT fail-closed)');
  });

  test('keeps the same resource graph as VPN mode (bucket and EIP still built)', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::EC2::EIP', 1);
    template.resourceCountIs('AWS::AutoScaling::AutoScalingGroup', 1);
  });
});

describe('custom gateway with SSM endpoints enabled', () => {
  const app = new App();
  const stack = new Stack(app, 'CustomGwSsm');
  new VpcPublicPrivateSetup(stack, 'Net', {
    networkMode: 'PublicPrivateCustomRouting',
    enableSsmEndpoints: true,
  });
  const template = Template.fromStack(stack);

  test('adds the three SSM interface endpoints in a single AZ', () => {
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 3);
    // Each endpoint sits in exactly one subnet to keep the per-ENI cost down.
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      PrivateDnsEnabled: true,
      SubnetIds: [{ Ref: Match.anyValue() }],
    });
  });
});

describe('multiple instances in one stack', () => {
  const app = new App();
  const stack = new Stack(app, 'Multi');
  new VpcPublicPrivateSetup(stack, 'NetA', { networkMode: 'PublicPrivate', resourcesPrefixName: 'a' });
  new VpcPublicPrivateSetup(stack, 'NetB', { networkMode: 'PublicPrivate', resourcesPrefixName: 'b' });

  test('synthesizes without logical-ID collision', () => {
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::EC2::VPC', 2);
  });
});
