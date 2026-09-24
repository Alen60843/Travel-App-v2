import { Injectable } from '@nestjs/common';
import { ChatRoomType, MessageType } from '@tripwith/shared';
import { DataSource, type EntityManager } from 'typeorm';

import { bigintTransformer } from '../database/entities/transformers';
import { ChatRoomNotFoundError } from './chat.errors';
import type { MessagePage, PersistedMessage } from './chat.types';

interface RoomRow {
  readonly id: string;
}

interface MessageRow {
  readonly id: string;
  readonly room_id: string;
  readonly seq: string;
  readonly sender_user_id: string;
  readonly type: MessageType;
  readonly body: string;
  readonly client_message_id: string;
  readonly created_at: Date | string;
}

/** A row from the combined membership + message-page query (see §4/§5 of the
 * approved WS2 design): a NULL `id` is the authorized-but-empty sentinel —
 * every other column is NULL alongside it, since Postgres NULL-fills the
 * whole unmatched side of a LEFT JOIN, never just one column of it — and is
 * distinct from zero total rows, which means unauthorized. */
interface MessagePageRow {
  readonly id: string | null;
  readonly room_id: string | null;
  readonly seq: string | null;
  readonly sender_user_id: string | null;
  readonly type: MessageType | null;
  readonly body: string | null;
  readonly client_message_id: string | null;
  readonly created_at: Date | string | null;
}

interface BroadcastTargetsRow {
  readonly type: ChatRoomType;
  readonly user_id: string | null;
}

export interface BroadcastTargets {
  readonly type: ChatRoomType;
  readonly activeMemberIds: readonly string[];
}

/** Internal repository/service contract only — never exposed on MessageView. */
export interface SendMessageResult {
  readonly message: PersistedMessage;
  readonly created: boolean;
}

/**
 * PostgreSQL authority for message send, history, sync, and read-state.
 *
 * The chat_rooms row lock (SELECT ... FOR UPDATE) is the serialization point
 * for every sender in a room: it is acquired first, before the membership
 * check and before the clientMessageId lookup, so a concurrent retry can
 * never race the BEFORE INSERT tw_assign_message_seq trigger into consuming
 * a sequence for what turns out to be a duplicate. A transaction blocked on
 * this lock re-reads the membership and idempotency state fresh once it
 * acquires the lock, so it always observes the winner's committed result.
 *
 * messages_client_dedupe_uk (the partial UNIQUE index on
 * (room_id, sender_user_id, client_message_id)) remains a database backstop
 * only — this repository's correctness does not depend on catching a
 * conflict from it, and no ON CONFLICT clause is used for idempotency.
 *
 * History and sync combine authorization and message visibility into a
 * single SQL statement (a LEFT JOIN from chat_members, never a separate
 * "check membership, then SELECT messages" pair) so there is no window
 * between authorization and read in which membership could theoretically
 * change. Read-state's authorization is instead enforced by its own UPDATE's
 * WHERE clause, which is equally atomic for the same reason.
 */
@Injectable()
export class ChatRepository {
  constructor(private readonly dataSource: DataSource) {}

  async sendTextMessage(
    roomId: string,
    senderUserId: string,
    clientMessageId: string,
    body: string,
  ): Promise<SendMessageResult> {
    return this.dataSource.transaction(async (manager) => {
      await this.lockRoom(manager, roomId);
      await this.assertActiveMember(manager, roomId, senderUserId);

      const existing = await this.findByClientMessageId(
        manager,
        roomId,
        senderUserId,
        clientMessageId,
      );
      if (existing) return { message: existing, created: false };

      const inserted = await this.insertMessage(manager, roomId, senderUserId, clientMessageId, body);
      return { message: inserted, created: true };
    });
  }

  /** Fresh, post-commit read: the room's authoritative type and its current
   * active members. Callers decide delivery routing from this — this method
   * makes no delivery decision itself. */
  async getBroadcastTargets(roomId: string): Promise<BroadcastTargets | null> {
    const rows = (await this.dataSource.query(
      `SELECT cr.type, cm.user_id
         FROM chat_rooms cr
         LEFT JOIN chat_members cm
           ON cm.room_id = cr.id AND cm.left_at IS NULL
        WHERE cr.id = $1`,
      [roomId],
    )) as BroadcastTargetsRow[];
    const [first] = rows;
    if (!first) return null;
    // chat_members' composite PK (room_id, user_id) already makes a
    // duplicate impossible for this query, but the target list feeds
    // directly into realtime fan-out (a duplicate there means a duplicate
    // emit), so de-duplicate defensively rather than relying solely on that
    // schema guarantee.
    const activeMemberIds = [
      ...new Set(rows.map((row) => row.user_id).filter((id): id is string => id !== null)),
    ];
    return { type: first.type, activeMemberIds };
  }

