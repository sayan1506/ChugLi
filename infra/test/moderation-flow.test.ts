import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbMock } from './aws-client-mocks';
import { handler } from '../lambda/app';

function event(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    arguments: args,
    identity: { cognitoIdentityPoolId: 'pool-1', cognitoIdentityId: 'identity-1' },
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

function callerMember(now: number) {
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

function targetMember(now: number) {
  return {
    PK: 'CLAN#clan-1',
    SK: 'MEMBER#session-2',
    sessionId: 'session-2',
    memberId: 'member-2',
    alias: 'BlueOtter-456',
    joinedAt: now - 20,
    expiresAt: now + 3000,
  };
}

function message(now: number) {
  return {
    PK: 'CLAN#clan-1',
    SK: 'MSG#message-1',
    messageId: 'message-1',
    clanId: 'clan-1',
    memberId: 'member-2',
    alias: 'BlueOtter-456',
    text: 'visible before moderation',
    status: 'APPROVED',
    revision: 1,
    createdAt: now - 10,
    expiresAt: now + 3000,
  };
}

describe('Phase 5 moderation and personal mute flow', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.CHUGLI_TABLE_NAME = 'TestTable';
    process.env.APPSYNC_GRAPHQL_URL = '';
    process.env.APPSYNC_REGION = 'us-east-1';
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (String(input.Key?.PK ?? '') === 'SESSION#identity-1') {
        return { Attributes: { sessionId: 'session-1', expiresAt: Math.floor(Date.now() / 1000) + 86400 } };
      }
      return {};
    });
  });

  it('stores a personal mute with clan expiry and active-member condition checks', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') return { Item: activeClan(now) };
      if (input.Key?.SK === 'MEMBER#session-1') return { Item: callerMember(now) };
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [callerMember(now), targetMember(now)] });
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event('muteMember', { clanId: 'clan-1', memberId: 'member-2' }));
    expect(result).toMatchObject({ memberId: 'member-2', muted: true });

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(transaction).toHaveLength(4);
    expect(transaction[3]?.Put?.Item).toMatchObject({
      PK: 'CLAN#clan-1',
      SK: 'MUTE#session-1#member-2',
      memberId: 'member-2',
      expiresAt: activeClan(now).expiresAt,
    });
  });

  it('redacts muted-member text on authorized history reads', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') return { Item: activeClan(now) };
      if (input.Key?.SK === 'MEMBER#session-1') return { Item: callerMember(now) };
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (String(input.ExpressionAttributeValues?.[':mutePrefix'] ?? '').startsWith('MUTE#session-1#')) {
        return { Items: [{ memberId: 'member-2', expiresAt: now + 3000 }] };
      }
      return { Items: [message(now)] };
    });

    const result = await handler(event('listMessages', { clanId: 'clan-1' })) as {
      items: Array<{ messageId: string; text: string | null; muted: boolean }>;
    };
    expect(result.items[0]).toMatchObject({ messageId: 'message-1', text: null, muted: true });
  });


  it('does not expose another member\'s pending or blocked submissions through history', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') return { Item: activeClan(now) };
      if (input.Key?.SK === 'MEMBER#session-1') return { Item: callerMember(now) };
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (String(input.ExpressionAttributeValues?.[':mutePrefix'] ?? '').startsWith('MUTE#session-1#')) {
        return { Items: [] };
      }
      return {
        Items: [
          { ...message(now), messageId: 'pending', SK: 'MSG#pending', status: 'PENDING', text: 'held secret' },
          { ...message(now), messageId: 'blocked', SK: 'MSG#blocked', status: 'BLOCKED', text: 'blocked secret' },
          { ...message(now), messageId: 'hidden', SK: 'MSG#hidden', status: 'HIDDEN', text: 'hidden secret' },
          { ...message(now), messageId: 'approved', SK: 'MSG#approved', status: 'APPROVED', text: 'visible text' },
        ],
      };
    });

    const result = await handler(event('listMessages', { clanId: 'clan-1' })) as {
      items: Array<{ messageId: string; status: string; text: string | null }>;
    };

    expect(result.items.map((item) => item.messageId)).toEqual(['hidden', 'approved']);
    expect(result.items[0]).toMatchObject({ status: 'HIDDEN', text: null });
    expect(result.items[1]).toMatchObject({ status: 'APPROVED', text: 'visible text' });
  });

  it('denies direct reads of another member\'s held submission', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).callsFake((input) => {
      const sk = String(input.Key?.SK ?? '');
      if (sk === 'META') return { Item: activeClan(now) };
      if (sk === 'MEMBER#session-1') return { Item: callerMember(now) };
      if (sk === 'MSG#message-1') return { Item: { ...message(now), status: 'PENDING', text: 'held secret' } };
      return { Item: undefined };
    });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      handler(event('getMessage', { clanId: 'clan-1', messageId: 'message-1' })),
    ).rejects.toThrow('Message not found');
  });

  it('does not start another model review for an already-recorded duplicate report', async () => {
    const now = Math.floor(Date.now() / 1000);
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      ddbMock.on(GetCommand).callsFake((input) => {
        const sk = String(input.Key?.SK ?? '');
        if (sk === 'META') return { Item: activeClan(now) };
        if (sk === 'MEMBER#session-1') return { Item: callerMember(now) };
        if (sk === 'MSG#message-1') return { Item: { ...message(now), reviewState: 'COMPLETE', reviewReason: 'BENIGN' } };
        if (sk === 'REPORT#message-1#session-1') {
          return { Item: { messageId: 'message-1', sessionId: 'session-1', reason: 'SPAM', expiresAt: now + 3000 } };
        }
        return { Item: undefined };
      });
      ddbMock.on(TransactWriteCommand).rejects(Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException' }));

      const result = await handler(event('reportMessage', {
        clanId: 'clan-1',
        messageId: 'message-1',
        reason: 'SPAM',
      }));

      expect(result).toMatchObject({ messageId: 'message-1', status: 'APPROVED' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
