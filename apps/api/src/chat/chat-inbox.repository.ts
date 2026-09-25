import { Injectable } from '@nestjs/common';
import type { ChatRoomType, EventHostType, EventStatus, MessageType } from '@tripwith/shared';
import { DataSource } from 'typeorm';

/** One flat row per ACTIVE membership; every presentation join is LEFT, so a row never disappears for lack of metadata. */
export interface InboxRow {
  readonly room_id: string;
  readonly type: ChatRoomType;
  readonly joined_at: Date;
  readonly unread_count: string | number;

  readonly lm_id: string | null;
  readonly lm_seq: string | number | null;
  readonly lm_sender_user_id: string | null;
  readonly lm_type: MessageType | null;
  readonly lm_body: string | null;
  readonly lm_created_at: Date | null;

  readonly event_id: string | null;
  readonly event_title: string | null;
  readonly event_host_type: EventHostType | null;
  readonly event_status: EventStatus | null;
  readonly event_starts_at: Date | null;
  readonly event_capacity_min: number | null;
  readonly event_capacity_max: number | null;
  readonly event_reserved_seat_count: number | null;
  readonly event_host_user_id: string | null;
  readonly event_host_display_name: string | null;
  readonly event_host_avatar_url: string | null;
  readonly event_provider_id: string | null;
  readonly event_provider_name: string | null;

  readonly counterpart_user_id: string | null;
  readonly counterpart_display_name: string | null;
  readonly counterpart_avatar_url: string | null;

  readonly room_provider_id: string | null;
  readonly room_provider_name: string | null;
}

/**
 * The whole Inbox in ONE statement (no per-room queries). Authorization is
 * the driving WHERE clause itself: rows start from the caller's own
 * chat_members rows with left_at IS NULL (served by chat_members_user_idx),
 * so a left/removed membership, a pending or historical Join Request, or
 * Event participation without chat membership can never surface a room.
 *
 * Presentation joins select display columns only: the Event host's profile
 * display name/avatar (none for a deleted account), the Provider's name
 * (never owner_user_id or contact data), and for MATCH rooms the OTHER
 * party resolved from the canonical matches row — not from chat_members, so
 * no member list is ever read. The latest visible (non-soft-deleted) message
 * is a LATERAL LIMIT 1 on messages_room_seq_idx, excluding media keys and
 * shared locations exactly as history does by never selecting them here.
 *
 * Ordering: latest visible message time, else the caller's joined_at, newest
 * first; room id ascending breaks ties deterministically.
 */
export const INBOX_SQL = `
SELECT cr.id                                        AS room_id,
       cr.type                                      AS type,
       cm.joined_at                                 AS joined_at,
       GREATEST(cr.last_seq - cm.last_read_seq, 0)  AS unread_count,

       lm.id                                        AS lm_id,
       lm.seq                                       AS lm_seq,
       lm.sender_user_id                            AS lm_sender_user_id,
       lm.type                                      AS lm_type,
       lm.body                                      AS lm_body,
       lm.created_at                                AS lm_created_at,

       e.id                                         AS event_id,
       e.title                                      AS event_title,
       e.host_type                                  AS event_host_type,
       e.status                                     AS event_status,
       e.starts_at                                  AS event_starts_at,
       e.capacity_min                               AS event_capacity_min,
       e.capacity_max                               AS event_capacity_max,
       e.reserved_seat_count                        AS event_reserved_seat_count,
       e.host_user_id                               AS event_host_user_id,
       host_profile.display_name                    AS event_host_display_name,
       host_profile.avatar_url                      AS event_host_avatar_url,
       event_provider.id                            AS event_provider_id,
       event_provider.name                          AS event_provider_name,

       counterpart.id                               AS counterpart_user_id,
       counterpart_profile.display_name             AS counterpart_display_name,
       counterpart_profile.avatar_url               AS counterpart_avatar_url,

       room_provider.id                             AS room_provider_id,
       room_provider.name                           AS room_provider_name
  FROM chat_members cm
  JOIN chat_rooms cr ON cr.id = cm.room_id
  LEFT JOIN LATERAL (
         SELECT m.id, m.seq, m.sender_user_id, m.type, m.body, m.created_at
           FROM messages m
          WHERE m.room_id = cr.id AND m.deleted_at IS NULL
          ORDER BY m.seq DESC
          LIMIT 1
       ) lm ON TRUE
  LEFT JOIN events e
         ON cr.type = 'EVENT' AND e.id = cr.event_id
  LEFT JOIN users host_user
         ON host_user.id = e.host_user_id AND host_user.deleted_at IS NULL
  LEFT JOIN user_profiles host_profile
         ON host_profile.user_id = host_user.id
  LEFT JOIN providers event_provider
         ON event_provider.id = e.host_provider_id
  LEFT JOIN matches mt
         ON cr.type = 'MATCH' AND mt.chat_room_id = cr.id
  LEFT JOIN users counterpart
         ON counterpart.id = CASE WHEN mt.user_a_id = cm.user_id THEN mt.user_b_id
                                  WHEN mt.user_b_id = cm.user_id THEN mt.user_a_id END
  LEFT JOIN user_profiles counterpart_profile
         ON counterpart_profile.user_id = counterpart.id AND counterpart.deleted_at IS NULL
  LEFT JOIN providers room_provider
         ON cr.type = 'PROVIDER_INQUIRY' AND room_provider.id = cr.provider_id
 WHERE cm.user_id = $1
   AND cm.left_at IS NULL
   AND ($2::uuid IS NULL OR cm.room_id = $2::uuid)
 ORDER BY COALESCE(lm.created_at, cm.joined_at) DESC, cr.id ASC`;

@Injectable()
export class ChatInboxRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Every room where userId is an active member, newest activity first. */
  listInboxRows(userId: string): Promise<InboxRow[]> {
    return this.dataSource.query(INBOX_SQL, [userId, null]) as Promise<InboxRow[]>;
  }

  /** The same row for one room, or null when userId is not an active member (or it does not exist). */
  async findInboxRow(userId: string, roomId: string): Promise<InboxRow | null> {
    const rows = (await this.dataSource.query(INBOX_SQL, [userId, roomId])) as InboxRow[];
    return rows[0] ?? null;
  }
}
