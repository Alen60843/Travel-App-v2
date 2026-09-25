import { randomUUID } from 'node:crypto';

import { EventVisibility } from '@tripwith/shared';

import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import { EventsRepository } from '../events/events.repository';
import { EventsService } from '../events/events.service';
import { JoinRequestsService } from '../events/join-requests.service';
import { ChatInboxRepository } from './chat-inbox.repository';
import { ChatInboxService } from './chat-inbox.service';
import type { InboxRoomView } from './chat-inbox.types';
import { ChatRoomNotFoundError } from './chat.errors';
import { ChatRepository } from './chat.repository';

/**
 * Touchable Prototype Step 4 — GET /v1/chat/rooms (+ /:roomId) against real
 * PostgreSQL. Event rooms are produced by the real join/approve/leave/remove
 * services; the MATCH room is seeded exactly as SwipesRepository creates it.
 */
const prefix = `inbox-int-${randomUUID()}`;
const slugPrefix = `iint-${randomUUID().slice(0, 8)}`;
let sequence = 0;
let categoryId: number;
let events: EventsService;
let requests: JoinRequestsService;
let chat: ChatRepository;
let inbox: ChatInboxService;
const matchRoomIds: string[] = [];

async function user(profile?: { displayName: string; avatarUrl?: string }): Promise<string> {
  const uid = `${prefix}-${++sequence}`;
  const [row] = (await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
     VALUES ($1, $2, DATE '1990-01-01', 'ACTIVE') RETURNING id`,
    [uid, `${uid}@example.test`],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Failed to create inbox test user.');
  if (profile) {
    await AppDataSource.query(
      `INSERT INTO user_profiles (user_id, display_name, avatar_url, travel_style) VALUES ($1, $2, $3, 3)`,
      [row.id, profile.displayName, profile.avatarUrl ?? null],
    );
  }
  return row.id;
}

async function providerSession(ownerUserId: string): Promise<{ providerId: string; eventId: string }> {
  const [provider] = (await AppDataSource.query(
    `INSERT INTO providers (slug, name, owner_user_id, contact_email)
     VALUES ($1, 'Andes Adventures', $2, 'bookings@andes.example') RETURNING id`,
    [`${slugPrefix}-${++sequence}`, ownerUserId],
  )) as Array<{ id: string }>;
  const [session] = (await AppDataSource.query(
    `INSERT INTO events (
       host_type, host_provider_id, category_id, title, capacity_min, capacity_max,
       join_approval_required, starts_at, ends_at, meeting_point, status
     ) VALUES (
       'PROVIDER', $1, $2, 'Rainbow Mountain', 8, 12, FALSE,
       TIMESTAMPTZ '2090-09-26 05:00:00+00', TIMESTAMPTZ '2090-09-26 15:00:00+00',
       ST_MakePoint(-71.9785, -13.5170)::GEOGRAPHY, 'DRAFT'
     ) RETURNING id`,
    [provider!.id, categoryId],
  )) as Array<{ id: string }>;
  await events.publishEvent(ownerUserId, session!.id);
  return { providerId: provider!.id, eventId: session!.id };
}

async function matchRoom(x: string, y: string): Promise<string> {
  const [room] = (await AppDataSource.query(
    `INSERT INTO chat_rooms (type) VALUES ('MATCH') RETURNING id`,
  )) as Array<{ id: string }>;
  matchRoomIds.push(room!.id);
  await AppDataSource.query(
    'INSERT INTO chat_members (room_id, user_id) VALUES ($1, $2), ($1, $3)', [room!.id, x, y],
  );
  const [a, b] = x < y ? [x, y] : [y, x];
  await AppDataSource.query(
    'INSERT INTO matches (user_a_id, user_b_id, chat_room_id) VALUES ($1, $2, $3)', [a, b, room!.id],
  );
  return room!.id;
}

async function eventRoomId(eventId: string): Promise<string> {
  const [row] = (await AppDataSource.query(
    `SELECT id FROM chat_rooms WHERE event_id = $1 AND type = 'EVENT'`, [eventId],
  )) as Array<{ id: string }>;
  if (!row) throw new Error('Expected an EVENT chat room.');
  return row.id;
}

const send = (roomId: string, sender: string, body: string) =>
  chat.sendTextMessage(roomId, sender, randomUUID(), body);

const roomIds = async (userId: string) => (await inbox.listRooms(userId)).map((room) => room.roomId);

function assertNoPrivateData(rooms: readonly InboxRoomView[], forbiddenIds: readonly string[]) {
  const json = JSON.stringify(rooms);
  for (const value of [...forbiddenIds, prefix, '@example.test', '1990-01-01', 'bookings@andes.example']) {
    expect(json).not.toContain(value);
  }
  for (const key of [
    'firebaseUid', 'email', 'dateOfBirth', 'ownerUserId', 'owner_user_id', 'members', 'participants',
    'sharedLocation', 'mediaStorageKey', 'clientMessageId', 'trustScore', 'paymentId', 'lastReadSeq',
  ]) {
    expect(json).not.toContain(`"${key}"`);
  }
}

describe('ChatInboxService (real PostgreSQL)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
    const repository = new EventsRepository(AppDataSource);
    chat = new ChatRepository(AppDataSource);
    events = new EventsService(repository, new GeoService());
    requests = new JoinRequestsService(repository, chat);
    inbox = new ChatInboxService(new ChatInboxRepository(AppDataSource));
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
        // Rooms (and their messages) go before users: messages.sender_user_id
        // is ON DELETE SET NULL, which a TEXT message's CHECK would reject.
        const fixtureEvents = `SELECT e.id FROM events e
            LEFT JOIN providers p ON p.id = e.host_provider_id
            LEFT JOIN users u ON u.id = e.host_user_id
           WHERE p.slug LIKE $1 OR u.firebase_uid LIKE $2`;
        const params = [`${slugPrefix}%`, `${prefix}%`];
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query(`DELETE FROM event_status_history WHERE event_id IN (${fixtureEvents})`, params);
        await manager.query(`DELETE FROM events WHERE id IN (${fixtureEvents})`, params);
        await manager.query('DELETE FROM matches WHERE chat_room_id = ANY($1::uuid[])', [matchRoomIds]);
        await manager.query('DELETE FROM chat_rooms WHERE id = ANY($1::uuid[])', [matchRoomIds]);
        await manager.query('DELETE FROM providers WHERE slug LIKE $1', [`${slugPrefix}%`]);
        await manager.query('DELETE FROM users WHERE firebase_uid LIKE $1', [`${prefix}%`]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('shows the Rainbow Mountain room to P, A, B and C only, and drops it for C after C leaves', async () => {
    const ownerP = await user();
    const [leaderA, leaderB, travellerC, stranger] = [await user(), await user(), await user(), await user()];
    const { providerId, eventId } = await providerSession(ownerP);
    await requests.create(leaderA, eventId, { guestCount: 3 });
    await requests.create(leaderB, eventId, { guestCount: 2 });
    await requests.create(travellerC, eventId, { guestCount: 1 });
    const room = await eventRoomId(eventId);

    await send(room, leaderA, 'Who is bringing snacks?');
    const latest = await send(room, leaderB, 'Meet at the plaza at 4:30!');

    const [row] = await inbox.listRooms(travellerC);
    expect(row).toEqual({
      roomId: room,
      type: 'EVENT',
      title: 'Rainbow Mountain',
      subtitle: 'Andes Adventures',
      avatarUrl: null,
      eventId,
      event: {
        id: eventId,
        title: 'Rainbow Mountain',
        hostType: 'PROVIDER',
        status: 'ACTIVE',
        startsAt: '2090-09-26T05:00:00.000Z',
        capacityMin: 8,
        capacityMax: 12,
        reservedSeatCount: 9,
        groupState: 'CONFIRMED',
        seatsToConfirm: 0,
        host: { type: 'PROVIDER', providerId, name: 'Andes Adventures' },
      },
      counterpart: null,
      provider: null,
      lastMessage: {
        messageId: latest.message.id,
        seq: 2,
        senderUserId: leaderB,
        type: 'TEXT',
        body: 'Meet at the plaza at 4:30!',
        createdAt: latest.message.createdAt.toISOString(),
      },
      lastActivityAt: latest.message.createdAt.toISOString(),
      unreadCount: 2,
    });
    // Other members are never listed; the provider owner is never exposed.
    assertNoPrivateData([row!], [ownerP, leaderA, travellerC]);
    await expect(inbox.getRoom(travellerC, room)).resolves.toEqual(row);

    // Provider owner and the other members see it; an unrelated user cannot discover it.
    for (const member of [ownerP, leaderA, leaderB]) expect(await roomIds(member)).toEqual([room]);
    expect(await roomIds(stranger)).toEqual([]);
    await expect(inbox.getRoom(stranger, room)).rejects.toBeInstanceOf(ChatRoomNotFoundError);

    // C leaves: membership inactive -> gone from C's Inbox and header, and the
    // existing message authorization refuses C exactly as before.
    await requests.leave(travellerC, eventId);
    expect(await roomIds(travellerC)).toEqual([]);
    await expect(inbox.getRoom(travellerC, room)).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    await expect(send(room, travellerC, 'still here?')).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    await expect(chat.listMessagesAfter(room, travellerC, 0, 10)).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    for (const member of [ownerP, leaderA, leaderB]) expect(await roomIds(member)).toEqual([room]);
    await expect(inbox.getRoom(ownerP, room)).resolves.toMatchObject({
      event: { reservedSeatCount: 7, groupState: 'FORMING', seatsToConfirm: 1 },
    });

    // The provider owner removes A pre-start: A's Inbox drops the room too.
    await requests.remove(ownerP, eventId, leaderA);
    expect(await roomIds(leaderA)).toEqual([]);
    expect(await roomIds(ownerP)).toEqual([room]);
    expect(await roomIds(leaderB)).toEqual([room]);
  });

  it('never shows the room to a pending requester or to a historical APPROVED requester who left', async () => {
    const host = await user({ displayName: 'Noa the Host', avatarUrl: 'https://cdn.example/noa.png' });
    const [member, pending, former] = [await user(), await user(), await user()];
    const draft = await events.createEvent(host, {
      categoryId, title: 'Old City food walk', capacityMax: 10, visibility: EventVisibility.Public,
      joinApprovalRequired: true, startsAt: '2090-02-01T17:00:00Z', endsAt: '2090-02-01T20:00:00Z',
      latitude: 31.778, longitude: 35.235,
    });
    const walk = await events.publishEvent(host, draft.id);
    const memberRequest = await requests.create(member, walk.id, {});
    await requests.approve(host, walk.id, memberRequest.id);
    const formerRequest = await requests.create(former, walk.id, { guestCount: 1 });
    await requests.approve(host, walk.id, formerRequest.id);
    await requests.leave(former, walk.id);
    await requests.create(pending, walk.id, {});
    const room = await eventRoomId(walk.id);

    // USER-hosted room: safe host profile, empty room -> lastMessage null.
    const [hostRow] = await inbox.listRooms(host);
    expect(hostRow).toMatchObject({
      roomId: room, type: 'EVENT', title: 'Old City food walk', subtitle: 'Noa the Host',
      avatarUrl: 'https://cdn.example/noa.png', eventId: walk.id, lastMessage: null, unreadCount: 0,
      event: {
        hostType: 'USER',
        host: { type: 'USER', userId: host, displayName: 'Noa the Host', avatarUrl: 'https://cdn.example/noa.png' },
      },
    });
    assertNoPrivateData([hostRow!], [member, pending, former]);
    expect(await roomIds(member)).toEqual([room]);

    expect(await roomIds(pending)).toEqual([]);
    await expect(inbox.getRoom(pending, room)).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    // `former` still has an APPROVED JoinRequest on record, but no active membership.
    expect(await roomIds(former)).toEqual([]);
    await expect(inbox.getRoom(former, room)).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('shows each side of a MATCH room the OTHER traveller only', async () => {
    const x = await user({ displayName: 'Xavi', avatarUrl: 'https://cdn.example/x.png' });
    const y = await user({ displayName: 'Yael' });
    const room = await matchRoom(x, y);

    const [forX] = await inbox.listRooms(x);
    const [forY] = await inbox.listRooms(y);
    expect(forX).toMatchObject({
      roomId: room, type: 'MATCH', title: 'Yael', subtitle: null, avatarUrl: null,
      eventId: null, event: null, lastMessage: null,
      counterpart: { userId: y, displayName: 'Yael', avatarUrl: null },
    });
    expect(forY).toMatchObject({
      roomId: room, type: 'MATCH', title: 'Xavi', avatarUrl: 'https://cdn.example/x.png',
      counterpart: { userId: x, displayName: 'Xavi', avatarUrl: 'https://cdn.example/x.png' },
    });
    // Each side sees only the other party — never itself.
    expect(JSON.stringify(forX)).not.toContain(x);
    expect(JSON.stringify(forY)).not.toContain(y);
    assertNoPrivateData([forX!, forY!], []);
  });

  it('orders by latest conversation activity, then by room id for exact ties', async () => {
    const me = await user({ displayName: 'Me' });
    const [friend, other] = [await user({ displayName: 'Friend' }), await user({ displayName: 'Other' })];
    const first = await matchRoom(me, friend);
    const second = await matchRoom(me, other);

    await send(first, friend, 'older');
    await send(second, other, 'newer');
    expect(await roomIds(me)).toEqual([second, first]);

    await send(first, me, 'now newest');
    expect(await roomIds(me)).toEqual([first, second]);

    // Two empty rooms joined at the same instant: deterministic room-id order.
    const [p, q] = [await user(), await user()];
    const tieA = await matchRoom(p, q);
    const tieB = await matchRoom(p, await user());
    await AppDataSource.query(
      `UPDATE chat_members SET joined_at = TIMESTAMPTZ '2090-01-01 00:00:00+00'
        WHERE user_id = $1 AND room_id = ANY($2::uuid[])`,
      [p, [tieA, tieB]],
    );
    expect(await roomIds(p)).toEqual([tieA, tieB].sort());
  });
});
