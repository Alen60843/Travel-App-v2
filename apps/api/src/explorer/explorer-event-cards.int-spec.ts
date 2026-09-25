import { randomUUID } from 'node:crypto';

import { EventStatus, EventVisibility } from '@tripwith/shared';

import { ChatRepository } from '../chat/chat.repository';
import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import type { CreateEventDto } from '../events/dto';
import { EventsRepository } from '../events/events.repository';
import { EventsService } from '../events/events.service';
import { JoinRequestsService } from '../events/join-requests.service';
import { ExplorerRepository } from './explorer.repository';
import { ExplorerService } from './explorer.service';
import type { ExplorerEventCard, ExplorerEventCardsView, NormalizedExplorerQuery } from './explorer.types';

/**
 * Prototype Step 5 — GET /v1/explorer/event-cards (and the unchanged map
 * endpoint's counts) against real PostgreSQL/PostGIS. Every fixture sits
 * around a per-run random mid-ocean point with a tight radius, so no other
 * data in the database can enter these results.
 */
const prefix = `cards-int-${randomUUID()}`;
const slugPrefix = `cint-${randomUUID().slice(0, 8)}`;
const CENTER = { latitude: -40 - Math.random() * 5, longitude: -130 - Math.random() * 5 };
const WINDOW = { windowStart: '2090-09-01T00:00:00Z', windowEnd: '2090-10-01T00:00:00Z' };
let sequence = 0;
let categoryCode: string;
let categoryId: number;
let otherCategoryCode: string;
let otherCategoryId: number;
let events: EventsService;
let requests: JoinRequestsService;
let explorer: ExplorerService;

