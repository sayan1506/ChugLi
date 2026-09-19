export type MessageStatus = 'APPROVED' | 'PENDING' | 'BLOCKED' | 'HIDDEN';
export type ReportReason = 'THREAT' | 'HARASSMENT' | 'SPAM' | 'OTHER';

export interface ChatMessage {
  messageId: string;
  clanId: string;
  memberId: string;
  alias: string;
  text: string | null;
  status: MessageStatus;
  muted: boolean;
  locallyHidden?: boolean;
  revision: number;
  createdAt: number;
  expiresAt: number;
}

export interface MessagePage {
  items: ChatMessage[];
  nextToken: string | null;
  serverNow: number;
}

export interface ModerationResult {
  messageId: string;
  status: MessageStatus;
  revision: number;
  expiresAt: number;
  serverNow: number;
  reviewPending: boolean;
}
