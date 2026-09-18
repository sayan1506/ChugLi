import { ApolloProvider } from '@apollo/client';
import { apolloClient } from '@/aws/clients';
import { AuthProvider } from '@/auth/AuthContext';
import { ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ApolloProvider client={apolloClient}>
      <AuthProvider>{children}</AuthProvider>
    </ApolloProvider>
  );
}
