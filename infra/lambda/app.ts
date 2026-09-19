import type { AppSyncResolverEvent } from 'aws-lambda';
import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

interface SessionItem {
  sessionId: string;
  expiresAt: number;
}

interface ClanItem {
  clanId: string;
  title: string;
  category: string;
  lat: number;
  lng: number;
  geoPK?: string;
  geoSK?: number;
  createdAt: number;
  expiresAt: number;
}

interface MemberItem {
  sessionId: string;
  memberId: string;
  alias: string;
  joinedAt: number;
  expiresAt: number;
}

interface MessageItem {
  messageId: string;
  clanId: string;
  memberId: string;
  alias: string;
  text: string;
  status: 'APPROVED' | 'PENDING' | 'BLOCKED' | 'HIDDEN';
  revision: number;
  createdAt: number;
  expiresAt: number;
}

interface RequestItem {
  clanId: string;
  messageId: string;
  payloadHash: string;
  status: MessageItem['status'];
  revision: number;
  expiresAt: number;
}

interface CallerSession {
  identityId: string;
  sessionId: string;
}

interface ClanEvent {
  eventId: string;
  clanId: string;
  messageId: string;
  status: MessageItem['status'];
  revision: number;
  expiresAt: number;
}

type ResolverEvent = AppSyncResolverEvent<Record<string, unknown>>;

function tableName(): string {
  return process.env.CHUGLI_TABLE_NAME ?? '';
}
const SESSION_INACTIVITY_SECONDS = Number(process.env.SESSION_INACTIVITY_SECONDS ?? '86400');
const CLAN_LIFETIME_SECONDS = Number(process.env.CLAN_LIFETIME_SECONDS ?? '3600');
const JOIN_RADIUS_METERS = Number(process.env.JOIN_RADIUS_METERS ?? '5000');
const MESSAGE_LIMIT = 500;
const MESSAGE_PAGE_SIZE = 50;
const GEO_INDEX_NAME = 'GSI_GEO';
const GEOHASH_PRECISION = 5;
const NEARBY_PAGE_SIZE = 50;
const NEARBY_QUERY_PAGE_SIZE = 25;
const NEARBY_MAX_QUERY_PAGES = 12;
const EARTH_RADIUS_METERS = 6_371_000;
const GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz';
const CREATE_CLAN_LIMIT = 3;
const CREATE_CLAN_WINDOW_SECONDS = 3600;
const SEND_LIMIT = 10;
const SEND_WINDOW_SECONDS = 60;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ALIAS_ADJECTIVES = ['Swift', 'Bright', 'Calm', 'Clever', 'Kind', 'Bold', 'Sunny', 'Quiet'];
const ALIAS_ANIMALS = ['Fox', 'Otter', 'Panda', 'Falcon', 'Koala', 'Tiger', 'Dolphin', 'Owl'];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function logError(operation: string, err: unknown): void {
  const errorName =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : 'UnknownError';
  console.error(JSON.stringify({ operation, errorName }));
}

function isConditionalFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

function isTransactionFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'TransactionCanceledException'
  );
}

function verifiedIdentityId(event: ResolverEvent): string {
  const identity = event.identity;
  if (!identity || typeof identity !== 'object') {
    throw new Error('Unauthorized');
  }
  const record = identity as unknown as Record<string, unknown>;
  const poolId = record.cognitoIdentityPoolId ?? record.identityPoolId;
  const identityId = record.cognitoIdentityId ?? record.identityId;
  if (typeof poolId !== 'string' || poolId.length === 0) {
    throw new Error('Unauthorized');
  }
  if (typeof identityId !== 'string' || identityId.length === 0) {
    throw new Error('Unauthorized');
  }
  return identityId;
}

