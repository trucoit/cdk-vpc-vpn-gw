import { CfnElement, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { VpcPublicPrivateSetup } from './vpc-public-private-setup';

/**
 * Standalone stack that produces the deployable, parametric template.
 *
 * It instantiates the construct with no config props (parameter mode) and then
 * rewrites the hashed logical IDs (introduced by nesting under the construct)
 * back to their bare construct id, for a clean, readable, deploy-anywhere
 * template. This ID rewrite lives here on purpose: a `Stack` is never embedded
 * in another stack, so a module consumer cannot trigger it and hit an ID
 * collision.
 */
export class VpcPublicPrivateSetupStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.templateOptions.templateFormatVersion = '2010-09-09';

    new VpcPublicPrivateSetup(this, 'VpcPublicPrivateSetup');

    for (const child of this.node.findAll()) {
      if (CfnElement.isCfnElement(child)) {
        child.overrideLogicalId(child.node.id);
      }
    }
  }
}
