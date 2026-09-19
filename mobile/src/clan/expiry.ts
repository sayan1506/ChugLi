export interface ServerTimeAnchor {
  serverNowSeconds: number;
  monotonicMs: number;
}

export function createServerTimeAnchor(serverNowSeconds: number, monotonicMs: number): ServerTimeAnchor {
  return { serverNowSeconds, monotonicMs };
}

export function estimateServerNow(anchor: ServerTimeAnchor, monotonicMs: number): number {
  const elapsedSeconds = Math.max(0, monotonicMs - anchor.monotonicMs) / 1000;
  return anchor.serverNowSeconds + elapsedSeconds;
}

export function remainingClanSeconds(expiresAt: number, serverNow: number): number {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(serverNow)) {
    return 0;
  }
  return Math.max(0, Math.ceil(expiresAt - serverNow));
}

export function formatClanCountdown(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];

  if (error instanceof Error) {
    messages.push(error.message);
  } else if (typeof error === 'string') {
    messages.push(error);
  } else if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      messages.push(message);
    }
  }

  if (typeof error === 'object' && error !== null && 'graphQLErrors' in error) {
    const candidate = error as { graphQLErrors?: Array<{ message?: unknown }> };
    for (const graphQLError of candidate.graphQLErrors ?? []) {
      if (typeof graphQLError?.message === 'string') {
        messages.push(graphQLError.message);
      }
    }
  }

  return messages;
}

export function isExpiredClanError(error: unknown): boolean {
  return errorMessages(error).some((message) =>
    message.toLowerCase().includes('clan not found or expired'),
  );
}