async function requireSession(event: ResolverEvent, now: number): Promise<CallerSession> {
  const identityId = verifiedIdentityId(event);
  const key = { PK: `SESSION#${identityId}`, SK: 'META' };
  const expiresAt = now + SESSION_INACTIVITY_SECONDS;

  try {
    const result = await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: key,
        UpdateExpression: 'SET lastSeenAt = :now, expiresAt = :newExpiresAt',
        ConditionExpression: 'attribute_exists(PK) AND expiresAt > :now',
        ExpressionAttributeValues: {
          ':now': now,
          ':newExpiresAt': expiresAt,
        },
        ReturnValues: 'ALL_NEW',
      }),
    );
    const item = result.Attributes as SessionItem | undefined;
    if (!item?.sessionId) {
      throw new Error('Unauthorized');
    }
    return { identityId, sessionId: item.sessionId };
  } catch (err) {
    if (isConditionalFailure(err)) {
      throw new Error('Session expired or unavailable');
    }
    throw err;
  }
}

function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${name} must be 1-${maxLength} characters`);
  }
  return normalized;
}

function requireCoordinate(value: unknown, name: 'lat' | 'lng'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  const max = name === 'lat' ? 90 : 180;
  if (value < -max || value > max) {
    throw new Error(`${name} is out of range`);
  }
  return value;
}

function requireClanId(value: unknown): string {
  return requireString(value, 'clanId', 120);
}

function makeAlias(): string {
  const adjective = ALIAS_ADJECTIVES[randomInt(ALIAS_ADJECTIVES.length)] ?? 'Guest';
  const animal = ALIAS_ANIMALS[randomInt(ALIAS_ANIMALS.length)] ?? 'Fox';
  return `${adjective}${animal}-${randomInt(100, 1000)}`;
}

function clanPk(clanId: string): string {
  return `CLAN#${clanId}`;
}

function memberSk(sessionId: string): string {
  return `MEMBER#${sessionId}`;
}

function messageSk(messageId: string): string {
  return `MSG#${messageId}`;
}

function createMessageId(): string {
  return `${String(Date.now()).padStart(13, '0')}-${randomUUID()}`;
}

function normalizeLongitude(lng: number): number {
  let normalized = lng;
  while (normalized < -180) normalized += 360;
  while (normalized >= 180) normalized -= 360;
  return normalized;
}

export function encodeGeohash(lat: number, lng: number, precision = GEOHASH_PRECISION): string {
  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let evenBit = true;
  let bit = 0;
  let value = 0;
  let hash = '';
  const normalizedLng = normalizeLongitude(lng);

  while (hash.length < precision) {
    if (evenBit) {
      const mid = (lngMin + lngMax) / 2;
      if (normalizedLng >= mid) {
        value = (value << 1) | 1;
        lngMin = mid;
      } else {
        value <<= 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        value = (value << 1) | 1;
        latMin = mid;
      } else {
        value <<= 1;
        latMax = mid;
      }
    }
    evenBit = !evenBit;
    bit += 1;
    if (bit === 5) {
      hash += GEOHASH_ALPHABET[value] ?? '0';
      bit = 0;
      value = 0;
    }
  }

  return hash;
}

function geohashGridDimensions(precision: number): { latBits: number; lngBits: number } {
  const totalBits = precision * 5;
  return {
    lngBits: Math.ceil(totalBits / 2),
    latBits: Math.floor(totalBits / 2),
  };
}

function longitudeRangesForBoundingBox(centerLng: number, deltaLng: number): Array<[number, number]> {
  if (deltaLng >= 180) {
    return [[-180, 180]];
  }
  const min = centerLng - deltaLng;
  const max = centerLng + deltaLng;
  if (min < -180) {
    return [[min + 360, 180], [-180, max]];
  }
  if (max > 180) {
    return [[min, 180], [-180, max - 360]];
  }
  return [[min, max]];
}

