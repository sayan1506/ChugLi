interface PublicConfig {
  appsyncGraphqlUrl: string;
  awsRegion: string;
  cognitoIdentityPoolId: string;
  appsyncApiId: string;
  devMode: boolean;
}

function requireEnv(value: string | undefined, key: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function getPublicConfig(): PublicConfig {
  return {
    appsyncGraphqlUrl: requireEnv(
      process.env.EXPO_PUBLIC_APPSYNC_GRAPHQL_URL,
      'EXPO_PUBLIC_APPSYNC_GRAPHQL_URL'
    ),
    awsRegion: requireEnv(
      process.env.EXPO_PUBLIC_AWS_REGION,
      'EXPO_PUBLIC_AWS_REGION'
    ),
    cognitoIdentityPoolId: requireEnv(
      process.env.EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID,
      'EXPO_PUBLIC_COGNITO_IDENTITY_POOL_ID'
    ),
    appsyncApiId: requireEnv(
      process.env.EXPO_PUBLIC_APPSYNC_API_ID,
      'EXPO_PUBLIC_APPSYNC_API_ID'
    ),
    devMode:
      requireEnv(
        process.env.EXPO_PUBLIC_DEV_MODE,
        'EXPO_PUBLIC_DEV_MODE'
      ) === 'true',
  };
}

export const publicConfig = getPublicConfig();
