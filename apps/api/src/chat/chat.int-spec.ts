import { randomUUID } from 'node:crypto';

import { ChatRoomType, UserAccountStatus } from '@tripwith/shared';

import { AppDataSource } from '../database/data-source';
import { PresenceState, type PresenceService } from '../realtime';
import type { ChatBroadcastService } from './chat-broadcast.service';
import { ChatRoomNotFoundError } from './chat.errors';
import { ChatRepository } from './chat.repository';
import { ChatService } from './chat.service';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SyncMessagesQueryDto } from './dto/sync-messages-query.dto';
import { UpdateReadStateDto } from './dto/update-read-state.dto';

/**
 * A controllable fake, not a real Redis-backed PresenceService — this file
 * is PostgreSQL-focused (membership authorization is what's under test
 * here). Presence VALUE correctness (ONLINE/AFK/OFFLINE aggregation, TTL,
 * multi-session) is already unit-tested for real in presence.service.spec.ts
 * against PresenceService's actual logic; using a real Redis connection
 * here too would only add an unrelated infra dependency to a Postgres-only
 * test file for no additional coverage.
 */
function createFakePresenceService(states: ReadonlyMap<string, PresenceState> = new Map()) {
  return { getStates: jest.fn().mockResolvedValue(states) };
}

/**
 * WS2 + WS3 + WS4.1 + WS5 STATUS: written but not yet executed against a
 * live database — see the WS2/WS3/WS4.1/WS5 final reports. This file
 * requires a reachable PostgreSQL instance (`AppDataSource.initialize()`),
 * which was not available in the environment these tests were authored in.
 * Nothing here should be taken as a passing result until it has actually
 * been run.
 *
 * EVENT room creation itself (event ↔ chat_rooms provisioning, membership
 * activation from Phase 6 participant approval) is out of scope here and
 * deferred to WS5 — no application code creates EVENT rooms yet, so these
 * WS3/WS4.1 tests seed EVENT rooms/membership directly via raw SQL, exactly
 * like the MATCH tests above seed their fixtures.
 *
 * WS4.1's presence-snapshot tests use a controllable FAKE PresenceService
 * (see createFakePresenceService below), not a real Redis connection — this
 * file tests PostgreSQL membership authorization for real; presence VALUE
 * correctness is separately unit-tested for real in presence.service.spec.ts.
 *
 * WS5's tests exercise ChatRepository.ensureEventRoom/activateEventMember/
 * deactivateEventMember directly against real PostgreSQL, each wrapped in
 * its own AppDataSource.transaction(...) call standing in for a future
 * Phase 6 participant service's own transaction — these are internal
 * integration primitives with no Phase 6 caller yet (see events.entity.ts /
 * events.controller.ts: no join/approve/reject/leave endpoints exist), so
 * this file seeds a minimal event fixture directly via raw SQL rather than
 * depending on the events module.
 */

const RUN_ID = randomUUID().replace(/-/g, '');
const UID_PREFIX = `chat-int-${RUN_ID}`;

interface TestAccount {
  readonly id: string;
  readonly firebaseUid: string;
}

const createdRoomIds: string[] = [];

async function createUser(suffix: string): Promise<TestAccount> {
  const firebaseUid = `${UID_PREFIX}-${suffix}`;
  const [user] = await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, account_status, date_of_birth)
     VALUES ($1, $2, $3, DATE '1990-01-01')
     RETURNING id`,
    [firebaseUid, `${RUN_ID}-${suffix}@example.com`, UserAccountStatus.Active],
  );
  return { id: user.id as string, firebaseUid };
}

/**
 * `eventId`/`providerId` are required for their matching type and forbidden
 * otherwise — chat_rooms_context_chk (MATCH -> both NULL, EVENT ->
 * event_id IS NOT NULL, PROVIDER_INQUIRY -> provider_id IS NOT NULL)
 * rejects any other combination, and both columns carry real FKs, so
 * neither can ever be seeded with a fabricated/non-existent id — callers
 * must create a real Event/Provider first (see createEvent/createProvider
 * below) and pass its id here.
 */
async function createRoom(
  type: ChatRoomType = ChatRoomType.Match,
  eventId: string | null = null,
  providerId: string | null = null,
): Promise<string> {
  const [room] = await AppDataSource.query(
    `INSERT INTO chat_rooms (type, event_id, provider_id) VALUES ($1, $2, $3) RETURNING id`,
    [type, eventId, providerId],
  );
  createdRoomIds.push(room.id as string);
  return room.id as string;
}

async function addMember(roomId: string, userId: string, leftAt: Date | null = null): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO chat_members (room_id, user_id, left_at) VALUES ($1, $2, $3)`,
    [roomId, userId, leftAt],
  );
}

async function roomState(roomId: string): Promise<{ readonly messageCount: number; readonly lastSeq: number }> {
  const [row] = await AppDataSource.query(
    `SELECT
       (SELECT count(*)::int FROM messages WHERE room_id = $1) AS message_count,
       (SELECT last_seq::int FROM chat_rooms WHERE id = $1) AS last_seq`,
    [roomId],
  );
  return { messageCount: row.message_count, lastSeq: row.last_seq };
}

