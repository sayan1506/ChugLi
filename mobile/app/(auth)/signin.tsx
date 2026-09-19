import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import SessionScreen from '@/components/SessionScreen';
import { useAuth } from '@/auth/AuthContext';

export default function SignInScreen() {
  const router = useRouter();
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/home');
    }
  }, [isAuthenticated, router]);

  return <SessionScreen />;
}
