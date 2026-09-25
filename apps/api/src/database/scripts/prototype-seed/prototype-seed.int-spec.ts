import { randomUUID } from 'node:crypto';

import { AppDataSource } from '../../data-source';
import { GeoService } from '../../geo';
import { ExplorerRepository } from '../../../explorer/explorer.repository';
import { ExplorerService } from '../../../explorer/explorer.service';
import {
  assertPrototypeSeedAllowed,
  cleanupPrototypeSeed,
  PROTOTYPE_SEED_PROVIDER,
  PROTOTYPE_SEED_SESSIONS,
  PROTOTYPE_SEED_UID_PREFIX,
  PROTOTYPE_SEED_USER_IDS,
  PROTOTYPE_SEED_USERS,
  runPrototypeSeed,
  type PrototypeSeedResult,
} from './prototype-seed';

/**
 * Step 6 prototype seed against real PostgreSQL. Leaves the database the way
 * it found it: re-seeded when the seed was already present, clean otherwise.
 * Unrelated look-alike rows (same provider name, same uid prefix, same-titled
 * event) are created first and must survive every seed run untouched.
 */
const U = PROTOTYPE_SEED_USERS;
const decoy = {
  userId: randomUUID(),
  // Same uid prefix, but NOT one of the seed's fixed ids: must never be deleted.
  firebaseUid: `${PROTOTYPE_SEED_UID_PREFIX}decoy-${randomUUID()}`,
  providerId: randomUUID(),
  providerSlug: `andes-adventures-decoy-${randomUUID().slice(0, 8)}`,
  eventId: '',
};
let seededBefore = false;

async function countSeedRows() {
  const [row] = (await AppDataSource.query(
    `WITH su AS (SELECT id FROM users WHERE id = ANY($1::uuid[]) AND firebase_uid LIKE $2),
          se AS (SELECT id FROM events WHERE host_provider_id = $3 OR host_user_id IN (SELECT id FROM su))
     SELECT (SELECT count(*)::int FROM su) AS users,
            (SELECT count(*)::int FROM providers WHERE id = $3) AS providers,
            (SELECT count(*)::int FROM se) AS events,
            (SELECT count(*)::int FROM event_participants WHERE event_id IN (SELECT id FROM se)) AS participants,
            (SELECT count(*)::int FROM event_join_requests WHERE event_id IN (SELECT id FROM se)) AS join_requests,
            (SELECT count(*)::int FROM chat_rooms WHERE event_id IN (SELECT id FROM se)) AS chat_rooms,
            (SELECT count(*)::int FROM chat_members m JOIN chat_rooms r ON r.id = m.room_id
               WHERE r.event_id IN (SELECT id FROM se)) AS chat_members,
            (SELECT count(*)::int FROM messages g JOIN chat_rooms r ON r.id = g.room_id
               WHERE r.event_id IN (SELECT id FROM se)) AS messages`,
    [PROTOTYPE_SEED_USER_IDS, `${PROTOTYPE_SEED_UID_PREFIX}%`, PROTOTYPE_SEED_PROVIDER.id],
  )) as Array<Record<string, number>>;
  return row!;
}

