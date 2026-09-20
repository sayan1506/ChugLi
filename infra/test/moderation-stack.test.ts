import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ChugLiStack } from '../lib/chugli-stack';

type PolicyStatement = {
  Action?: string | string[];
  Resource?: unknown;
};

type PolicyResource = {
  Properties?: {
    PolicyDocument?: {
      Statement?: PolicyStatement[];
    };
  };
};

function policyStatements(template: Template): PolicyStatement[] {
  const policies = template.findResources('AWS::IAM::Policy') as Record<string, PolicyResource>;
  return Object.values(policies).flatMap(
    (policy) => policy.Properties?.PolicyDocument?.Statement ?? [],
  );
}

function hasAction(statement: PolicyStatement, action: string): boolean {
  const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
  return actions.some((value) => value === action);
}

describe('Phase 5 infrastructure', () => {
  it('creates the moderation/report/mute resolvers and grants Bedrock only to backend execution by default', () => {
    const app = new App();
    const stack = new ChugLiStack(app, 'ModerationStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Mutation',
      FieldName: 'reportMessage',
    });
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Mutation',
      FieldName: 'retryMessageReview',
    });
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Mutation',
      FieldName: 'muteMember',
    });
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Mutation',
      FieldName: 'leaveClan',
    });

    const statements = policyStatements(template);
    expect(statements.some((statement) => hasAction(statement, 'bedrock:InvokeModel'))).toBe(true);
  });

  it('removes Bedrock invocation permission when the AI review pause switch is disabled', () => {
    const app = new App();
    app.node.setContext('aiReviewEnabled', false);
    const stack = new ChugLiStack(app, 'ModerationPausedStack');
    const template = Template.fromStack(stack);

    const statements = policyStatements(template);
    expect(statements.some((statement) => hasAction(statement, 'bedrock:InvokeModel'))).toBe(false);

    template.hasOutput('AiReviewEnabled', { Value: 'false' });
  });
});
