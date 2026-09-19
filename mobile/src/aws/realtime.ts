import { Sha256 } from '@aws-crypto/sha256-js';
import { SignatureV4 } from '@smithy/signature-v4';
import type { HttpRequest } from '@smithy/types';
import { print } from 'graphql';
import { getCredentials } from '@/auth/credentials';
import { publicConfig } from '@/config/env';
import { ON_CLAN_EVENT_SUBSCRIPTION } from '@/chat/operations';

export interface ClanEvent {
  eventId: string;
  clanId: string;
  messageId: string;
  status: 'APPROVED' | 'PENDING' | 'BLOCKED' | 'HIDDEN';
  revision: number;
  expiresAt: number;
}

interface SubscriptionOptions {
  clanId: string;
  onEvent: (event: ClanEvent) => void;
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export interface ClanSubscriptionController {
  stop: () => void;
  reconnect: () => void;
}

const AUTH_HEADERS = {
  accept: 'application/json, text/javascript',
  'content-encoding': 'amz-1.0',
  'content-type': 'application/json; charset=UTF-8',
};

function requireHeader(headers: Record<string, string>, name: string): string {
  const value = headers[name];
  if (!value) {
    throw new Error(`Missing signed AppSync header: ${name}`);
  }
  return value;
}

function normalizeSignedHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {
    accept: headers.accept ?? AUTH_HEADERS.accept,
    'content-encoding': headers['content-encoding'] ?? AUTH_HEADERS['content-encoding'],
    'content-type': headers['content-type'] ?? AUTH_HEADERS['content-type'],
    host: requireHeader(headers, 'host'),
    'x-amz-date': requireHeader(headers, 'x-amz-date'),
    authorization: requireHeader(headers, 'authorization'),
  };
  const token = headers['x-amz-security-token'];
  if (token) {
    normalized['x-amz-security-token'] = token;
  }
  return normalized;
}

async function signRealtimeRequest(path: string, body: string): Promise<Record<string, string>> {
  const credentials = await getCredentials();
  const graphqlUrl = new URL(publicConfig.appsyncGraphqlUrl);
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    region: publicConfig.awsRegion,
    service: 'appsync',
    sha256: Sha256,
    applyChecksum: false,
  });

  const request: HttpRequest = {
    method: 'POST',
    protocol: 'https:',
    hostname: graphqlUrl.hostname,
    path,
    headers: {
      ...AUTH_HEADERS,
      host: graphqlUrl.host,
    },
    body,
  };
  const signed = await signer.sign(request);
  return normalizeSignedHeaders(signed.headers as Record<string, string>);
}

function realtimeUrl(): string {
  const graphqlUrl = new URL(publicConfig.appsyncGraphqlUrl);
  const realtimeHost = graphqlUrl.hostname.replace('.appsync-api.', '.appsync-realtime-api.');
  return `wss://${realtimeHost}${graphqlUrl.pathname}`;
}

function encodeBase64(value: string): string {
  if (typeof globalThis.btoa === 'function') {
    return globalThis.btoa(value);
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < value.length; index += 3) {
    const a = value.charCodeAt(index);
    const b = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
    const c = index + 2 < value.length ? value.charCodeAt(index + 2) : 0;
    if (a > 0xff || b > 0xff || c > 0xff) {
      throw new Error('AppSync authorization data must be ASCII');
    }

    const triplet = (a << 16) | (b << 8) | c;
    encoded += alphabet.charAt((triplet >> 18) & 0x3f);
    encoded += alphabet.charAt((triplet >> 12) & 0x3f);
    encoded += index + 1 < value.length ? alphabet.charAt((triplet >> 6) & 0x3f) : '=';
    encoded += index + 2 < value.length ? alphabet.charAt(triplet & 0x3f) : '=';
  }
  return encoded;
}

function encodeHeader(value: string): string {
  return encodeURIComponent(encodeBase64(value));
}

function errorFromPayload(payload: unknown): Error {
  if (typeof payload === 'string') {
    return new Error(payload);
  }
  try {
    return new Error(JSON.stringify(payload));
  } catch {
    return new Error('AppSync subscription error');
  }
}

export function subscribeToClanEvents(options: SubscriptionOptions): ClanSubscriptionController {
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let connectionTimeoutMs = 300_000;
  let reconnectAttempt = 0;
  const subscriptionId = `clan-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function resetHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = setTimeout(() => {
      socket?.close();
    }, connectionTimeoutMs + 5_000);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) {
      return;
    }
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
    const delay = base + Math.floor(Math.random() * 500);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function register() {
    const data = JSON.stringify({
      query: print(ON_CLAN_EVENT_SUBSCRIPTION),
      variables: { clanId: options.clanId },
    });
    const authorization = await signRealtimeRequest('/graphql', data);
    if (stopped || socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(
      JSON.stringify({
        id: subscriptionId,
        type: 'start',
        payload: {
          data,
          extensions: { authorization },
        },
      }),
    );
  }

  async function connect() {
    clearTimers();
    if (stopped) {
      return;
    }
    try {
      const authorization = await signRealtimeRequest('/graphql/connect', '{}');
      if (stopped) {
        return;
      }
      const url = `${realtimeUrl()}?header=${encodeHeader(JSON.stringify(authorization))}&payload=${encodeHeader('{}')}`;
      socket = new WebSocket(url, 'graphql-ws');

      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'connection_init' }));
      };

      socket.onmessage = (message) => {
        try {
          const parsed = JSON.parse(String(message.data)) as {
            id?: string;
            type?: string;
            payload?: unknown;
          };
          switch (parsed.type) {
            case 'connection_ack': {
              const payload = parsed.payload as { connectionTimeoutMs?: number } | undefined;
              if (typeof payload?.connectionTimeoutMs === 'number') {
                connectionTimeoutMs = payload.connectionTimeoutMs;
              }
              resetHeartbeat();
              void register().catch((err: unknown) => {
                options.onError?.(err instanceof Error ? err : new Error('Subscription registration failed'));
                socket?.close();
              });
              break;
            }
            case 'ka':
              resetHeartbeat();
              break;
            case 'start_ack':
              reconnectAttempt = 0;
              options.onReady?.();
              break;
            case 'data': {
              const payload = parsed.payload as { data?: { onClanEvent?: ClanEvent | null } } | undefined;
              const event = payload?.data?.onClanEvent;
              if (event) {
                options.onEvent(event);
              }
              break;
            }
            case 'error':
              options.onError?.(errorFromPayload(parsed.payload));
              break;
            default:
              break;
          }
        } catch {
          options.onError?.(new Error('Invalid AppSync real-time message'));
        }
      };

      socket.onerror = (event) => {
        options.onError?.(new Error('AppSync real-time connection error'));
      };

      socket.onclose = (event) => {
        socket = null;
        if (heartbeatTimer) {
          clearTimeout(heartbeatTimer);
          heartbeatTimer = null;
        }
        scheduleReconnect();
      };
    } catch (err) {
      options.onError?.(err instanceof Error ? err : new Error('Unable to connect to AppSync real-time'));
      scheduleReconnect();
    }
  }

  void connect();

  return {
    stop() {
      stopped = true;
      clearTimers();
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stop', id: subscriptionId }));
      }
      socket?.close();
      socket = null;
    },
    reconnect() {
      if (stopped) {
        return;
      }
      clearTimers();
      socket?.close();
      socket = null;
      void connect();
    },
  };
}
