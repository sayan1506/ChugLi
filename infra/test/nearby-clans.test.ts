import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbMock } from './aws-client-mocks';
import { encodeGeohash, geohashCellsForRadius, handler, haversineMeters } from '../lambda/app';
import { ChugLiStack } from '../lib/chugli-stack';

function event(args: Record<string, unknown> = {}, fieldName = 'nearbyClans') {
  return {
    arguments: args,
    identity: {
      cognitoIdentityPoolId: 'pool-1',
      cognitoIdentityId: 'identity-1',
    },
    info: {
      fieldName,
      parentTypeName: fieldName === 'joinClan' ? 'Mutation' : 'Query',
      variables: {},
      selectionSetList: [],
      selectionSetGraphQL: '{}',
    },
    request: { headers: {} },
    source: null,
    prev: null,
    stash: {},
  } as unknown as AppSyncResolverEvent<Record<string, unknown>>;
}

function sessionTouch(input: { Key?: Record<string, unknown> }) {
  if (String(input.Key?.PK ?? '') === 'SESSION#identity-1') {
    return {
      Attributes: {
        sessionId: 'session-1',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
    };
  }
  return {};
}

describe('nearby clan discovery', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.CHUGLI_TABLE_NAME = 'TestTable';
    ddbMock.on(UpdateCommand).callsFake(sessionTouch);
  });

  it('enumerates geohash cells across a cell boundary instead of assuming one cell', () => {
    const cells = geohashCellsForRadius(0, 0, 5000, 5);
    const centre = encodeGeohash(0, 0, 5);
    const nearbyAcrossBoundary = encodeGeohash(0, 0.044, 5);

    expect(cells).toContain(centre);
    expect(cells).toContain(nearbyAcrossBoundary);
    expect(cells.length).toBeGreaterThan(1);
    expect(haversineMeters(0, 0, 0, 0.044)).toBeLessThan(5000);
  });

  it('returns a clan across a geohash-5 boundary but within 5 km', async () => {
    const now = Math.floor(Date.now() / 1000);
    const centerLat = 0;
    const centerLng = 0;
    const boundaryLat = 0;
    const boundaryLng = 0.044; // ~4.89 km away, in an adjacent geohash-5 cell
    const centerGeohash = encodeGeohash(centerLat, centerLng, 5);
    const boundaryGeohash = encodeGeohash(boundaryLat, boundaryLng, 5);
    expect(boundaryGeohash).not.toBe(centerGeohash);
    expect(haversineMeters(centerLat, centerLng, boundaryLat, boundaryLng)).toBeLessThan(5000);

    ddbMock.on(QueryCommand).callsFake((input) => {
      const geoPK = input.ExpressionAttributeValues?.[':geoPK'];
      if (geoPK === `GEO#${boundaryGeohash}`) {
        return {
          Items: [
            {
              PK: 'CLAN#boundary-clan',
              SK: 'META',
              clanId: 'boundary-clan',
              title: 'Boundary Clan',
              category: 'General',
              lat: boundaryLat,
              lng: boundaryLng,
              createdAt: now - 100,
              expiresAt: now + 3000,
              geoPK: `GEO#${boundaryGeohash}`,
              geoSK: now + 3000,
            },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await handler(event({ lat: centerLat, lng: centerLng })) as {
      items: Array<{ clanId: string; distanceMeters: number }>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clanId).toBe('boundary-clan');
    expect(result.items[0]?.distanceMeters).toBeLessThanOrEqual(5000);
  });

  it('excludes a clan just outside 5 km (e.g. ~5,050 m away)', async () => {
    const now = Math.floor(Date.now() / 1000);
    // 5050 meters north of (0, 0) is ~0.04542 degrees
    const outsideLat = 0.04542;
    const outsideLng = 0;
    const distance = haversineMeters(0, 0, outsideLat, outsideLng);
    expect(distance).toBeGreaterThan(5000);
    expect(distance).toBeLessThan(5100);

    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'CLAN#just-outside',
          SK: 'META',
          clanId: 'just-outside',
          title: 'Outside Clan',
          category: 'General',
          lat: outsideLat,
          lng: outsideLng,
          createdAt: now - 50,
          expiresAt: now + 3000,
          geoPK: `GEO#${encodeGeohash(outsideLat, outsideLng)}`,
          geoSK: now + 3000,
        },
      ],
    });

    const result = await handler(event({ lat: 0, lng: 0 })) as {
      items: Array<{ clanId: string }>;
    };

    expect(result.items).toHaveLength(0);
  });

  it('handles search boxes that cross the international date line', () => {
    const cells = geohashCellsForRadius(0, 179.99, 5000, 5);
    expect(cells).toContain(encodeGeohash(0, 179.99, 5));
    expect(cells).toContain(encodeGeohash(0, -179.99, 5));
  });

  it('works end-to-end across the international date line', async () => {
    const now = Math.floor(Date.now() / 1000);
    const userLat = 0;
    const userLng = 179.99;
    const clanLat = 0;
    const clanLng = -179.99; // ~2.22 km away across the date line
    const distance = haversineMeters(userLat, userLng, clanLat, clanLng);
    expect(distance).toBeLessThan(5000);

    const clanGeohash = encodeGeohash(clanLat, clanLng, 5);
    ddbMock.on(QueryCommand).callsFake((input) => {
      const geoPK = input.ExpressionAttributeValues?.[':geoPK'];
      if (geoPK === `GEO#${clanGeohash}`) {
        return {
          Items: [
            {
              PK: 'CLAN#dateline-clan',
              SK: 'META',
              clanId: 'dateline-clan',
              title: 'Date Line Clan',
              category: 'General',
              lat: clanLat,
              lng: clanLng,
              createdAt: now - 30,
              expiresAt: now + 3000,
              geoPK: `GEO#${clanGeohash}`,
              geoSK: now + 3000,
            },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await handler(event({ lat: userLat, lng: userLng })) as {
      items: Array<{ clanId: string; distanceMeters: number }>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clanId).toBe('dateline-clan');
    expect(result.items[0]?.distanceMeters).toBe(Math.round(distance));
  });

  it('covers the full 5 km longitude span at very high latitude', () => {
    const cells = geohashCellsForRadius(89.9, 0, 5000, 5);
    expect(cells).toContain(encodeGeohash(89.9209964, 25.8437611, 5));
    expect(cells).toContain(encodeGeohash(89.9093292, -26.7034242, 5));
  });

  it('works end-to-end at high latitude', async () => {
    const now = Math.floor(Date.now() / 1000);
    const userLat = 85.0;
    const userLng = 0.0;
    const clanLat = 85.02;
    const clanLng = 0.0; // ~2.22 km north
    const distance = haversineMeters(userLat, userLng, clanLat, clanLng);
    expect(distance).toBeLessThan(5000);

    const clanGeohash = encodeGeohash(clanLat, clanLng, 5);
    ddbMock.on(QueryCommand).callsFake((input) => {
      const geoPK = input.ExpressionAttributeValues?.[':geoPK'];
      if (geoPK === `GEO#${clanGeohash}`) {
        return {
          Items: [
            {
              PK: 'CLAN#polar-clan',
              SK: 'META',
              clanId: 'polar-clan',
              title: 'Polar Clan',
              category: 'Science',
              lat: clanLat,
              lng: clanLng,
              createdAt: now - 20,
              expiresAt: now + 3000,
              geoPK: `GEO#${clanGeohash}`,
              geoSK: now + 3000,
            },
          ],
        };
      }
      return { Items: [] };
    });

    const result = await handler(event({ lat: userLat, lng: userLng })) as {
      items: Array<{ clanId: string; distanceMeters: number }>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clanId).toBe('polar-clan');
    expect(result.items[0]?.distanceMeters).toBe(Math.round(distance));
  });

  it('excludes an expired clan (expiresAt <= serverNow)', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'CLAN#expired-clan',
          SK: 'META',
          clanId: 'expired-clan',
          title: 'Expired Clan',
          category: 'General',
          lat: 22.573,
          lng: 88.364,
          createdAt: now - 4000,
          expiresAt: now - 10,
          geoPK: `GEO#${encodeGeohash(22.573, 88.364)}`,
          geoSK: now - 10,
        },
      ],
    });

    const result = await handler(event({ lat: 22.5726, lng: 88.3639 })) as {
      items: Array<{ clanId: string }>;
    };

    expect(result.items).toHaveLength(0);
  });

  it('queries GSI_GEO, filters exact distance, sorts results, and hides coordinates', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'CLAN#near',
          SK: 'META',
          clanId: 'near',
          title: 'Near Clan',
          category: 'Study',
          lat: 22.573,
          lng: 88.364,
          createdAt: now - 20,
          expiresAt: now + 3000,
          geoPK: `GEO#${encodeGeohash(22.573, 88.364)}`,
          geoSK: now + 3000,
        },
        {
          PK: 'CLAN#edge',
          SK: 'META',
          clanId: 'edge',
          title: 'Edge Clan',
          category: 'General',
          lat: 22.6,
          lng: 88.39,
          createdAt: now - 10,
          expiresAt: now + 3000,
          geoPK: `GEO#${encodeGeohash(22.6, 88.39)}`,
          geoSK: now + 3000,
        },
        {
          PK: 'CLAN#far',
          SK: 'META',
          clanId: 'far',
          title: 'Too Far',
          category: 'General',
          lat: 22.7,
          lng: 88.5,
          createdAt: now - 10,
          expiresAt: now + 3000,
          geoPK: `GEO#${encodeGeohash(22.7, 88.5)}`,
          geoSK: now + 3000,
        },
      ],
    });

    const result = await handler(event({ lat: 22.5726, lng: 88.3639 })) as {
      items: Array<Record<string, unknown>>;
      nextToken: string | null;
    };

    expect(result.items.map((item) => item.clanId)).toEqual(['near', 'edge']);
    expect(result.items[0]).toEqual(expect.objectContaining({
      clanId: 'near',
      distanceMeters: expect.any(Number),
    }));

    // Verify privacy: absolutely NO exact coordinates or private IDs exposed
    expect(result.items[0]).not.toHaveProperty('lat');
    expect(result.items[0]).not.toHaveProperty('lng');
    expect(result.items[0]).not.toHaveProperty('geoPK');
    expect(result.items[0]).not.toHaveProperty('geoSK');
    expect(result.items[0]).not.toHaveProperty('geohash');
    expect(result.items[0]).not.toHaveProperty('sessionId');
    expect(result.items[0]).not.toHaveProperty('identityId');

    const queries = ddbMock.commandCalls(QueryCommand);
    expect(queries.length).toBeGreaterThan(1);
    for (const query of queries) {
      expect(query.args[0].input).toMatchObject({
        TableName: 'TestTable',
        IndexName: 'GSI_GEO',
        KeyConditionExpression: 'geoPK = :geoPK AND geoSK > :now',
      });
      expect(query.args[0].input.ConsistentRead).toBeUndefined();
    }
  });

  it('collapses duplicate clan candidates to one result with the nearest distance', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'CLAN#dup',
          SK: 'META',
          clanId: 'dup',
          title: 'Duplicate Clan',
          category: 'General',
          lat: 22.573,
          lng: 88.364,
          createdAt: now - 10,
          expiresAt: now + 3000,
          geoPK: 'GEO#tup4t',
          geoSK: now + 3000,
        },
        {
          PK: 'CLAN#dup',
          SK: 'META',
          clanId: 'dup',
          title: 'Duplicate Clan',
          category: 'General',
          lat: 22.573,
          lng: 88.364,
          createdAt: now - 10,
          expiresAt: now + 3000,
          geoPK: 'GEO#tup4w',
          geoSK: now + 3000,
        },
      ],
    });

    const result = await handler(event({ lat: 22.5726, lng: 88.3639 })) as {
      items: Array<{ clanId: string; distanceMeters: number }>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.clanId).toBe('dup');
  });

  it('returns an opaque continuation token when bounded query work remains', async () => {
    const lastEvaluatedKey = {
      geoPK: 'GEO#dr5ru',
      geoSK: 9999999999,
      PK: 'CLAN#cursor',
      SK: 'META',
    };
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: lastEvaluatedKey });

    const first = await handler(event({ lat: 40.7128, lng: -74.006 })) as {
      nextToken: string | null;
    };
    expect(first.nextToken).toEqual(expect.any(String));
    expect(first.nextToken).not.toContain('GEO#');

    const before = ddbMock.commandCalls(QueryCommand).length;
    await handler(event({ lat: 40.7128, lng: -74.006, nextToken: first.nextToken }));
    const firstResumeQuery = ddbMock.commandCalls(QueryCommand)[before];
    expect(firstResumeQuery?.args[0].input.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it('rejects a continuation token if it is reused for different coordinates', async () => {
    const lastEvaluatedKey = {
      geoPK: 'GEO#dr5ru',
      geoSK: 9999999999,
      PK: 'CLAN#cursor',
      SK: 'META',
    };
    ddbMock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: lastEvaluatedKey });
    const first = await handler(event({ lat: 40.7128, lng: -74.006 })) as {
      nextToken: string | null;
    };

    await expect(
      handler(event({ lat: 40.7138, lng: -74.006, nextToken: first.nextToken })),
    ).rejects.toThrow('Invalid nextToken');
  });

  it('safely rejects malformed or tampered continuation tokens', async () => {
    await expect(
      handler(event({ lat: 40.7128, lng: -74.006, nextToken: 'invalid-base64-token!!' })),
    ).rejects.toThrow('Invalid nextToken');

    const wrongVersion = Buffer.from(JSON.stringify({ v: 2 })).toString('base64url');
    await expect(
      handler(event({ lat: 40.7128, lng: -74.006, nextToken: wrongVersion })),
    ).rejects.toThrow('Invalid nextToken');

    const outOfBoundsCell = Buffer.from(
      JSON.stringify({ v: 1, lat: 40.7128, lng: -74.006, cellIndex: 999999 }),
    ).toString('base64url');
    await expect(
      handler(event({ lat: 40.7128, lng: -74.006, nextToken: outOfBoundsCell })),
    ).rejects.toThrow('Invalid nextToken');
  });

  it('joining a discovered clan still performs live distance validation against stored center', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Clan center is at (22.5726, 88.3639)
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.PK ?? '');
      const sk = String(input.Key?.SK ?? '');
      if (pk === 'CLAN#discovered-clan' && sk === 'META') {
        return {
          Item: {
            PK: 'CLAN#discovered-clan',
            SK: 'META',
            clanId: 'discovered-clan',
            title: 'Discovered Clan',
            category: 'Study',
            lat: 22.5726,
            lng: 88.3639,
            createdAt: now - 60,
            expiresAt: now + 3000,
          },
        };
      }
      return { Item: undefined };
    });

    // Caller attempts to join with coordinates > 5 km away (e.g. 22.65, 88.3639 is ~8.6 km away)
    await expect(
      handler(event({ clanId: 'discovered-clan', lat: 22.65, lng: 88.3639 }, 'joinClan')),
    ).rejects.toThrow('Too far from this clan');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('an arbitrary clan ID does not bypass distance validation on join', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.PK ?? '');
      const sk = String(input.Key?.SK ?? '');
      if (pk === 'CLAN#arbitrary-clan' && sk === 'META') {
        return {
          Item: {
            PK: 'CLAN#arbitrary-clan',
            SK: 'META',
            clanId: 'arbitrary-clan',
            title: 'Arbitrary Clan',
            category: 'General',
            lat: 10.0,
            lng: 10.0,
            createdAt: now - 30,
            expiresAt: now + 3000,
          },
        };
      }
      return { Item: undefined };
    });

    await expect(
      handler(event({ clanId: 'arbitrary-clan', lat: 20.0, lng: 20.0 }, 'joinClan')),
    ).rejects.toThrow('Too far from this clan');
  });

  it('verifies guest IAM policy includes nearbyClans and excludes publishClanEvent, DynamoDB, Bedrock', () => {
    const app = new App();
    const stack = new ChugLiStack(app, 'TestStack');
    const template = Template.fromStack(stack);

    // Verify GuestRole policy permissions
    interface PolicyResource {
      Properties?: {
        PolicyName?: string;
        PolicyDocument?: {
          Statement?: Array<{
            Action: string | string[];
            Resource: unknown[];
          }>;
        };
      };
    }

    const policies = template.findResources('AWS::IAM::Policy') as Record<string, PolicyResource>;
    const guestPolicy = Object.values(policies).find((p) =>
      p.Properties?.PolicyName?.includes('GuestRoleDefaultPolicy'),
    );

    expect(guestPolicy).toBeDefined();
    const statements = guestPolicy?.Properties?.PolicyDocument?.Statement ?? [];

    const appsyncStatement = statements.find((s) =>
      Array.isArray(s.Action) ? s.Action.includes('appsync:GraphQL') : s.Action === 'appsync:GraphQL',
    );
    expect(appsyncStatement).toBeDefined();

    const resourceStrings = (appsyncStatement?.Resource ?? []).map((r) => JSON.stringify(r));
    // nearbyClans MUST be permitted
    const hasNearby = resourceStrings.some((r) => r.includes('Query') && r.includes('nearbyClans'));
    expect(hasNearby).toBe(true);

    // publishClanEvent MUST NOT be permitted
    const hasPublish = resourceStrings.some((r) => r.includes('publishClanEvent'));
    expect(hasPublish).toBe(false);

    // Verify NO direct DynamoDB permissions on GuestRole
    const hasDynamo = statements.some((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a) => a.toLowerCase().includes('dynamodb'));
    });
    expect(hasDynamo).toBe(false);

    // Verify NO Bedrock permissions on GuestRole
    const hasBedrock = statements.some((s) => {
      const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
      return actions.some((a) => a.toLowerCase().includes('bedrock'));
    });
    expect(hasBedrock).toBe(false);
  });
});
