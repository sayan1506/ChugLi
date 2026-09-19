import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import { clearCredentials } from '@/auth/credentials';
import { apolloClient } from '@/aws/clients';
import { subscribeToClanEvents, type ClanEvent, type ClanSubscriptionController } from '@/aws/realtime';
import {
  createServerTimeAnchor,
  estimateServerNow,
  isExpiredClanError,
  remainingClanSeconds,
  type ServerTimeAnchor,
} from '@/clan/expiry';
import { GET_CLAN_QUERY } from '@/clan/operations';
import type { Clan } from '@/clan/types';
import { GET_MESSAGE_QUERY, LIST_MESSAGES_QUERY, SEND_MESSAGE_MUTATION } from '@/chat/operations';
import type { ChatMessage, MessagePage } from '@/chat/types';

interface SendResult {
  messageId: string;
  status: ChatMessage['status'];
  revision: number;
  expiresAt: number;
  serverNow: number;
}

interface PendingSend {
  text: string;
  requestId: string;
}

export type RealtimeState = 'connecting' | 'connected' | 'offline';

function monotonicNowMs(): number {
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const item of current) {
    byId.set(item.messageId, item);
  }
  for (const item of incoming) {
    const existing = byId.get(item.messageId);
    if (!existing || item.revision >= existing.revision) {
      byId.set(item.messageId, item);
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt - b.createdAt;
    }
    return a.messageId.localeCompare(b.messageId);
  });
}

