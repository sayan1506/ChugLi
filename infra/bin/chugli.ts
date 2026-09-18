import { App } from 'aws-cdk-lib';
import { ChugLiStack } from '../lib/chugli-stack';

const app = new App();
new ChugLiStack(app, 'ChugLi', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
