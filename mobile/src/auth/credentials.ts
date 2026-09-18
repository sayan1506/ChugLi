import { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } from '@aws-sdk/client-cognito-identity';
import { publicConfig } from '@/config/env';

interface CachedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  identityId: string;
  expiration: number;
}

let cachedCredentials: CachedCredentials | null = null;
let credentialsExpiry = 0;

export async function getCredentials(): Promise<CachedCredentials> {
  const now = Date.now();
  if (cachedCredentials && now < credentialsExpiry - 60000) {
    return cachedCredentials;
  }

  const client = new CognitoIdentityClient({ region: publicConfig.awsRegion });

  const getIdCmd = new GetIdCommand({
    IdentityPoolId: publicConfig.cognitoIdentityPoolId,
  });
  const { IdentityId } = await client.send(getIdCmd);

  if (!IdentityId) {
    throw new Error('Failed to obtain Cognito Identity ID');
  }

  const getCredsCmd = new GetCredentialsForIdentityCommand({
    IdentityId,
  });
  const { Credentials } = await client.send(getCredsCmd);

  if (!Credentials?.AccessKeyId || !Credentials?.SecretKey || !Credentials?.SessionToken) {
    throw new Error('Failed to obtain Cognito credentials');
  }

  const expiry = Credentials.Expiration?.getTime() ?? now + 3600000;
  credentialsExpiry = expiry;

  cachedCredentials = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
    identityId: IdentityId,
    expiration: expiry,
  };

  return cachedCredentials;
}

export async function clearCredentials(): Promise<void> {
  cachedCredentials = null;
  credentialsExpiry = 0;
}
