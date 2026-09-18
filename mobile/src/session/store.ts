import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'chugli_session';
const IDENTITY_ID_KEY = 'chugli_identity_id';

export interface SessionData {
  sessionId: string;
  expiresAt: number;
  serverNow: number;
  identityId: string;
}

export async function saveSession(data: SessionData): Promise<void> {
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(data));
  await SecureStore.setItemAsync(IDENTITY_ID_KEY, data.identityId);
}

export async function loadSession(): Promise<SessionData | null> {
  const stored = await SecureStore.getItemAsync(SESSION_KEY);
  if (!stored) {
    return null;
  }
  try {
    return JSON.parse(stored) as SessionData;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await SecureStore.deleteItemAsync(IDENTITY_ID_KEY);
}

export async function getIdentityId(): Promise<string | null> {
  return SecureStore.getItemAsync(IDENTITY_ID_KEY);
}

export function isSessionValid(session: SessionData | null): boolean {
  if (!session) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return session.expiresAt > now + 300;
}
