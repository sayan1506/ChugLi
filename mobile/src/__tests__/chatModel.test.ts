import { mergeMessages } from '@/hooks/useClanChat';
import type { ChatMessage } from '@/chat/types';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    messageId: 'm1',
    clanId: 'c1',
    memberId: 'member-1',
    alias: 'SwiftFox-123',
    text: 'hello',
    status: 'APPROVED',
    muted: false,
    revision: 1,
    createdAt: 100,
    expiresAt: 1000,
    ...overrides,
  };
}

describe('mergeMessages', () => {
  it('deduplicates messages and keeps the newest revision', () => {
    const result = mergeMessages(
      [message({ messageId: 'm1', revision: 1, text: 'old' })],
      [message({ messageId: 'm1', revision: 2, text: null, status: 'HIDDEN' })],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ messageId: 'm1', revision: 2, text: null, status: 'HIDDEN' });
  });



  it('preserves a reporter-side hidden message on equal-revision reconciliation', () => {
    const result = mergeMessages(
      [message({ messageId: 'm1', revision: 2, text: null, locallyHidden: true })],
      [message({ messageId: 'm1', revision: 2, text: 'server text', status: 'APPROVED' })],
    );

    expect(result[0]).toMatchObject({ messageId: 'm1', revision: 2, text: null, locallyHidden: true });
  });

  it('sorts message history oldest to newest for the chat view', () => {
    const result = mergeMessages([], [
      message({ messageId: 'm2', createdAt: 200 }),
      message({ messageId: 'm1', createdAt: 100 }),
    ]);

    expect(result.map((item) => item.messageId)).toEqual(['m1', 'm2']);
  });
});
