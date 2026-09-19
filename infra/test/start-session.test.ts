import { describe, it, expect, beforeEach } from 'vitest';
import { handler } from '../lambda/start-session';
import { ddbMock } from './aws-client-mocks';
import { startSessionEvent } from './fixtures';
import type { AppSyncResolverEvent } from 'aws-lambda';
import { PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { PutCommandInput } from '@aws-sdk/lib-dynamodb';

function conditionalFailure(): Error {
  const error = new Error('Conditional check failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
}

describe('startSession resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    process.env.CHUGLI_TABLE_NAME = 'TestTable';
    process.env.SESSION_INACTIVITY_SECONDS = '86400';
  });

  function getPutInput(index = 0): PutCommandInput {
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls.length).toBeGreaterThan(index);
    const cmd = calls[index]!.args[0] as { input: PutCommandInput };
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
      expiresAt: result.expiresAt,
    });
    expect(putInput.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('returns the existing session and extends the 24-hour inactivity expiry when active', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldExpiresAt = now + 600;
    ddbMock.on(GetCommand).resolves({
      Item: { sessionId: 'existing-session', createdAt: now - 100, lastSeenAt: now - 100, expiresAt: oldExpiresAt },
    });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);

    expect(result.sessionId).toBe('existing-session');
    expect(result.expiresAt).toBe(result.serverNow + 86400);
    expect(result.expiresAt).toBeGreaterThan(oldExpiresAt);

    const putInput = getPutInput();
    expect(putInput.Item).toMatchObject({
      sessionId: 'existing-session',
      lastSeenAt: result.serverNow,
      expiresAt: result.expiresAt,
    });
    expect(putInput.ConditionExpression).toBe('sessionId = :sid AND expiresAt = :exp');
    expect(putInput.ExpressionAttributeValues).toMatchObject({ ':sid': 'existing-session', ':exp': oldExpiresAt });
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

  it('replaces an expired session even while its TTL row still exists', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = {
      sessionId: 'old-session',
      createdAt: now - 90000,
      lastSeenAt: now - 90000,
      expiresAt: now - 3600,
    };
    ddbMock.on(GetCommand).resolves({ Item: expired });
    ddbMock.on(PutCommand).resolves({});

    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);

    expect(result.sessionId).not.toBe('old-session');
    expect(result.expiresAt).toBe(result.serverNow + 86400);

    const putInput = getPutInput();
    expect(putInput.Item).toMatchObject({ PK: 'SESSION#identity-1', SK: 'META', sessionId: result.sessionId });
    expect(putInput.ConditionExpression).toBe('sessionId = :oldSid AND expiresAt = :oldExp AND expiresAt <= :now');
    expect(putInput.ExpressionAttributeValues).toMatchObject({
      ':oldSid': 'old-session',
      ':oldExp': expired.expiresAt,
      ':now': result.serverNow,
    });
  });

  it('returns a concurrently-created active session after a conditional create conflict', async () => {
    const now = Math.floor(Date.now() / 1000);
    const concurrent = {
      sessionId: 'concurrent-session',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 86400,
    };

    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: undefined })
      .resolves({ Item: concurrent });
    ddbMock.on(PutCommand).rejectsOnce(conditionalFailure());

    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);

    expect(result.sessionId).toBe('concurrent-session');
    expect(result.expiresAt).toBe(concurrent.expiresAt);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it('recovers from a concurrent touch conflict by returning the fresh active session', async () => {
    const now = Math.floor(Date.now() / 1000);
    const existing = {
      sessionId: 'existing-session',
      createdAt: now - 100,
      lastSeenAt: now - 100,
      expiresAt: now + 600,
    };
    const fresh = {
      ...existing,
      lastSeenAt: now,
      expiresAt: now + 86400,
    };

    ddbMock
      .on(GetCommand)
      .resolvesOnce({ Item: existing })
      .resolves({ Item: fresh });
    ddbMock.on(PutCommand).rejectsOnce(conditionalFailure());

    const result = await handler(startSessionEvent as unknown as AppSyncResolverEvent<unknown>);

    expect(result.sessionId).toBe('existing-session');
    expect(result.expiresAt).toBe(fresh.expiresAt);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});
