import { Injectable, Logger } from '@nestjs/common';
import { ChatRoomType } from '@tripwith/shared';

import { PresenceService, PresenceState, type PresenceUpdate } from '../realtime';

/**
 * Room types delivered via authoritative user:{userId} fan-out (fresh
 * chat_members read after commit, emit to each active member's personal
 * room). Positive-listed and fail-closed by construction: a future room
 * type (e.g. PROVIDER_INQUIRY) is silently NOT broadcast until explicitly
 * added here, rather than silently included by a negative check.
 *
 * EVENT joins MATCH on this list in WS3 using the exact same delivery
 * mechanism — no chat:{roomId} Socket.IO room, no subscribe step. That
 * mechanism would require reliably evicting a removed member's socket from
 * the room the instant chat_members.left_at is set, which nothing in this
 * codebase does yet; user:{userId} fan-out has no such gap because it
 * re-reads active membership fresh on every single send, so a removed
 * member simply stops appearing in activeMemberIds from that point on.
 */
const FAN_OUT_DELIVERABLE_ROOM_TYPES: ReadonlySet<ChatRoomType> = new Set([
  ChatRoomType.Match,
  ChatRoomType.Event,
]);

import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatRepository } from './chat.repository';
import type {
  MessagePage,
  MessagePageView,
  MessageView,
  PersistedMessage,
  ReadStateView,
} from './chat.types';
import type { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { HISTORY_DEFAULT_LIMIT } from './dto/list-messages-query.dto';
import type { SendMessageDto } from './dto/send-message.dto';
import type { SyncMessagesQueryDto } from './dto/sync-messages-query.dto';
import { SYNC_DEFAULT_LIMIT } from './dto/sync-messages-query.dto';
import type { UpdateReadStateDto } from './dto/update-read-state.dto';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly chat: ChatRepository,
    private readonly broadcast: ChatBroadcastService,
    private readonly presence: PresenceService,
  ) {}

  async sendTextMessage(
    roomId: string,
    senderUserId: string,
    dto: SendMessageDto,
  ): Promise<MessageView> {
    const { message, created } = await this.chat.sendTextMessage(
      roomId,
      senderUserId,
      dto.clientMessageId,
      dto.body,
    );
    const view = this.toView(message);

    // Only a newly persisted message triggers delivery — a clientMessageId
    // retry must never cause a second realtime emit. The message is already
    // durably committed at this point: nothing below may turn this into a
    // failed response, so any failure in the broadcast pipeline (the
    // post-commit lookup or the emit itself) is caught and logged, never
    // rethrown.
    if (created) {
      try {
        await this.broadcastToActiveMembers(roomId, view);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown error';
        this.logger.error(`Post-commit broadcast failed for room ${roomId}: ${message}`);
      }
    }

    return view;
  }

  async listHistory(
    roomId: string,
    userId: string,
    query: ListMessagesQueryDto,
  ): Promise<MessagePageView> {
    const page = await this.chat.listMessagesBefore(
      roomId,
      userId,
      query.beforeSeq ?? null,
      query.limit ?? HISTORY_DEFAULT_LIMIT,
    );
    return this.toPageView(page);
  }

  async syncMessages(
    roomId: string,
    userId: string,
    query: SyncMessagesQueryDto,
  ): Promise<MessagePageView> {
    const page = await this.chat.listMessagesAfter(
      roomId,
      userId,
      query.afterSeq,
      query.limit ?? SYNC_DEFAULT_LIMIT,
    );
    return this.toPageView(page);
  }

  async advanceReadState(
    roomId: string,
    userId: string,
    dto: UpdateReadStateDto,
  ): Promise<ReadStateView> {
    const lastReadSeq = await this.chat.advanceReadState(roomId, userId, dto.seq);
    return { lastReadSeq };
  }

  /**
   * WS4.1: authorized cross-user presence snapshot for a chat room.
   *
   * Authorization and the member list come from the same PostgreSQL
   * statement (ChatRepository.getActiveMemberIds) — the requester must
   * currently be an active member themselves, or this throws the same
   * generic ChatRoomNotFoundError used everywhere else in chat/**, with no
   * room-existence leakage. Target user ids are never accepted from the
   * client: the returned set is exactly "every current active member of
   * this room," nothing the caller can widen or narrow. Room-type agnostic
   * by construction — works for MATCH and EVENT identically, since both
   * are just chat_members rows.
   *
   * Presence itself is Redis-backed auxiliary state (PresenceService) —
   * a Redis failure there already fails safe to OFFLINE per WS4's design;
   * this method does nothing further to weaken or bypass that.
   */
  async getPresenceSnapshot(roomId: string, requesterId: string): Promise<readonly PresenceUpdate[]> {
    const memberIds = await this.chat.getActiveMemberIds(roomId, requesterId);
    const states = await this.presence.getStates(memberIds);
    return memberIds.map((userId) => ({
      userId,
      state: states.get(userId) ?? PresenceState.Offline,
    }));
  }

  /** Room-type gate: MATCH and EVENT both deliver to every active member's
   * user:{id} room via a fresh post-commit chat_members read — see
   * FAN_OUT_DELIVERABLE_ROOM_TYPES for why. Any other type is not
   * broadcast. */
  private async broadcastToActiveMembers(roomId: string, view: MessageView): Promise<void> {
    const targets = await this.chat.getBroadcastTargets(roomId);
    if (targets && FAN_OUT_DELIVERABLE_ROOM_TYPES.has(targets.type)) {
      this.broadcast.emitToUsers(targets.activeMemberIds, view);
    }
  }

  private toView(message: PersistedMessage): MessageView {
    return {
      id: message.id,
      roomId: message.roomId,
      seq: message.seq,
      senderUserId: message.senderUserId,
      type: message.type,
      body: message.body,
      clientMessageId: message.clientMessageId,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private toPageView(page: MessagePage): MessagePageView {
    return {
      messages: page.messages.map((message) => this.toView(message)),
      hasMore: page.hasMore,
    };
  }
}
