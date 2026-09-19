import * as SecureStore from 'expo-secure-store';
import { saveSession, loadSession, clearSession, isSessionValid, SessionData } from '@/session/store';

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockSecureStore = SecureStore as jest.Mocked<typeof SecureStore>;

describe('session store', () => {
  const validSession: SessionData = {
    sessionId: 'test-session-id',
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    serverNow: Math.floor(Date.now() / 1000),
    identityId: 'identity-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves session data', async () => {
    await saveSession(validSession);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledTimes(2);
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('chugli_session', JSON.stringify(validSession));
    expect(mockSecureStore.setItemAsync).toHaveBeenCalledWith('chugli_identity_id', 'identity-1');
  });

  it('loads valid session', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(JSON.stringify(validSession));
    const result = await loadSession();
    expect(result).toEqual(validSession);
  });

  it('returns null for missing session', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce(null);
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('returns null for corrupted session', async () => {
    mockSecureStore.getItemAsync.mockResolvedValueOnce('invalid-json');
    const result = await loadSession();
    expect(result).toBeNull();
  });

  it('clears session', async () => {
    await clearSession();
    expect(mockSecureStore.deleteItemAsync).toHaveBeenCalledTimes(2);
  });

  it('validates active session', () => {
    expect(isSessionValid(validSession)).toBe(true);
  });

  it('rejects expired session', () => {
    const expired = { ...validSession, expiresAt: Math.floor(Date.now() / 1000) - 100 };
    expect(isSessionValid(expired)).toBe(false);
  });

  it('rejects null session', () => {
    expect(isSessionValid(null)).toBe(false);
  });

  it('rejects a persisted session without a Cognito identity', () => {
    const missingIdentity = { ...validSession, identityId: '' };
    expect(isSessionValid(missingIdentity)).toBe(false);
  });

  it('rejects session expiring soon', () => {
    const soon = { ...validSession, expiresAt: Math.floor(Date.now() / 1000) + 100 };
    expect(isSessionValid(soon)).toBe(false);
  });
});
