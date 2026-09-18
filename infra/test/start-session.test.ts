import { describe, it, expect, beforeEach } from 'vitest';
import { handler } from '../lambda/start-session';
import { ddbMock } from './aws-client-mocks';
import { startSessionEvent } from './fixtures';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PutCommandInput } from '@aws-sdk/lib-dynamodb';

describe('startSession resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.CHUGLI_TABLE_NAME = 'TestTable';
    process.env.SESSION_INACTIVITY_SECONDS = '86400';
  });

  function getPutInput(): PutCommandInput {
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const cmd = calls[0]!.args[0] as { input: PutCommandInput };
    return cmd.input;
  }

  it('creates a new session when none exists', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(PutCommand).resolves({});
    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);
    expect(result).toEqual({
      sessionId: expect.any(String),
      expiresAt: expect.any(Number),
      serverNow: expect.any(Number),
    });
    expect(result.expiresAt).toBe(result.serverNow + 86400);
    const putInput = getPutInput();
    expect(putInput.Item).toMatchObject({
      PK: 'SESSION#identity-1',
      SK: 'META',
      lastSeenAt: expect.any(Number),
    });
    expect(putInput.ConditionExpression).toContain('attribute_not_exists');
  });

  it('returns the existing session and bumps lastSeenAt when active', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).resolves({
      Item: { sessionId: 'existing-session', createdAt: now - 100, lastSeenAt: now - 100, expiresAt: now + 86000 },
    });
    ddbMock.on(PutCommand).resolves({});
    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);
    expect(result).toEqual({ sessionId: 'existing-session', expiresAt: now + 86000, serverNow: expect.any(Number) });
    const putInput = getPutInput();
    expect(putInput.Item).toMatchObject({ sessionId: 'existing-session', lastSeenAt: expect.any(Number) });
    expect(putInput.ConditionExpression).toContain('sessionId =');
  });

  it('rejects a call without a verified identity', async () => {
    const unauthenticated = { ...startSessionEvent, identity: undefined } as unknown as AppSyncResolverEvent<unknown>;
    await expect(handler(unauthenticated)).rejects.toThrow('Unauthorized');
  });

  it('rejects a call with a missing identityPoolId', async () => {
    const noPool = {
      ...startSessionEvent,
      identity: { identityId: 'identity-1' },
    } as unknown as AppSyncResolverEvent<unknown>;
    await expect(handler(noPool)).rejects.toThrow('Unauthorized');
  });

  it('rejects a call with a missing identityId', async () => {
    const noIdentityId = {
      ...startSessionEvent,
      identity: { identityPoolId: 'pool-1' },
    } as unknown as AppSyncResolverEvent<unknown>;
    await expect(handler(noIdentityId)).rejects.toThrow('Unauthorized');
  });

  it('rotates the session when the stored session has expired', async () => {
    const now = Math.floor(Date.now() / 1000);
    ddbMock.on(GetCommand).resolves({
      Item: { sessionId: 'old-session', createdAt: now - 90000, lastSeenAt: now - 90000, expiresAt: now - 3600 },
    });
    ddbMock.on(PutCommand).resolves({});
    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);
    expect(result.sessionId).not.toBe('old-session');
    expect(result.expiresAt).toBe(result.serverNow + 86400);
    const putInput = getPutInput();
    expect(putInput.Item).toMatchObject({ PK: 'SESSION#identity-1', SK: 'META', sessionId: result.sessionId });
    expect(putInput.ConditionExpression).toContain('attribute_not_exists');
  });
});
