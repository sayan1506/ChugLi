#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CdkOutputs {
  GraphqlUrl: string;
  Region: string;
  IdentityPoolId: string;
  GuestRoleArn: string;
  ApiId: string;
}

function runCommand(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch (err) {
    throw new Error(`Command failed: ${cmd}\n${err}`);
  }
}

function getCdkOutputs(): CdkOutputs {
  const stackName = 'ChugLi';
  const outputs = runCommand(
    `aws cloudformation describe-stacks --stack-name ${stackName} --query 'Stacks[0].Outputs' --output json --profile chugli --region us-east-1`,
    __dirname
  );
  const parsed = JSON.parse(outputs);
  const result: Record<string, string> = {};
  for (const o of parsed) {
    result[o.OutputKey] = o.OutputValue;
  }
  return result as CdkOutputs;
}

function main() {
  const mobileDir = resolve(__dirname, 'mobile');
  const envPath = resolve(mobileDir, '.env');

  let outputs: CdkOutputs;
  try {
    outputs = getCdkOutputs();
  } catch {
    console.warn('Could not fetch CDK outputs from AWS. Using local synth output.');
    const synthOutput = runCommand('npx cdk synth --json', resolve(__dirname, 'infra'));
    const synth = JSON.parse(synthOutput);
    const stack = synth[Object.keys(synth)[0]];
    const stackOutputs = stack?.Outputs || {};
    outputs = {
      GraphqlUrl: stackOutputs.GraphqlUrl?.Value || '',
      Region: stackOutputs.Region?.Value || 'us-east-1',
      IdentityPoolId: stackOutputs.IdentityPoolId?.Value || '',
      GuestRoleArn: stackOutputs.GuestRoleArn?.Value || '',
      ApiId: stackOutputs.ApiId?.Value || '',
    };
  }

  if (!outputs.GraphqlUrl || !outputs.IdentityPoolId) {
    throw new Error('Missing required CDK outputs. Deploy the stack first.');
  }

  const envContent = `# ChugLi Mobile - Public Configuration
# Generated from CDK outputs on ${new Date().toISOString()}
# DO NOT EDIT MANUALLY - run sync-config.ts instead

EXPO_PUBLIC_APPSYNC_GRAPHQL_URL=${outputs.GraphqlUrl}
EXPO_PUBLIC_AWS_REGION=${outputs.Region}
EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID=${outputs.IdentityPoolId}
EXPO_PUBLIC_APPSYNC_API_ID=${outputs.ApiId}
EXPO_PUBLIC_DEV_MODE=true
`;

  if (!existsSync(mobileDir)) {
    mkdirSync(mobileDir, { recursive: true });
  }

  writeFileSync(envPath, envContent);
  console.log('✓ Mobile config synced to mobile/.env');
  console.log(`  GraphQL URL: ${outputs.GraphqlUrl}`);
  console.log(`  Region: ${outputs.Region}`);
  console.log(`  Identity Pool: ${outputs.IdentityPoolId}`);
  console.log(`  API ID: ${outputs.ApiId}`);
}

main();