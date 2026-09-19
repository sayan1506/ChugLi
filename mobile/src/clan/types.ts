export interface Clan {
  clanId: string;
  title: string;
  category: string;
  createdAt: number;
  expiresAt: number;
  serverNow: number;
  myMemberId: string;
  myAlias: string;
}

export interface NearbyClan {
  clanId: string;
  title: string;
  category: string;
  createdAt: number;
  expiresAt: number;
  distanceMeters: number;
}

export interface NearbyClanPage {
  items: NearbyClan[];
  nextToken: string | null;
  serverNow: number;
}