export function useClanChat(clanId: string) {
  const [clan, setClan] = useState<Clan | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>('offline');
  const [expired, setExpired] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  const subscriptionRef = useRef<ClanSubscriptionController | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const pendingSendRef = useRef<PendingSend | null>(null);
  const mountedRef = useRef(true);
  const expiredRef = useRef(false);
  const serverClockRef = useRef<ServerTimeAnchor | null>(null);

  const stopSubscription = useCallback(() => {
    subscriptionRef.current?.stop();
    subscriptionRef.current = null;
    if (mountedRef.current) {
      setRealtimeState('offline');
    }
  }, []);

  const expireClan = useCallback(() => {
    expiredRef.current = true;
    serverClockRef.current = null;
    pendingSendRef.current = null;
    subscriptionRef.current?.stop();
    subscriptionRef.current = null;

    if (!mountedRef.current) {
      return;
    }

    setExpired(true);
    setRemainingSeconds(0);
    setMessages([]);
    setNextToken(null);
    setLoadingMore(false);
    setSending(false);
    setRealtimeState('offline');
    setError(null);
  }, []);

  const syncServerClock = useCallback((expiresAt: number, serverNow: number): boolean => {
    const anchor = createServerTimeAnchor(serverNow, monotonicNowMs());
    serverClockRef.current = anchor;
    const remaining = remainingClanSeconds(expiresAt, serverNow);

    if (!mountedRef.current) {
      return remaining > 0;
    }

    setRemainingSeconds(remaining);
    if (remaining <= 0) {
      expireClan();
      return false;
    }

    expiredRef.current = false;
    setExpired(false);
    return true;
  }, [expireClan]);

  const fetchMessage = useCallback(async (messageId: string): Promise<ChatMessage | null> => {
    try {
      const { data } = await apolloClient.query<{ getMessage: ChatMessage }>({
        query: GET_MESSAGE_QUERY,
        variables: { clanId, messageId },
        fetchPolicy: 'network-only',
      });
      return data.getMessage ?? null;
    } catch (err) {
      if (isExpiredClanError(err)) {
        expireClan();
      }
      return null;
    }
  }, [clanId, expireClan]);

  const reconcile = useCallback(async (): Promise<boolean> => {
    try {
      const [clanResult, messagesResult] = await Promise.all([
        apolloClient.query<{ getClan: Clan }>({
          query: GET_CLAN_QUERY,
          variables: { clanId },
          fetchPolicy: 'network-only',
        }),
        apolloClient.query<{ listMessages: MessagePage }>({
          query: LIST_MESSAGES_QUERY,
          variables: { clanId, nextToken: null },
          fetchPolicy: 'network-only',
        }),
      ]);

      if (!mountedRef.current) {
        return false;
      }

      const nextClan = clanResult.data.getClan;
      const nextPage = messagesResult.data.listMessages;
      const serverNow = Math.max(nextClan.serverNow, nextPage.serverNow);
      setClan(nextClan);

      if (!syncServerClock(nextClan.expiresAt, serverNow)) {
        return false;
      }

      setMessages((current) => mergeMessages(current, nextPage.items));
      setNextToken(nextPage.nextToken);
      setError(null);
      return true;
    } catch (err) {
      if (isExpiredClanError(err)) {
        expireClan();
        return false;
      }
      throw err;
    }
  }, [clanId, expireClan, syncServerClock]);

  const handleEvent = useCallback(async (event: ClanEvent) => {
    if (event.clanId !== clanId || expiredRef.current) {
      return;
    }
    if (event.status === 'APPROVED') {
      const message = await fetchMessage(event.messageId);
      if (message && mountedRef.current && !expiredRef.current) {
        setMessages((current) => mergeMessages(current, [message]));
      }
      return;
    }

    if (event.status === 'HIDDEN' || event.status === 'BLOCKED') {
      setMessages((current) =>
        current.map((message) =>
          message.messageId === event.messageId && event.revision >= message.revision
            ? { ...message, text: null, status: event.status, revision: event.revision }
            : message,
        ),
      );
    }
  }, [clanId, fetchMessage]);

  const startSubscription = useCallback(() => {
    if (!clanId || expiredRef.current || appStateRef.current !== 'active') {
      return;
    }

    subscriptionRef.current?.stop();
    setRealtimeState('connecting');
    subscriptionRef.current = subscribeToClanEvents({
      clanId,
      onReady: () => {
        if (!mountedRef.current || expiredRef.current) {
          return;
        }
        setRealtimeState('connected');
        void reconcile().catch((err: unknown) => {
          if (mountedRef.current && !expiredRef.current) {
            setError(err instanceof Error ? err.message : 'Failed to refresh chat');
          }
        });
      },
      onEvent: (event) => {
        void handleEvent(event);
      },
      onError: (err) => {
        if (isExpiredClanError(err)) {
          expireClan();
          return;
        }
        if (mountedRef.current && !expiredRef.current) {
          setRealtimeState('offline');
          setError(err.message);
        }
      },
    });
  }, [clanId, expireClan, handleEvent, reconcile]);

  useEffect(() => {
    mountedRef.current = true;
    appStateRef.current = AppState.currentState;
    expiredRef.current = false;
    serverClockRef.current = null;
    setClan(null);
    setMessages([]);
    setNextToken(null);
    setExpired(false);
    setRemainingSeconds(null);
    setRealtimeState('offline');
    setLoading(Boolean(clanId));
    setError(null);

    if (!clanId) {
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }

    void (async () => {
      try {
        const active = await reconcile();
        if (active && appStateRef.current === 'active') {
          startSubscription();
        }
      } catch (err) {
        if (mountedRef.current && !expiredRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load clan');
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    })();

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      const previous = appStateRef.current;
      appStateRef.current = nextState;

      if (nextState === 'active' && previous !== 'active') {
        void (async () => {
          try {
            // Force a fresh Cognito credential fetch after suspension. The HTTP
            // reconciliation request obtains them first; the restored realtime
            // subscription then reuses the refreshed temporary credentials.
            await clearCredentials();
            const active = await reconcile();
            if (active) {
              startSubscription();
            }
          } catch (err) {
            if (mountedRef.current && !expiredRef.current) {
              setError(err instanceof Error ? err.message : 'Failed to refresh chat');
            }
          }
        })();
      } else if (nextState !== 'active') {
        stopSubscription();
      }
    });

    const reconcileInterval = setInterval(() => {
      if (appStateRef.current === 'active' && !expiredRef.current) {
        void reconcile().catch(() => {
          // Subscription events are the fast path; resume or the next interval retries.
        });
      }
    }, 30_000);

    return () => {
      mountedRef.current = false;
      appStateSubscription.remove();
      clearInterval(reconcileInterval);
      subscriptionRef.current?.stop();
      subscriptionRef.current = null;
      pendingSendRef.current = null;
      serverClockRef.current = null;
    };
  }, [clanId, reconcile, startSubscription, stopSubscription]);

  useEffect(() => {
    if (!clan || expired) {
      return;
    }

    const updateCountdown = () => {
      const anchor = serverClockRef.current;
      if (!anchor || expiredRef.current) {
        return;
      }
      const serverNow = estimateServerNow(anchor, monotonicNowMs());
      const remaining = remainingClanSeconds(clan.expiresAt, serverNow);
      setRemainingSeconds(remaining);
      if (remaining <= 0) {
        expireClan();
      }
    };

    updateCountdown();
    const countdownInterval = setInterval(updateCountdown, 1000);
    return () => clearInterval(countdownInterval);
  }, [clan, expired, expireClan]);

  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore || expiredRef.current) {
      return;
    }
    setLoadingMore(true);
    try {
      const { data } = await apolloClient.query<{ listMessages: MessagePage }>({
        query: LIST_MESSAGES_QUERY,
        variables: { clanId, nextToken },
        fetchPolicy: 'network-only',
      });
      if (mountedRef.current && !expiredRef.current) {
        const page = data.listMessages;
        setMessages((current) => mergeMessages(current, page.items));
        setNextToken(page.nextToken);
        if (clan) {
          syncServerClock(clan.expiresAt, page.serverNow);
        }
      }
    } catch (err) {
      if (isExpiredClanError(err)) {
        expireClan();
      } else if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load older messages');
      }
    } finally {
      if (mountedRef.current) {
        setLoadingMore(false);
      }
    }
  }, [clan, clanId, expireClan, loadingMore, nextToken, syncServerClock]);

  const sendMessage = useCallback(async (rawText: string) => {
    if (expiredRef.current) {
      throw new Error('Clan has expired');
    }

    const text = rawText.trim();
    if (!text) {
      throw new Error('Message cannot be empty');
    }
    if (Array.from(text).length > 500) {
      throw new Error('Message must be 500 characters or fewer');
    }

    const existing = pendingSendRef.current;
    const pending = existing?.text === text ? existing : { text, requestId: uuidv4() };
    pendingSendRef.current = pending;
    setSending(true);
    setError(null);

    try {
      const { data } = await apolloClient.mutate<{ sendMessage: SendResult }>({
        mutation: SEND_MESSAGE_MUTATION,
        variables: { clanId, requestId: pending.requestId, text },
        fetchPolicy: 'network-only',
      });
      const result = data?.sendMessage;
      if (!result) {
        throw new Error('No send result returned');
      }
      pendingSendRef.current = null;
      if (clan) {
        syncServerClock(clan.expiresAt, result.serverNow);
      }
      const committed = await fetchMessage(result.messageId);
      if (committed && mountedRef.current && !expiredRef.current) {
        setMessages((current) => mergeMessages(current, [committed]));
      }
      return result;
    } catch (err) {
      if (isExpiredClanError(err)) {
        expireClan();
      } else {
        const message = err instanceof Error ? err.message : 'Failed to send message';
        if (mountedRef.current) {
          setError(message);
        }
      }
      throw err;
    } finally {
      if (mountedRef.current) {
        setSending(false);
      }
    }
  }, [clan, clanId, expireClan, fetchMessage, syncServerClock]);

  const retry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await clearCredentials();
      const active = await reconcile();
      if (active) {
        startSubscription();
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [reconcile, startSubscription]);

  return {
    clan,
    messages,
    nextToken,
    loading,
    loadingMore,
    sending,
    error,
    realtimeState,
    expired,
    remainingSeconds,
    sendMessage,
    loadMore,
    retry,
    reconcile,
  };
}