function sendDto(clientMessageId: string, body = 'hello'): SendMessageDto {
  return Object.assign(new SendMessageDto(), { clientMessageId, body });
}

const createdEventIds: string[] = [];
let ws5CategoryId: number | undefined;

/** Minimal, self-contained event fixture — WS5's chat-side contract must
 * not depend on the events module's own test helpers (out of Chat's scope
 * per the task), so this seeds directly via raw SQL, same convention as
 * createUser/createRoom above. */
async function createEventCategoryOnce(): Promise<number> {
  if (ws5CategoryId !== undefined) return ws5CategoryId;
  const [category] = await AppDataSource.query(
    `INSERT INTO event_categories (code, label, is_active, sort_order)
     VALUES ($1, $2, TRUE, 32767)
     RETURNING id`,
    // event_categories_code_chk: ^[a-z0-9_]{2,40}$ — no hyphens allowed.
    // RUN_ID is itself already hyphen-stripped (see its definition above),
    // but the literal template text must avoid them too; total length here
    // is 8 + 32 = 40, exactly at the constraint's upper bound.
    [`ws5_int_${RUN_ID}`, `WS5 integration ${RUN_ID.slice(0, 8)}`],
  );
  ws5CategoryId = category.id as number;
  return ws5CategoryId;
}

async function createEvent(hostUserId: string): Promise<string> {
  const categoryId = await createEventCategoryOnce();
  const [event] = await AppDataSource.query(
    `INSERT INTO events
       (host_type, host_user_id, category_id, title, capacity_max,
        starts_at, ends_at, meeting_point)
     VALUES ('USER', $1, $2, $3, 10,
             now() + INTERVAL '7 days', now() + INTERVAL '7 days 2 hours',
             ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326)::geography)
     RETURNING id`,
    [hostUserId, categoryId, `WS5 integration event ${randomUUID()}`],
  );
  createdEventIds.push(event.id as string);
  return event.id as string;
}

/**
 * A real, valid EVENT-typed chat_rooms row: creates a throwaway host user
 * and a real Event first, since chat_rooms.event_id carries a genuine FK
 * (never a fabricated UUID) and chat_rooms_context_chk requires
 * event_id IS NOT NULL for type = 'EVENT'.
 */
async function createEventRoom(): Promise<string> {
  const host = await createUser(`event-room-host-${randomUUID()}`);
  const eventId = await createEvent(host.id);
  return createRoom(ChatRoomType.Event, eventId);
}

const createdProviderIds: string[] = [];

async function createProvider(): Promise<string> {
  // providers_slug_chk: ^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$ — hyphens are
  // allowed, but total length is capped at 80. UID_PREFIX (9 + 32 chars)
  // plus a full hyphenated randomUUID() would exceed that, so this uses
  // an 8-char hex suffix instead, matching this file's own RUN_ID.slice(0,8)
  // convention for short unique labels.
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const [provider] = await AppDataSource.query(
    `INSERT INTO providers (slug, name) VALUES ($1, $2) RETURNING id`,
    [`${UID_PREFIX}-provider-${suffix}`, `Chat integration provider ${suffix}`],
  );
  createdProviderIds.push(provider.id as string);
  return provider.id as string;
}

/**
 * A real, valid PROVIDER_INQUIRY-typed chat_rooms row: creates a real
 * Provider first, for the same reason createEventRoom creates a real Event
 * — provider_id carries a genuine FK and chat_rooms_context_chk requires
 * provider_id IS NOT NULL for type = 'PROVIDER_INQUIRY'.
 */
async function createProviderInquiryRoom(): Promise<string> {
  const providerId = await createProvider();
  return createRoom(ChatRoomType.ProviderInquiry, null, providerId);
}

