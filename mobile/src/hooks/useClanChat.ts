import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { v4 as uuidv4 } from 'uuid';
import { apolloClient } from '@/aws/clients';
import { subscribeToClanEvents, type ClanEvent, type ClanSubscriptionController } from '@/aws/realtime';
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
  const [realtimeState, setRealtimeState] = useState<RealtimeState>('connecting');
  const subscriptionRef = useRef<ClanSubscriptionController | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const pendingSendRef = useRef<PendingSend | null>(null);
  const mountedRef = useRef(true);

  const fetchMessage = useCallback(async (messageId: string): Promise<ChatMessage | null> => {
    try {
      const { data } = await apolloClient.query<{ getMessage: ChatMessage }>({
        query: GET_MESSAGE_QUERY,
        variables: { clanId, messageId },
        fetchPolicy: 'network-only',
      });
      return data.getMessage ?? null;
    } catch {
      return null;
    }
  }, [clanId]);

  const reconcile = useCallback(async () => {
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
      return;
    }
    setClan(clanResult.data.getClan);
    setMessages((current) => mergeMessages(current, messagesResult.data.listMessages.items));
    setNextToken(messagesResult.data.listMessages.nextToken);
    setError(null);
  }, [clanId]);

  const handleEvent = useCallback(async (event: ClanEvent) => {
    if (event.clanId !== clanId) {
      return;
    }
    if (event.status === 'APPROVED') {
      const message = await fetchMessage(event.messageId);
      if (message && mountedRef.current) {
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
    subscriptionRef.current?.stop();
    setRealtimeState('connecting');
    subscriptionRef.current = subscribeToClanEvents({
      clanId,
      onReady: () => {
        if (!mountedRef.current) {
          return;
        }
        setRealtimeState('connected');
        void reconcile().catch((err: unknown) => {
          if (mountedRef.current) {
            setError(err instanceof Error ? err.message : 'Failed to refresh chat');
          }
        });
      },
      onEvent: (event) => {
        void handleEvent(event);
      },
      onError: (err) => {
        if (mountedRef.current) {
          setRealtimeState('offline');
          setError(err.message);
        }
      },
    });
  }, [clanId, handleEvent, reconcile]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    setError(null);
    startSubscription();
    void reconcile()
      .catch((err: unknown) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to load clan');
        }
      })
      .finally(() => {
        if (mountedRef.current) {
          setLoading(false);
        }
      });

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      const previous = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === 'active' && previous !== 'active') {
        startSubscription();
        void reconcile().catch((err: unknown) => {
          if (mountedRef.current) {
            setError(err instanceof Error ? err.message : 'Failed to refresh chat');
          }
        });
      } else if (nextState !== 'active') {
        subscriptionRef.current?.stop();
        subscriptionRef.current = null;
        setRealtimeState('offline');
      }
    });

    const interval = setInterval(() => {
      if (appStateRef.current === 'active') {
        void reconcile().catch(() => {
          // Subscription events are the fast path; the next interval or resume retries.
        });
      }
    }, 30_000);

    return () => {
      mountedRef.current = false;
      appStateSubscription.remove();
      clearInterval(interval);
      subscriptionRef.current?.stop();
      subscriptionRef.current = null;
    };
  }, [reconcile, startSubscription]);

  const loadMore = useCallback(async () => {
    if (!nextToken || loadingMore) {
      return;
    }
    setLoadingMore(true);
    try {
      const { data } = await apolloClient.query<{ listMessages: MessagePage }>({
        query: LIST_MESSAGES_QUERY,
        variables: { clanId, nextToken },
        fetchPolicy: 'network-only',
      });
      if (mountedRef.current) {
        setMessages((current) => mergeMessages(current, data.listMessages.items));
        setNextToken(data.listMessages.nextToken);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load older messages');
      }
    } finally {
      if (mountedRef.current) {
        setLoadingMore(false);
      }
    }
  }, [clanId, loadingMore, nextToken]);

  const sendMessage = useCallback(async (rawText: string) => {
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
      const committed = await fetchMessage(result.messageId);
      if (committed && mountedRef.current) {
        setMessages((current) => mergeMessages(current, [committed]));
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      if (mountedRef.current) {
        setError(message);
      }
      throw err;
    } finally {
      if (mountedRef.current) {
        setSending(false);
      }
    }
  }, [clanId, fetchMessage]);

  const retry = useCallback(async () => {
    setLoading(true);
    try {
      await reconcile();
      startSubscription();
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
    sendMessage,
    loadMore,
    retry,
    reconcile,
  };
}
