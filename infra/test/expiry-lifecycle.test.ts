import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ChugLiStack } from '../lib/chugli-stack';
import { handler } from '../lambda/app';
import { ddbMock } from './aws-client-mocks';

function event(fieldName: string, args: Record<string, unknown> = {}) {
  return {
    arguments: args,
    identity: {
      cognitoIdentityPoolId: 'pool-1',
      cognitoIdentityId: 'identity-1',
    },
    info: {
      fieldName,
      parentTypeName: fieldName === 'onClanEvent' ? 'Subscription' : 'Query',
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

function clan(now: number, expiresAt = now + 600) {
  return {
    PK: 'CLAN#clan-1',
    SK: 'META',
    clanId: 'clan-1',
    title: 'Lifecycle Clan',
    category: 'Test',
    lat: 22.5726,
    lng: 88.3639,
    createdAt: now - 60,
    expiresAt,
  };
}

function member(now: number, expiresAt = now + 600) {
  return {
    PK: 'CLAN#clan-1',
    SK: 'MEMBER#session-1',
    sessionId: 'session-1',
    memberId: 'member-1',
    alias: 'CalmOwl-123',
    joinedAt: now - 30,
    expiresAt,
  };
}

describe('Phase 4 expiry and lifecycle backend guarantees', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.CHUGLI_TABLE_NAME = 'TestTable';
    process.env.APPSYNC_GRAPHQL_URL = '';
    process.env.APPSYNC_REGION = 'us-east-1';
    ddbMock.on(UpdateCommand).callsFake(sessionTouch);
  });

  it('gives the clan and creator membership the exact same server-generated expiry', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});

    const result = await handler(event('createClan', {
      title: 'Lifecycle Clan',
      category: 'Test',
      lat: 22.5726,
      lng: 88.3639,
    })) as { expiresAt: number; serverNow: number };

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const clanExpiry = transaction[0]?.Put?.Item?.expiresAt;
    const memberExpiry = transaction[1]?.Put?.Item?.expiresAt;

    expect(result.expiresAt).toBe(result.serverNow + 3600);
    expect(clanExpiry).toBe(result.expiresAt);
    expect(memberExpiry).toBe(result.expiresAt);
  });

  it('copies the active clan expiry to a newly joined membership', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 777;
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') {
        return { Item: clan(now, expiresAt) };
      }
      return { Item: undefined };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await handler(event('joinClan', { clanId: 'clan-1', lat: 22.5726, lng: 88.3639 }));

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(transaction[1]?.Put?.Item?.expiresAt).toBe(expiresAt);
  });

  it('copies the clan expiry to both a message and its retry-deduplication row', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 888;
    ddbMock.on(GetCommand).callsFake((input) => {
      const pk = String(input.Key?.PK ?? '');
      const sk = String(input.Key?.SK ?? '');
      if (pk === 'CLAN#clan-1' && sk === 'META') {
        return { Item: clan(now, expiresAt) };
      }
      if (pk === 'CLAN#clan-1' && sk === 'MEMBER#session-1') {
        return { Item: member(now, expiresAt) };
      }
      return { Item: undefined };
    });
    ddbMock.on(TransactWriteCommand).resolves({});

    await handler(event('sendMessage', {
      clanId: 'clan-1',
      requestId: 'phase4-request',
      text: 'expiry inheritance',
    }));

    const transaction = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(transaction[2]?.Put?.Item?.expiresAt).toBe(expiresAt);
    expect(transaction[3]?.Put?.Item?.expiresAt).toBe(expiresAt);
  });

  it.each([
    ['getClan', { clanId: 'clan-1' }],
    ['listMessages', { clanId: 'clan-1' }],
    ['getMessage', { clanId: 'clan-1', messageId: 'message-1' }],
    ['sendMessage', { clanId: 'clan-1', requestId: 'request-1', text: 'late message' }],
    ['onClanEvent', { clanId: 'clan-1' }],
    ['joinClan', { clanId: 'clan-1', lat: 22.5726, lng: 88.3639 }],
  ])('rejects %s while expired DynamoDB rows still physically exist', async (fieldName, args) => {
    const now = Math.floor(Date.now() / 1000);
    const expiredAt = now - 5;
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.Key?.SK === 'META') {
        return { Item: clan(now, expiredAt) };
      }
      if (input.Key?.SK === 'MEMBER#session-1') {
        return { Item: member(now, expiredAt) };
      }
      return { Item: undefined };
    });

    await expect(handler(event(fieldName, args))).rejects.toThrow('Clan not found or expired');
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('filters out expired clans from nearby discovery and queries geoSK > :now', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(QueryCommand).callsFake((input) => {
      expect(input.KeyConditionExpression).toBe('geoPK = :geoPK AND geoSK > :now');
      expect(input.ExpressionAttributeValues?.[':now']).toBe(now);
      return {
        Items: [
          {
            PK: 'CLAN#expired-clan',
            SK: 'META',
            clanId: 'expired-clan',
            title: 'Expired Clan',
            category: 'Test',
            lat: 22.5726,
            lng: 88.3639,
            expiresAt: now - 10,
          },
          {
            PK: 'CLAN#active-clan',
            SK: 'META',
            clanId: 'active-clan',
            title: 'Active Clan',
            category: 'Test',
            lat: 22.5726,
            lng: 88.3639,
            expiresAt: now + 500,
          },
        ],
      };
    });

    const result = await handler(event('nearbyClans', { lat: 22.5726, lng: 88.3639 })) as {
      items: Array<{ clanId: string }>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.clanId).toBe('active-clan');
  });

  it('keeps DynamoDB TTL enabled on expiresAt and defaults the deployed clan lifetime to one hour', () => {
    const app = new App();
    const stack = new ChugLiStack(app, 'ExpiryDefaultStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          CLAN_LIFETIME_SECONDS: '3600',
        },
      },
    });
  });

  it('supports an explicitly labelled accelerated lifetime for live Phase 4 testing', () => {
    const app = new App();
    app.node.setContext('clanLifetimeSeconds', '120');
    const stack = new ChugLiStack(app, 'ExpiryAcceleratedStack');
    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          CLAN_LIFETIME_SECONDS: '120',
        },
      },
    });
  });
});