export function geohashCellsForRadius(
  lat: number,
  lng: number,
  radiusMeters = JOIN_RADIUS_METERS,
  precision = GEOHASH_PRECISION,
): string[] {
  const angular = radiusMeters / EARTH_RADIUS_METERS;
  const latDelta = (angular * 180) / Math.PI;
  const minLat = Math.max(-90, lat - latDelta);
  const maxLat = Math.min(90, lat + latDelta);
  const cosLat = Math.cos(toRadians(lat));
  const reachesPole = Math.abs(lat) + latDelta >= 90;
  const longitudeRatio = Math.abs(cosLat) < 1e-12
    ? 1
    : Math.min(1, Math.sin(angular) / Math.abs(cosLat));
  const lngDelta = reachesPole
    ? 180
    : (Math.asin(longitudeRatio) * 180) / Math.PI;
  const longitudeRanges = longitudeRangesForBoundingBox(normalizeLongitude(lng), lngDelta);

  const { latBits, lngBits } = geohashGridDimensions(precision);
  const latCells = 2 ** latBits;
  const lngCells = 2 ** lngBits;
  const latStep = 180 / latCells;
  const lngStep = 360 / lngCells;
  const maxLatIndex = latCells - 1;
  const maxLngIndex = lngCells - 1;

  const latStart = Math.max(0, Math.min(maxLatIndex, Math.floor((minLat + 90) / latStep)));
  const latEnd = Math.max(0, Math.min(maxLatIndex, Math.floor((Math.min(maxLat, 90 - Number.EPSILON) + 90) / latStep)));
  const cellEntries = new Map<string, number>();

  for (let latIndex = latStart; latIndex <= latEnd; latIndex += 1) {
    const centerLat = -90 + (latIndex + 0.5) * latStep;
    for (const [rangeMin, rangeMax] of longitudeRanges) {
      const lngStart = Math.max(0, Math.min(maxLngIndex, Math.floor((rangeMin + 180) / lngStep)));
      const adjustedMax = rangeMax === 180 ? 180 - Number.EPSILON : rangeMax;
      const lngEnd = Math.max(0, Math.min(maxLngIndex, Math.floor((adjustedMax + 180) / lngStep)));
      for (let lngIndex = lngStart; lngIndex <= lngEnd; lngIndex += 1) {
        const centerLng = -180 + (lngIndex + 0.5) * lngStep;
        const hash = encodeGeohash(centerLat, centerLng, precision);
        const dist = haversineMeters(lat, lng, centerLat, centerLng);
        const existing = cellEntries.get(hash);
        if (existing === undefined || dist < existing) {
          cellEntries.set(hash, dist);
        }
      }
    }
  }

  return [...cellEntries.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([hash]) => hash);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadius = EARTH_RADIUS_METERS;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const clampedA = Math.min(1, Math.max(0, a));
  return 2 * earthRadius * Math.asin(Math.sqrt(clampedA));
}

async function consumeRateLimit(
  identityId: string,
  action: 'createClan' | 'sendMessage',
  now: number,
): Promise<void> {
  const isCreate = action === 'createClan';
  const windowSeconds = isCreate ? CREATE_CLAN_WINDOW_SECONDS : SEND_WINDOW_SECONDS;
  const limit = isCreate ? CREATE_CLAN_LIMIT : SEND_LIMIT;
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;

  try {
    await doc.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { PK: `RATE#${identityId}#${action}`, SK: String(windowStart) },
        UpdateExpression:
          'SET #count = if_not_exists(#count, :zero) + :one, expiresAt = :expiresAt, createdAt = if_not_exists(createdAt, :now)',
        ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':limit': limit,
          ':expiresAt': windowStart + windowSeconds + 300,
          ':now': now,
        },
      }),
    );
  } catch (err) {
    if (isConditionalFailure(err)) {
      throw new Error(`Rate limit exceeded for ${action}`);
    }
    throw err;
  }
}

async function getClanItem(clanId: string): Promise<ClanItem | undefined> {
  const result = await doc.send(
    new GetCommand({
      TableName: tableName(),
      Key: { PK: clanPk(clanId), SK: 'META' },
      ConsistentRead: true,
    }),
  );
  return result.Item as ClanItem | undefined;
}

async function getMemberItem(clanId: string, sessionId: string): Promise<MemberItem | undefined> {
  const result = await doc.send(
    new GetCommand({
      TableName: tableName(),
      Key: { PK: clanPk(clanId), SK: memberSk(sessionId) },
      ConsistentRead: true,
    }),
  );
  return result.Item as MemberItem | undefined;
}

function assertActiveClan(clan: ClanItem | undefined, now: number): asserts clan is ClanItem {
  if (!clan || typeof clan.expiresAt !== 'number' || clan.expiresAt <= now) {
    throw new Error('Clan not found or expired');
  }
}

