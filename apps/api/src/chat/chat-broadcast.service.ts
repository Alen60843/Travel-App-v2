import { Injectable, Logger } from '@nestjs/common';

import { RealtimeGateway, userRoom } from '../realtime';

const CHAT_MESSAGE_EVENT = 'chat:message';

/**
 * Thin Socket.IO delivery wrapper. Receives already-authorized target user
 * ids and emits to each one's existing user:{id} room — it does not decide
 * membership, room type, or anything else business-authorization-related;
 * those decisions are made by the caller (ChatService) before this is ever
 * invoked. This is the only file under chat/ that imports RealtimeGateway or
 * any Socket.IO type.
 */
@Injectable()
export class ChatBroadcastService {
  private readonly logger = new Logger(ChatBroadcastService.name);

  constructor(private readonly gateway: RealtimeGateway) {}

  emitToUsers(userIds: readonly string[], payload: unknown): void {
    for (const userId of userIds) {
      try {
        this.gateway.server.to(userRoom(userId)).emit(CHAT_MESSAGE_EVENT, payload);
      } catch (error) {
        // A delivery failure is a realtime-layer concern only. The message
        // is already durably committed by the time this runs; it must never
        // be allowed to affect the outcome already returned to the caller.
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.error(`Failed to emit chat:message to user ${userId}: ${message}`);
      }
    }
  }
}
