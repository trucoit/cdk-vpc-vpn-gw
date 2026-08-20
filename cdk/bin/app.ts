#!/usr/bin/env node
import { App, CliCredentialsStackSynthesizer } from 'aws-cdk-lib';
import { VpcPublicPrivateSetupStack } from '../lib/vpc-public-private-setup-stack';

const app = new App();

// One stack, one synthesized template. The stack id becomes both the CDK stack
// name and the synthesized template file name (see the Makefile `synth` target).
new VpcPublicPrivateSetupStack(app, 'VpcPublicPrivateSetup', {
  // CliCredentialsStackSynthesizer deploys with the caller's CLI credentials and
  // emits no bootstrap-version parameter or CheckBootstrapVersion rule, so the
  // synthesized template needs no `cdk bootstrap` and deploys with plain
  // `aws cloudformation deploy` as well as `cdk deploy`.
  synthesizer: new CliCredentialsStackSynthesizer(),
  // Drop the CDKMetadata resource so the output is free of CDK-specific scaffolding.
  analyticsReporting: false,
  // Matches the original template's top-level Description.
  description:
    'VPC with public and (optionally) private subnets. NetworkMode selects one of ' +
    'three layouts: PublicOnly, PublicPrivate (managed NAT gateway), or ' +
    'PublicPrivateCustomRouting (a self-healing EC2 Spot gateway that routes all ' +
    'private-subnet egress - a VPN client can be layered on top).',
});

app.synth();