  /**
   * Authorization + membership listing in one statement: returns every
   * currently active member of roomId, but ONLY if the requester
   * themselves is currently an active member — otherwise 0 rows. This is
   * unambiguous (unlike history/sync's sentinel-row need) because an
   * authorized requester is themselves always at least one of the active
   * members returned, so 0 rows can only ever mean "not authorized," never
   * "authorized but empty."
   */
  async getActiveMemberIds(roomId: string, requesterId: string): Promise<readonly string[]> {
    const rows = (await this.dataSource.query(
      `SELECT cm.user_id
         FROM chat_members cm
        WHERE cm.room_id = $1
          AND cm.left_at IS NULL
          AND EXISTS (
                SELECT 1 FROM chat_members req
                 WHERE req.room_id = $1 AND req.user_id = $2 AND req.left_at IS NULL
              )`,
      [roomId, requesterId],
    )) as { readonly user_id: string }[];
    if (rows.length === 0) throw new ChatRoomNotFoundError();
    return rows.map((row) => row.user_id);
  }

  /**
   * ================================================================
   * WS5 CHAT-SIDE INTEGRATION CONTRACT
   * ================================================================
   * The three methods below (ensureEventRoom, activateEventMember,
   * deactivateEventMember) are internal integration primitives for a Phase 6
   * participant service that does not exist yet — not public HTTP endpoints,
   * not called from anywhere in this codebase today.
   *
   * Every one of them takes the CALLER's own EntityManager and never opens
   * its own transaction (no `this.dataSource.transaction(...)` wrapper,
   * unlike sendTextMessage/advanceReadState above). This is deliberate: the
   * intended caller is a future participant-approval/removal service that
   * performs its own event_participants/event_join_requests write and these
   * chat_members/chat_rooms writes in ONE PostgreSQL transaction, passing
   * its own manager through. Two failure orderings if that were split
   * across separate transactions: (a) participant approval commits, chat
   * activation fails — a paid/approved participant with no chat access; (b)
   * chat activation commits, participant approval rolls back — a stranger
   * sitting in the event's group chat despite never actually being
   * approved, a real authorization leak, not just a UX gap. Composing both
   * writes into the caller's single transaction eliminates both failure
   * modes; this repository does not and must not manage that transaction
   * itself.
   *
   * Deactivation needs no realtime/history/sync/read-state/presence code of
   * its own: WS3's broadcast target query and WS4.1's presence snapshot
   * both already re-read chat_members.left_at fresh on every call, so a
   * member excluded here is automatically excluded everywhere else the
   * instant this commits — nothing to duplicate.
   */

  /**
   * Idempotent get-or-create for a single event's EVENT-type chat room,
   * using the schema's own chat_rooms_event_uk partial unique index
   * ( ON chat_rooms (event_id) WHERE type = 'EVENT' ) as the correctness
   * backstop — same INSERT-then-re-SELECT-on-conflict shape already proven
   * by SwipesRepository.findOrCreateMatch for MATCH rooms. Concurrent or
   * repeated calls for the same eventId converge on exactly one room id.
   */
  async ensureEventRoom(manager: EntityManager, eventId: string): Promise<string> {
    const existing = (await manager.query(
      `SELECT id FROM chat_rooms WHERE event_id = $1 AND type = $2`,
      [eventId, ChatRoomType.Event],
    )) as RoomRow[];
    if (existing[0]) return existing[0].id;

    const inserted = (await manager.query(
      `INSERT INTO chat_rooms (type, event_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id) WHERE type = 'EVENT' DO NOTHING
       RETURNING id`,
      [ChatRoomType.Event, eventId],
    )) as RoomRow[];
    if (inserted[0]) return inserted[0].id;

    // Another transaction won the chat_rooms_event_uk race between our
    // SELECT and INSERT; its room is canonical.
    const resolved = (await manager.query(
      `SELECT id FROM chat_rooms WHERE event_id = $1 AND type = $2`,
      [eventId, ChatRoomType.Event],
    )) as RoomRow[];
    if (!resolved[0]) throw new Error('Canonical EVENT chat room disappeared during creation');
    return resolved[0].id;
  }

  /**
   * Narrow read-only lookup for a caller that needs the EVENT room id but
   * must NOT create one as a side effect (WS8.4B: cancelling membership in
   * an event that was never approved into never had a room, and must not
   * spuriously get one just because it's being left/removed). Returns null
   * rather than throwing — an absent room is a legitimate "nothing to
   * deactivate" case for the caller, not an error.
   */
  async findEventRoomId(manager: EntityManager, eventId: string): Promise<string | null> {
    const rows = (await manager.query(
      `SELECT id FROM chat_rooms WHERE event_id = $1 AND type = $2`,
      [eventId, ChatRoomType.Event],
    )) as RoomRow[];
    return rows[0]?.id ?? null;
  }

