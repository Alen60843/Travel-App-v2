import { randomUUID } from 'node:crypto';

import { EventStatus, EventVisibility } from '@tripwith/shared';

import { ChatRepository } from '../chat/chat.repository';
import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import { EventDetailService } from './event-detail.service';
import type { PublicEventDetailView } from './event-detail.types';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { JoinRequestsService } from './join-requests.service';

/**
 * Touchable Prototype Step 3 — GET /v1/events/:eventId read model against
 * real PostgreSQL. Provider sessions are seeded directly (no provider-session
 * creation API exists); everything else goes through the real services.
 */
const prefix = `detail-int-${randomUUID()}`;
const slugPrefix = `dint-${randomUUID().slice(0, 8)}`;
let sequence = 0;
let categoryId: number;
let events: EventsService;
let requests: JoinRequestsService;
let detail: EventDetailService;

async function user(profile?: { displayName: string; avatarUrl: string }): Promise<string> {
  const uid = `${prefix}-${++sequence}`;
  const [row] = (await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
     VALUES ($1, $2, DATE '1990-01-01', 'ACTIVE') RETURNING id`,
    [uid, `${uid}@example.test`],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create event-detail test user.');
  if (profile) {
    await AppDataSource.query(
      `INSERT INTO user_profiles (user_id, display_name, avatar_url, travel_style) VALUES ($1, $2, $3, 3)`,
      [row.id, profile.displayName, profile.avatarUrl],
    );
  }
  return row.id;
}

async function provider(name: string, ownerUserId: string | null): Promise<string> {
  const [row] = (await AppDataSource.query(
    `INSERT INTO providers (slug, name, owner_user_id, contact_email)
     VALUES ($1, $2, $3, 'bookings@provider.example') RETURNING id`,
    [`${slugPrefix}-${++sequence}`, name, ownerUserId],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create provider fixture.');
  return row.id;
}

async function providerSession(
  providerId: string,
  options: { capacityMin: number; capacityMax: number; status?: 'DRAFT' | 'ACTIVE' },
): Promise<string> {
  const [row] = (await AppDataSource.query(
    `INSERT INTO events (
       host_type, host_provider_id, category_id, title, capacity_min, capacity_max,
       join_approval_required, visibility, price_minor, currency,
       starts_at, ends_at, meeting_point, meeting_point_label, status
     ) VALUES (
       'PROVIDER', $1, $2, 'Rainbow Mountain', $3, $4, FALSE, 'PUBLIC', 4500, 'USD',
       TIMESTAMPTZ '2090-09-26 05:00:00+00', TIMESTAMPTZ '2090-09-26 15:00:00+00',
       ST_MakePoint(-71.9785, -13.5170)::GEOGRAPHY, 'Plaza de Armas, Cusco', $5
     ) RETURNING id`,
    [providerId, categoryId, options.capacityMin, options.capacityMax, options.status ?? 'DRAFT'],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create provider session fixture.');
  return row.id;
}

async function userEvent(host: string, visibility: EventVisibility, publish = true) {
  const draft = await events.createEvent(host, {
    categoryId, title: 'Old City food walk', capacityMax: 10, capacityMin: 4,
    visibility, joinApprovalRequired: true, priceMinor: 2000, currency: 'EUR',
    startsAt: '2090-02-01T17:00:00Z', endsAt: '2090-02-01T20:00:00Z',
    latitude: 31.778, longitude: 35.235, meetingPointLabel: 'Jaffa Gate',
  });
  return publish ? events.publishEvent(host, draft.id) : draft;
}

async function eventRoomId(eventId: string): Promise<string> {
  const [row] = (await AppDataSource.query(
    `SELECT id FROM chat_rooms WHERE event_id = $1 AND type = 'EVENT'`, [eventId],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Expected an EVENT chat room.');
  return row.id;
}

/** Every identifier or secret that must never appear anywhere in a traveller response. */
async function assertNoPrivateData(view: PublicEventDetailView, forbidden: readonly string[]) {
  const json = JSON.stringify(view);
  for (const value of [...forbidden, prefix, '@example.test', '1990-01-01', 'bookings@provider.example']) {
    expect(json).not.toContain(value);
  }
  for (const key of [
    'firebaseUid', 'email', 'dateOfBirth', 'ownerUserId', 'owner_user_id', 'hostUserId',
    'hostProviderId', 'paymentId', 'trustScoreRaw', 'decidedByUserId', 'moderation',
  ]) {
    expect(json).not.toContain(`"${key}"`);
  }
}

describe('EventDetailService — GET /v1/events/:eventId (real PostgreSQL/PostGIS)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
    const repository = new EventsRepository(AppDataSource);
    const chat = new ChatRepository(AppDataSource);
    events = new EventsService(repository, new GeoService());
    requests = new JoinRequestsService(repository, chat);
    detail = new EventDetailService(repository, chat);
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
        const fixtureEvents = `SELECT e.id FROM events e
            LEFT JOIN providers p ON p.id = e.host_provider_id
            LEFT JOIN users u ON u.id = e.host_user_id
           WHERE p.slug LIKE $1 OR u.firebase_uid LIKE $2`;
        const params = [`${slugPrefix}%`, `${prefix}%`];
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query(`DELETE FROM event_status_history WHERE event_id IN (${fixtureEvents})`, params);
        await manager.query(`DELETE FROM events WHERE id IN (${fixtureEvents})`, params);
        await manager.query('DELETE FROM providers WHERE slug LIKE $1', [`${slugPrefix}%`]);
        await manager.query('DELETE FROM users WHERE firebase_uid LIKE $1', [`${prefix}%`]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('shows the Andes Adventures session to an unrelated traveller, then to C as a member, and to P as manager', async () => {
    const ownerP = await user();
    const [leaderA, leaderB, travellerC, stranger] = [await user(), await user(), await user(), await user()];
    const andes = await provider('Andes Adventures', ownerP);
    const rainbow = await providerSession(andes, { capacityMin: 8, capacityMax: 12 });
    await events.publishEvent(ownerP, rainbow);
    await requests.create(leaderA, rainbow, { guestCount: 3 }); // party of 4
    await requests.create(leaderB, rainbow, { guestCount: 2 }); // party of 3

    // C is unrelated: FORMING, 7 joined, 1 more needed, 5 left, may join, no room.
    const before = await detail.getEventDetail(travellerC, rainbow);
    expect(before.host).toEqual({ type: 'PROVIDER', providerId: andes, name: 'Andes Adventures' });
    expect(before.event).toMatchObject({
      id: rainbow,
      title: 'Rainbow Mountain',
      hostType: 'PROVIDER',
      status: EventStatus.Active,
      visibility: EventVisibility.Public,
      capacityMin: 8,
      capacityMax: 12,
      reservedSeatCount: 7,
      participantCount: 2,
      remainingSeats: 5,
      groupState: 'FORMING',
      seatsToConfirm: 1,
      priceMinor: 4500,
      currency: 'USD',
      joinApprovalRequired: false,
      meetingPoint: { latitude: -13.517, longitude: -71.9785, label: 'Plaza de Armas, Cusco' },
    });
    expect(before.viewer).toEqual({
      isManager: false,
      isParticipant: false,
      partySize: null,
      joinRequest: null,
      canRequestToJoin: true,
      joinUnavailableReason: null,
      primaryAction: 'REQUEST_TO_JOIN',
      chatRoomId: null,
    });
    await assertNoPrivateData(before, [ownerP, leaderA, leaderB]);

    // C joins with +1 guest: party of 2 -> 4 + 3 + 2 = 9 -> CONFIRMED.
    await requests.create(travellerC, rainbow, { guestCount: 1 });
    const room = await eventRoomId(rainbow);

    const asMember = await detail.getEventDetail(travellerC, rainbow);
    expect(asMember.event).toMatchObject({
      reservedSeatCount: 9, participantCount: 3, remainingSeats: 3,
      groupState: 'CONFIRMED', seatsToConfirm: 0,
    });
    expect(asMember.viewer).toMatchObject({
      isManager: false,
      isParticipant: true,
      partySize: 2,
      joinRequest: { status: 'APPROVED', requestedSeats: 2 },
      canRequestToJoin: false,
      primaryAction: 'OPEN_CHAT',
      chatRoomId: room,
    });
    await assertNoPrivateData(asMember, [ownerP, leaderA, leaderB]);

    const asManager = await detail.getEventDetail(ownerP, rainbow);
    expect(asManager.viewer).toMatchObject({
      isManager: true, isParticipant: false, partySize: null,
      canRequestToJoin: false, primaryAction: 'MANAGE', chatRoomId: room,
    });
    expect(asManager.host).toEqual({ type: 'PROVIDER', providerId: andes, name: 'Andes Adventures' });

    const asStranger = await detail.getEventDetail(stranger, rainbow);
    expect(asStranger.viewer).toMatchObject({ isParticipant: false, chatRoomId: null, primaryAction: 'REQUEST_TO_JOIN' });
    expect(JSON.stringify(asStranger)).not.toContain(room);
  });

  it('serves a USER-hosted Event with the host profile and tracks pending -> member -> left honestly', async () => {
    const host = await user({ displayName: 'Noa the Host', avatarUrl: 'https://cdn.example/noa.png' });
    const traveller = await user();
    const walk = await userEvent(host, EventVisibility.Public);

    const fresh = await detail.getEventDetail(traveller, walk.id);
    expect(fresh.host).toEqual({
      type: 'USER', userId: host, displayName: 'Noa the Host', avatarUrl: 'https://cdn.example/noa.png',
    });
    expect(fresh.event).toMatchObject({
      hostType: 'USER', reservedSeatCount: 1, groupState: 'FORMING', seatsToConfirm: 3, remainingSeats: 9,
    });
    await assertNoPrivateData(fresh, []);

    // Pending request (approval required): awaiting approval, no membership, no room.
    const pending = await requests.create(traveller, walk.id, { guestCount: 2 });
    await expect(detail.getEventDetail(traveller, walk.id)).resolves.toMatchObject({
      viewer: {
        isParticipant: false, partySize: null,
        joinRequest: { id: pending.id, status: 'PENDING', requestedSeats: 3 },
        canRequestToJoin: false, primaryAction: 'AWAITING_APPROVAL', chatRoomId: null,
      },
    });

    // Approved -> active member with party 3 and the room.
    await requests.approve(host, walk.id, pending.id);
    const room = await eventRoomId(walk.id);
    await expect(detail.getEventDetail(traveller, walk.id)).resolves.toMatchObject({
      event: { reservedSeatCount: 4, groupState: 'CONFIRMED', seatsToConfirm: 0 },
      viewer: { isParticipant: true, partySize: 3, primaryAction: 'OPEN_CHAT', chatRoomId: room },
    });
    await expect(detail.getEventDetail(host, walk.id)).resolves.toMatchObject({
      viewer: { isManager: true, primaryAction: 'MANAGE', chatRoomId: room },
    });

    // Left: the APPROVED request stays as history, but it is not membership.
    await requests.leave(traveller, walk.id);
    const afterLeave = await detail.getEventDetail(traveller, walk.id);
    expect(afterLeave.viewer).toEqual({
      isManager: false,
      isParticipant: false,
      partySize: null,
      joinRequest: { id: pending.id, status: 'APPROVED', requestedSeats: 3 },
      canRequestToJoin: true,
      joinUnavailableReason: null,
      primaryAction: 'REQUEST_TO_JOIN',
      chatRoomId: null,
    });
    expect(afterLeave.event).toMatchObject({ reservedSeatCount: 1, groupState: 'FORMING' });
  });

  it('never makes a DRAFT publicly visible', async () => {
    const host = await user();
    const stranger = await user();
    const draft = await userEvent(host, EventVisibility.Public, false);

    await expect(detail.getEventDetail(stranger, draft.id)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(detail.getEventDetail(host, draft.id)).resolves.toMatchObject({
      event: { status: EventStatus.Draft, groupState: null },
      viewer: { isManager: true, primaryAction: 'MANAGE', chatRoomId: null },
    });
  });

  it.each([EventVisibility.Private, EventVisibility.Unlisted])(
    'does not leak a %s Event to unrelated users, exactly like a missing Event',
    async (visibility) => {
      const host = await user();
      const stranger = await user();
      const member = await user();
      const hidden = await userEvent(host, visibility);

      const missing = await detail.getEventDetail(stranger, randomUUID()).catch((error: unknown) => error);
      const denied = await detail.getEventDetail(stranger, hidden.id).catch((error: unknown) => error);
      expect(denied).toBeInstanceOf(EventNotFoundError);
      expect(denied).toMatchObject({
        code: (missing as EventNotFoundError).code,
        status: (missing as EventNotFoundError).status,
        message: (missing as EventNotFoundError).message,
      });

      // A current participant keeps access to the Event they belong to.
      await AppDataSource.query(
        'INSERT INTO event_participants (event_id, user_id, guest_count) VALUES ($1, $2, 1)',
        [hidden.id, member],
      );
      await expect(detail.getEventDetail(member, hidden.id)).resolves.toMatchObject({
        event: { visibility }, viewer: { isParticipant: true, partySize: 2 },
      });
    },
  );

  it('keeps a cancelled Event for its participant but not for strangers, and cancelled participation is not membership', async () => {
    const host = await user();
    const participant = await user();
    const leaver = await user();
    const stranger = await user();
    const walk = await userEvent(host, EventVisibility.Public);
    const kept = await requests.create(participant, walk.id, {});
    await requests.approve(host, walk.id, kept.id);
    const left = await requests.create(leaver, walk.id, {});
    await requests.approve(host, walk.id, left.id);
    await requests.leave(leaver, walk.id);

    await events.cancelEvent(host, walk.id);

    await expect(detail.getEventDetail(participant, walk.id)).resolves.toMatchObject({
      event: { status: EventStatus.Cancelled, groupState: 'CANCELLED' },
      viewer: { isParticipant: true, canRequestToJoin: false, primaryAction: 'OPEN_CHAT' },
    });
    // The leaver's participation is cancelled: no membership, so a cancelled
    // Event is no longer theirs to see.
    await expect(detail.getEventDetail(leaver, walk.id)).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(detail.getEventDetail(stranger, walk.id)).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it.each([EventVisibility.Private, EventVisibility.Unlisted])(
    'cannot bypass Event Detail privacy by joining a %s Event: refused like a missing id, nothing written',
    async (visibility) => {
      const host = await user();
      const stranger = await user();
      const hidden = await userEvent(host, visibility);

      const missing = await requests.create(stranger, randomUUID(), {}).catch((error: unknown) => error);
      const refused = await requests.create(stranger, hidden.id, { guestCount: 1 }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(EventNotFoundError);
      expect(refused).toMatchObject({
        code: (missing as EventNotFoundError).code,
        status: (missing as EventNotFoundError).status,
        message: (missing as EventNotFoundError).message,
      });

      const [written] = (await AppDataSource.query(
        `SELECT (SELECT count(*)::int FROM event_join_requests WHERE event_id = $1) AS requests,
                (SELECT count(*)::int FROM event_participants  WHERE event_id = $1) AS participants,
                (SELECT count(*)::int FROM chat_rooms          WHERE event_id = $1) AS rooms`,
        [hidden.id],
      )) as Array<Record<string, number>>;
      expect(written).toEqual({ requests: 0, participants: 0, rooms: 0 });

      // The failed attempt did not make the stranger a related viewer.
      await expect(detail.getEventDetail(stranger, hidden.id)).rejects.toBeInstanceOf(EventNotFoundError);
    },
  );

  it('cannot confirm a PUBLIC DRAFT exists through the join path: missing-Event answer, nothing written', async () => {
    const host = await user();
    const stranger = await user();
    const draft = await userEvent(host, EventVisibility.Public, false);

    const missing = await requests.create(stranger, randomUUID(), {}).catch((error: unknown) => error);
    const refused = await requests.create(stranger, draft.id, { guestCount: 2 }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(EventNotFoundError);
    expect(refused).toMatchObject({
      code: (missing as EventNotFoundError).code,
      status: (missing as EventNotFoundError).status,
      message: (missing as EventNotFoundError).message,
    });

    const [written] = (await AppDataSource.query(
      `SELECT (SELECT count(*)::int FROM event_join_requests WHERE event_id = $1) AS requests,
              (SELECT count(*)::int FROM event_participants  WHERE event_id = $1) AS participants,
              (SELECT count(*)::int FROM chat_rooms          WHERE event_id = $1) AS rooms`,
      [draft.id],
    )) as Array<Record<string, number>>;
    expect(written).toEqual({ requests: 0, participants: 0, rooms: 0 });
    await expect(detail.getEventDetail(stranger, draft.id)).rejects.toBeInstanceOf(EventNotFoundError);

    // The manager's own DRAFT behaves as before on both paths.
    await expect(requests.create(host, draft.id, {})).rejects.toMatchObject({ code: 'EVENT_SELF_JOIN' });
    await expect(detail.getEventDetail(host, draft.id)).resolves.toMatchObject({
      event: { status: EventStatus.Draft }, viewer: { isManager: true },
    });
  });

  it('still accepts a request on a PUBLIC FULL Event, which stays PENDING (Phase 8 semantics)', async () => {
    const host = await user();
    const [first, late] = [await user(), await user()];
    const draft = await events.createEvent(host, {
      categoryId, title: 'Tiny sunset kayak', capacityMax: 2, visibility: EventVisibility.Public,
      joinApprovalRequired: false, startsAt: '2090-03-01T17:00:00Z', endsAt: '2090-03-01T19:00:00Z',
      latitude: 31.778, longitude: 35.235,
    });
    await events.publishEvent(host, draft.id);
    await requests.create(first, draft.id, {}); // host 1 + first 1 = 2 -> FULL

    const lateRequest = await requests.create(late, draft.id, {});
    expect(lateRequest).toMatchObject({ status: 'PENDING', currentlyFits: false });
    await expect(detail.getEventDetail(late, draft.id)).resolves.toMatchObject({
      event: { status: EventStatus.Full, groupState: 'FULL', remainingSeats: 0 },
      viewer: { isParticipant: false, primaryAction: 'AWAITING_APPROVAL', chatRoomId: null },
    });
  });

  it('hides an unclaimed (owner_user_id NULL) provider session from travellers', async () => {
    const stranger = await user();
    const unclaimed = await provider('Unclaimed Imported Tours', null);
    const orphan = await providerSession(unclaimed, { capacityMin: 2, capacityMax: 6, status: 'ACTIVE' });

    await expect(detail.getEventDetail(stranger, orphan)).rejects.toBeInstanceOf(EventNotFoundError);
  });
});
