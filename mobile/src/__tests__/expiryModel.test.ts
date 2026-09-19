import {
  createServerTimeAnchor,
  estimateServerNow,
  formatClanCountdown,
  isExpiredClanError,
  remainingClanSeconds,
} from '@/clan/expiry';

describe('clan expiry model', () => {
  it('advances from the server timestamp using monotonic elapsed time', () => {
    const anchor = createServerTimeAnchor(10_000, 500);
    expect(estimateServerNow(anchor, 3_000)).toBe(10_002.5);
  });

  it('never moves the estimated server time backwards if the monotonic value regresses', () => {
    const anchor = createServerTimeAnchor(10_000, 500);
    expect(estimateServerNow(anchor, 100)).toBe(10_000);
  });

  it('calculates a bounded countdown and closes exactly at server expiry', () => {
    expect(remainingClanSeconds(1_100, 1_000)).toBe(100);
    expect(remainingClanSeconds(1_100, 1_099.2)).toBe(1);
    expect(remainingClanSeconds(1_100, 1_100)).toBe(0);
    expect(remainingClanSeconds(1_100, 1_200)).toBe(0);
  });

  it('formats the phone countdown', () => {
    expect(formatClanCountdown(3599)).toBe('59:59');
    expect(formatClanCountdown(3600)).toBe('1:00:00');
    expect(formatClanCountdown(5)).toBe('00:05');
    expect(formatClanCountdown(0)).toBe('00:00');
    expect(formatClanCountdown(-10)).toBe('00:00');
    expect(formatClanCountdown(Number.NaN)).toBe('00:00');
    expect(formatClanCountdown(Number.POSITIVE_INFINITY)).toBe('00:00');
  });

  it('recognizes the backend expiry error used for cold-start and resume closure across error formats', () => {
    expect(isExpiredClanError(new Error('Clan not found or expired'))).toBe(true);
    expect(isExpiredClanError('Clan not found or expired')).toBe(true);
    expect(isExpiredClanError({ message: 'Clan not found or expired' })).toBe(true);
    expect(isExpiredClanError({ graphQLErrors: [{ message: 'Clan not found or expired' }] })).toBe(true);
    expect(isExpiredClanError(Object.assign(new Error('GraphQL error'), {
      graphQLErrors: [{ message: 'Clan not found or expired' }],
    }))).toBe(true);
    expect(isExpiredClanError(new Error('Network request failed'))).toBe(false);
    expect(isExpiredClanError(null)).toBe(false);
    expect(isExpiredClanError(undefined)).toBe(false);
  });
});
