import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';
import { publicConfig } from '@/config/env';
import { getCredentials } from '@/auth/credentials';
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/types';

async function signedFetch(
  uri: RequestInfo | URL,
  options: RequestInit = {}
): Promise<Response> {
  const creds = await getCredentials();

  const url = new URL(
    typeof uri === 'string' ? uri : uri.toString()
  );

  const headers = new Headers(options.headers);
  headers.set('host', url.host);

  const headerRecord: Record<string, string> = {};
  headers.forEach((value, key) => {
    headerRecord[key] = value;
  });

  const body =
    typeof options.body === 'string'
      ? options.body
      : undefined;

  const signer = new SignatureV4({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
    region: publicConfig.awsRegion,
    service: 'appsync',
    sha256: Sha256,
  });

  const request: HttpRequest = {
    method: options.method ?? 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: headerRecord,
    body,
  };

  const signed = await signer.sign(request);

  return fetch(uri, {
    ...options,
    headers: signed.headers as Record<string, string>,
    body,
  });
}

export function createApolloClient(): ApolloClient<unknown> {
  const httpLink = new HttpLink({
    uri: publicConfig.appsyncGraphqlUrl,
    fetch: signedFetch,
  });

  return new ApolloClient({
    link: httpLink,
    cache: new InMemoryCache(),
    defaultOptions: {
      watchQuery: { fetchPolicy: 'cache-and-network' },
      query: { fetchPolicy: 'network-only' },
    },
  });
}

export const apolloClient = createApolloClient();