  /**
   * Idempotent activation, in a single statement so all three required
   * cases (no row, existing active row, existing left row) are handled by
   * one ON CONFLICT clause rather than three branches: missing -> inserted;
   * already active -> left_at overwritten with the same NULL it already
   * had; previously left -> reactivated by clearing left_at. Mirrors
   * SwipesRepository.ensureMembers's ON CONFLICT DO NOTHING idiom, upgraded
   * to DO UPDATE here specifically because — unlike a fresh MATCH — a prior
   * EVENT membership may already exist in a left state that needs clearing.
   */
  async activateEventMember(manager: EntityManager, roomId: string, userId: string): Promise<void> {
    await manager.query(
      `INSERT INTO chat_members (room_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (room_id, user_id) DO UPDATE SET left_at = NULL`,
      [roomId, userId],
    );
  }

  /**
   * Idempotent deactivation. The WHERE clause's own left_at IS NULL guard
   * makes every required case safe without branching: an active row is
   * updated; an already-inactive row matches zero rows and is left
   * untouched (no error, no double-timestamp overwrite); a missing row
   * likewise matches zero rows — a safe no-op, consistent with this being
   * an idempotent integration primitive rather than a user-facing
   * authorization boundary (there is no requester here to reject).
   */
  async deactivateEventMember(manager: EntityManager, roomId: string, userId: string): Promise<void> {
    await manager.query(
      `UPDATE chat_members
          SET left_at = now()
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId],
    );
  }

  /** Newest-first keyset page, seq < beforeSeq (or unbounded when omitted).
   * Soft-deleted messages (deleted_at) are excluded from this user-facing
   * read, matching the established convention for every other deleted_at
   * column in this schema (providers, reviews, provider_media all filter it
   * out of normal reads while retaining the row) — moderation evidence is
   * retained in the row, not shown to chat participants. This is unrelated
   * to messages_client_dedupe_uk, which has no deleted_at predicate and
   * remains intentionally binding regardless of delete state (see
   * findByClientMessageId). */
  async listMessagesBefore(
    roomId: string,
    userId: string,
    beforeSeq: number | null,
    limit: number,
  ): Promise<MessagePage> {
    const rows = (await this.dataSource.query(
      `SELECT m.id, m.room_id, m.seq, m.sender_user_id, m.type, m.body, m.client_message_id, m.created_at
         FROM chat_members cm
         LEFT JOIN (
           SELECT * FROM messages
            WHERE room_id = $1 AND ($2::bigint IS NULL OR seq < $2) AND deleted_at IS NULL
            ORDER BY seq DESC
            LIMIT $3
         ) m ON TRUE
        WHERE cm.room_id = $1 AND cm.user_id = $4 AND cm.left_at IS NULL
        ORDER BY m.seq DESC`,
      [roomId, beforeSeq, limit + 1, userId],
    )) as MessagePageRow[];
    return this.toMessagePage(rows, limit);
  }

  /** Ascending recovery page, seq > afterSeq — reconnect/sync. Soft-deleted
   * messages excluded — see listMessagesBefore's comment. */
  async listMessagesAfter(
    roomId: string,
    userId: string,
    afterSeq: number,
    limit: number,
  ): Promise<MessagePage> {
    const rows = (await this.dataSource.query(
      `SELECT m.id, m.room_id, m.seq, m.sender_user_id, m.type, m.body, m.client_message_id, m.created_at
         FROM chat_members cm
         LEFT JOIN (
           SELECT * FROM messages
            WHERE room_id = $1 AND seq > $2 AND deleted_at IS NULL
            ORDER BY seq ASC
            LIMIT $3
         ) m ON TRUE
        WHERE cm.room_id = $1 AND cm.user_id = $4 AND cm.left_at IS NULL
        ORDER BY m.seq ASC`,
      [roomId, afterSeq, limit + 1, userId],
    )) as MessagePageRow[];
    return this.toMessagePage(rows, limit);
  }

  /**
   * newRead = GREATEST(currentRead, LEAST(requestedSeq, room.last_seq)).
   *
   * Step 1 (assertActiveMember) is a fast-path check, not the sole
   * authorization gate: step 2's own WHERE independently re-includes
   * left_at IS NULL and this method throws on an unexpected 0-row result
   * from it too, so a membership change in the narrow window between the
   * two statements can never produce a stale or unauthorized write — the
   * UPDATE re-validates and fails safely on its own.
   */
  async advanceReadState(roomId: string, userId: string, requestedSeq: number): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertActiveMember(manager, roomId, userId);

      // TypeORM's manager.query() does NOT return a plain rows array for a
      // raw UPDATE/DELETE statement, even with RETURNING — the pg driver
      // reports this statement's command tag as "UPDATE" regardless of the
      // RETURNING clause, and TypeORM's PostgresQueryRunner.query() special-
      // cases UPDATE/DELETE to return [rows, rowCount] (see
      // node_modules/typeorm/driver/postgres/PostgresQueryRunner.js). Only
      // the default case (INSERT, SELECT) returns the bare rows array.
      // Destructuring [rows] here unwraps that outer tuple; using `rows`
      // directly (as if it were the rows array itself) silently reads
      // .last_read_seq off the wrong value.
      const [rows] = await manager.query(
        `WITH room AS (SELECT last_seq FROM chat_rooms WHERE id = $1)
         UPDATE chat_members cm
            SET last_read_seq = GREATEST(cm.last_read_seq, LEAST($3::bigint, room.last_seq))
           FROM room
          WHERE cm.room_id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL
        RETURNING cm.last_read_seq`,
        [roomId, userId, requestedSeq],
      ) as [Array<{ readonly last_read_seq: string }>, number];
      const row = rows[0];
      if (!row) throw new ChatRoomNotFoundError();

      const finalSeq = bigintTransformer.from(row.last_read_seq);
      if (finalSeq === null) throw new Error('chat_members.last_read_seq was unexpectedly NULL');
      return finalSeq;
    });
  }

  private async lockRoom(manager: EntityManager, roomId: string): Promise<void> {
    const rows = (await manager.query(
      `SELECT id FROM chat_rooms WHERE id = $1 FOR UPDATE`,
      [roomId],
    )) as RoomRow[];
    if (rows.length === 0) throw new ChatRoomNotFoundError();
  }

  private async assertActiveMember(
    manager: EntityManager,
    roomId: string,
    userId: string,
  ): Promise<void> {
    const rows = await manager.query(
      `SELECT 1
         FROM chat_members
        WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [roomId, userId],
    );
    if (rows.length === 0) throw new ChatRoomNotFoundError();
  }