async function requireMembership(
  clanId: string,
  sessionId: string,
  now: number,
): Promise<{ clan: ClanItem; member: MemberItem }> {
  const [clan, member] = await Promise.all([getClanItem(clanId), getMemberItem(clanId, sessionId)]);
  assertActiveClan(clan, now);
  if (!member || member.expiresAt <= now || member.sessionId !== sessionId) {
    throw new Error('Membership required');
  }
  return { clan, member };
}

function publicClan(clan: ClanItem, member: MemberItem, now: number) {
  return {
    clanId: clan.clanId,
    title: clan.title,
    category: clan.category,
    createdAt: clan.createdAt,
    expiresAt: clan.expiresAt,
    serverNow: now,
    myMemberId: member.memberId,
    myAlias: member.alias,
  };
}

async function createClan(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const title = requireString(event.arguments.title, 'title', 80);
  const category = requireString(event.arguments.category, 'category', 40);
  const lat = requireCoordinate(event.arguments.lat, 'lat');
  const lng = requireCoordinate(event.arguments.lng, 'lng');
  await consumeRateLimit(caller.identityId, 'createClan', now);

  for (let attempt = 0; attempt < 3; attempt++) {
    const clanId = randomUUID();
    const expiresAt = now + CLAN_LIFETIME_SECONDS;
    const member: MemberItem = {
      sessionId: caller.sessionId,
      memberId: randomUUID(),
      alias: makeAlias(),
      joinedAt: now,
      expiresAt,
    };
    const geohash = encodeGeohash(lat, lng);
    const clan: ClanItem = {
      clanId,
      title,
      category,
      lat,
      lng,
      geoPK: `GEO#${geohash}`,
      geoSK: expiresAt,
      createdAt: now,
      expiresAt,
    };

    try {
      await doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: tableName(),
                Item: { PK: clanPk(clanId), SK: 'META', ...clan },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: tableName(),
                Item: { PK: clanPk(clanId), SK: memberSk(caller.sessionId), ...member },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
          ],
        }),
      );
      return publicClan(clan, member, now);
    } catch (err) {
      if (!isTransactionFailure(err) || attempt === 2) {
        throw err;
      }
    }
  }

  throw new Error('Failed to create clan');
}

async function joinClan(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const clanId = requireClanId(event.arguments.clanId);
  const lat = requireCoordinate(event.arguments.lat, 'lat');
  const lng = requireCoordinate(event.arguments.lng, 'lng');
  const clan = await getClanItem(clanId);
  assertActiveClan(clan, now);

  const distance = haversineMeters(lat, lng, clan.lat, clan.lng);
  if (distance > JOIN_RADIUS_METERS) {
    throw new Error('Too far from this clan');
  }

  const existing = await getMemberItem(clanId, caller.sessionId);
  if (existing && existing.expiresAt > now) {
    return publicClan(clan, existing, now);
  }

  const member: MemberItem = {
    sessionId: caller.sessionId,
    memberId: randomUUID(),
    alias: makeAlias(),
    joinedAt: now,
    expiresAt: clan.expiresAt,
  };

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName(),
              Key: { PK: clanPk(clanId), SK: 'META' },
              ConditionExpression: 'expiresAt > :now',
              ExpressionAttributeValues: { ':now': now },
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: { PK: clanPk(clanId), SK: memberSk(caller.sessionId), ...member },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
    return publicClan(clan, member, now);
  } catch (err) {
    if (!isTransactionFailure(err)) {
      throw err;
    }
    const concurrent = await getMemberItem(clanId, caller.sessionId);
    if (concurrent && concurrent.expiresAt > now) {
      return publicClan(clan, concurrent, now);
    }
    throw new Error('Unable to join clan');
  }
}

interface NearbyToken {
  v: 1;
  lat: number;
  lng: number;
  cellIndex: number;
  exclusiveStartKey?: Record<string, unknown>;
}

function nearbyQueryCoordinates(lat: number, lng: number): { lat: number; lng: number } {
  return {
    lat: Math.round(lat * 1_000_000) / 1_000_000,
    lng: Math.round(normalizeLongitude(lng) * 1_000_000) / 1_000_000,
  };
}