describe('chat core: send TEXT message (real PostgreSQL)', () => {
  let repository: ChatRepository;
  let service: ChatService;
  let broadcast: { emitToUsers: jest.Mock };
  let presence: ReturnType<typeof createFakePresenceService>;

  beforeAll(async () => {
    await AppDataSource.initialize();
    repository = new ChatRepository(AppDataSource);
    broadcast = { emitToUsers: jest.fn() };
    presence = createFakePresenceService();
    service = new ChatService(
      repository,
      broadcast as unknown as ChatBroadcastService,
      presence as unknown as PresenceService,
    );
  });

  afterAll(async () => {
    try {
      if (createdRoomIds.length > 0) {
        await AppDataSource.query(`DELETE FROM chat_rooms WHERE id = ANY($1::uuid[])`, [
          createdRoomIds,
        ]);
      }
      if (createdEventIds.length > 0) {
        // event_status_history is append-only (event_status_history_append_only
        // forbids UPDATE/DELETE unconditionally, including the cascade delete
        // from event_id ON DELETE CASCADE) — same pattern as
        // join-requests.int-spec.ts / reviews.int-spec.ts. The trigger is
        // disabled only for the duration of this one transaction, scoped to
        // exactly this suite's own tracked event ids; if any statement here
        // fails, the whole transaction — including the DISABLE TRIGGER —
        // rolls back, so the trigger is never left disabled outside this
        // block. events.host_user_id is ON DELETE RESTRICT, so events must
        // still be removed before the users who host them, below.
        await AppDataSource.transaction(async (manager) => {
          await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
          await manager.query(`DELETE FROM event_status_history WHERE event_id = ANY($1::uuid[])`, [
            createdEventIds,
          ]);
          await manager.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [
            createdEventIds,
          ]);
          await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
        });
      }
      if (createdProviderIds.length > 0) {
        await AppDataSource.query(`DELETE FROM providers WHERE id = ANY($1::uuid[])`, [
          createdProviderIds,
        ]);
      }
      await AppDataSource.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [
        `${UID_PREFIX}%`,
      ]);
      if (ws5CategoryId !== undefined) {
        await AppDataSource.query(`DELETE FROM event_categories WHERE id = $1`, [ws5CategoryId]);
      }
    } finally {
      await AppDataSource.destroy();
    }
  });

  beforeEach(() => {
    broadcast.emitToUsers.mockClear();
  });

  it('persists a TEXT message from an active member with seq = 1', async () => {
    const room = await createRoom();
    const sender = await createUser('happy-sender');
    await addMember(room, sender.id);

    const clientMessageId = randomUUID();
    const result = await service.sendTextMessage(room, sender.id, sendDto(clientMessageId, 'hi there'));

    expect(result.seq).toBe(1);
    expect(result.roomId).toBe(room);
    expect(result.senderUserId).toBe(sender.id);
    expect(result.body).toBe('hi there');
    expect(result.clientMessageId).toBe(clientMessageId);

    const [row] = await AppDataSource.query(
      `SELECT id, room_id, seq, sender_user_id, body, client_message_id
         FROM messages WHERE id = $1`,
      [result.id],
    );
    expect(row).toMatchObject({
      id: result.id,
      room_id: room,
      seq: '1',
      sender_user_id: sender.id,
      body: 'hi there',
      client_message_id: clientMessageId,
    });
  });

  it('assigns the next contiguous seq on a second send', async () => {
    const room = await createRoom();
    const sender = await createUser('second-send');
    await addMember(room, sender.id);

    const first = await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), 'one'));
    const second = await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), 'two'));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    await expect(roomState(room)).resolves.toEqual({ messageCount: 2, lastSeq: 2 });
  });

  it('rejects a non-member without inserting or advancing last_seq', async () => {
    const room = await createRoom();
    const stranger = await createUser('non-member');

    await expect(
      service.sendTextMessage(room, stranger.id, sendDto(randomUUID())),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    await expect(roomState(room)).resolves.toEqual({ messageCount: 0, lastSeq: 0 });
  });

  it('rejects a member whose left_at is set, without inserting or advancing last_seq', async () => {
    const room = await createRoom();
    const departed = await createUser('departed-member');
    await addMember(room, departed.id, new Date());

    await expect(
      service.sendTextMessage(room, departed.id, sendDto(randomUUID())),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    await expect(roomState(room)).resolves.toEqual({ messageCount: 0, lastSeq: 0 });
  });

  it('rejects a nonexistent room', async () => {
    const ghostRoom = randomUUID();
    const someone = await createUser('nonexistent-room-sender');

    await expect(
      service.sendTextMessage(ghostRoom, someone.id, sendDto(randomUUID())),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('makes an identical clientMessageId retry idempotent: same id/seq, no new row, last_seq unchanged', async () => {
    const room = await createRoom();
    const sender = await createUser('retry-sender');
    await addMember(room, sender.id);
    const clientMessageId = randomUUID();

    const first = await service.sendTextMessage(room, sender.id, sendDto(clientMessageId, 'original'));
    const afterFirst = await roomState(room);

    const retry = await service.sendTextMessage(room, sender.id, sendDto(clientMessageId, 'original'));
    const afterRetry = await roomState(room);

    expect(retry).toEqual(first);
    expect(afterRetry).toEqual(afterFirst);
    expect(afterRetry.messageCount).toBe(1);
  });

  it('scopes clientMessageId dedupe per sender: two different senders reusing the same id both succeed', async () => {
    const room = await createRoom();
    const senderA = await createUser('dedupe-sender-a');
    const senderB = await createUser('dedupe-sender-b');
    await addMember(room, senderA.id);
    await addMember(room, senderB.id);
    const sharedClientMessageId = randomUUID();

    const fromA = await service.sendTextMessage(room, senderA.id, sendDto(sharedClientMessageId, 'from A'));
    const fromB = await service.sendTextMessage(room, senderB.id, sendDto(sharedClientMessageId, 'from B'));

    expect(fromA.id).not.toBe(fromB.id);
    expect(fromA.senderUserId).toBe(senderA.id);
    expect(fromB.senderUserId).toBe(senderB.id);
    await expect(roomState(room)).resolves.toEqual({ messageCount: 2, lastSeq: 2 });
  });

  describe('concurrency: chat_rooms row lock serializes senders', () => {
    it('N concurrent identical retries converge to exactly one message and one consumed seq', async () => {
      const room = await createRoom();
      const sender = await createUser('concurrent-retry-sender');
      await addMember(room, sender.id);
      const clientMessageId = randomUUID();
      const N = 6;

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          service.sendTextMessage(room, sender.id, sendDto(clientMessageId, 'retry payload')),
        ),
      );

      const distinctIds = new Set(results.map((r) => r.id));
      const distinctSeqs = new Set(results.map((r) => r.seq));
      expect(distinctIds.size).toBe(1);
      expect(distinctSeqs.size).toBe(1);
      await expect(roomState(room)).resolves.toEqual({ messageCount: 1, lastSeq: 1 });
    });

    it('N concurrent distinct sends produce exactly N messages with a contiguous, gapless, non-duplicate seq range', async () => {
      const room = await createRoom();
      const sender = await createUser('concurrent-distinct-sender');
      await addMember(room, sender.id);
      const N = 8;

      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          service.sendTextMessage(room, sender.id, sendDto(randomUUID(), `message ${i}`)),
        ),
      );

      const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
      await expect(roomState(room)).resolves.toEqual({ messageCount: N, lastSeq: N });
    });
  });

  describe('idempotent send / broadcast gating (repository-level created flag)', () => {
    it('created is true on first insert, false on a clientMessageId retry', async () => {
      const room = await createRoom();
      const sender = await createUser('created-flag-sender');
      await addMember(room, sender.id);
      const clientMessageId = randomUUID();

      const first = await repository.sendTextMessage(room, sender.id, clientMessageId, 'first');
      const retry = await repository.sendTextMessage(room, sender.id, clientMessageId, 'first');

      expect(first.created).toBe(true);
      expect(retry.created).toBe(false);
      expect(retry.message.id).toBe(first.message.id);
      expect(retry.message.seq).toBe(first.message.seq);
    });

    it('broadcasts to active MATCH members exactly once, never on a retry', async () => {
      const room = await createRoom(ChatRoomType.Match);
      const memberA = await createUser('broadcast-match-a');
      const memberB = await createUser('broadcast-match-b');
      await addMember(room, memberA.id);
      await addMember(room, memberB.id);
      const clientMessageId = randomUUID();

      await service.sendTextMessage(room, memberA.id, sendDto(clientMessageId, 'hi'));
      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
      const [targets] = broadcast.emitToUsers.mock.calls[0] as [string[], unknown];
      expect(new Set(targets)).toEqual(new Set([memberA.id, memberB.id]));

      await service.sendTextMessage(room, memberA.id, sendDto(clientMessageId, 'hi'));
      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast for a PROVIDER_INQUIRY-type room (fail-closed: only MATCH/EVENT deliver)', async () => {
      const room = await createProviderInquiryRoom();
      const member = await createUser('broadcast-provider-inquiry-member');
      await addMember(room, member.id);

      await service.sendTextMessage(room, member.id, sendDto(randomUUID(), 'hi'));

      expect(broadcast.emitToUsers).not.toHaveBeenCalled();
    });
  });

  describe('WS3: EVENT group chat (deferred)', () => {
    it('an active EVENT member can send, and history/sync/read-state all work for a multi-member EVENT room', async () => {
      const room = await createEventRoom();
      const host = await createUser('event-host');
      const attendeeA = await createUser('event-attendee-a');
      const attendeeB = await createUser('event-attendee-b');
      await addMember(room, host.id);
      await addMember(room, attendeeA.id);
      await addMember(room, attendeeB.id);

      const sent = await service.sendTextMessage(room, attendeeA.id, sendDto(randomUUID(), 'hi all'));
      expect(sent.seq).toBe(1);

      const history = await service.listHistory(room, host.id, new ListMessagesQueryDto());
      expect(history.messages.map((m) => m.seq)).toEqual([1]);

      const sync = await service.syncMessages(
        room,
        attendeeB.id,
        Object.assign(new SyncMessagesQueryDto(), { afterSeq: 0 }),
      );
      expect(sync.messages.map((m) => m.seq)).toEqual([1]);

      await expect(
        service.advanceReadState(room, host.id, Object.assign(new UpdateReadStateDto(), { seq: 1 })),
      ).resolves.toEqual({ lastReadSeq: 1 });
    });

    it('rejects a non-member and a left member on every operation for an EVENT room', async () => {
      const room = await createEventRoom();
      const member = await createUser('event-reject-active');
      const stranger = await createUser('event-reject-stranger');
      const departed = await createUser('event-reject-departed');
      await addMember(room, member.id);
      await addMember(room, departed.id, new Date());
      await service.sendTextMessage(room, member.id, sendDto(randomUUID(), 'seed'));

      for (const outsider of [stranger, departed]) {
        await expect(
          service.sendTextMessage(room, outsider.id, sendDto(randomUUID())),
        ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
        await expect(
          service.listHistory(room, outsider.id, new ListMessagesQueryDto()),
        ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
        await expect(
          service.syncMessages(
            room,
            outsider.id,
            Object.assign(new SyncMessagesQueryDto(), { afterSeq: 0 }),
          ),
        ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
        await expect(
          service.advanceReadState(
            room,
            outsider.id,
            Object.assign(new UpdateReadStateDto(), { seq: 1 }),
          ),
        ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
      }
    });

    it('a duplicate clientMessageId retry persists the EVENT message once and broadcasts once', async () => {
      const room = await createEventRoom();
      const sender = await createUser('event-retry-sender');
      const other = await createUser('event-retry-other');
      await addMember(room, sender.id);
      await addMember(room, other.id);
      const clientMessageId = randomUUID();

      const first = await service.sendTextMessage(room, sender.id, sendDto(clientMessageId, 'retry me'));
      const retry = await service.sendTextMessage(room, sender.id, sendDto(clientMessageId, 'retry me'));

      expect(retry).toEqual(first);
      await expect(roomState(room)).resolves.toEqual({ messageCount: 1, lastSeq: 1 });
      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
    });

    it('broadcasts to every current active EVENT member, including the sender, using a fresh membership read', async () => {
      const room = await createEventRoom();
      const sender = await createUser('event-broadcast-sender');
      const memberB = await createUser('event-broadcast-b');
      const memberC = await createUser('event-broadcast-c');
      await addMember(room, sender.id);
      await addMember(room, memberB.id);
      await addMember(room, memberC.id);

      await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), 'hi everyone'));

      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
      const [targets] = broadcast.emitToUsers.mock.calls[0] as [string[], unknown];
      expect(new Set(targets)).toEqual(new Set([sender.id, memberB.id, memberC.id]));
    });

    it('a member removed after an earlier message does not receive a later message', async () => {
      const room = await createEventRoom();
      const sender = await createUser('event-removal-sender');
      const leaving = await createUser('event-removal-leaving');
      await addMember(room, sender.id);
      await addMember(room, leaving.id);

      await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), 'before removal'));
      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
      const [firstTargets] = broadcast.emitToUsers.mock.calls[0] as [string[], unknown];
      expect(firstTargets).toContain(leaving.id);

      await AppDataSource.query(
        `UPDATE chat_members SET left_at = now() WHERE room_id = $1 AND user_id = $2`,
        [room, leaving.id],
      );

      await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), 'after removal'));
      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(2);
      const [secondTargets] = broadcast.emitToUsers.mock.calls[1] as [string[], unknown];
      expect(secondTargets).not.toContain(leaving.id);
      expect(secondTargets).toEqual([sender.id]);
    });
  });

  describe('history (GET /v1/chat/rooms/:roomId/messages, deferred)', () => {
    it('returns newest-first pages honoring beforeSeq, with correct hasMore', async () => {
      const room = await createRoom();
      const sender = await createUser('history-sender');
      await addMember(room, sender.id);
      for (let i = 0; i < 5; i += 1) {
        await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), `msg ${i}`));
      }

      const firstPage = await service.listHistory(
        room,
        sender.id,
        Object.assign(new ListMessagesQueryDto(), { limit: 2 }),
      );
      expect(firstPage.messages.map((m) => m.seq)).toEqual([5, 4]);
      expect(firstPage.hasMore).toBe(true);

      const secondPage = await service.listHistory(
        room,
        sender.id,
        Object.assign(new ListMessagesQueryDto(), {
          beforeSeq: firstPage.messages[1]!.seq,
          limit: 2,
        }),
      );
      expect(secondPage.messages.map((m) => m.seq)).toEqual([3, 2]);
      expect(secondPage.hasMore).toBe(true);

      const lastPage = await service.listHistory(
        room,
        sender.id,
        Object.assign(new ListMessagesQueryDto(), {
          beforeSeq: secondPage.messages[1]!.seq,
          limit: 2,
        }),
      );
      expect(lastPage.messages.map((m) => m.seq)).toEqual([1]);
      expect(lastPage.hasMore).toBe(false);
    });

    it('distinguishes authorized-empty history from unauthorized access', async () => {
      const room = await createRoom();
      const member = await createUser('history-empty-member');
      const stranger = await createUser('history-stranger');
      await addMember(room, member.id);

      await expect(
        service.listHistory(room, member.id, new ListMessagesQueryDto()),
      ).resolves.toEqual({ messages: [], hasMore: false });

      await expect(
        service.listHistory(room, stranger.id, new ListMessagesQueryDto()),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    });

    it('rejects a member whose left_at is set, with no room-existence leakage', async () => {
      const room = await createRoom();
      const departed = await createUser('history-departed');
      await addMember(room, departed.id, new Date());

      await expect(
        service.listHistory(room, departed.id, new ListMessagesQueryDto()),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    });
  });

  describe('sync (GET /v1/chat/rooms/:roomId/sync, deferred)', () => {
    it('returns ascending recovery pages after a known seq, with correct hasMore', async () => {
      const room = await createRoom();
      const sender = await createUser('sync-sender');
      await addMember(room, sender.id);
      const sent: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const result = await service.sendTextMessage(room, sender.id, sendDto(randomUUID(), `msg ${i}`));
        sent.push(result.seq);
      }

      const page = await service.syncMessages(
        room,
        sender.id,
        Object.assign(new SyncMessagesQueryDto(), { afterSeq: sent[1], limit: 2 }),
      );
      expect(page.messages.map((m) => m.seq)).toEqual([sent[2], sent[3]]);
      expect(page.hasMore).toBe(true);

      const finalPage = await service.syncMessages(
        room,
        sender.id,
        Object.assign(new SyncMessagesQueryDto(), { afterSeq: sent[3], limit: 2 }),
      );
      expect(finalPage.messages.map((m) => m.seq)).toEqual([sent[4]]);
      expect(finalPage.hasMore).toBe(false);
    });

    it('distinguishes authorized-empty (fully caught up) from unauthorized access', async () => {
      const room = await createRoom();
      const member = await createUser('sync-empty-member');
      const stranger = await createUser('sync-stranger');
      await addMember(room, member.id);
      const result = await service.sendTextMessage(room, member.id, sendDto(randomUUID()));

      await expect(
        service.syncMessages(
          room,
          member.id,
          Object.assign(new SyncMessagesQueryDto(), { afterSeq: result.seq }),
        ),
      ).resolves.toEqual({ messages: [], hasMore: false });

      await expect(
        service.syncMessages(
          room,
          stranger.id,
          Object.assign(new SyncMessagesQueryDto(), { afterSeq: 0 }),
        ),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    });
  });

  describe('read-state (PATCH /v1/chat/rooms/:roomId/read, deferred)', () => {
    it('advances monotonically, clamped to room.last_seq, returning the canonical value', async () => {
      const room = await createRoom();
      const member = await createUser('read-state-member');
      await addMember(room, member.id);
      for (let i = 0; i < 3; i += 1) {
        await service.sendTextMessage(room, member.id, sendDto(randomUUID(), `msg ${i}`));
      }

      await expect(
        service.advanceReadState(room, member.id, Object.assign(new UpdateReadStateDto(), { seq: 2 })),
      ).resolves.toEqual({ lastReadSeq: 2 });

      // A stale/regressive request must not regress the stored value, and
      // must still return the canonical current value.
      await expect(
        service.advanceReadState(room, member.id, Object.assign(new UpdateReadStateDto(), { seq: 1 })),
      ).resolves.toEqual({ lastReadSeq: 2 });

      // A request past room.last_seq clamps to last_seq, not the requested value.
      await expect(
        service.advanceReadState(
          room,
          member.id,
          Object.assign(new UpdateReadStateDto(), { seq: 999 }),
        ),
      ).resolves.toEqual({ lastReadSeq: 3 });
    });

    it('rejects a non-member and a member whose left_at is set', async () => {
      const room = await createRoom();
      const stranger = await createUser('read-state-stranger');
      const departed = await createUser('read-state-departed');
      await addMember(room, departed.id, new Date());

      await expect(
        service.advanceReadState(room, stranger.id, Object.assign(new UpdateReadStateDto(), { seq: 1 })),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
      await expect(
        service.advanceReadState(room, departed.id, Object.assign(new UpdateReadStateDto(), { seq: 1 })),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    });

    it('converges concurrent out-of-order updates (80, 90, 85, 100, 95) to 100', async () => {
      const room = await createRoom();
      const member = await createUser('read-state-concurrency-member');
      await addMember(room, member.id);
      for (let i = 0; i < 100; i += 1) {
        await service.sendTextMessage(room, member.id, sendDto(randomUUID(), `msg ${i}`));
      }
      await expect(roomState(room)).resolves.toMatchObject({ lastSeq: 100 });

      const targets = [80, 90, 85, 100, 95];
      await Promise.all(
        targets.map((seq) =>
          service.advanceReadState(room, member.id, Object.assign(new UpdateReadStateDto(), { seq })),
        ),
      );

      const [row] = await AppDataSource.query(
        `SELECT last_read_seq::int FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [room, member.id],
      );
      expect(row.last_read_seq).toBe(100);
    });
  });

  describe('WS4.1: authorized cross-user presence snapshot (deferred)', () => {
    it('an active room member receives presence for every current active member, using a real PostgreSQL membership read', async () => {
      const room = await createRoom();
      const requester = await createUser('presence-snapshot-requester');
      const other = await createUser('presence-snapshot-other');
      await addMember(room, requester.id);
      await addMember(room, other.id);
      presence.getStates.mockResolvedValueOnce(
        new Map([
          [requester.id, PresenceState.Online],
          [other.id, PresenceState.Afk],
        ]),
      );

      const snapshot = await service.getPresenceSnapshot(room, requester.id);

      expect(presence.getStates).toHaveBeenCalledWith(
        expect.arrayContaining([requester.id, other.id]),
      );
      expect(new Set(snapshot.map((entry) => entry.userId))).toEqual(
        new Set([requester.id, other.id]),
      );
      expect(snapshot).toContainEqual({ userId: requester.id, state: PresenceState.Online });
      expect(snapshot).toContainEqual({ userId: other.id, state: PresenceState.Afk });
    });

    it('excludes a left member from the returned member list', async () => {
      const room = await createRoom();
      const requester = await createUser('presence-snapshot-excl-requester');
      const departed = await createUser('presence-snapshot-excl-departed');
      await addMember(room, requester.id);
      await addMember(room, departed.id, new Date());
      presence.getStates.mockResolvedValueOnce(new Map([[requester.id, PresenceState.Online]]));

      const snapshot = await service.getPresenceSnapshot(room, requester.id);

      expect(snapshot.map((entry) => entry.userId)).not.toContain(departed.id);
    });

    it('rejects a non-member requester with the same generic ChatRoomNotFoundError boundary, no room-existence leakage', async () => {
      const room = await createRoom();
      const member = await createUser('presence-snapshot-member-only');
      const stranger = await createUser('presence-snapshot-stranger');
      await addMember(room, member.id);

      await expect(service.getPresenceSnapshot(room, stranger.id)).rejects.toBeInstanceOf(
        ChatRoomNotFoundError,
      );
    });

    it('rejects a left member requester the same way as a stranger', async () => {
      const room = await createRoom();
      const departed = await createUser('presence-snapshot-departed-requester');
      await addMember(room, departed.id, new Date());

      await expect(service.getPresenceSnapshot(room, departed.id)).rejects.toBeInstanceOf(
        ChatRoomNotFoundError,
      );
    });

    it('works identically for an EVENT-typed room (same generic membership query, no room-type branching)', async () => {
      const room = await createEventRoom();
      const requester = await createUser('presence-snapshot-event-requester');
      const attendeeA = await createUser('presence-snapshot-event-attendee-a');
      const attendeeB = await createUser('presence-snapshot-event-attendee-b');
      await addMember(room, requester.id);
      await addMember(room, attendeeA.id);
      await addMember(room, attendeeB.id);
      presence.getStates.mockResolvedValueOnce(
        new Map([
          [requester.id, PresenceState.Online],
          [attendeeA.id, PresenceState.Online],
          [attendeeB.id, PresenceState.Offline],
        ]),
      );

      const snapshot = await service.getPresenceSnapshot(room, requester.id);

      expect(new Set(snapshot.map((entry) => entry.userId))).toEqual(
        new Set([requester.id, attendeeA.id, attendeeB.id]),
      );
    });
  });

  describe('WS5: chat-side integration contract (deferred, real PostgreSQL)', () => {
    it('concurrent ensureEventRoom calls for the same event converge on exactly one EVENT chat room', async () => {
      const host = await createUser('ws5-ensure-room-host');
      const eventId = await createEvent(host.id);

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          AppDataSource.transaction((manager) => repository.ensureEventRoom(manager, eventId)),
        ),
      );

      const distinctRoomIds = new Set(results);
      expect(distinctRoomIds.size).toBe(1);
      const [roomId] = results;
      createdRoomIds.push(roomId!);

      const [{ count }] = await AppDataSource.query(
        `SELECT count(*)::int AS count FROM chat_rooms WHERE event_id = $1 AND type = 'EVENT'`,
        [eventId],
      );
      expect(count).toBe(1);
    });

    it('repeated activateEventMember calls converge on exactly one active chat_members row', async () => {
      const host = await createUser('ws5-activate-host');
      const member = await createUser('ws5-activate-member');
      const eventId = await createEvent(host.id);
      const roomId = await AppDataSource.transaction((manager) =>
        repository.ensureEventRoom(manager, eventId),
      );
      createdRoomIds.push(roomId);

      await Promise.all(
        Array.from({ length: 5 }, () =>
          AppDataSource.transaction((manager) =>
            repository.activateEventMember(manager, roomId, member.id),
          ),
        ),
      );

      const [{ count }] = await AppDataSource.query(
        `SELECT count(*)::int AS count FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, member.id],
      );
      expect(count).toBe(1);
      const [row] = await AppDataSource.query(
        `SELECT left_at FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, member.id],
      );
      expect(row.left_at).toBeNull();
    });

    it('deactivateEventMember sets left_at; calling it again is stable (idempotent)', async () => {
      const host = await createUser('ws5-deactivate-host');
      const member = await createUser('ws5-deactivate-member');
      const eventId = await createEvent(host.id);
      const roomId = await AppDataSource.transaction((manager) =>
        repository.ensureEventRoom(manager, eventId),
      );
      createdRoomIds.push(roomId);
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, member.id),
      );

      await AppDataSource.transaction((manager) =>
        repository.deactivateEventMember(manager, roomId, member.id),
      );
      const [firstRow] = await AppDataSource.query(
        `SELECT left_at FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, member.id],
      );
      expect(firstRow.left_at).not.toBeNull();
      const firstLeftAt = firstRow.left_at;

      await AppDataSource.transaction((manager) =>
        repository.deactivateEventMember(manager, roomId, member.id),
      );
      const [secondRow] = await AppDataSource.query(
        `SELECT left_at FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, member.id],
      );
      // The guarded UPDATE's WHERE left_at IS NULL excludes an already-left
      // row, so the second call is a true no-op — the timestamp does not move.
      expect(secondRow.left_at).toEqual(firstLeftAt);
    });

    it('deactivate then reactivate: the same logical membership becomes active again, not a duplicate row', async () => {
      const host = await createUser('ws5-reactivate-host');
      const member = await createUser('ws5-reactivate-member');
      const eventId = await createEvent(host.id);
      const roomId = await AppDataSource.transaction((manager) =>
        repository.ensureEventRoom(manager, eventId),
      );
      createdRoomIds.push(roomId);
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, member.id),
      );
      await AppDataSource.transaction((manager) =>
        repository.deactivateEventMember(manager, roomId, member.id),
      );

      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, member.id),
      );

      const [{ count }] = await AppDataSource.query(
        `SELECT count(*)::int AS count FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, member.id],
      );
      expect(count).toBe(1);
      const [row] = await AppDataSource.query(
        `SELECT left_at FROM chat_members WHERE room_id = $1 AND user_id = $2`,
        [roomId, member.id],
      );
      expect(row.left_at).toBeNull();
    });

    it('a deactivated member loses send/history/sync/read-state access — no duplicated authorization logic needed', async () => {
      const host = await createUser('ws5-access-host');
      const member = await createUser('ws5-access-member');
      const eventId = await createEvent(host.id);
      const roomId = await AppDataSource.transaction((manager) =>
        repository.ensureEventRoom(manager, eventId),
      );
      createdRoomIds.push(roomId);
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, member.id),
      );
      await service.sendTextMessage(roomId, member.id, sendDto(randomUUID(), 'before removal'));

      await AppDataSource.transaction((manager) =>
        repository.deactivateEventMember(manager, roomId, member.id),
      );

      await expect(
        service.sendTextMessage(roomId, member.id, sendDto(randomUUID())),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
      await expect(
        service.listHistory(roomId, member.id, new ListMessagesQueryDto()),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
      await expect(
        service.syncMessages(
          roomId,
          member.id,
          Object.assign(new SyncMessagesQueryDto(), { afterSeq: 0 }),
        ),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
      await expect(
        service.advanceReadState(
          roomId,
          member.id,
          Object.assign(new UpdateReadStateDto(), { seq: 1 }),
        ),
      ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    });

    it('EVENT broadcast targets exclude a member deactivated via deactivateEventMember', async () => {
      const host = await createUser('ws5-broadcast-host');
      const member = await createUser('ws5-broadcast-member');
      const leaving = await createUser('ws5-broadcast-leaving');
      const eventId = await createEvent(host.id);
      const roomId = await AppDataSource.transaction((manager) =>
        repository.ensureEventRoom(manager, eventId),
      );
      createdRoomIds.push(roomId);
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, member.id),
      );
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, leaving.id),
      );

      await AppDataSource.transaction((manager) =>
        repository.deactivateEventMember(manager, roomId, leaving.id),
      );

      await service.sendTextMessage(roomId, member.id, sendDto(randomUUID(), 'after removal'));
      const [targets] = broadcast.emitToUsers.mock.calls.at(-1) as [string[], unknown];
      expect(targets).not.toContain(leaving.id);
      expect(targets).toContain(member.id);
    });

    it('the authorized presence snapshot excludes a member deactivated via deactivateEventMember', async () => {
      const host = await createUser('ws5-presence-host');
      const member = await createUser('ws5-presence-member');
      const leaving = await createUser('ws5-presence-leaving');
      const eventId = await createEvent(host.id);
      const roomId = await AppDataSource.transaction((manager) =>
        repository.ensureEventRoom(manager, eventId),
      );
      createdRoomIds.push(roomId);
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, member.id),
      );
      await AppDataSource.transaction((manager) =>
        repository.activateEventMember(manager, roomId, leaving.id),
      );
      await AppDataSource.transaction((manager) =>
        repository.deactivateEventMember(manager, roomId, leaving.id),
      );
      presence.getStates.mockResolvedValueOnce(new Map([[member.id, PresenceState.Online]]));

      const snapshot = await service.getPresenceSnapshot(roomId, member.id);

      expect(snapshot.map((entry) => entry.userId)).not.toContain(leaving.id);
      expect(snapshot.map((entry) => entry.userId)).toContain(member.id);
    });
  });
});
