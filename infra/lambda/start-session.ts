import type { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

interface SessionMetaItem {
  sessionId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

interface StartSessionResult {
  sessionId: string;
  expiresAt: number;
  serverNow: number;
}

const SESSION_INACTIVITY_SECONDS = Number(process.env.SESSION_INACTIVITY_SECONDS ?? '86400');
const MAX_CONDITIONAL_WRITE_ATTEMPTS = 5;

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function serverNowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function verifiedIdentityId(event: AppSyncResolverEvent<unknown>): string {
  const identity = event.identity;
  if (!identity || typeof identity !== 'object') {
    throw new Error('Unauthorized');
  }
  const identityRecord = identity as unknown as Record<string, unknown>;
  const poolId = identityRecord.cognitoIdentityPoolId ?? identityRecord.identityPoolId;
  const identityId = identityRecord.cognitoIdentityId ?? identityRecord.identityId;
  if (typeof poolId !== 'string' || poolId.length === 0) {
    throw new Error('Unauthorized');
  }
  if (typeof identityId !== 'string' || identityId.length === 0) {
    throw new Error('Unauthorized');
  }
  return identityId;
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

function isUsableSession(item: SessionMetaItem | undefined, now: number): item is SessionMetaItem {
  return Boolean(
    item &&
      typeof item.sessionId === 'string' &&
      item.sessionId.length > 0 &&
      typeof item.expiresAt === 'number' &&
      item.expiresAt > now,
  );
}

function logError(operation: string, err: unknown): void {
  const name =
    typeof err === 'object' && err !== null && 'name' in err
      ? String((err as { name: unknown }).name)
      : 'UnknownError';
  console.error(JSON.stringify({ operation, errorName: name }));
}

async function readSession(sessionPk: string): Promise<SessionMetaItem | undefined> {
  const result = await doc.send(
    new GetCommand({
      TableName: process.env.CHUGLI_TABLE_NAME,
      Key: { PK: sessionPk, SK: 'META' },
      ConsistentRead: true,
    }),
  );
  return result.Item as SessionMetaItem | undefined;
}

async function createOrRotateSession(
  sessionPk: string,
  now: number,
  initialExpired?: SessionMetaItem,
): Promise<StartSessionResult> {
  const expiresAt = now + SESSION_INACTIVITY_SECONDS;
  let expectedExpired = initialExpired;

  for (let attempt = 1; attempt <= MAX_CONDITIONAL_WRITE_ATTEMPTS; attempt++) {
    const sessionId = crypto.randomUUID();
    const conditionExpression = expectedExpired
      ? 'sessionId = :oldSid AND expiresAt = :oldExp AND expiresAt <= :now'
      : 'attribute_not_exists(PK)';
    const expressionAttributeValues = expectedExpired
      ? {
          ':oldSid': expectedExpired.sessionId,
          ':oldExp': expectedExpired.expiresAt,
          ':now': now,
        }
      : undefined;

    try {
      await doc.send(
        new PutCommand({
          TableName: process.env.CHUGLI_TABLE_NAME,
          Item: {
            PK: sessionPk,
            SK: 'META',
            sessionId,
            createdAt: now,
            lastSeenAt: now,
            expiresAt,
          },
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: expressionAttributeValues,
        }),
      );
      return { sessionId, expiresAt, serverNow: now };
    } catch (err) {
      if (!isConditionalCheckFailure(err)) {
        logError('createOrRotateSession', err);
        throw err;
      }

      const fresh = await readSession(sessionPk).catch(() => undefined);
      if (isUsableSession(fresh, now)) {
        return { sessionId: fresh.sessionId, expiresAt: fresh.expiresAt, serverNow: now };
      }

      expectedExpired = fresh;
      if (attempt === MAX_CONDITIONAL_WRITE_ATTEMPTS) {
        break;
      }
    }
  }

  throw new Error('Session creation failed after retries');
}

async function touchSession(sessionPk: string, now: number, existing: SessionMetaItem): Promise<StartSessionResult> {
  const expiresAt = now + SESSION_INACTIVITY_SECONDS;

  try {
    await doc.send(
      new PutCommand({
        TableName: process.env.CHUGLI_TABLE_NAME,
        Item: { ...existing, lastSeenAt: now, expiresAt },
        ConditionExpression: 'sessionId = :sid AND expiresAt = :exp',
        ExpressionAttributeValues: { ':sid': existing.sessionId, ':exp': existing.expiresAt },
      }),
    );
    return { sessionId: existing.sessionId, expiresAt, serverNow: now };
  } catch (err) {
    if (!isConditionalCheckFailure(err)) {
      logError('touchSession', err);
      throw err;
    }

    const fresh = await readSession(sessionPk);
    if (isUsableSession(fresh, now)) {
      return { sessionId: fresh.sessionId, expiresAt: fresh.expiresAt, serverNow: now };
    }

    return createOrRotateSession(sessionPk, now, fresh);
  }
}

export async function handler(event: AppSyncResolverEvent<unknown>): Promise<StartSessionResult> {
  try {
    const now = serverNowSeconds();
    const identityId = verifiedIdentityId(event);
    const sessionPk = `SESSION#${identityId}`;
    const existing = await readSession(sessionPk);

    if (isUsableSession(existing, now)) {
      return touchSession(sessionPk, now, existing);
    }

    return createOrRotateSession(sessionPk, now, existing);
  } catch (err) {
    logError('handler', err);
    throw err;
  }
}
