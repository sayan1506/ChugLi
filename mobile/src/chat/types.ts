export type MessageStatus = 'APPROVED' | 'PENDING' | 'BLOCKED' | 'HIDDEN';

export interface ChatMessage {
  messageId: string;
  clanId: string;
  memberId: string;
  alias: string;
  text: string | null;
  status: MessageStatus;
  revision: number;
  createdAt: number;
  expiresAt: number;
}

export interface MessagePage {
  items: ChatMessage[];
  nextToken: string | null;
  serverNow: number;
}
