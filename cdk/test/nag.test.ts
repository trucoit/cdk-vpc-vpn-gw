import { App, Aspects, Stack } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { VpcPublicPrivateSetup, VpcPublicPrivateSetupStack } from '../lib';

// Suppressions for the things this stack does on purpose. Each entry names the
// rule and why the finding is accepted rather than fixed. Applied by resource
// path so the same set works for the parametric stack and the props-mode stack
// (both share the construct's child ids).
function applySuppressions(stack: Stack, base: string) {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `${base}/CustomGwInstanceRole`,
    [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AmazonSSMManagedInstanceCore is the standard keyless-access path for Session Manager. The gateway has no inbound ports; SSM is the only way in.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'ec2:DescribeRouteTables and ec2:DescribeAddresses cannot be resource-scoped by AWS, so they require "*". ModifyInstanceAttribute and AssociateAddress use instance/network-interface/* because the instance id is not known at deploy time; they are constrained by a gateway-tag condition and the stack-owned EIP allocation.',
      },
    ],
    true,
  );

  NagSuppressions.addResourceSuppressionsByPath(stack, `${base}/CustomGwVpnBucket`, [
    {
      id: 'AwsSolutions-S1',
      reason:
        'Single-purpose private bucket holding VPN client files, already SSE-encrypted with all public access blocked. A dedicated server-access-log bucket is out of scope for this template.',
    },
  ]);

  NagSuppressions.addResourceSuppressionsByPath(stack, `${base}/CustomGwASG`, [
    {
      id: 'AwsSolutions-AS3',
      reason:
        'Scaling-event notifications are out of scope for this template. The instance-level health watchdog (gw-bootstrap.sh) already marks a broken gateway unhealthy so the size-1 group replaces it.',
    },
  ]);
}

describe('cdk-nag AwsSolutions', () => {
  function nagErrors(stack: Stack): string[] {
    Aspects.of(stack).add(new AwsSolutionsChecks({ verbose: true }));
    const results = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*'));
    return results.map((r) => JSON.stringify(r.entry.data));
  }

  test('parametric standalone stack has no unsuppressed findings', () => {
    const app = new App();
    const stack = new VpcPublicPrivateSetupStack(app, 'Nag');
    applySuppressions(stack, 'Nag/VpcPublicPrivateSetup');
    expect(nagErrors(stack)).toHaveLength(0);
  });

  test('props-mode custom-routing stack (all features on) has no unsuppressed findings', () => {
    const app = new App();
    const stack = new Stack(app, 'NagProps');
    new VpcPublicPrivateSetup(stack, 'Network', {
      networkMode: 'PublicPrivateCustomRouting',
      enableSsmEndpoints: true,
      enableFlowLogs: true,
    });
    applySuppressions(stack, 'NagProps/Network');
    expect(nagErrors(stack)).toHaveLength(0);
  });
});
