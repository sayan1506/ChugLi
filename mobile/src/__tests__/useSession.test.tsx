import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useSession } from '@/hooks/useSession';
import { apolloClient } from '@/aws/clients';
import { getCredentials } from '@/auth/credentials';
import { isSessionValid, loadSession, saveSession } from '@/session/store';

jest.mock('@/aws/clients', () => ({
  apolloClient: {
    mutate: jest.fn(),
  },
}));

jest.mock('@/auth/credentials', () => ({
  getCredentials: jest.fn(),
}));

jest.mock('@/session/store', () => ({
  saveSession: jest.fn(),
  loadSession: jest.fn(),
  isSessionValid: jest.fn(),
}));

const mockMutate = apolloClient.mutate as jest.Mock;
const mockGetCredentials = getCredentials as jest.MockedFunction<typeof getCredentials>;
const mockLoadSession = loadSession as jest.MockedFunction<typeof loadSession>;
const mockSaveSession = saveSession as jest.MockedFunction<typeof saveSession>;
const mockIsSessionValid = isSessionValid as jest.MockedFunction<typeof isSessionValid>;

describe('useSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadSession.mockResolvedValue(null);
    mockIsSessionValid.mockReturnValue(false);
  });

  it('persists the Cognito identity used to sign startSession', async () => {
    mockGetCredentials.mockResolvedValue({
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      sessionToken: 'token',
      identityId: 'us-east-1:identity-123',
      expiration: Date.now() + 3600000,
    });
    mockMutate.mockResolvedValue({
      data: {
        startSession: {
          sessionId: 'session-123',
          expiresAt: 2_000_000_000,
          serverNow: 1_999_913_600,
        },
      },
    });
    mockSaveSession.mockResolvedValue(undefined);

    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(mockLoadSession).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.startSession();
    });

    expect(mockGetCredentials).toHaveBeenCalledTimes(1);
    expect(mockMutate).toHaveBeenCalledTimes(1);
    expect(mockSaveSession).toHaveBeenCalledWith({
      sessionId: 'session-123',
      expiresAt: 2_000_000_000,
      serverNow: 1_999_913_600,
      identityId: 'us-east-1:identity-123',
    });
    expect(result.current.session?.identityId).toBe('us-east-1:identity-123');
    expect(result.current.state).toBe('success');
  });
});
