import type { MessageType } from '@tripwith/shared';

export interface MessageView {
  readonly id: string;
  readonly roomId: string;
  readonly seq: number;
  readonly senderUserId: string;
  readonly type: MessageType;
  readonly body: string;
  readonly clientMessageId: string;
  readonly createdAt: string;
}

export interface PersistedMessage {
  readonly id: string;
  readonly roomId: string;
  readonly seq: number;
  readonly senderUserId: string;
  readonly type: MessageType;
  readonly body: string;
  readonly clientMessageId: string;
  readonly createdAt: Date;
}

export interface MessagePage {
  readonly messages: readonly PersistedMessage[];
  readonly hasMore: boolean;
}

export interface MessagePageView {
  readonly messages: readonly MessageView[];
  readonly hasMore: boolean;
}

export interface ReadStateView {
  readonly lastReadSeq: number;
}
