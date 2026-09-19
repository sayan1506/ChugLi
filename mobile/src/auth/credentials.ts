import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { publicConfig } from '@/config/env';
import { getIdentityId } from '@/session/store';

interface CachedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  identityId: string;
  expiration: number;
}

let cachedCredentials: CachedCredentials | null = null;
let credentialsExpiry = 0;

async function getOrCreateIdentityId(client: CognitoIdentityClient): Promise<string> {
  const storedIdentityId = await getIdentityId();

  if (storedIdentityId) {
    return storedIdentityId;
  }

  const { IdentityId } = await client.send(
    new GetIdCommand({
      IdentityPoolId: publicConfig.cognitoIdentityPoolId,
    }),
  );

  if (!IdentityId) {
    throw new Error('Failed to obtain Cognito Identity ID');
  }

  return IdentityId;
}

export async function getCredentials(): Promise<CachedCredentials> {
  const now = Date.now();

  if (cachedCredentials && now < credentialsExpiry - 60000) {
    return cachedCredentials;
  }

  const client = new CognitoIdentityClient({
    region: publicConfig.awsRegion,
  });

  const identityId = await getOrCreateIdentityId(client);

  const { Credentials } = await client.send(
    new GetCredentialsForIdentityCommand({
      IdentityId: identityId,
    }),
  );

  if (
    !Credentials?.AccessKeyId ||
    !Credentials?.SecretKey ||
    !Credentials?.SessionToken
  ) {
    throw new Error('Failed to obtain Cognito credentials');
  }

  const expiry =
    Credentials.Expiration?.getTime() ?? now + 3600000;

  credentialsExpiry = expiry;

  cachedCredentials = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
    identityId,
    expiration: expiry,
  };

  return cachedCredentials;
}

export async function clearCredentials(): Promise<void> {
  cachedCredentials = null;
  credentialsExpiry = 0;
}
