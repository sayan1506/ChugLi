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

function logError(operation: string, err: unknown): void {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : 'UnknownError';
  console.error(JSON.stringify({ operation, errorName: name }));
}

async function createSession(sessionPk: string, now: number): Promise<StartSessionResult> {
  const expiresAt = now + SESSION_INACTIVITY_SECONDS;
  for (let attempt = 1; attempt <= MAX_CONDITIONAL_WRITE_ATTEMPTS; attempt++) {
    const sessionId = crypto.randomUUID();
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
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
      return { sessionId, expiresAt, serverNow: now };
    } catch (err) {
      const isConditionalFailure =
        typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ConditionalCheckFailedException';
      if (isConditionalFailure && attempt < MAX_CONDITIONAL_WRITE_ATTEMPTS) {
        const fresh = await doc
          .send(
            new GetCommand({
              TableName: process.env.CHUGLI_TABLE_NAME,
              Key: { PK: sessionPk, SK: 'META' },
              ConsistentRead: true,
            }),
          )
          .catch(() => undefined);
        const item = fresh?.Item as SessionMetaItem | undefined;
        if (item && typeof item.sessionId === 'string' && item.expiresAt > now) {
          return { sessionId: item.sessionId, expiresAt: item.expiresAt, serverNow: now };
        }
        continue;
      }
      logError('createSession', err);
      throw err;
    }
  }
  throw new Error('Session creation failed after retries');
}

async function touchSession(sessionPk: string, now: number, existing: SessionMetaItem): Promise<StartSessionResult> {
  try {
    await doc.send(
      new PutCommand({
        TableName: process.env.CHUGLI_TABLE_NAME,
        Item: { ...existing, lastSeenAt: now },
        ConditionExpression: 'sessionId = :sid AND expiresAt = :exp',
        ExpressionAttributeValues: { ':sid': existing.sessionId, ':exp': existing.expiresAt },
      }),
    );
  } catch (err) {
    const isConditionalFailure =
      typeof err === 'object' && err !== null && (err as { name?: string }).name === 'ConditionalCheckFailedException';
    if (!isConditionalFailure) {
      logError('touchSession', err);
      throw err;
    }
  }
  return { sessionId: existing.sessionId, expiresAt: existing.expiresAt, serverNow: now };
}

export async function handler(event: AppSyncResolverEvent<unknown>): Promise<StartSessionResult> {
  try {
    const now = serverNowSeconds();
    const identityId = verifiedIdentityId(event);
    const sessionPk = `SESSION#${identityId}`;

    const get = await doc.send(
      new GetCommand({
        TableName: process.env.CHUGLI_TABLE_NAME,
        Key: { PK: sessionPk, SK: 'META' },
        ConsistentRead: true,
      }),
    );
    const existing = get.Item as SessionMetaItem | undefined;

    if (
      existing &&
      typeof existing.sessionId === 'string' &&
      existing.sessionId.length > 0 &&
      typeof existing.expiresAt === 'number' &&
      existing.expiresAt > now
    ) {
      return touchSession(sessionPk, now, existing);
    }

    return await createSession(sessionPk, now);
  } catch (err) {
    logError('handler', err);
    throw err;
  }
}