async function activeChatMembers(eventId: string): Promise<string[]> {
  const rows = (await AppDataSource.query(
    `SELECT m.user_id FROM chat_members m JOIN chat_rooms r ON r.id = m.room_id
      WHERE r.event_id = $1 AND r.type = 'EVENT' AND m.left_at IS NULL ORDER BY m.user_id`,
    [eventId],
  )) as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

describe('Prototype seed (real PostgreSQL)', () => {
  let first: PrototypeSeedResult;
  let second: PrototypeSeedResult;
  let countsAfterFirst: Record<string, number>;

  beforeAll(async () => {
    assertPrototypeSeedAllowed(process.env);
    await AppDataSource.initialize();
    const [existing] = (await AppDataSource.query(
      'SELECT count(*)::int AS n FROM providers WHERE id = $1', [PROTOTYPE_SEED_PROVIDER.id],
    )) as Array<{ n: number }>;
    seededBefore = existing!.n > 0;

    // Unrelated look-alikes that the seed must never touch.
    await AppDataSource.query(
      `INSERT INTO users (id, firebase_uid, email, date_of_birth, account_status)
       VALUES ($1, $2, $3, DATE '1990-01-01', 'ACTIVE')`,
      [decoy.userId, decoy.firebaseUid, `decoy-${decoy.userId}@example.test`],
    );
    await AppDataSource.query(
      `INSERT INTO providers (id, slug, name) VALUES ($1, $2, 'Andes Adventures')`,
      [decoy.providerId, decoy.providerSlug],
    );
    const [event] = (await AppDataSource.query(
      `INSERT INTO events (host_type, host_user_id, category_id, title, capacity_max, starts_at, ends_at, meeting_point, status)
       SELECT 'USER', $1, id, 'Cusco Sunset Meetup', 5, now() + INTERVAL '3 days', now() + INTERVAL '3 days 2 hours',
              ST_SetSRID(ST_MakePoint(-71.98, -13.51), 4326)::geography, 'DRAFT'
         FROM event_categories WHERE is_active ORDER BY id LIMIT 1
       RETURNING id`,
      [decoy.userId],
    )) as Array<{ id: string }>;
    decoy.eventId = event!.id;

    first = await runPrototypeSeed(AppDataSource);
    countsAfterFirst = await countSeedRows();
    second = await runPrototypeSeed(AppDataSource);
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query('DELETE FROM event_status_history WHERE event_id = $1', [decoy.eventId]);
        await manager.query('DELETE FROM events WHERE id = $1', [decoy.eventId]);
        await manager.query('DELETE FROM providers WHERE id = $1', [decoy.providerId]);
        await manager.query('DELETE FROM users WHERE id = $1', [decoy.userId]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
      if (seededBefore) await runPrototypeSeed(AppDataSource);
      else await cleanupPrototypeSeed(AppDataSource);
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('is idempotent: a second run leaves exactly the same seed-owned row counts', async () => {
    expect(countsAfterFirst).toEqual({
      users: 9, providers: 1, events: 4, participants: 6, join_requests: 6,
      chat_rooms: 3, chat_members: 9, messages: 1,
    });
    await expect(countSeedRows()).resolves.toEqual(countsAfterFirst);
    // Stable ids for the seed-owned provider and provider sessions.
    expect(second.providerId).toBe(first.providerId);
    expect(second.events.rainbow.id).toBe(PROTOTYPE_SEED_SESSIONS.rainbow.id);
    expect(second.events.humantay.id).toBe(PROTOTYPE_SEED_SESSIONS.humantay.id);
  });

  it('never touches unrelated rows, even look-alikes', async () => {
    const [survivors] = (await AppDataSource.query(
      `SELECT (SELECT count(*)::int FROM users WHERE id = $1 AND firebase_uid = $2) AS "user",
              (SELECT count(*)::int FROM providers WHERE id = $3 AND name = 'Andes Adventures') AS provider,
              (SELECT count(*)::int FROM events WHERE id = $4 AND title = 'Cusco Sunset Meetup') AS event`,
      [decoy.userId, decoy.firebaseUid, decoy.providerId, decoy.eventId],
    )) as Array<Record<string, number>>;
    expect(survivors).toEqual({ user: 1, provider: 1, event: 1 });
  });

  it('forms Rainbow Mountain: FORMING, 7 reserved by 2 party leaders, 5 left, needs 1 more', () => {
    expect(second.events.rainbow).toMatchObject({
      hostType: 'PROVIDER', status: 'ACTIVE', visibility: 'PUBLIC', joinApprovalRequired: false,
      depositMinor: 0, priceMinor: 12_000, currency: 'PEN',
      capacityMin: 8, capacityMax: 12, reservedSeatCount: 7, participantCount: 2,
      remainingSeats: 5, groupState: 'FORMING', seatsToConfirm: 1,
    });
  });

  it('confirms Humantay Lake (not full), keeps the meetup OPEN and the cooking class FULL', () => {
    expect(second.events.humantay).toMatchObject({
      capacityMin: 10, capacityMax: 14, reservedSeatCount: 11, participantCount: 3,
      remainingSeats: 3, groupState: 'CONFIRMED', seatsToConfirm: 0,
    });
    expect(second.events.sunset).toMatchObject({
      hostType: 'USER', title: 'Cusco Sunset Meetup', capacityMin: null, capacityMax: 10,
      reservedSeatCount: 1, participantCount: 0, groupState: 'OPEN', seatsToConfirm: null,
    });
    expect(second.events.cooking).toMatchObject({
      hostType: 'USER', status: 'FULL', capacityMax: 4, hostGuestCount: 1,
      reservedSeatCount: 4, participantCount: 1, remainingSeats: 0, groupState: 'FULL',
    });
  });

  it('seeds only future events relative to the run', () => {
    for (const event of Object.values(second.events)) {
      expect(Date.parse(event.startsAt)).toBeGreaterThan(Date.now());
    }
  });

  it('puts the provider owner and party leaders — never guests — in the Event chats', async () => {
    expect(await activeChatMembers(PROTOTYPE_SEED_SESSIONS.rainbow.id)).toEqual(
      [U.andesOwner.id, U.ana.id, U.ben.id].sort(),
    );
    expect(await activeChatMembers(PROTOTYPE_SEED_SESSIONS.humantay.id)).toEqual(
      [U.andesOwner.id, U.carla.id, U.diego.id, U.elif.id].sort(),
    );
    expect(await activeChatMembers(second.events.cooking.id)).toEqual([U.lucas.id, U.farah.id].sort());
    // 9 accounts exist for 25 physical seats: guests never become users.
    const [users] = (await AppDataSource.query(
      'SELECT count(*)::int AS n FROM users WHERE firebase_uid LIKE $1 AND id = ANY($2::uuid[])',
      [`${PROTOTYPE_SEED_UID_PREFIX}%`, PROTOTYPE_SEED_USER_IDS],
    )) as Array<{ n: number }>;
    expect(users!.n).toBe(9);
    const [welcome] = (await AppDataSource.query(
      'SELECT sender_user_id FROM messages WHERE room_id = $1', [second.rainbowChatRoomId],
    )) as Array<{ sender_user_id: string }>;
    expect(welcome!.sender_user_id).toBe(U.andesOwner.id);
  });

  it('never forges counters: every reserved/participant count equals the recomputation from membership rows', async () => {
    const rows = (await AppDataSource.query(
      `SELECT e.id, e.reserved_seat_count, e.participant_count,
              (CASE WHEN e.host_type = 'USER' THEN 1 + e.host_guest_count ELSE 0 END)
                + COALESCE(SUM(1 + p.guest_count) FILTER (WHERE p.cancelled_at IS NULL), 0) AS recomputed_seats,
              count(p.id) FILTER (WHERE p.cancelled_at IS NULL) AS recomputed_participants
         FROM events e LEFT JOIN event_participants p ON p.event_id = e.id
        WHERE e.id = ANY($1::uuid[])
        GROUP BY e.id`,
      [Object.values(second.events).map((event) => event.id)],
    )) as Array<Record<string, string | number>>;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(Number(row.reserved_seat_count)).toBe(Number(row.recomputed_seats));
      expect(Number(row.participant_count)).toBe(Number(row.recomputed_participants));
    }
  });

  it('is discoverable through the real Explorer event cards around Cusco', async () => {
    const explorer = new ExplorerService(new ExplorerRepository(AppDataSource, new GeoService()));
    const view = await explorer.discoverEventCards('viewer', {
      centerLatitude: -13.5167, centerLongitude: -71.9787, radiusMeters: 5_000,
    });
    const byId = new Map(view.cards.map((card) => [card.eventId, card]));
    expect(byId.get(PROTOTYPE_SEED_SESSIONS.rainbow.id)).toMatchObject({
      host: { type: 'PROVIDER', providerId: PROTOTYPE_SEED_PROVIDER.id, name: 'Andes Adventures' },
      groupState: 'FORMING', seatsToConfirm: 1, reservedSeatCount: 7, remainingSeats: 5,
    });
    expect(byId.get(PROTOTYPE_SEED_SESSIONS.humantay.id)).toMatchObject({ groupState: 'CONFIRMED' });
    expect(byId.get(second.events.sunset.id)).toMatchObject({
      groupState: 'OPEN', host: { type: 'USER', userId: U.sofia.id, displayName: 'Sofía' },
    });
    expect(byId.get(second.events.cooking.id)).toMatchObject({ groupState: 'FULL' });
    // The decoy is a DRAFT: never discoverable.
    expect(byId.has(decoy.eventId)).toBe(false);
  });
});
