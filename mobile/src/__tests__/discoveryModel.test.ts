import { formatDistance, mergeNearbyClans } from '@/discovery/model';
import type { NearbyClan } from '@/clan/types';

function clan(overrides: Partial<NearbyClan>): NearbyClan {
  return {
    clanId: 'clan-1',
    title: 'Robotics',
    category: 'Study',
    createdAt: 100,
    expiresAt: 1000,
    distanceMeters: 500,
    ...overrides,
  };
}

describe('nearby clan model', () => {
  it('deduplicates accumulated pages and keeps nearest distance', () => {
    const result = mergeNearbyClans(
      [clan({ clanId: 'a', distanceMeters: 900 }), clan({ clanId: 'b', distanceMeters: 400 })],
      [clan({ clanId: 'a', distanceMeters: 700 }), clan({ clanId: 'c', distanceMeters: 1200 })],
    );

    expect(result.map((item) => [item.clanId, item.distanceMeters])).toEqual([
      ['b', 400],
      ['a', 700],
      ['c', 1200],
    ]);
  });

  it('formats nearby distances for the phone UI', () => {
    expect(formatDistance(345)).toBe('345 m');
    expect(formatDistance(1250)).toBe('1.3 km');
  });
});
