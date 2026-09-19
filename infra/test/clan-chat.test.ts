import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppSyncResolverEvent } from 'aws-lambda';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddbMock } from './aws-client-mocks';
import { handler, haversineMeters } from '../lambda/app';

function event(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    arguments: args,
    identity: {
      cognitoIdentityPoolId: 'pool-1',
      cognitoIdentityId: 'identity-1',
    },
    info: {
      fieldName,
      parentTypeName: fieldName === 'onClanEvent' ? 'Subscription' : 'Mutation',
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

function sessionTouchMock(input: { Key?: Record<string, unknown> }) {
  if (String(input.Key?.PK ?? '').startsWith('SESSION#identity-1')) {
    return {
      Attributes: {
        sessionId: 'session-1',
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
      },
    };
  }
  return {};
}

function activeClan(now: number) {
  return {
    PK: 'CLAN#clan-1',
    SK: 'META',
    clanId: 'clan-1',
    title: 'Robotics Lab',
    category: 'Study',
    lat: 22.5726,
    lng: 88.3639,
    createdAt: now - 60,
    expiresAt: now + 3000,
  };
}

function member(now: number) {
  return {
    PK: 'CLAN#clan-1',
    SK: 'MEMBER#session-1',
    sessionId: 'session-1',
    memberId: 'member-1',
    alias: 'SwiftFox-123',
    joinedAt: now - 30,
    expiresAt: now + 3000,
  };
}

describe('Phase 2 resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.CHUGLI_TABLE_NAME = 'TestTable';
    process.env.APPSYNC_GRAPHQL_URL = '';
    process.env.APPSYNC_REGION = 'us-east-1';
    ddbMock.on(UpdateCommand).callsFake(sessionTouchMock);
  });

  it('calculates Haversine distance in meters', () => {
    expect(haversineMeters(22.5726, 88.3639, 22.5726, 88.3639)).toBe(0);
    const oneDegree = haversineMeters(0, 0, 1, 0);
    expect(oneDegree).toBeGreaterThan(110_000);
    expect(oneDegree).toBeLessThan(112_000);
  });

  it('creates a clan and creator membership in one transaction', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(
      event('createClan', {
        title: ' Robotics Lab ',
        category: ' Study ',
        lat: 22.5726,
        lng: 88.3639,
      }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      title: 'Robotics Lab',
      category: 'Study',
      myMemberId: expect.any(String),
      myAlias: expect.any(String),
    });
    expect(result.expiresAt).toBe((result.serverNow as number) + 3600);

    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.TransactItems).toHaveLength(2);
    expect(input.TransactItems?.[0]?.Put?.Item).toMatchObject({
      SK: 'META',
      clanId: result.clanId,
      title: 'Robotics Lab',
      category: 'Study',
      lat: 22.5726,
      lng: 88.3639,
    });
    expect(input.TransactItems?.[1]?.Put?.Item).toMatchObject({
      SK: 'MEMBER#session-1',
      sessionId: 'session-1',
    });
  });

  it('rejects a join outside the 5 km radius', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).resolves({ Item: { ...activeClan(now), lat: 0, lng: 0 } });

    await expect(
      handler(event('joinClan', { clanId: 'clan-1', lat: 1, lng: 0 })),
    ).rejects.toThrow('Too far from this clan');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('denies a subscription when the caller is not a member', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') {
        return { Item: activeClan(now) };
      }
      return { Item: undefined };
    });

    await expect(handler(event('onClanEvent', { clanId: 'clan-1' }))).rejects.toThrow(
      'Membership required',
    );
  });

  it('returns the original committed send for a retried requestId', async () => {
    const now = Math.floor(Date.now() / 1000);
    const text = 'hello phase two';
    const hash = createHash('sha256').update(`clan-1\n${text}`, 'utf8').digest('hex');
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.PK ?? '');
      const sk = String(input.Key?.SK ?? '');
      if (pk === 'CLAN#clan-1' && sk === 'META') {
        return { Item: activeClan(now) };
      }
      if (pk === 'CLAN#clan-1' && sk === 'MEMBER#session-1') {
        return { Item: member(now) };
      }
      if (pk === 'SESSION#session-1' && sk === 'REQUEST#request-1') {
        return {
          Item: {
            clanId: 'clan-1',
            messageId: 'message-1',
            payloadHash: hash,
            status: 'APPROVED',
            revision: 1,
            expiresAt: now + 3000,
          },
        };
      }
      return { Item: undefined };
    });

    const result = await handler(
      event('sendMessage', { clanId: 'clan-1', requestId: 'request-1', text }),
    );

    expect(result).toMatchObject({
      messageId: 'message-1',
      status: 'APPROVED',
      revision: 1,
    });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    // Only requireSession touches the rate/session table; a deduplicated retry does not write a second message.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it('returns authorized history while keeping non-approved text private', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') {
        return { Item: activeClan(now) };
      }
      if (input.Key?.SK === 'MEMBER#session-1') {
        return { Item: member(now) };
      }
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'CLAN#clan-1',
          SK: 'MSG#2',
          messageId: '2',
          clanId: 'clan-1',
          memberId: 'member-1',
          alias: 'SwiftFox-123',
          text: 'private pending text',
          status: 'PENDING',
          revision: 1,
          createdAt: now - 5,
          expiresAt: now + 3000,
        },
        {
          PK: 'CLAN#clan-1',
          SK: 'MSG#1',
          messageId: '1',
          clanId: 'clan-1',
          memberId: 'member-1',
          alias: 'SwiftFox-123',
          text: 'approved text',
          status: 'APPROVED',
          revision: 1,
          createdAt: now - 10,
          expiresAt: now + 3000,
        },
      ],
    });

    const result = await handler(event('listMessages', { clanId: 'clan-1' })) as {
      items: Array<{ status: string; text: string | null }>;
    };

    expect(result.items).toEqual([
      expect.objectContaining({ status: 'PENDING', text: null }),
      expect.objectContaining({ status: 'APPROVED', text: 'approved text' }),
    ]);
  });

  it('joins a nearby clan and creates membership atomically', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      const sk = String(input.Key?.SK ?? '');
      if (sk === 'META') {
        return { Item: activeClan(now) };
      }
      if (sk === 'MEMBER#session-1') {
        return { Item: undefined };
      }
      return { Item: undefined };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(
      event('joinClan', { clanId: 'clan-1', lat: 22.5726, lng: 88.3639 }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      clanId: 'clan-1',
      title: 'Robotics Lab',
      myMemberId: expect.any(String),
      myAlias: expect.any(String),
    });

    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const items = calls[0]!.args[0].input.TransactItems;
    expect(items).toHaveLength(2);
    expect(items?.[0]?.ConditionCheck?.Key).toEqual({ PK: 'CLAN#clan-1', SK: 'META' });
    expect(items?.[1]?.Put?.Item).toMatchObject({
      PK: 'CLAN#clan-1',
      SK: 'MEMBER#session-1',
      sessionId: 'session-1',
    });
  });

  it('denies message history to a non-member before querying messages', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') {
        return { Item: activeClan(now) };
      }
      return { Item: undefined };
    });

    await expect(handler(event('listMessages', { clanId: 'clan-1' }))).rejects.toThrow(
      'Membership required',
    );
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('commits a new message and request deduplication record in one transaction', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.PK ?? '');
      const sk = String(input.Key?.SK ?? '');
      if (pk === 'CLAN#clan-1' && sk === 'META') {
        return { Item: activeClan(now) };
      }
      if (pk === 'CLAN#clan-1' && sk === 'MEMBER#session-1') {
        return { Item: member(now) };
      }
      if (pk === 'SESSION#session-1' && sk === 'REQUEST#request-new') {
        return { Item: undefined };
      }
      return { Item: undefined };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(
      event('sendMessage', { clanId: 'clan-1', requestId: 'request-new', text: 'hello' }),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      messageId: expect.any(String),
      status: 'APPROVED',
      revision: 1,
    });

    const calls = ddbMock.commandCalls(TransactWriteCommand);
    expect(calls).toHaveLength(1);
    const items = calls[0]!.args[0].input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items?.[2]?.Put?.Item).toMatchObject({
      PK: 'CLAN#clan-1',
      clanId: 'clan-1',
      text: 'hello',
      status: 'APPROVED',
      revision: 1,
    });
    expect(items?.[3]?.Put?.Item).toMatchObject({
      PK: 'SESSION#session-1',
      SK: 'REQUEST#request-new',
      clanId: 'clan-1',
      status: 'APPROVED',
      revision: 1,
    });
  });

  it('rejects reusing a requestId with different message content', async () => {
    const now = Math.floor(Date.now() / 1000);
    const originalHash = createHash('sha256').update('clan-1\noriginal', 'utf8').digest('hex');
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.PK ?? '');
      const sk = String(input.Key?.SK ?? '');
      if (pk === 'CLAN#clan-1' && sk === 'META') {
        return { Item: activeClan(now) };
      }
      if (pk === 'CLAN#clan-1' && sk === 'MEMBER#session-1') {
        return { Item: member(now) };
      }
      if (pk === 'SESSION#session-1' && sk === 'REQUEST#request-1') {
        return {
          Item: {
            clanId: 'clan-1',
            messageId: 'message-1',
            payloadHash: originalHash,
            status: 'APPROVED',
            revision: 1,
            expiresAt: now + 3000,
          },
        };
      }
      return { Item: undefined };
    });

    await expect(
      handler(event('sendMessage', { clanId: 'clan-1', requestId: 'request-1', text: 'changed' })),
    ).rejects.toThrow('requestId was already used with different content');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

});