async function user(profile?: { displayName: string; avatarUrl?: string }): Promise<string> {
  const uid = `${prefix}-${++sequence}`;
  const [row] = (await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
     VALUES ($1, $2, DATE '1990-01-01', 'ACTIVE') RETURNING id`,
    [uid, `${uid}@example.test`],
  )) as Array<{ id: string }>;
  if (profile) {
    await AppDataSource.query(
      `INSERT INTO user_profiles (user_id, display_name, avatar_url, travel_style) VALUES ($1, $2, $3, 3)`,
      [row!.id, profile.displayName, profile.avatarUrl ?? null],
    );
  }
  return row!.id;
}

async function provider(name: string, ownerUserId: string | null): Promise<string> {
  const [row] = (await AppDataSource.query(
    `INSERT INTO providers (slug, name, owner_user_id, contact_email)
     VALUES ($1, $2, $3, 'bookings@provider.example') RETURNING id`,
    [`${slugPrefix}-${++sequence}`, name, ownerUserId],
  )) as Array<{ id: string }>;
  return row!.id;
}

async function providerSession(
  providerId: string,
  title: string,
  startsAt: string,
  options: { capacityMin: number | null; capacityMax: number; status?: 'DRAFT' | 'ACTIVE' },
): Promise<string> {
  const [row] = (await AppDataSource.query(
    `INSERT INTO events (
       host_type, host_provider_id, category_id, title, description, capacity_min, capacity_max,
       join_approval_required, price_minor, currency, starts_at, ends_at,
       meeting_point, meeting_point_label, status
     ) VALUES (
       'PROVIDER', $1, $2, $3, 'Guided day trip', $4, $5, FALSE, 4500, 'USD',
       $6::timestamptz, $6::timestamptz + INTERVAL '10 hours',
       ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, 'Harbour gate', $9
     ) RETURNING id`,
    [
      providerId, categoryId, title, options.capacityMin, options.capacityMax,
      startsAt, CENTER.longitude, CENTER.latitude, options.status ?? 'DRAFT',
    ],
  )) as Array<{ id: string }>;
  return row!.id;
}

async function userEvent(
  host: string,
  overrides: Partial<CreateEventDto> & { startsAt: string },
  publish = true,
) {
  const draft = await events.createEvent(host, {
    categoryId, title: 'Harbour food walk', capacityMax: 10, visibility: EventVisibility.Public,
    joinApprovalRequired: false, priceMinor: 2000, currency: 'EUR',
    endsAt: new Date(Date.parse(overrides.startsAt) + 3 * 3_600_000).toISOString(),
    latitude: CENTER.latitude, longitude: CENTER.longitude,
    ...overrides,
  });
  return publish ? events.publishEvent(host, draft.id) : draft;
}

async function forceStatus(eventId: string, actor: string, status: 'IN_PROGRESS' | 'COMPLETED') {
  await AppDataSource.transaction(async (manager) => {
    await manager.query(
      `SELECT set_config('tripwith.actor_user_id', $1, true),
              set_config('tripwith.transition_reason', 'test_lifecycle', true)`,
      [actor],
    );
    await manager.query(`UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1`, [eventId]);
    if (status === 'COMPLETED') {
      await manager.query(`UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1`, [eventId]);
    }
  });
}

const area = { centerLatitude: CENTER.latitude, centerLongitude: CENTER.longitude, radiusMeters: 5_000 };

async function cards(extra: Record<string, unknown> = {}): Promise<ExplorerEventCardsView> {
  return explorer.discoverEventCards('viewer', { ...area, ...WINDOW, ...extra });
}

const byId = (view: ExplorerEventCardsView, id: string): ExplorerEventCard | undefined =>
  view.cards.find((card) => card.eventId === id);

describe('Explorer event cards — "groups forming near you" (real PostgreSQL/PostGIS)', () => {
  const ids: Record<string, string> = {};
  let ownerP: string;
  let andes: string;
  let userHost: string;

  beforeAll(async () => {
    await AppDataSource.initialize();
    const repository = new EventsRepository(AppDataSource);
    events = new EventsService(repository, new GeoService());
    requests = new JoinRequestsService(repository, new ChatRepository(AppDataSource));
    explorer = new ExplorerService(new ExplorerRepository(AppDataSource, new GeoService()));
    const categories = (await AppDataSource.query(
      'SELECT id, code FROM event_categories WHERE is_active ORDER BY id LIMIT 2',
    )) as Array<{ id: number; code: string }>;
    if (categories.length < 2) throw new Error('Two active event categories are required.');
    [categoryId, categoryCode, otherCategoryId, otherCategoryCode] =
      [categories[0]!.id, categories[0]!.code, categories[1]!.id, categories[1]!.code];

    ownerP = await user();
    andes = await provider('Andes Adventures', ownerP);
    userHost = await user({ displayName: 'Noa the Host', avatarUrl: 'https://cdn.example/noa.png' });

    // Visible: provider session (FORMING), USER event with no minimum (OPEN), a FULL USER event.
    ids.rainbow = await providerSession(andes, 'Rainbow Mountain', '2090-09-26T05:00:00Z', { capacityMin: 8, capacityMax: 12 });
    await events.publishEvent(ownerP, ids.rainbow);
    ids.open = (await userEvent(userHost, { title: 'Harbour food walk', startsAt: '2090-09-10T17:00:00Z' })).id;
    ids.full = (await userEvent(userHost, { title: 'Tiny kayak trip', capacityMax: 2, startsAt: '2090-09-12T08:00:00Z' })).id;
    await requests.create(await user(), ids.full, {}); // host 1 + 1 = 2 -> FULL

    // Hidden / ineligible.
    ids.draft = (await userEvent(userHost, { title: 'Draft walk', startsAt: '2090-09-11T10:00:00Z' }, false)).id;
    ids.private = (await userEvent(userHost, { title: 'Private walk', visibility: EventVisibility.Private, startsAt: '2090-09-11T10:00:00Z' })).id;
    ids.unlisted = (await userEvent(userHost, { title: 'Unlisted walk', visibility: EventVisibility.Unlisted, startsAt: '2090-09-11T10:00:00Z' })).id;
    ids.cancelled = (await userEvent(userHost, { title: 'Cancelled walk', startsAt: '2090-09-11T10:00:00Z' })).id;
    await events.cancelEvent(userHost, ids.cancelled);
    ids.inProgress = (await userEvent(userHost, { title: 'Running walk', startsAt: '2090-09-11T10:00:00Z' })).id;
    await forceStatus(ids.inProgress, userHost, 'IN_PROGRESS');
    ids.completed = (await userEvent(userHost, { title: 'Finished walk', startsAt: '2090-09-11T10:00:00Z' })).id;
    await forceStatus(ids.completed, userHost, 'COMPLETED');
    const unclaimed = await provider('Unclaimed Imported Tours', null);
    ids.unclaimed = await providerSession(unclaimed, 'Orphan Session', '2090-09-11T10:00:00Z', { capacityMin: 2, capacityMax: 6, status: 'ACTIVE' });
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

  it('forms Rainbow Mountain 4 + 3 (+ 2) from DB truth, with no client arithmetic', async () => {
    await requests.create(await user(), ids.rainbow!, { guestCount: 3 }); // party A: 4 seats
    await requests.create(await user(), ids.rainbow!, { guestCount: 2 }); // party B: 3 seats

    expect(byId(await cards(), ids.rainbow!)).toEqual({
      eventId: ids.rainbow,
      title: 'Rainbow Mountain',
      description: 'Guided day trip',
      category: expect.objectContaining({ code: categoryCode }),
      hostType: 'PROVIDER',
      host: { type: 'PROVIDER', providerId: andes, name: 'Andes Adventures' },
      status: EventStatus.Active,
      startsAt: '2090-09-26T05:00:00.000Z',
      endsAt: '2090-09-26T15:00:00.000Z',
      coordinate: { latitude: expect.closeTo(CENTER.latitude, 9), longitude: expect.closeTo(CENTER.longitude, 9) },
      meetingPointLabel: 'Harbour gate',
      capacityMin: 8,
      capacityMax: 12,
      reservedSeatCount: 7,
      remainingSeats: 5,
      participantCount: 2,
      groupState: 'FORMING',
      seatsToConfirm: 1,
      priceMinor: 4500,
      currency: 'USD',
      joinApprovalRequired: false,
    });

    await requests.create(await user(), ids.rainbow!, { guestCount: 1 }); // party C: 2 seats
    expect(byId(await cards(), ids.rainbow!)).toMatchObject({
      reservedSeatCount: 9, participantCount: 3, remainingSeats: 3, groupState: 'CONFIRMED', seatsToConfirm: 0,
    });
  });

  it('shows USER-hosted OPEN and FULL Events with a safe profile host summary', async () => {
    const view = await cards();
    const host = { type: 'USER', userId: userHost, displayName: 'Noa the Host', avatarUrl: 'https://cdn.example/noa.png' };
    expect(byId(view, ids.open!)).toMatchObject({
      hostType: 'USER', host, capacityMin: null, reservedSeatCount: 1, participantCount: 0,
      remainingSeats: 9, groupState: 'OPEN', seatsToConfirm: null,
    });
    expect(byId(view, ids.full!)).toMatchObject({
      host, status: EventStatus.Full, reservedSeatCount: 2, participantCount: 1, remainingSeats: 0, groupState: 'FULL',
    });
  });

  it('never lists DRAFT, PRIVATE, UNLISTED, CANCELLED, IN_PROGRESS, COMPLETED or unclaimed-provider Events — nor counts them on the map', async () => {
    const view = await cards();
    expect(view.cards.map((card) => card.eventId).sort()).toEqual([ids.rainbow, ids.open, ids.full].sort());
    for (const hidden of ['draft', 'private', 'unlisted', 'cancelled', 'inProgress', 'completed', 'unclaimed']) {
      expect(byId(view, ids[hidden]!)).toBeUndefined();
    }

    // Existing map endpoint: same population, including exact pin/cluster counts.
    for (const zoom of [18, 3]) {
      const map = await explorer.discoverEvents('viewer', { ...area, ...WINDOW, zoom });
      expect(map.eventCount).toBe(3);
    }
    const pins = await explorer.discoverEvents('viewer', { ...area, ...WINDOW, zoom: 18 });
    expect(pins.markers.map((marker) => marker.id).sort()).toEqual([ids.rainbow, ids.open, ids.full].sort());
  });

  it('exposes no owner, identity, roster, request, chat or payment data', async () => {
    const json = JSON.stringify(await cards());
    const participants = (await AppDataSource.query(
      `SELECT user_id FROM event_participants WHERE event_id = ANY($1::uuid[])`, [[ids.rainbow, ids.full]],
    )) as Array<{ user_id: string }>;
    const requestIds = (await AppDataSource.query(
      `SELECT id FROM event_join_requests WHERE event_id = ANY($1::uuid[])`, [[ids.rainbow, ids.full]],
    )) as Array<{ id: string }>;
    const rooms = (await AppDataSource.query(
      `SELECT id FROM chat_rooms WHERE event_id = ANY($1::uuid[])`, [[ids.rainbow, ids.full]],
    )) as Array<{ id: string }>;
    expect(participants.length).toBeGreaterThan(0);
    expect(rooms.length).toBeGreaterThan(0);
    for (const value of [
      ownerP, ...participants.map((row) => row.user_id), ...requestIds.map((row) => row.id), ...rooms.map((row) => row.id),
      prefix, '@example.test', '1990-01-01', 'bookings@provider.example',
    ]) {
      expect(json).not.toContain(value);
    }
    for (const key of [
      'ownerUserId', 'owner_user_id', 'firebaseUid', 'email', 'dateOfBirth', 'participants', 'chatRoomId',
      'paymentId', 'depositMinor', 'hostGuestCount', 'trustScore', 'viewer',
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it('keeps the existing filters: category, time window and radius', async () => {
    const other = (await userEvent(userHost, {
      title: 'Other-category walk', categoryId: otherCategoryId, startsAt: '2090-09-15T10:00:00Z',
    })).id;
    expect(byId(await cards(), other)).toBeDefined();
    expect(byId(await cards({ categoryCodes: [categoryCode] }), other)).toBeUndefined();
    expect(byId(await cards({ categoryCodes: [otherCategoryCode] }), other)).toBeDefined();

    const septemberFirstHalf = await cards({ windowStart: '2090-09-01T00:00:00Z', windowEnd: '2090-09-11T00:00:00Z' });
    expect(septemberFirstHalf.cards.map((card) => card.eventId)).toEqual([ids.open]);

    const farAway = await explorer.discoverEventCards('viewer', {
      centerLatitude: CENTER.latitude + 1, centerLongitude: CENTER.longitude, radiusMeters: 5_000, ...WINDOW,
    });
    expect(farAway.cards.filter((card) => Object.values(ids).includes(card.eventId))).toEqual([]);
  });

  it('treats starts_at == now as started (excluded) and starts_at after now as joinable, on cards AND map', async () => {
    const repository = new ExplorerRepository(AppDataSource, new GeoService());
    const openStartsAt = new Date('2090-09-10T17:00:00Z'); // ids.open
    const at = (now: Date): NormalizedExplorerQuery => ({
      spatial: { kind: 'radius', center: CENTER, radiusMeters: 5_000 },
      now,
      windowStart: now,
      windowEnd: new Date('2090-10-01T00:00:00Z'),
      categoryCodes: [categoryCode],
      zoom: 18,
      limit: 100,
    });

    const exactlyAtStart = await repository.findDiscoverableEventCards(at(openStartsAt));
    expect(exactlyAtStart.cards.map((card) => card.eventId)).not.toContain(ids.open);
    expect(exactlyAtStart.cards.map((card) => card.eventId)).toEqual(expect.arrayContaining([ids.full, ids.rainbow]));
    const mapAtStart = await repository.findDiscoverableMarkers(at(openStartsAt));
    expect(mapAtStart.markers.map((marker) => marker.id)).not.toContain(ids.open);

    const justBefore = new Date(openStartsAt.getTime() - 1);
    expect((await repository.findDiscoverableEventCards(at(justBefore))).cards.map((card) => card.eventId)).toContain(ids.open);
    expect((await repository.findDiscoverableMarkers(at(justBefore))).markers.map((marker) => marker.id)).toContain(ids.open);
  });

  it('drops already-started ACTIVE and FULL Events from cards, pins and cluster counts (real clock)', async () => {
    const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
    const startedActive = (await userEvent(userHost, { title: 'Started walk', startsAt: inDays(2) })).id;
    const startedFull = (await userEvent(userHost, { title: 'Started kayak', capacityMax: 2, startsAt: inDays(2) })).id;
    await requests.create(await user(), startedFull, {});
    const future = (await userEvent(userHost, { title: 'Upcoming walk', startsAt: inDays(3) })).id;
    // Lifecycle jobs have not run yet: both stay ACTIVE / FULL, but have started.
    await AppDataSource.query(
      `UPDATE events SET starts_at = now() - INTERVAL '1 hour', ends_at = now() + INTERVAL '2 hours'
        WHERE id = ANY($1::uuid[])`,
      [[startedActive, startedFull]],
    );
    const statuses = (await AppDataSource.query(
      `SELECT status FROM events WHERE id = ANY($1::uuid[]) ORDER BY status`, [[startedActive, startedFull]],
    )) as Array<{ status: string }>;
    expect(statuses.map((row) => row.status)).toEqual(['ACTIVE', 'FULL']);

    // Default window (now .. now + 30 days) around the fixture point.
    const view = await explorer.discoverEventCards('viewer', area);
    expect(view.cards.map((card) => card.eventId)).toEqual([future]);
    for (const zoom of [18, 3]) {
      const map = await explorer.discoverEvents('viewer', { ...area, zoom });
      expect(map.eventCount).toBe(1);
    }
    const pins = await explorer.discoverEvents('viewer', { ...area, zoom: 18 });
    expect(pins.markers.map((marker) => marker.id)).toEqual([future]);
  });

  it('orders deterministically by startsAt, then eventId, and pages with hasMore', async () => {
    const twinA = (await userEvent(userHost, { title: 'Twin sunrise A', startsAt: '2090-09-20T05:00:00Z' })).id;
    const twinB = (await userEvent(userHost, { title: 'Twin sunrise B', startsAt: '2090-09-20T05:00:00Z' })).id;
    const view = await cards({ categoryCodes: [categoryCode] });
    const order = view.cards.map((card) => card.eventId);
    expect(order).toEqual([ids.open, ids.full, ...[twinA, twinB].sort(), ids.rainbow]);
    expect(view.hasMore).toBe(false);

    const firstPage = await cards({ categoryCodes: [categoryCode], limit: 2 });
    expect(firstPage.cards.map((card) => card.eventId)).toEqual([ids.open, ids.full]);
    expect(firstPage.hasMore).toBe(true);
  });
});
