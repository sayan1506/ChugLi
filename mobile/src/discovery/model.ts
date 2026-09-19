import type { NearbyClan } from '@/clan/types';

export function mergeNearbyClans(existing: NearbyClan[], incoming: NearbyClan[]): NearbyClan[] {
  const byId = new Map<string, NearbyClan>();
  for (const item of [...existing, ...incoming]) {
    const previous = byId.get(item.clanId);
    if (!previous || item.distanceMeters <= previous.distanceMeters) {
      byId.set(item.clanId, item);
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.distanceMeters - b.distanceMeters || a.clanId.localeCompare(b.clanId),
  );
}

export function formatDistance(distanceMeters: number): string {
  if (distanceMeters < 1000) {
    return `${Math.max(0, Math.round(distanceMeters))} m`;
  }
  return `${(distanceMeters / 1000).toFixed(distanceMeters < 10_000 ? 1 : 0)} km`;
}