function encodeNearbyToken(token: NearbyToken | null): string | null {
  if (!token) return null;
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

function decodeNearbyToken(
  raw: unknown,
  lat: number,
  lng: number,
  cellsLength: number,
): NearbyToken | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 4096) {
    throw new Error('Invalid nextToken');
  }
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as NearbyToken;
    const expected = nearbyQueryCoordinates(lat, lng);
    if (
      parsed.v !== 1 ||
      parsed.lat !== expected.lat ||
      parsed.lng !== expected.lng ||
      !Number.isInteger(parsed.cellIndex) ||
      parsed.cellIndex < 0 ||
      parsed.cellIndex >= cellsLength
    ) {
      throw new Error('Invalid nextToken');
    }
    return parsed;
  } catch {
    throw new Error('Invalid nextToken');
  }
}

function publicNearbyClan(clan: ClanItem, distanceMeters: number) {
  return {
    clanId: clan.clanId,
    title: clan.title,
    category: clan.category,
    createdAt: clan.createdAt,
    expiresAt: clan.expiresAt,
    distanceMeters: Math.round(distanceMeters),
  };
}

async function nearbyClans(event: ResolverEvent, now: number) {
  await requireSession(event, now);
  const lat = requireCoordinate(event.arguments.lat, 'lat');
  const lng = requireCoordinate(event.arguments.lng, 'lng');
  const cells = geohashCellsForRadius(lat, lng);
  if (cells.length === 0) {
    return { items: [], nextToken: null, serverNow: now };
  }

  const token = decodeNearbyToken(event.arguments.nextToken, lat, lng, cells.length);
  let cellIndex = token?.cellIndex ?? 0;
  let exclusiveStartKey = token?.exclusiveStartKey;
  let queryPages = 0;
  const candidates = new Map<string, { clan: ClanItem; distanceMeters: number }>();

  while (
    cellIndex < cells.length &&
    queryPages < NEARBY_MAX_QUERY_PAGES &&
    candidates.size < NEARBY_PAGE_SIZE
  ) {
    const geoPK = `GEO#${cells[cellIndex]}`;
    const result = await doc.send(
      new QueryCommand({
        TableName: tableName(),
        IndexName: GEO_INDEX_NAME,
        KeyConditionExpression: 'geoPK = :geoPK AND geoSK > :now',
        ExpressionAttributeValues: {
          ':geoPK': geoPK,
          ':now': now,
        },
        Limit: Math.min(NEARBY_QUERY_PAGE_SIZE, NEARBY_PAGE_SIZE - candidates.size),
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: true,
      }),
    );
    queryPages += 1;

    for (const rawItem of result.Items ?? []) {
      const clan = rawItem as ClanItem;
      if (
        !clan.clanId ||
        typeof clan.lat !== 'number' ||
        typeof clan.lng !== 'number' ||
        clan.expiresAt <= now
      ) {
        continue;
      }
      const distanceMeters = haversineMeters(lat, lng, clan.lat, clan.lng);
      if (distanceMeters <= JOIN_RADIUS_METERS) {
        const existing = candidates.get(clan.clanId);
        if (!existing || distanceMeters < existing.distanceMeters) {
          candidates.set(clan.clanId, { clan, distanceMeters });
        }
      }
    }

    const lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (lastEvaluatedKey) {
      exclusiveStartKey = lastEvaluatedKey;
    } else {
      cellIndex += 1;
      exclusiveStartKey = undefined;
    }
  }

  const items = [...candidates.values()]
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.clan.clanId.localeCompare(b.clan.clanId))
    .slice(0, NEARBY_PAGE_SIZE)
    .map(({ clan, distanceMeters }) => publicNearbyClan(clan, distanceMeters));

  const coordinates = nearbyQueryCoordinates(lat, lng);
  const nextToken = cellIndex < cells.length
    ? encodeNearbyToken({
        v: 1,
        lat: coordinates.lat,
        lng: coordinates.lng,
        cellIndex,
        exclusiveStartKey,
      })
    : null;

  return { items, nextToken, serverNow: now };
}

async function getClan(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const clanId = requireClanId(event.arguments.clanId);
  const { clan, member } = await requireMembership(clanId, caller.sessionId, now);
  return publicClan(clan, member, now);
}