  /**
   * Deliberately does NOT filter deleted_at IS NULL, unlike the user-facing
   * reads (listMessagesBefore/After). messages_client_dedupe_uk — the
   * partial unique index this lookup mirrors — has no deleted_at predicate
   * (`WHERE client_message_id IS NOT NULL` only), unlike every other
   * soft-delete column in this schema (providers_slug_uk,
   * reviews_user_per_event_uk, ...), which all pair their partial unique
   * index with deleted_at IS NULL to let a new row reclaim the slot after
   * deletion. This one's absence is a deliberate signal: a clientMessageId
   * stays permanently bound to its row even if that row is later
   * soft-deleted. Filtering deleted_at here would make a retry miss the
   * still-canonical row and then collide with that same still-live
   * constraint on INSERT — turning a graceful idempotent return into an
   * unhandled unique-violation. WS1's idempotency guarantee is preserved
   * exactly as-is.
   */
  private async findByClientMessageId(
    manager: EntityManager,
    roomId: string,
    senderUserId: string,
    clientMessageId: string,
  ): Promise<PersistedMessage | null> {
    const rows = (await manager.query(
      `SELECT id, room_id, seq, sender_user_id, type, body, client_message_id, created_at
         FROM messages
        WHERE room_id = $1 AND sender_user_id = $2 AND client_message_id = $3`,
      [roomId, senderUserId, clientMessageId],
    )) as MessageRow[];
    return rows[0] ? this.toMessage(rows[0]) : null;
  }

  private async insertMessage(
    manager: EntityManager,
    roomId: string,
    senderUserId: string,
    clientMessageId: string,
    body: string,
  ): Promise<PersistedMessage> {
    const [row] = (await manager.query(
      `INSERT INTO messages (room_id, sender_user_id, type, body, client_message_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, room_id, seq, sender_user_id, type, body, client_message_id, created_at`,
      [roomId, senderUserId, MessageType.Text, body, clientMessageId],
    )) as MessageRow[];
    if (!row) throw new Error('Failed to insert message');
    return this.toMessage(row);
  }

  private toMessagePage(rows: readonly MessagePageRow[], limit: number): MessagePage {
    if (rows.length === 0) throw new ChatRoomNotFoundError();

    // A NULL id is the authorized-but-empty sentinel (LEFT JOIN found no
    // matching message row); every other real message row has a non-null id.
    const messageRows = rows.filter((row): row is MessageRow => row.id !== null);
    const hasMore = messageRows.length > limit;
    const page = hasMore ? messageRows.slice(0, limit) : messageRows;
    return { messages: page.map((row) => this.toMessage(row)), hasMore };
  }

  private toMessage(row: MessageRow): PersistedMessage {
    const seq = bigintTransformer.from(row.seq);
    if (seq === null) throw new Error('messages.seq was unexpectedly NULL');
    return {
      id: row.id,
      roomId: row.room_id,
      seq,
      senderUserId: row.sender_user_id,
      type: row.type,
      body: row.body,
      clientMessageId: row.client_message_id,
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
    };
  }
}
