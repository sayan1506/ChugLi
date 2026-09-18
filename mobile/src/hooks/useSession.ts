import { useState, useCallback, useEffect } from 'react';
import { apolloClient } from '@/aws/clients';
import { START_SESSION_MUTATION } from '@/session/operations';
import { saveSession, loadSession, isSessionValid, SessionData } from '@/session/store';

export type SessionState = 'idle' | 'loading' | 'success' | 'error';

export interface UseSessionReturn {
  session: SessionData | null;
  state: SessionState;
  error: string | null;
  startSession: () => Promise<void>;
  clearError: () => void;
}

export function useSession(): UseSessionReturn {
  const [session, setSession] = useState<SessionData | null>(null);
  const [state, setState] = useState<SessionState>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const existing = await loadSession();
      if (mounted && existing && isSessionValid(existing)) {
        setSession(existing);
        setState('success');
      }
    })();
    return () => { mounted = false; };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const startSession = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const { data } = await apolloClient.mutate({
        mutation: START_SESSION_MUTATION,
        fetchPolicy: 'network-only',
      });

      const result = data?.startSession;
      if (!result) {
        throw new Error('No session data returned');
      }

      const sessionData: SessionData = {
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        serverNow: result.serverNow,
        identityId: '',
      };

      await saveSession(sessionData);
      setSession(sessionData);
      setState('success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start session';
      setError(message);
      setState('error');
    }
  }, []);

  return { session, state, error, startSession, clearError };
}