function encodeNextToken(key: Record<string, unknown> | undefined): string | null {
  if (!key) {
    return null;
  }
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeNextToken(token: unknown, clanId: string): Record<string, unknown> | undefined {
  if (token === undefined || token === null || token === '') {
    return undefined;
  }
  if (typeof token !== 'string' || token.length > 2048) {
    throw new Error('Invalid nextToken');
  }
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed.PK !== clanPk(clanId) || typeof parsed.SK !== 'string' || !parsed.SK.startsWith('MSG#')) {
      throw new Error('Invalid nextToken');
    }
    return parsed;
  } catch {
    throw new Error('Invalid nextToken');
  }
}

function publicMessage(item: MessageItem) {
  return {
    messageId: item.messageId,
    clanId: item.clanId,
    memberId: item.memberId,
    alias: item.alias,
    text: item.status === 'APPROVED' ? item.text : null,
    status: item.status,
    revision: item.revision,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

async function listMessages(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const clanId = requireClanId(event.arguments.clanId);
  await requireMembership(clanId, caller.sessionId, now);
  const exclusiveStartKey = decodeNextToken(event.arguments.nextToken, clanId);

  const result = await doc.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :messagePrefix)',
      ExpressionAttributeValues: {
        ':pk': clanPk(clanId),
        ':messagePrefix': 'MSG#',
      },
      ScanIndexForward: false,
      Limit: MESSAGE_PAGE_SIZE,
      ExclusiveStartKey: exclusiveStartKey,
      ConsistentRead: true,
    }),
  );

  const items = (result.Items ?? [])
    .map((item) => item as MessageItem)
    .filter((item) => item.expiresAt > now)
    .map(publicMessage);

  return {
    items,
    nextToken: encodeNextToken(result.LastEvaluatedKey as Record<string, unknown> | undefined),
    serverNow: now,
  };
}

async function getMessage(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const clanId = requireClanId(event.arguments.clanId);
  const messageId = requireString(event.arguments.messageId, 'messageId', 180);
  await requireMembership(clanId, caller.sessionId, now);

  const result = await doc.send(
    new GetCommand({
      TableName: tableName(),
      Key: { PK: clanPk(clanId), SK: messageSk(messageId) },
      ConsistentRead: true,
    }),
  );
  const item = result.Item as MessageItem | undefined;
  if (!item || item.expiresAt <= now) {
    throw new Error('Message not found');
  }
  return publicMessage(item);
}

function payloadHash(clanId: string, text: string): string {
  return createHash('sha256').update(`${clanId}\n${text}`, 'utf8').digest('hex');
}

async function getRequest(sessionId: string, requestId: string): Promise<RequestItem | undefined> {
  const result = await doc.send(
    new GetCommand({
      TableName: tableName(),
      Key: { PK: `SESSION#${sessionId}`, SK: `REQUEST#${requestId}` },
      ConsistentRead: true,
    }),
  );
  return result.Item as RequestItem | undefined;
}

function deduplicatedSendResult(request: RequestItem, hash: string, clanId: string, now: number) {
  if (request.clanId !== clanId || request.payloadHash !== hash) {
    throw new Error('requestId was already used with different content');
  }
  return {
    messageId: request.messageId,
    status: request.status,
    revision: request.revision,
    expiresAt: request.expiresAt,
    serverNow: now,
  };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function amzDate(date: Date): { full: string; short: string } {
  const full = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full, short: full.slice(0, 8) };
}

async function publishClanEvent(event: ClanEvent): Promise<void> {
  const endpoint = process.env.APPSYNC_GRAPHQL_URL;
  const region = process.env.APPSYNC_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('Publisher configuration unavailable');
  }

  const query = `mutation PublishClanEvent($event: ClanEventInput!) {
    publishClanEvent(event: $event) {
      eventId clanId messageId status revision expiresAt
    }
  }`;
  const body = JSON.stringify({ query, variables: { event } });
  const url = new URL(endpoint);
  const date = amzDate(new Date());
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: url.host,
    'x-amz-date': date.full,
  };
  if (sessionToken) {
    headers['x-amz-security-token'] = sessionToken;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
  const canonicalRequest = [
    'POST',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    sha256Hex(body),
  ].join('\n');
  const scope = `${date.short}/${region}/appsync/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date.full,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, date.short);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 'appsync');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;

  const response = await fetch(endpoint, { method: 'POST', headers, body });
  if (!response.ok) {
    throw new Error(`Publisher HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { errors?: unknown[] };
  if (payload.errors?.length) {
    throw new Error('Publisher GraphQL error');
  }
}

