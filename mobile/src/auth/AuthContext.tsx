import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useSession } from '@/hooks/useSession';
import { SessionData } from '@/session/store';

interface AuthContextValue {
  session: SessionData | null;
  state: 'idle' | 'loading' | 'success' | 'error';
  error: string | null;
  startSession: () => Promise<void>;
  clearError: () => void;
  isAuthenticated: boolean;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { session, state, error, startSession, clearError } = useSession();
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    setIsHydrated(true);
  }, []);

  const isAuthenticated = state === 'success' && session !== null;
  const isLoading = state === 'loading' || !isHydrated;

  return (
    <AuthContext.Provider
      value={{
        session,
        state,
        error,
        startSession,
        clearError,
        isAuthenticated,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
