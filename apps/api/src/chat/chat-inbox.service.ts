import { Injectable } from '@nestjs/common';
import { ChatRoomType, EventHostType } from '@tripwith/shared';

import { bigintTransformer } from '../database/entities/transformers';
import type { PublicEventHostSummary } from '../events/event-detail.types';
import { deriveEventGroupFormation } from '../events/event-group-state';
import { ChatRoomNotFoundError } from './chat.errors';
import { ChatInboxRepository, type InboxRow } from './chat-inbox.repository';
import type {
  InboxEventSummary,
  InboxLastMessage,
  InboxProviderSummary,
  InboxRoomView,
  InboxUserSummary,
} from './chat-inbox.types';

@Injectable()
export class ChatInboxService {
  constructor(private readonly inbox: ChatInboxRepository) {}

  /** The caller's own Inbox; the user id only ever comes from authentication. */
  async listRooms(userId: string): Promise<readonly InboxRoomView[]> {
    return (await this.inbox.listInboxRows(userId)).map(toInboxRoomView);
  }

  /**
   * Room header for one room. Identical authorization to the Inbox (active
   * membership) and the same indistinguishable ChatRoomNotFoundError the
   * message endpoints use for "missing" and "not a member".
   */
  async getRoom(userId: string, roomId: string): Promise<InboxRoomView> {
    const row = await this.inbox.findInboxRow(userId, roomId);
    if (!row) throw new ChatRoomNotFoundError();
    return toInboxRoomView(row);
  }
}

export function toInboxRoomView(row: InboxRow): InboxRoomView {
  const event = row.type === ChatRoomType.Event ? eventSummary(row) : null;
  const counterpart = row.type === ChatRoomType.Match ? counterpartSummary(row) : null;
  const provider = row.type === ChatRoomType.ProviderInquiry ? providerSummary(row) : null;
  const lastMessage = lastMessageOf(row);

  let title = 'Conversation';
  let subtitle: string | null = null;
  let avatarUrl: string | null = null;
  if (event) {
    title = event.title;
    subtitle = event.host.type === 'PROVIDER' ? event.host.name : event.host.displayName;
    avatarUrl = event.host.type === 'USER' ? event.host.avatarUrl : null;
  } else if (counterpart) {
    title = counterpart.displayName ?? 'TripWith traveller';
    avatarUrl = counterpart.avatarUrl;
  } else if (provider) {
    title = provider.name;
  }

  return {
    roomId: row.room_id,
    type: row.type,
    title,
    subtitle,
    avatarUrl,
    eventId: event?.id ?? null,
    event,
    counterpart,
    provider,
    lastMessage,
    lastActivityAt: (lastMessage ? new Date(lastMessage.createdAt) : toDate(row.joined_at)).toISOString(),
    unreadCount: Math.max(0, Number(row.unread_count)),
  };
}

function eventSummary(row: InboxRow): InboxEventSummary | null {
  if (
    row.event_id === null || row.event_title === null || row.event_host_type === null
    || row.event_status === null || row.event_starts_at === null
    || row.event_capacity_max === null || row.event_reserved_seat_count === null
  ) {
    return null;
  }
  let host: PublicEventHostSummary;
  if (row.event_host_type === EventHostType.Provider && row.event_provider_id && row.event_provider_name) {
    host = { type: 'PROVIDER', providerId: row.event_provider_id, name: row.event_provider_name };
  } else if (row.event_host_user_id) {
    host = {
      type: 'USER',
      userId: row.event_host_user_id,
      displayName: row.event_host_display_name,
      avatarUrl: row.event_host_avatar_url,
    };
  } else {
    return null;
  }
  return {
    id: row.event_id,
    title: row.event_title,
    hostType: row.event_host_type,
    status: row.event_status,
    startsAt: toDate(row.event_starts_at).toISOString(),
    capacityMin: row.event_capacity_min,
    capacityMax: row.event_capacity_max,
    reservedSeatCount: row.event_reserved_seat_count,
    ...deriveEventGroupFormation({
      status: row.event_status,
      capacityMin: row.event_capacity_min,
      reservedSeatCount: row.event_reserved_seat_count,
    }),
    host,
  };
}

function counterpartSummary(row: InboxRow): InboxUserSummary | null {
  if (row.counterpart_user_id === null) return null;
  return {
    userId: row.counterpart_user_id,
    displayName: row.counterpart_display_name,
    avatarUrl: row.counterpart_avatar_url,
  };
}

function providerSummary(row: InboxRow): InboxProviderSummary | null {
  if (row.room_provider_id === null || row.room_provider_name === null) return null;
  return { providerId: row.room_provider_id, name: row.room_provider_name };
}

function lastMessageOf(row: InboxRow): InboxLastMessage | null {
  if (row.lm_id === null || row.lm_type === null || row.lm_created_at === null) return null;
  const seq = bigintTransformer.from(row.lm_seq === null ? null : String(row.lm_seq));
  if (seq === null) throw new Error('messages.seq was unexpectedly NULL');
  return {
    messageId: row.lm_id,
    seq,
    senderUserId: row.lm_sender_user_id,
    type: row.lm_type,
    body: row.lm_body,
    createdAt: toDate(row.lm_created_at).toISOString(),
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
