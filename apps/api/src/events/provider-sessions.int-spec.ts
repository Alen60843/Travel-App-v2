import { randomUUID } from 'node:crypto';

import { EventHostType, EventStatus } from '@tripwith/shared';

import { ChatRepository } from '../chat/chat.repository';
import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { JoinRequestsService } from './join-requests.service';

/**
 * Group Formation Step 2 — provider owner as session manager, end to end
 * against real PostgreSQL. Provider-hosted sessions are seeded directly
 * (there is deliberately no provider-session creation API yet); everything
 * after seeding goes through the real services.
 */
const prefix = `provider-int-${randomUUID()}`;
const slugPrefix = `pint-${randomUUID().slice(0, 8)}`;
let sequence = 0;
let categoryId: number;
let events: EventsService;
let requests: JoinRequestsService;

async function user(): Promise<string> {
  const uid = `${prefix}-${++sequence}`;
  const [row] = (await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
     VALUES ($1, $2, DATE '1990-01-01', 'ACTIVE') RETURNING id`,
    [uid, `${uid}@example.test`],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create provider-session test user.');
  return row.id;
}

async function provider(name: string, ownerUserId: string | null): Promise<string> {
  const [row] = (await AppDataSource.query(
    `INSERT INTO providers (slug, name, owner_user_id) VALUES ($1, $2, $3) RETURNING id`,
    [`${slugPrefix}-${++sequence}`, name, ownerUserId],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create provider fixture.');
  return row.id;
}

async function session(
  providerId: string,
  options: {
    title: string;
    capacityMin?: number | null;
    capacityMax: number;
    joinApprovalRequired: boolean;
    status?: 'DRAFT' | 'ACTIVE';
  },
): Promise<string> {
  const [row] = (await AppDataSource.query(
    `INSERT INTO events (
       host_type, host_provider_id, category_id, title, capacity_min, capacity_max,
       join_approval_required, starts_at, ends_at, meeting_point, status
     ) VALUES (
       'PROVIDER', $1, $2, $3, $4, $5, $6,
       TIMESTAMPTZ '2090-09-26 05:00:00+00', TIMESTAMPTZ '2090-09-26 15:00:00+00',
       ST_MakePoint(-71.2745, -13.8691)::GEOGRAPHY, $7
     ) RETURNING id`,
    [
      providerId, categoryId, options.title, options.capacityMin ?? null, options.capacityMax,
      options.joinApprovalRequired, options.status ?? 'DRAFT',
    ],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create provider session fixture.');
  return row.id;
}

async function chatMembers(eventId: string) {
  return (await AppDataSource.query(
    `SELECT m.user_id, m.left_at
       FROM chat_members m
       JOIN chat_rooms r ON r.id = m.room_id
      WHERE r.event_id = $1 AND r.type = 'EVENT'
      ORDER BY m.joined_at, m.user_id`,
    [eventId],
  )) as Array<{ user_id: string; left_at: Date | null }>;
}

const activeMemberIds = async (eventId: string) =>
  (await chatMembers(eventId)).filter((m) => m.left_at === null).map((m) => m.user_id).sort();

describe('Provider owner as session manager (real PostgreSQL/PostGIS)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
    const repository = new EventsRepository(AppDataSource);
    events = new EventsService(repository, new GeoService());
    requests = new JoinRequestsService(repository, new ChatRepository(AppDataSource));
    const [category] = (await AppDataSource.query(
      'SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1',
    )) as Array<{ id: number }>;
    if (!category) throw new Error('The canonical event category seed is missing.');
    categoryId = category.id;
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
        // Fixture-only cleanup follows the established append-only audit
        // cleanup pattern (single transaction, trigger re-enabled on commit).
        const fixtureEvents = `SELECT e.id FROM events e JOIN providers p ON p.id = e.host_provider_id WHERE p.slug LIKE $1`;
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query(`DELETE FROM event_status_history WHERE event_id IN (${fixtureEvents})`, [`${slugPrefix}%`]);
        await manager.query(`DELETE FROM events WHERE id IN (${fixtureEvents})`, [`${slugPrefix}%`]);
        await manager.query('DELETE FROM providers WHERE slug LIKE $1', [`${slugPrefix}%`]);
        await manager.query('DELETE FROM users WHERE firebase_uid LIKE $1', [`${prefix}%`]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('forms the Andes Adventures Rainbow Mountain group 4 + 3 + 2 under the provider owner', async () => {
    const ownerP = await user();
    const leaderA = await user();
    const leaderB = await user();
    const leaderC = await user();
    const outsider = await user();
    const andes = await provider('Andes Adventures', ownerP);
    const rainbow = await session(andes, {
      title: 'Rainbow Mountain', capacityMin: 8, capacityMax: 12, joinApprovalRequired: false,
    });

    // P sees and manages the session; the provider row is the host, P is not.
    const listed = await events.listEvents(ownerP);
    expect(listed.map((event) => event.id)).toContain(rainbow);
    await expect(events.listEvents(outsider)).resolves.toEqual([]);
    await expect(events.getEvent(outsider, rainbow)).rejects.toBeInstanceOf(EventNotFoundError);

    // Start: published by P, no host seat on a provider session.
    await expect(events.publishEvent(ownerP, rainbow)).resolves.toMatchObject({
      hostType: EventHostType.Provider,
      status: EventStatus.Active,
      capacityMin: 8,
      capacityMax: 12,
      reservedSeatCount: 0,
      participantCount: 0,
      groupState: 'FORMING',
      seatsToConfirm: 8,
    });

    // Party A: leader + 3 guests = 4 seats, auto-approved (fits, approval off).
    await expect(requests.create(leaderA, rainbow, { guestCount: 3 })).resolves.toMatchObject({
      status: 'APPROVED', requestedSeats: 4,
    });
    await expect(events.getEvent(ownerP, rainbow)).resolves.toMatchObject({
      reservedSeatCount: 4, participantCount: 1, groupState: 'FORMING', seatsToConfirm: 4,
    });

    // Party B: leader + 2 guests = 3 seats.
    await requests.create(leaderB, rainbow, { guestCount: 2 });
    await expect(events.getEvent(ownerP, rainbow)).resolves.toMatchObject({
      reservedSeatCount: 7, participantCount: 2, groupState: 'FORMING', seatsToConfirm: 1,
    });

    // Party C: leader + 1 guest = 2 seats -> 9 joined, minimum 8 reached.
    await requests.create(leaderC, rainbow, { guestCount: 1 });
    await expect(events.getEvent(ownerP, rainbow)).resolves.toMatchObject({
      status: EventStatus.Active,
      reservedSeatCount: 9,
      participantCount: 3,
      remainingSeats: 3,
      groupState: 'CONFIRMED',
      seatsToConfirm: 0,
    });

    // Chat: the provider OWNER is the host-side member; party leaders join;
    // guests are headcount only (4 members for 9 seats).
    expect(await activeMemberIds(rainbow)).toEqual([ownerP, leaderA, leaderB, leaderC].sort());

    // The owner is manager, never participant.
    await expect(requests.create(ownerP, rainbow, {})).rejects.toMatchObject({ code: 'EVENT_SELF_JOIN' });
    await expect(requests.leave(ownerP, rainbow)).rejects.toMatchObject({
      code: 'HOST_CANNOT_LEAVE_VIA_PARTICIPANT_ENDPOINT',
    });

    // An unrelated user can neither remove nor cancel.
    await expect(requests.remove(outsider, rainbow, leaderB)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(events.cancelEvent(outsider, rainbow)).rejects.toBeInstanceOf(EventNotFoundError);

    // P removes party C pre-start: all 2 seats return at once, the group
    // drops back below its minimum, C leaves the chat.
    await expect(requests.remove(ownerP, rainbow, leaderC)).resolves.toMatchObject({
      userId: leaderC, cancelledByUserId: ownerP, cancellationReason: 'HOST_REMOVAL',
    });
    await expect(events.getEvent(ownerP, rainbow)).resolves.toMatchObject({
      reservedSeatCount: 7, participantCount: 2, groupState: 'FORMING', seatsToConfirm: 1,
    });
    expect(await activeMemberIds(rainbow)).toEqual([ownerP, leaderA, leaderB].sort());

    // An ordinary participant still leaves through the normal path.
    await expect(requests.leave(leaderB, rainbow)).resolves.toMatchObject({
      cancellationReason: 'VOLUNTARY_LEAVE',
    });

    // P cancels the session; the audit trail names P as the actor.
    await expect(events.cancelEvent(ownerP, rainbow)).resolves.toMatchObject({
      status: EventStatus.Cancelled, groupState: 'CANCELLED',
    });
    const history = (await AppDataSource.query(
      `SELECT to_status, actor_user_id, reason FROM event_status_history
        WHERE event_id = $1 ORDER BY created_at ASC, id ASC`,
      [rainbow],
    )) as Array<Record<string, unknown>>;
    expect(history).toEqual([
      { to_status: EventStatus.Draft, actor_user_id: null, reason: 'created' },
      { to_status: EventStatus.Active, actor_user_id: ownerP, reason: 'host_publish' },
      { to_status: EventStatus.Cancelled, actor_user_id: ownerP, reason: 'host_cancel' },
    ]);
  });

  it('lets only the provider owner list, approve, reject, and override requests on an approval session', async () => {
    const ownerP = await user();
    const outsider = await user();
    const [partyD, partyE, partyF, partyG] = [await user(), await user(), await user(), await user()];
    const andes = await provider('Andes Adventures Approval', ownerP);
    const humantay = await session(andes, {
      title: 'Humantay Lake', capacityMin: 4, capacityMax: 5, joinApprovalRequired: true,
    });
    await events.publishEvent(ownerP, humantay);

    const requestD = await requests.create(partyD, humantay, { guestCount: 1 });
    const requestE = await requests.create(partyE, humantay, { guestCount: 2 });
    const requestF = await requests.create(partyF, humantay, {});
    expect([requestD.status, requestE.status, requestF.status]).toEqual(['PENDING', 'PENDING', 'PENDING']);

    // Unrelated user: no view, no decision, no override, no removal, no cancel.
    await expect(requests.listForHost(outsider, humantay)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(requests.approve(outsider, humantay, requestD.id)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(requests.reject(outsider, humantay, requestF.id)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(
      requests.approveWithCapacityOverride(outsider, humantay, requestE.id),
    ).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(events.updateEvent(outsider, humantay, { title: 'Hijacked session' })).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    const [untouched] = (await AppDataSource.query(
      `SELECT count(*)::int AS pending FROM event_join_requests WHERE event_id = $1 AND status = 'PENDING'`,
      [humantay],
    )) as Array<{ pending: number }>;
    expect(untouched?.pending).toBe(3);

    // P sees every request and decides them with the ordinary Phase 8 rules.
    expect((await requests.listForHost(ownerP, humantay)).map((row) => row.id).sort()).toEqual(
      [requestD.id, requestE.id, requestF.id].sort(),
    );
    await expect(requests.approve(ownerP, humantay, requestD.id)).resolves.toMatchObject({
      status: 'APPROVED', currentReservedSeatCount: 2,
    });
    await expect(requests.reject(ownerP, humantay, requestF.id)).resolves.toMatchObject({ status: 'REJECTED' });

    // E (3 seats) fits exactly: 2 + 3 = 5 -> FULL through the audit trigger,
    // and the 4-person minimum is met.
    await requests.approve(ownerP, humantay, requestE.id);
    await expect(events.getEvent(ownerP, humantay)).resolves.toMatchObject({
      status: EventStatus.Full, reservedSeatCount: 5, groupState: 'FULL',
    });

    // G does not fit: ordinary approval refuses, the owner-only override raises
    // capacityMax by exactly the party size and records P as the approver.
    const requestG = await requests.create(partyG, humantay, { guestCount: 1 });
    await expect(requests.approve(ownerP, humantay, requestG.id)).rejects.toMatchObject({
      code: 'EVENT_CAPACITY_OVERRIDE_REQUIRED',
    });
    await expect(
      requests.approveWithCapacityOverride(ownerP, humantay, requestG.id),
    ).resolves.toMatchObject({
      status: 'APPROVED',
      capacityBeforeOverride: 5,
      capacityAfterOverride: 7,
      capacityOverrideApprovedByUserId: ownerP,
    });
    const [decisions] = (await AppDataSource.query(
      `SELECT count(*) FILTER (WHERE decided_by_user_id = $2)::int AS by_owner,
              count(*) FILTER (WHERE decided_by_user_id IS DISTINCT FROM $2)::int AS by_other
         FROM event_join_requests WHERE event_id = $1 AND status IN ('APPROVED', 'REJECTED')`,
      [humantay, ownerP],
    )) as Array<{ by_owner: number; by_other: number }>;
    expect(decisions).toEqual({ by_owner: 4, by_other: 0 });
    expect(await activeMemberIds(humantay)).toEqual([ownerP, partyD, partyE, partyG].sort());
  });

  it('never grants management of an unclaimed provider session (owner_user_id NULL)', async () => {
    const someone = await user();
    const traveller = await user();
    const unclaimed = await provider('Unclaimed Imported Tours', null);
    const orphan = await session(unclaimed, {
      title: 'Orphan Session', capacityMin: 2, capacityMax: 6, joinApprovalRequired: false, status: 'ACTIVE',
    });

    // Nobody manages it — the NULL owner matches no user id.
    await expect(events.listEvents(someone)).resolves.toEqual([]);
    await expect(events.getEvent(someone, orphan)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(events.publishEvent(someone, orphan)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(events.cancelEvent(someone, orphan)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(requests.listForHost(someone, orphan)).rejects.toBeInstanceOf(EventNotFoundError);

    // Not operational: no join request can be created, so no participant or
    // chat room with a missing host ever exists.
    await expect(requests.create(traveller, orphan, { guestCount: 1 })).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    const [counts] = (await AppDataSource.query(
      `SELECT (SELECT count(*)::int FROM event_join_requests WHERE event_id = $1) AS requests,
              (SELECT count(*)::int FROM event_participants  WHERE event_id = $1) AS participants,
              (SELECT count(*)::int FROM chat_rooms          WHERE event_id = $1) AS rooms`,
      [orphan],
    )) as Array<Record<string, number>>;
    expect(counts).toEqual({ requests: 0, participants: 0, rooms: 0 });
  });

  it('revokes management the moment a provider loses its owner, while travellers may still leave', async () => {
    const formerOwner = await user();
    const traveller = await user();
    const lapsed = await provider('Lapsed Owner Tours', formerOwner);
    const sessionId = await session(lapsed, {
      title: 'Lapsed Session', capacityMax: 6, joinApprovalRequired: false,
    });
    await events.publishEvent(formerOwner, sessionId);
    await requests.create(traveller, sessionId, {});

    await AppDataSource.query('UPDATE providers SET owner_user_id = NULL WHERE id = $1', [lapsed]);

    await expect(events.getEvent(formerOwner, sessionId)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(events.cancelEvent(formerOwner, sessionId)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(requests.remove(formerOwner, sessionId, traveller)).rejects.toBeInstanceOf(EventNotFoundError);
    // Self-service seat release never depended on a manager.
    await expect(requests.leave(traveller, sessionId)).resolves.toMatchObject({
      cancellationReason: 'VOLUNTARY_LEAVE',
    });
  });
});
