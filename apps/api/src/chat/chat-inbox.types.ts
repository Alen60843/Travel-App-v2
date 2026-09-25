import type {
  ChatRoomType,
  EventHostType,
  EventStatus,
  MessageType,
} from '@tripwith/shared';

import type { EventGroupState } from '../events/event-group-state';
import type { PublicEventHostSummary } from '../events/event-detail.types';

/**
 * Touchable Prototype Step 4: one row of the authenticated user's Inbox
 * (GET /v1/chat/rooms) and the room header (GET /v1/chat/rooms/:roomId).
 * Only rooms where the caller is an ACTIVE chat member ever appear. Never a
 * raw ChatRoom / ChatMember / Message entity, never a member list.
 */
export interface InboxRoomView {
  readonly roomId: string;
  readonly type: ChatRoomType;
  /** Server-chosen row title: Event title, the other traveller's name, or the Provider name. */
  readonly title: string;
  /** Server-chosen secondary line: the Event host's public name; null otherwise. */
  readonly subtitle: string | null;
  readonly avatarUrl: string | null;
  readonly eventId: string | null;
  /** EVENT rooms only. */
  readonly event: InboxEventSummary | null;
  /** MATCH rooms only: the OTHER traveller, never the caller and never other members. */
  readonly counterpart: InboxUserSummary | null;
  /** PROVIDER_INQUIRY rooms only (no product flow creates them yet). */
  readonly provider: InboxProviderSummary | null;
  readonly lastMessage: InboxLastMessage | null;
  /** Latest visible message time, else when the caller joined the room. */
  readonly lastActivityAt: string;
  /**
   * The schema's own O(1) definition: chat_rooms.last_seq -
   * chat_members.last_read_seq (never negative). It advances only through
   * PATCH /v1/chat/rooms/:roomId/read, exactly as before.
   */
  readonly unreadCount: number;
}

export interface InboxEventSummary {
  readonly id: string;
  readonly title: string;
  readonly hostType: EventHostType;
  readonly status: EventStatus;
  readonly startsAt: string;
  readonly capacityMin: number | null;
  readonly capacityMax: number;
  /** Physical travellers joined (party leaders + guests, plus a USER host's party). */
  readonly reservedSeatCount: number;
  readonly groupState: EventGroupState | null;
  readonly seatsToConfirm: number | null;
  /** Same public host summary as GET /v1/events/:eventId — never providers.owner_user_id. */
  readonly host: PublicEventHostSummary;
}

export interface InboxUserSummary {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

export interface InboxProviderSummary {
  readonly providerId: string;
  readonly name: string;
}

/** Only the fields the history endpoint already shows members; no media key, no shared location. */
export interface InboxLastMessage {
  readonly messageId: string;
  readonly seq: number;
  /** Null only for SYSTEM messages. */
  readonly senderUserId: string | null;
  readonly type: MessageType;
  readonly body: string | null;
  readonly createdAt: string;
}