async function sendMessage(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const clanId = requireClanId(event.arguments.clanId);
  const requestId = requireString(event.arguments.requestId, 'requestId', 120);
  if (typeof event.arguments.text !== 'string') {
    throw new Error('text is required');
  }
  const text = event.arguments.text.trim();
  const textLength = Array.from(text).length;
  if (textLength === 0 || textLength > MESSAGE_LIMIT) {
    throw new Error(`text must be 1-${MESSAGE_LIMIT} characters`);
  }

  const { clan, member } = await requireMembership(clanId, caller.sessionId, now);
  const hash = payloadHash(clanId, text);
  const existingRequest = await getRequest(caller.sessionId, requestId);
  if (existingRequest) {
    return deduplicatedSendResult(existingRequest, hash, clanId, now);
  }

  await consumeRateLimit(caller.identityId, 'sendMessage', now);
  const messageId = createMessageId();
  const revision = 1;
  const message: MessageItem = {
    messageId,
    clanId,
    memberId: member.memberId,
    alias: member.alias,
    text,
    status: 'APPROVED',
    revision,
    createdAt: now,
    expiresAt: clan.expiresAt,
  };
  const request: RequestItem = {
    clanId,
    messageId,
    payloadHash: hash,
    status: 'APPROVED',
    revision,
    expiresAt: clan.expiresAt,
  };

  try {
    await doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName(),
              Key: { PK: clanPk(clanId), SK: 'META' },
              ConditionExpression: 'expiresAt > :now',
              ExpressionAttributeValues: { ':now': now },
            },
          },
          {
            ConditionCheck: {
              TableName: tableName(),
              Key: { PK: clanPk(clanId), SK: memberSk(caller.sessionId) },
              ConditionExpression: 'expiresAt > :now',
              ExpressionAttributeValues: { ':now': now },
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: { PK: clanPk(clanId), SK: messageSk(messageId), ...message },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: { PK: `SESSION#${caller.sessionId}`, SK: `REQUEST#${requestId}`, ...request },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
  } catch (err) {
    if (isTransactionFailure(err)) {
      const concurrentRequest = await getRequest(caller.sessionId, requestId);
      if (concurrentRequest) {
        return deduplicatedSendResult(concurrentRequest, hash, clanId, now);
      }
      throw new Error('Message write failed');
    }
    throw err;
  }

  const clanEvent: ClanEvent = {
    eventId: randomUUID(),
    clanId,
    messageId,
    status: 'APPROVED',
    revision,
    expiresAt: clan.expiresAt,
  };
  try {
    await publishClanEvent(clanEvent);
  } catch (err) {
    // The database commit is the source of truth. A publication failure is repaired
    // by client reconciliation and must not encourage the caller to duplicate-send.
    logError('publishClanEvent', err);
  }

  return {
    messageId,
    status: 'APPROVED' as const,
    revision,
    expiresAt: clan.expiresAt,
    serverNow: now,
  };
}

async function authorizeSubscription(event: ResolverEvent, now: number) {
  const caller = await requireSession(event, now);
  const clanId = requireClanId(event.arguments.clanId);
  await requireMembership(clanId, caller.sessionId, now);
  return { authorized: true };
}

export async function handler(event: ResolverEvent): Promise<unknown> {
  const fieldName = event.info?.fieldName;
  const now = nowSeconds();
  try {
    switch (fieldName) {
      case 'createClan':
        return await createClan(event, now);
      case 'joinClan':
        return await joinClan(event, now);
      case 'nearbyClans':
        return await nearbyClans(event, now);
      case 'getClan':
        return await getClan(event, now);
      case 'listMessages':
        return await listMessages(event, now);
      case 'getMessage':
        return await getMessage(event, now);
      case 'sendMessage':
        return await sendMessage(event, now);
      case 'onClanEvent':
        return await authorizeSubscription(event, now);
      default:
        throw new Error('Unsupported operation');
    }
  } catch (err) {
    logError(fieldName ?? 'unknown', err);
    throw err;
  }
}
