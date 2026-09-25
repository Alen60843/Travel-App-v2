import { randomUUID } from 'node:crypto';

import { EventStatus } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { ChatRepository } from '../chat/chat.repository';
import { AppDataSource } from '../database/data-source';
import { GeoService } from '../database/geo';
import type { CreateEventDto } from './dto';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { JoinRequestsService } from './join-requests.service';

const prefix = `join-int-${randomUUID()}`;
let sequence = 0;
let categoryId: number;
let host: string;
let traveller: string;
let outsider: string;
let events: EventsService;
let requests: JoinRequestsService;
let chat: ChatRepository;

async function user(): Promise<string> {
  const uid = `${prefix}-${++sequence}`;
  const [row] = await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
     VALUES ($1, $2, DATE '1990-01-01', 'ACTIVE') RETURNING id`, [uid, `${uid}@example.test`],
  );
  return row.id;
}

async function event(overrides: Partial<CreateEventDto> = {}, owner = host, publish = true) {
  const draft = await events.createEvent(owner, {
    categoryId, title: 'Join integration event', capacityMax: 4,
    startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T12:00:00Z',
    latitude: 31.778, longitude: 35.235, ...overrides,
  });
  return publish ? events.publishEvent(owner, draft.id) : draft;
}

async function stored(requestId: string) {
  const [row] = await AppDataSource.query('SELECT * FROM event_join_requests WHERE id = $1', [requestId]);
  return row;
}

async function participants(eventId: string) {
  return AppDataSource.query('SELECT * FROM event_participants WHERE event_id = $1', [eventId]);
}

async function makeOverdue(requestId: string) {
  await AppDataSource.query(
    `UPDATE event_join_requests SET requested_at = clock_timestamp() - INTERVAL '25 hours',
       expires_at = clock_timestamp() - INTERVAL '1 hour' WHERE id = $1`, [requestId],
  );
}

async function waitForLock(pid: number): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await AppDataSource.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (row?.wait_event_type === 'Lock') return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('JoinRequestsService (real PostgreSQL/PostGIS)', () => {
  beforeAll(async () => {
    await AppDataSource.initialize();
    const repository = new EventsRepository(AppDataSource);
    events = new EventsService(repository, new GeoService());
    chat = new ChatRepository(AppDataSource);
    requests = new JoinRequestsService(repository, chat);
    const [category] = await AppDataSource.query('SELECT id FROM event_categories WHERE is_active ORDER BY id LIMIT 1');
    categoryId = category.id;
    host = await user();
    traveller = await user();
    outsider = await user();
  });

  afterAll(async () => {
    if (!AppDataSource.isInitialized) return;
    try {
      await AppDataSource.transaction(async (manager) => {
        // Fixture-only cleanup follows Workstream A's append-only audit cleanup.
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query(
          `DELETE FROM event_status_history WHERE event_id IN
           (SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1))`, [`${prefix}%`],
        );
        // payments.event_id is ON DELETE RESTRICT — the financial-commitment
        // cancellation-guard fixture inserts a real payments row referencing
        // a tracked event, so it must be cleared before the event itself.
        await manager.query(
          `DELETE FROM payments WHERE event_id IN
           (SELECT id FROM events WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1))`, [`${prefix}%`],
        );
        await manager.query('DELETE FROM events WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)', [`${prefix}%`]);
        await manager.query('DELETE FROM users WHERE firebase_uid LIKE $1', [`${prefix}%`]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('creates PENDING with exactly 24h server-owned expiry, minimizes views, and maps duplicate requests', async () => {
    const target = await event();
    const before = Date.now();
    const request = await requests.create(traveller, target.id, { message: '😀'.repeat(500) });
    expect(request).toMatchObject({ eventId: target.id, userId: traveller, status: 'PENDING', approvedAt: null });
    // WS8.5D: every request created after this migration always gets a real,
    // non-null server-derived snapshot.
    expect(request.capacitySnapshotAvailable).toBe(true);
    expect(Date.parse(request.requestedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(request.expiresAt) - Date.parse(request.requestedAt)).toBe(86_400_000);
    expect(await stored(request.id)).toMatchObject({ status: 'PENDING', payment_id: null, decided_by_user_id: null });
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'JOIN_REQUEST_ALREADY_EXISTS', status: 409 });
    expect(await participants(target.id)).toHaveLength(0);
    expect(Object.keys(request).sort()).toEqual([
      'id', 'eventId', 'userId', 'status', 'message',
      'guestCount', 'requestedSeats',
      'capacitySnapshotAvailable',
      'capacityMaxAtRequest', 'reservedSeatCountAtRequest', 'availableSeatsAtRequest',
      'exceededCapacityAtRequest', 'exceededByAtRequest',
      'currentCapacityMax', 'currentReservedSeatCount', 'currentAvailableSeats',
      'currentlyFits', 'currentOverrideRequired', 'currentExceedsBy',
      'capacityOverrideApprovedAt', 'capacityOverrideApprovedByUserId',
      'capacityBeforeOverride', 'capacityAfterOverride',
      'requestedAt', 'expiresAt',
      'approvedAt', 'rejectedAt', 'cancelledAt', 'expiredAt',
    ].sort());
    expect((await requests.listMine(traveller)).every((row) => row.userId === traveller)).toBe(true);
    expect(await requests.listMine(outsider)).not.toContainEqual(request);
    expect(await requests.listForHost(host, target.id)).toEqual([request]);
  });

  it('rejects self-join and a current trust/account failure', async () => {
    const target = await event({ minTrustScore: 10 });
    await expect(requests.create(host, target.id, {})).rejects.toMatchObject({ code: 'EVENT_SELF_JOIN' });
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'EVENT_TRUST_REQUIRED' });
    const inactive = await user();
    await AppDataSource.query("UPDATE users SET account_status = 'DEACTIVATED' WHERE id = $1", [inactive]);
    await expect(requests.create(inactive, target.id, {})).rejects.toMatchObject({ code: 'JOIN_ACCOUNT_UNAVAILABLE' });
  });

  // Step 3 draft privacy closure: an unpublished Event must not be
  // confirmable, so an unrelated requester gets the missing-Event answer.
  it('answers an unrelated request on a DRAFT exactly like a missing Event', async () => {
    const target = await event({}, host, false);
    await expect(requests.create(traveller, target.id, {})).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it.each(['CANCELLED', 'IN_PROGRESS', 'COMPLETED', 'STARTED'])(
    'rejects a %s Event', async (status) => {
      const target = await event({}, host, false);
      if (status !== 'DRAFT') await events.publishEvent(host, target.id);
      if (status === 'CANCELLED') await events.cancelEvent(host, target.id);
      if (status === 'IN_PROGRESS' || status === 'COMPLETED') {
        await AppDataSource.query("UPDATE events SET status = 'IN_PROGRESS' WHERE id = $1", [target.id]);
      }
      if (status === 'COMPLETED') {
        await AppDataSource.query("UPDATE events SET status = 'COMPLETED', completed_at = now() WHERE id = $1", [target.id]);
      }
      if (status === 'STARTED') {
        await AppDataSource.query("UPDATE events SET starts_at = now() - INTERVAL '1 minute' WHERE id = $1", [target.id]);
      }
      await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({
        code: 'EVENT_NOT_JOINABLE',
      });
    },
  );

  // WS8.5C: FULL no longer means "closed to new requests" — only that
  // current physical capacity is exhausted. A FULL Event before starts_at
  // is otherwise eligible for joining, so a new request may still be
  // created (PENDING, exceeding capacity, requiring override to approve).
  it('a FULL Event still accepts a new Join Request before starts_at', async () => {
    // capacityMax: 2 = host's 1 physical seat + 1 for the traveller who fills it.
    const target = await event({ capacityMax: 2 });
    const first = await requests.create(traveller, target.id, {});
    await requests.approve(host, target.id, first.id);
    expect((await events.getEvent(host, target.id)).status).toBe('FULL');

    const second = await requests.create(outsider, target.id, {});

    expect(second.status).toBe('PENDING');
    expect(second.exceededCapacityAtRequest).toBe(true);
    expect(second.currentOverrideRequired).toBe(true);
  });

  it('does not accept protected input at the real service boundary', async () => {
    const target = await event();
    for (const key of [
      'userId', 'paymentId', 'status', 'expiresAt', 'isHost', 'participantCount',
      // WS8.5C: server-derived only — never client-suppliable.
      'capacityMaxAtRequest', 'reservedSeatCountAtRequest', 'reservedSeatCount',
      'capacityOverrideApprovedAt', 'capacityBeforeOverride', 'capacityAfterOverride',
    ]) {
      await expect(requests.create(traveller, target.id, { [key]: outsider })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(requests.create(traveller, target.id, { message: 'x'.repeat(501) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await requests.listForHost(host, target.id)).toEqual([]);
  });

  it('keeps host ownership, requester ownership and event/request pairing non-leaking', async () => {
    const target = await event();
    const otherEvent = await event();
    const request = await requests.create(traveller, target.id, {});
    for (const eventId of [target.id, randomUUID()]) {
      await expect(requests.listForHost(outsider, eventId)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
      await expect(requests.approve(outsider, eventId, request.id)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
      await expect(requests.reject(outsider, eventId, request.id)).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
    }
    await expect(requests.approve(host, otherEvent.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND', status: 404 });
    await expect(requests.reject(host, otherEvent.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND', status: 404 });
    await expect(requests.cancel(outsider, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND', status: 404 });
    expect((await stored(request.id)).status).toBe('PENDING');
  });

  it.each(['reject', 'cancel', 'expire'] as const)('%s history allows a fresh request', async (command) => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    if (command === 'reject') {
      expect(await requests.reject(host, target.id, request.id)).toMatchObject({ status: 'REJECTED', rejectedAt: expect.any(String) });
      expect((await stored(request.id)).decided_by_user_id).toBe(host);
    } else if (command === 'cancel') {
      expect(await requests.cancel(traveller, request.id)).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(String) });
      await expect(requests.cancel(traveller, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    } else {
      await makeOverdue(request.id);
      await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED' });
      expect(await stored(request.id)).toMatchObject({ status: 'EXPIRED', expired_at: expect.any(Date), approved_at: null });
    }
    expect(await participants(target.id)).toHaveLength(0);
    const replacement = await requests.create(traveller, target.id, {});
    expect(replacement.id).not.toBe(request.id);
    expect(replacement.status).toBe('PENDING');
  });

  it.each(['create', 'reject', 'cancel'] as const)('durably expires overdue rows on %s', async (command) => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    await makeOverdue(request.id);
    if (command === 'create') {
      const replacement = await requests.create(traveller, target.id, {});
      expect(replacement.id).not.toBe(request.id);
    } else {
      await expect(command === 'cancel'
        ? requests.cancel(traveller, request.id)
        : requests.reject(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED' });
    }
    expect(await stored(request.id)).toMatchObject({ status: 'EXPIRED', expired_at: expect.any(Date) });
  });

  it('retains expiry even when re-requesting fails the current Event checks', async () => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    await makeOverdue(request.id);
    await events.cancelEvent(host, target.id);
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'EVENT_NOT_JOINABLE' });
    expect((await stored(request.id)).status).toBe('EXPIRED');
  });

  it('approves once, creates exactly one participant, and records FULL through the audit trigger', async () => {
    // capacityMax: 2 = host's 1 physical seat + 1 for the approved traveller.
    const target = await event({ capacityMax: 2 });
    const request = await requests.create(traveller, target.id, {});
    const approved = await requests.approve(host, target.id, request.id);
    expect(approved).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String) });
    expect(await stored(request.id)).toMatchObject({ decided_by_user_id: host, approved_at: new Date(approved.approvedAt!) });
    expect(await participants(target.id)).toEqual([expect.objectContaining({ join_request_id: request.id, user_id: traveller, is_host: false })]);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1, status: EventStatus.Full });
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    await expect(requests.reject(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    await expect(requests.cancel(traveller, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });
    // WS8.5C: a FULL event still accepts a new request — it is simply
    // created already exceeding capacity, requiring override to approve.
    const overflow = await requests.create(outsider, target.id, {});
    expect(overflow.exceededCapacityAtRequest).toBe(true);
    const history = await AppDataSource.query("SELECT actor_user_id, reason FROM event_status_history WHERE event_id = $1 AND to_status = 'FULL'", [target.id]);
    expect(history).toEqual([{ actor_user_id: host, reason: 'capacity_reached' }]);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1 });
  });

  it('auto-approves free requests atomically without fabricating a host decision', async () => {
    // capacityMax: 2 = host's 1 physical seat + 1 for the auto-approved traveller.
    const target = await event({ capacityMax: 2, joinApprovalRequired: false });
    const request = await requests.create(traveller, target.id, {});
    expect(request).toMatchObject({ status: 'APPROVED', approvedAt: expect.any(String) });
    expect(await stored(request.id)).toMatchObject({ decided_by_user_id: null, payment_id: null });
    expect(await participants(target.id)).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1, status: 'FULL' });
    // WS8.5C: even with joinApprovalRequired=false, an over-capacity
    // request is NEVER auto-approved — it is created PENDING, awaiting an
    // explicit host decision (ordinary approval will still fail until
    // capacity frees up or the host uses the override action).
    const overflow = await requests.create(outsider, target.id, {});
    expect(overflow.status).toBe('PENDING');
    expect(overflow.currentOverrideRequired).toBe(true);
    expect(await requests.listForHost(host, target.id)).toHaveLength(2);
  });

  it('rolls back APPROVED when the participant insert conflicts in PostgreSQL', async () => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    await AppDataSource.query('INSERT INTO event_participants (event_id, user_id) VALUES ($1, $2)', [target.id, traveller]);
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'EVENT_ALREADY_JOINED', status: 409 });
    expect(await stored(request.id)).toMatchObject({ status: 'PENDING', approved_at: null, decided_by_user_id: null });
    expect(await participants(target.id)).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1 });
  });

  it('rolls back the auto-approved request, participant and FULL audit together on transaction failure', async () => {
    // capacityMax: 2 = host's 1 physical seat + 1 for the would-be auto-approved
    // traveller — with capacityMax: 1 the host alone already fills the Event
    // at publish time (status FULL immediately), which broke this test's
    // post-rollback status: 'ACTIVE' assertion.
    const target = await event({ capacityMax: 2, joinApprovalRequired: false });
    const failing = new JoinRequestsService(new (class extends EventsRepository {
      override transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
        return super.transaction(async (manager) => {
          await work(manager);
          throw new Error('Test failure before commit');
        });
      }
    })(AppDataSource), chat);
    await expect(failing.create(traveller, target.id, {})).rejects.toThrow('Test failure before commit');
    expect(await requests.listForHost(host, target.id)).toEqual([]);
    expect(await participants(target.id)).toEqual([]);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 0, status: 'ACTIVE' });
    expect(await AppDataSource.query("SELECT id FROM event_status_history WHERE event_id = $1 AND to_status = 'FULL'", [target.id])).toEqual([]);
  });

  it('rechecks event lifecycle and current requester account on approval', async () => {
    const target = await event();
    const requester = await user();
    const request = await requests.create(requester, target.id, {});
    await AppDataSource.query("UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1", [requester]);
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_ACCOUNT_UNAVAILABLE' });
    await AppDataSource.query("UPDATE users SET account_status = 'ACTIVE' WHERE id = $1", [requester]);
    await events.cancelEvent(host, target.id);
    await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'EVENT_NOT_JOINABLE' });
    expect(await stored(request.id)).toMatchObject({ status: 'PENDING', approved_at: null });
    expect(await participants(target.id)).toEqual([]);
  });

  it.each([true, false])('fails closed on deposit joining (manual approval=%s) and preserves the DB gate', async (joinApprovalRequired) => {
    const target = await event({ priceMinor: 100, depositMinor: 50, joinApprovalRequired });
    await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'PAID_JOIN_NOT_AVAILABLE' });
    const [seed] = await AppDataSource.query(
      `INSERT INTO event_join_requests (event_id, user_id, expires_at)
       VALUES ($1, $2, now() + INTERVAL '24 hours') RETURNING id`, [target.id, traveller],
    );
    await expect(requests.approve(host, target.id, seed.id)).rejects.toMatchObject({ code: 'PAID_JOIN_NOT_AVAILABLE' });
    await expect(AppDataSource.query("UPDATE event_join_requests SET status = 'APPROVED', approved_at = now() WHERE id = $1", [seed.id]))
      .rejects.toMatchObject({ driverError: { code: '23514' } });
    expect((await stored(seed.id)).status).toBe('PENDING');
    expect(await participants(target.id)).toHaveLength(0);
  });

  it('serializes repeated approvals without creating duplicate participants', async () => {
    const target = await event();
    const request = await requests.create(traveller, target.id, {});
    const outcomes = await Promise.allSettled([
      requests.approve(host, target.id, request.id), requests.approve(host, target.id, request.id),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'JOIN_REQUEST_NOT_PENDING' }) }),
    ]);
    expect(await participants(target.id)).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1 });
  });

  it('two real connections race for the final seat: one commits, the loser remains PENDING', async () => {
    // capacityMax: 3 = host's 1 physical seat + alreadySeated's 1 + exactly
    // 1 contested seat for first/second to race over.
    const target = await event({ capacityMax: 3 });
    const alreadySeated = await requests.create(await user(), target.id, {});
    await requests.approve(host, target.id, alreadySeated.id);
    const first = await requests.create(traveller, target.id, {});
    const second = await requests.create(outsider, target.id, {});
    let signalFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirst = resolve; });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalSecond!: (pid: number) => void;
    const secondStarted = new Promise<number>((resolve) => { signalSecond = resolve; });
    const pids: number[] = [];
    const repository = new (class extends EventsRepository {
      private reads = 0;
      override transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
        return super.transaction(async (manager) => {
          const [connection] = await manager.query('SELECT pg_backend_pid() AS pid');
          pids.push(connection.pid);
          if (pids.length === 2) signalSecond(connection.pid);
          return work(manager);
        });
      }
      override async findOwnedEvent(...args: Parameters<EventsRepository['findOwnedEvent']>) {
        const locked = await super.findOwnedEvent(...args);
        if (++this.reads === 1) { signalFirst(); await release; }
        return locked;
      }
    })(AppDataSource);
    const concurrent = new JoinRequestsService(repository, chat);
    const approvalOne = concurrent.approve(host, target.id, first.id);
    // Attach a rejection handler immediately; failures still reach assertions.
    const settledOne = Promise.allSettled([approvalOne]);
    await firstLocked;
    const approvalTwo = concurrent.approve(host, target.id, second.id);
    const outcomes = Promise.allSettled([approvalOne, approvalTwo]);
    let waited = false;
    try {
      waited = await waitForLock(await secondStarted);
    } finally { releaseFirst(); }
    const result = await outcomes;
    await settledOne;
    expect(new Set(pids).size).toBe(2);
    expect(waited).toBe(true);
    expect(result[0]).toMatchObject({ status: 'fulfilled', value: { status: 'APPROVED' } });
    expect(result[1]).toMatchObject({ status: 'rejected', reason: { code: 'EVENT_CAPACITY_OVERRIDE_REQUIRED', status: 409 } });
    expect(await stored(second.id)).toMatchObject({ status: 'PENDING', approved_at: null, decided_by_user_id: null });
    const rows = await participants(target.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row: { join_request_id: string }) => [first.id, second.id].includes(row.join_request_id))).toHaveLength(1);
    expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 2, capacityMax: 3, status: 'FULL' });
  });

  describe('WS5: EVENT chat provisioning', () => {
    async function chatRoomsFor(eventId: string) {
      return AppDataSource.query("SELECT id FROM chat_rooms WHERE event_id = $1 AND type = 'EVENT'", [eventId]);
    }

    async function activeChatMembers(roomId: string) {
      return AppDataSource.query('SELECT user_id FROM chat_members WHERE room_id = $1 AND left_at IS NULL', [roomId]);
    }

    it('manual approval atomically creates exactly one EVENT chat room, an active host membership, and an active participant membership', async () => {
      const target = await event();
      const request = await requests.create(traveller, target.id, {});
      await requests.approve(host, target.id, request.id);

      const rooms = await chatRoomsFor(target.id);
      expect(rooms).toHaveLength(1);
      const members = await activeChatMembers(rooms[0].id);
      expect(new Set(members.map((row: { user_id: string }) => row.user_id))).toEqual(new Set([host, traveller]));
    });

    it('auto approval produces the same final chat state as manual approval', async () => {
      const target = await event({ joinApprovalRequired: false });
      const request = await requests.create(traveller, target.id, {});
      expect(request.status).toBe('APPROVED');

      const rooms = await chatRoomsFor(target.id);
      expect(rooms).toHaveLength(1);
      const members = await activeChatMembers(rooms[0].id);
      expect(new Set(members.map((row: { user_id: string }) => row.user_id))).toEqual(new Set([host, traveller]));
    });

    it('multiple approvals for the same event converge on exactly one EVENT room, one active host membership, and one active membership per participant', async () => {
      const target = await event({ capacityMax: 3 });
      const firstTraveller = await user();
      const secondTraveller = await user();
      const firstRequest = await requests.create(firstTraveller, target.id, {});
      const secondRequest = await requests.create(secondTraveller, target.id, {});
      await requests.approve(host, target.id, firstRequest.id);
      await requests.approve(host, target.id, secondRequest.id);

      const rooms = await chatRoomsFor(target.id);
      expect(rooms).toHaveLength(1);
      const members = await activeChatMembers(rooms[0].id);
      // host + firstTraveller + secondTraveller, each exactly once (no
      // duplicate membership row is possible: chat_members' PK is
      // (room_id, user_id), and activateEventMember is an idempotent upsert).
      expect(new Set(members.map((row: { user_id: string }) => row.user_id))).toEqual(
        new Set([host, firstTraveller, secondTraveller]),
      );
      expect(members).toHaveLength(3);
    });

    it('duplicate/retry approval does not duplicate chat membership', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, {});
      await requests.approve(host, target.id, request.id);
      // A second decision on an already-APPROVED request is rejected before
      // approveAndParticipate (and therefore chat provisioning) runs again.
      await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({ code: 'JOIN_REQUEST_NOT_PENDING' });

      const rooms = await chatRoomsFor(target.id);
      expect(rooms).toHaveLength(1);
      const members = await activeChatMembers(rooms[0].id);
      expect(members).toHaveLength(2);
    });

    it('a chat provisioning failure inside the transaction leaves no partial participant/chat state', async () => {
      const target = await event();
      const request = await requests.create(traveller, target.id, {});
      const failingChat = {
        ensureEventRoom: chat.ensureEventRoom.bind(chat),
        activateEventMember: jest.fn().mockRejectedValue(new Error('chat provisioning unavailable')),
        deactivateEventMember: chat.deactivateEventMember.bind(chat),
      };
      const failing = new JoinRequestsService(
        new EventsRepository(AppDataSource),
        failingChat as unknown as ChatRepository,
      );

      await expect(failing.approve(host, target.id, request.id)).rejects.toThrow('chat provisioning unavailable');

      expect(await stored(request.id)).toMatchObject({ status: 'PENDING', approved_at: null, decided_by_user_id: null });
      expect(await participants(target.id)).toHaveLength(0);
      expect(await chatRoomsFor(target.id)).toHaveLength(0);
    });

    it('the existing last-seat race invariant is unaffected by chat provisioning: exactly one winner, and its EVENT chat membership is active', async () => {
      // capacityMax: 2 = host's 1 physical seat + exactly 1 contested seat.
      const target = await event({ capacityMax: 2 });
      const first = await requests.create(traveller, target.id, {});
      const second = await requests.create(outsider, target.id, {});

      const results = await Promise.allSettled([
        requests.approve(host, target.id, first.id),
        requests.approve(host, target.id, second.id),
      ]);
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);

      const rooms = await chatRoomsFor(target.id);
      expect(rooms).toHaveLength(1);
      const members = await activeChatMembers(rooms[0].id);
      // Host + exactly the one approved participant.
      expect(members).toHaveLength(2);
      expect(members.map((row: { user_id: string }) => row.user_id)).toContain(host);
    });
  });

  describe('WS8.4B: participant leave / organizer remove', () => {
    async function chatRoomsFor(eventId: string) {
      return AppDataSource.query("SELECT id FROM chat_rooms WHERE event_id = $1 AND type = 'EVENT'", [eventId]);
    }

    async function activeChatMembers(roomId: string) {
      return AppDataSource.query('SELECT user_id FROM chat_members WHERE room_id = $1 AND left_at IS NULL', [roomId]);
    }

    /** Bypasses updateEvent's DRAFT-only restriction, matching the test suite's
     * own makeOverdue convention for directly manipulating a timestamp that
     * application code would otherwise refuse to move once published. */
    async function makeStarted(eventId: string) {
      await AppDataSource.query(`UPDATE events SET starts_at = now() - interval '1 minute' WHERE id = $1`, [eventId]);
    }

    async function approvedParticipant(target: { id: string }, participant = traveller) {
      const request = await requests.create(participant, target.id, {});
      await requests.approve(host, target.id, request.id);
      return { requestId: request.id, participantId: participant };
    }

    it('a voluntary leave writes cancelled_at/attendance_status/reason/cancelled_by, deactivates chat, and leaves the JoinRequest APPROVED', async () => {
      const target = await event();
      const { requestId } = await approvedParticipant(target);

      const result = await requests.leave(traveller, target.id);
      expect(result).toMatchObject({ eventId: target.id, userId: traveller, cancellationReason: 'VOLUNTARY_LEAVE', cancelledByUserId: traveller });

      const [row] = await participants(target.id);
      expect(row).toMatchObject({
        cancelled_at: expect.any(Date),
        attendance_status: 'CANCELLED',
        cancellation_reason: 'VOLUNTARY_LEAVE',
        cancelled_by_user_id: traveller,
      });

      // The historical JoinRequest is untouched — still APPROVED.
      expect(await stored(requestId)).toMatchObject({ status: 'APPROVED' });

      const rooms = await chatRoomsFor(target.id);
      const members = await activeChatMembers(rooms[0].id);
      expect(members.map((r: { user_id: string }) => r.user_id)).not.toContain(traveller);
    });

    it('a host removal writes reason=HOST_REMOVAL, cancelled_by=host, and deactivates chat', async () => {
      const target = await event();
      await approvedParticipant(target);

      const result = await requests.remove(host, target.id, traveller);
      expect(result).toMatchObject({ cancellationReason: 'HOST_REMOVAL', cancelledByUserId: host });

      const [row] = await participants(target.id);
      expect(row).toMatchObject({ cancellation_reason: 'HOST_REMOVAL', cancelled_by_user_id: host });

      const rooms = await chatRoomsFor(target.id);
      const members = await activeChatMembers(rooms[0].id);
      expect(members.map((r: { user_id: string }) => r.user_id)).not.toContain(traveller);
    });

    it('participant_count decrements via tw_sync_participant_count, and FULL bounces back to ACTIVE when a seat is freed', async () => {
      // capacityMax: 2 = host's 1 physical seat + 1 for the approved traveller.
      const target = await event({ capacityMax: 2 });
      await approvedParticipant(target);
      expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 1, status: 'FULL' });

      await requests.leave(traveller, target.id);

      expect(await events.getEvent(host, target.id)).toMatchObject({ participantCount: 0, status: 'ACTIVE' });
      const history = await AppDataSource.query(
        "SELECT actor_user_id, reason FROM event_status_history WHERE event_id = $1 AND to_status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1",
        [target.id],
      );
      expect(history).toEqual([{ actor_user_id: traveller, reason: 'seat_freed' }]);
    });

    it('stays ACTIVE (no spurious transition) when an ACTIVE event has a participant leave', async () => {
      const target = await event({ capacityMax: 4 });
      await approvedParticipant(target);
      expect(await events.getEvent(host, target.id)).toMatchObject({ status: 'ACTIVE' });

      await requests.leave(traveller, target.id);

      expect(await events.getEvent(host, target.id)).toMatchObject({ status: 'ACTIVE', participantCount: 0 });
    });

    it('after a leave, a NEW JoinRequest for the same event+user succeeds — the old APPROVED request no longer blocks rejoin', async () => {
      const target = await event();
      await approvedParticipant(target);
      await requests.leave(traveller, target.id);

      const secondRequest = await requests.create(traveller, target.id, {});
      expect(secondRequest.status).toBe('PENDING');
      const approved = await requests.approve(host, target.id, secondRequest.id);
      expect(approved.status).toBe('APPROVED');

      // Both historical requests exist; the first remains truthfully APPROVED.
      const history = await AppDataSource.query(
        'SELECT status FROM event_join_requests WHERE event_id = $1 AND user_id = $2 ORDER BY requested_at ASC',
        [target.id, traveller],
      );
      expect(history.map((r: { status: string }) => r.status)).toEqual(['APPROVED', 'APPROVED']);
      expect(await participants(target.id)).toHaveLength(2); // cancelled + new active, both preserved
    });

    it('an active EventParticipant still blocks a duplicate join (EVENT_ALREADY_JOINED), leave notwithstanding', async () => {
      const target = await event();
      await approvedParticipant(target);

      await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'EVENT_ALREADY_JOINED' });
    });

    it('a PENDING request still blocks another pending request for the same event+user', async () => {
      const target = await event();
      await requests.create(traveller, target.id, {});

      await expect(requests.create(traveller, target.id, {})).rejects.toMatchObject({ code: 'JOIN_REQUEST_ALREADY_EXISTS' });
    });

    it('a duplicate leave is a safe idempotent no-op — same audit metadata, no error', async () => {
      const target = await event();
      await approvedParticipant(target);
      const first = await requests.leave(traveller, target.id);

      const second = await requests.leave(traveller, target.id);

      expect(second).toEqual(first);
      expect(await participants(target.id)).toHaveLength(1);
    });

    it('a duplicate remove is a safe idempotent no-op', async () => {
      const target = await event();
      await approvedParticipant(target);
      const first = await requests.remove(host, target.id, traveller);

      const second = await requests.remove(host, target.id, traveller);

      expect(second).toEqual(first);
    });

    it('rejects leave once starts_at has been reached', async () => {
      const target = await event();
      await approvedParticipant(target);
      await makeStarted(target.id);

      await expect(requests.leave(traveller, target.id)).rejects.toMatchObject({ code: 'EVENT_MEMBERSHIP_LOCKED' });
      expect((await participants(target.id))[0]).toMatchObject({ cancelled_at: null });
    });

    it('rejects remove for a CANCELLED event', async () => {
      const target = await event();
      await approvedParticipant(target);
      await events.cancelEvent(host, target.id);

      await expect(requests.remove(host, target.id, traveller)).rejects.toMatchObject({ code: 'EVENT_MEMBERSHIP_LOCKED' });
    });

    it('rejects a non-host attempting to remove a participant', async () => {
      const target = await event();
      await approvedParticipant(target);

      await expect(requests.remove(outsider, target.id, traveller)).rejects.toBeInstanceOf(EventNotFoundError);
    });

    it('rejects the host using the self-leave endpoint, and rejects the host removing themselves', async () => {
      const target = await event();

      await expect(requests.leave(host, target.id)).rejects.toMatchObject({ code: 'HOST_CANNOT_LEAVE_VIA_PARTICIPANT_ENDPOINT' });
      await expect(requests.remove(host, target.id, host)).rejects.toMatchObject({ code: 'HOST_CANNOT_REMOVE_SELF' });
    });

    it('rejects leave with an honest EVENT_NOT_A_MEMBER when no participation record has ever existed', async () => {
      const target = await event();

      await expect(requests.leave(outsider, target.id)).rejects.toMatchObject({ code: 'EVENT_NOT_A_MEMBER' });
    });

    it('refuses to cancel a participation carrying a financial commitment (payment_id set)', async () => {
      const target = await event();
      const { requestId } = await approvedParticipant(target);
      // A real payments row, not a bare random UUID — event_participants.payment_id
      // is a genuine FK (REFERENCES payments(id)), predating Phase 8.
      const [payment] = await AppDataSource.query(
        `INSERT INTO payments (user_id, kind, event_id, provider, amount_minor, idempotency_key, status)
         VALUES ($1, 'EVENT_DEPOSIT', $2, 'stripe', 1500, $3, 'AUTHORIZED') RETURNING id`,
        [traveller, target.id, `join-int-payment-${requestId}`],
      );
      await AppDataSource.query('UPDATE event_participants SET payment_id = $1 WHERE join_request_id = $2', [payment.id, requestId]);

      await expect(requests.leave(traveller, target.id)).rejects.toMatchObject({
        code: 'PAID_PARTICIPATION_CANCELLATION_NOT_SUPPORTED',
      });
      expect((await participants(target.id))[0]).toMatchObject({ cancelled_at: null });
    });

    it('event_participants_active_uk still lets the SAME user rejoin after a fully-committed leave/rejoin/leave cycle', async () => {
      const target = await event({ capacityMax: 5 });
      await approvedParticipant(target);
      await requests.leave(traveller, target.id);
      const second = await requests.create(traveller, target.id, {});
      await requests.approve(host, target.id, second.id);
      await requests.leave(traveller, target.id);
      const third = await requests.create(traveller, target.id, {});
      const approved = await requests.approve(host, target.id, third.id);

      expect(approved.status).toBe('APPROVED');
      expect(await participants(target.id)).toHaveLength(3);
      const active = await AppDataSource.query(
        'SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1 AND user_id = $2 AND cancelled_at IS NULL',
        [target.id, traveller],
      );
      expect(active[0].n).toBe(1);
    });
  });

  describe('WS8.5B: party size / guest seats', () => {
    it('a USER-hosted event starts with reservedSeatCount = 1 (host, no guests) and hostGuestCount defaults to 0', async () => {
      const draft = await events.createEvent(host, {
        categoryId, title: 'Guest seats event', capacityMax: 4,
        startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T12:00:00Z',
        latitude: 31.778, longitude: 35.235,
      });

      expect(draft.hostGuestCount).toBe(0);
      expect(draft.reservedSeatCount).toBe(1);
      expect(draft.remainingSeats).toBe(3);
    });

    it('a host bringing guests reserves 1 + hostGuestCount seats from the moment of creation', async () => {
      const draft = await events.createEvent(host, {
        categoryId, title: 'Host + guests event', capacityMax: 5, hostGuestCount: 2,
        startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T12:00:00Z',
        latitude: 31.778, longitude: 35.235,
      });

      expect(draft.reservedSeatCount).toBe(3);
      expect(draft.remainingSeats).toBe(2);
    });

    it('a participant party of 1 + guestCount increments reservedSeatCount by the full party size, leaving participantCount unchanged in meaning', async () => {
      const target = await event({ capacityMax: 5 });
      const traveller2 = await user();
      const request = await requests.create(traveller2, target.id, { guestCount: 2 });
      await requests.approve(host, target.id, request.id);

      const state = await events.getEvent(host, target.id);
      expect(state.participantCount).toBe(1); // registered rows only
      expect(state.reservedSeatCount).toBe(1 + 3); // host(1) + traveller2's party(3)
    });

    it('leaving/removing a multi-guest party releases ALL of its seats atomically, and a duplicate leave does not double-release', async () => {
      const target = await event({ capacityMax: 6 });
      const traveller2 = await user();
      const request = await requests.create(traveller2, target.id, { guestCount: 2 });
      await requests.approve(host, target.id, request.id);
      expect((await events.getEvent(host, target.id)).reservedSeatCount).toBe(1 + 3);

      await requests.leave(traveller2, target.id);
      expect((await events.getEvent(host, target.id)).reservedSeatCount).toBe(1);

      // Safe retry: must not go negative or double-release.
      await requests.leave(traveller2, target.id);
      expect((await events.getEvent(host, target.id)).reservedSeatCount).toBe(1);
    });

    it('a rejoin may use a different guestCount than the original (cancelled) party', async () => {
      const target = await event({ capacityMax: 6 });
      const traveller2 = await user();
      const first = await requests.create(traveller2, target.id, { guestCount: 2 });
      await requests.approve(host, target.id, first.id);
      await requests.leave(traveller2, target.id);

      const second = await requests.create(traveller2, target.id, { guestCount: 0 });
      await requests.approve(host, target.id, second.id);

      expect((await events.getEvent(host, target.id)).reservedSeatCount).toBe(1 + 1);
      const rows = await participants(target.id);
      const cancelled = rows.find((r: { guest_count: number }) => r.guest_count === 2);
      const active = rows.find((r: { cancelled_at: Date | null }) => r.cancelled_at === null);
      expect(cancelled?.guest_count).toBe(2); // historical row unchanged
      expect(active?.guest_count).toBe(0);
    });

    // WS8.5C superseded the WS8.5B behavior this test used to assert
    // (creation itself rejected when over capacity). Creation is now always
    // allowed regardless of fit — only ORDINARY APPROVAL is capacity-gated
    // (see the 'ordinary approval rejects a currently-over-capacity request'
    // test below). This test now proves the CURRENT behavior instead.
    it('creates a request whose party does not fit current remaining physical capacity as PENDING, correctly flagged', async () => {
      const target = await event({ capacityMax: 3 }); // host alone reserves 1, 2 remain
      const traveller2 = await user();

      const request = await requests.create(traveller2, target.id, { guestCount: 2 }); // needs 3, exceeds by 1

      expect(request.status).toBe('PENDING');
      expect(request.capacityMaxAtRequest).toBe(3);
      expect(request.reservedSeatCountAtRequest).toBe(1);
      expect(request.exceededCapacityAtRequest).toBe(true);
      expect(request.currentlyFits).toBe(false);
      expect(request.currentOverrideRequired).toBe(true);

      // Ordinary approval remains blocked — it still does not fit.
      await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({
        code: 'EVENT_CAPACITY_OVERRIDE_REQUIRED',
      });
    });

    it('the DB-level physical-capacity CHECK backstops the application check', async () => {
      const target = await event({ capacityMax: 2 });
      await expect(
        AppDataSource.query(
          `INSERT INTO event_participants (event_id, user_id, guest_count) VALUES ($1, $2, $3)`,
          [target.id, await user(), 5],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
    });

    it('rejects creating a host party larger than capacityMax (DB-level backstop)', async () => {
      await expect(
        AppDataSource.query(
          `INSERT INTO events (
             host_type, host_user_id, category_id, title, capacity_max, host_guest_count,
             starts_at, ends_at, meeting_point
           ) VALUES ('USER',$1,$2,'Impossible host party',2,5,
                     '2090-01-01T10:00:00Z','2090-01-01T12:00:00Z',
                     ST_SetSRID(ST_MakePoint(35.235, 31.778), 4326)::geography)`,
          [host, categoryId],
        ),
      ).rejects.toMatchObject({ driverError: { code: '23514' } });
    });

    it('publishes straight to FULL when the host party alone fills capacityMax, and DRAFT->FULL is now a legal transition', async () => {
      const draft = await events.createEvent(host, {
        categoryId, title: 'Host fills it', capacityMax: 3, hostGuestCount: 2,
        startsAt: '2090-01-01T10:00:00Z', endsAt: '2090-01-01T12:00:00Z',
        latitude: 31.778, longitude: 35.235,
      });
      const published = await events.publishEvent(host, draft.id);
      expect(published.status).toBe('FULL');
    });

    it('FULL -> ACTIVE occurs when a multi-guest party leaves and frees enough seats', async () => {
      const target = await event({ capacityMax: 4 }); // host reserves 1, 3 remain
      const traveller2 = await user();
      const request = await requests.create(traveller2, target.id, { guestCount: 2 }); // fills exactly
      await requests.approve(host, target.id, request.id);
      expect((await events.getEvent(host, target.id)).status).toBe('FULL');

      await requests.leave(traveller2, target.id);

      expect((await events.getEvent(host, target.id)).status).toBe('ACTIVE');
    });

    it('two parties race for the final seats: only one whose full party fits may succeed', async () => {
      const target = await event({ capacityMax: 4 }); // host reserves 1, 3 remain
      const daniel = await user();
      const sarah = await user();
      const danielRequest = await requests.create(daniel, target.id, { guestCount: 1 }); // needs 2
      const sarahRequest = await requests.create(sarah, target.id, { guestCount: 1 }); // needs 2 (only 3 remain total)

      const outcomes = await Promise.allSettled([
        requests.approve(host, target.id, danielRequest.id),
        requests.approve(host, target.id, sarahRequest.id),
      ]);

      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      const rejected = outcomes.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'EVENT_CAPACITY_OVERRIDE_REQUIRED' });
      expect((await events.getEvent(host, target.id)).reservedSeatCount).toBe(1 + 2);
    });
  });

  describe('WS8.5C: flexible capacity overrides', () => {
    it('creates an over-capacity request, exposes the request-time snapshot, and current fit is dynamic', async () => {
      const target = await event({ capacityMax: 2 }); // host reserves 1, 1 remains
      const request = await requests.create(traveller, target.id, { guestCount: 1 }); // needs 2

      expect(request.status).toBe('PENDING');
      expect(request.capacityMaxAtRequest).toBe(2);
      expect(request.reservedSeatCountAtRequest).toBe(1);
      expect(request.availableSeatsAtRequest).toBe(1);
      expect(request.exceededCapacityAtRequest).toBe(true);
      expect(request.exceededByAtRequest).toBe(1);
      expect(request.currentOverrideRequired).toBe(true);
      expect(request.currentExceedsBy).toBe(1);
    });

    it('the request-time snapshot never changes even after the Event capacity later changes', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 }); // exceeds by 1

      await requests.approveWithCapacityOverride(host, target.id, request.id);

      const [row] = await AppDataSource.query(
        'SELECT capacity_max_at_request, reserved_seat_count_at_request FROM event_join_requests WHERE id = $1',
        [request.id],
      );
      expect(row.capacity_max_at_request).toBe(2); // unchanged, even though capacityMax is now 3
      expect(row.reserved_seat_count_at_request).toBe(1);
    });

    it('a request that originally exceeded capacity may later fit normally once another participant leaves', async () => {
      const target = await event({ capacityMax: 3 }); // host reserves 1, 2 remain
      const daniel = await user();
      const danielRequest = await requests.create(daniel, target.id, { guestCount: 1 }); // needs 2, fits
      await requests.approve(host, target.id, danielRequest.id); // now FULL: 1 + 2 = 3

      const sarah = await user();
      const sarahRequest = await requests.create(sarah, target.id, {}); // needs 1, over capacity now
      expect(sarahRequest.exceededCapacityAtRequest).toBe(true);
      expect(sarahRequest.currentOverrideRequired).toBe(true);

      await requests.leave(daniel, target.id); // frees 2 seats

      const refreshed = await requests.listForHost(host, target.id);
      const sarahNow = refreshed.find((r) => r.id === sarahRequest.id);
      expect(sarahNow?.exceededCapacityAtRequest).toBe(true); // historical fact unchanged
      expect(sarahNow?.currentOverrideRequired).toBe(false); // but it fits now
      expect(sarahNow?.currentlyFits).toBe(true);

      const approved = await requests.approve(host, target.id, sarahRequest.id); // ordinary approval now succeeds
      expect(approved.status).toBe('APPROVED');
      expect(approved.capacityOverrideApprovedAt).toBeNull(); // no override was used
    });

    it('ordinary approval rejects a currently-over-capacity request and never changes capacityMax', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 }); // exceeds by 1

      await expect(requests.approve(host, target.id, request.id)).rejects.toMatchObject({
        code: 'EVENT_CAPACITY_OVERRIDE_REQUIRED',
      });
      expect((await events.getEvent(host, target.id)).capacityMax).toBe(2);
      expect(await participants(target.id)).toEqual([]);
    });

    it('explicit override approval is USER-host-only', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 });

      await expect(requests.approveWithCapacityOverride(outsider, target.id, request.id)).rejects.toBeInstanceOf(
        EventNotFoundError,
      );
    });

    it('explicit override increases capacityMax by exactly the minimum required amount, never a client-supplied number', async () => {
      const target = await event({ capacityMax: 2 }); // host reserves 1, 1 remains
      const request = await requests.create(traveller, target.id, { guestCount: 2 }); // needs 3, exceeds by 2

      const approved = await requests.approveWithCapacityOverride(host, target.id, request.id);

      expect(approved.status).toBe('APPROVED');
      // requiredCapacity = reservedSeatCount(1) + requestedSeats(3) = 4
      expect((await events.getEvent(host, target.id)).capacityMax).toBe(4);
      expect(approved.capacityBeforeOverride).toBe(2);
      expect(approved.capacityAfterOverride).toBe(4);
    });

    it('rejects a client-supplied target capacity on the override action', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 });

      for (const field of ['newCapacityMax', 'capacityIncrease', 'overrideSeats', 'reservedSeatCount', 'capacityMax']) {
        await expect(
          requests.approveWithCapacityOverride(host, target.id, request.id, { [field]: 999 }),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      }
    });

    it('rejects the override if the required capacity exceeds the technical ceiling', async () => {
      const target = await event({ capacityMax: 2 });
      // requiredCapacity = reservedSeatCount(host=1) + requestedSeats(1+9999=10000) = 10001,
      // genuinely exceeding the 10,000 ceiling. guestCount: 9998 would only
      // reach exactly 10,000, which is ALLOWED (only >10,000 must fail).
      const request = await requests.create(traveller, target.id, { guestCount: 9999 }); // needs 10000 seats

      await expect(requests.approveWithCapacityOverride(host, target.id, request.id)).rejects.toMatchObject({
        code: 'EVENT_CAPACITY_OVERRIDE_LIMIT_EXCEEDED',
      });
      expect((await events.getEvent(host, target.id)).capacityMax).toBe(2);
    });

    it('override + approval is atomic: capacity increase, participant creation, and chat activation all commit or roll back together', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 });
      const chatModule = new (class extends ChatRepository {
        override async activateEventMember(): Promise<void> {
          throw new Error('chat provisioning unavailable');
        }
      })(AppDataSource);
      const failing = new JoinRequestsService(new EventsRepository(AppDataSource), chatModule);

      await expect(failing.approveWithCapacityOverride(host, target.id, request.id)).rejects.toThrow(
        'chat provisioning unavailable',
      );

      expect((await events.getEvent(host, target.id)).capacityMax).toBe(2); // rolled back
      expect(await participants(target.id)).toEqual([]);
      expect((await stored(request.id)).status).toBe('PENDING');
    });

    it('records override audit evidence: actor, timestamp, capacity before/after', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 });

      const before = Date.now();
      const approved = await requests.approveWithCapacityOverride(host, target.id, request.id);

      expect(approved.capacityOverrideApprovedByUserId).toBe(host);
      expect(Date.parse(approved.capacityOverrideApprovedAt!)).toBeGreaterThanOrEqual(before);
      expect(approved.capacityBeforeOverride).toBe(2);
      expect(approved.capacityAfterOverride).toBe(3);
    });

    it('writes no override audit evidence when the request already fits by decision time', async () => {
      const target = await event({ capacityMax: 3 });
      const daniel = await user();
      const danielRequest = await requests.create(daniel, target.id, { guestCount: 1 });
      await requests.approve(host, target.id, danielRequest.id); // FULL now: 1+2=3

      const sarah = await user();
      const sarahRequest = await requests.create(sarah, target.id, {}); // exceeds by 1
      await requests.leave(daniel, target.id); // frees capacity — sarah's party fits again

      const approved = await requests.approveWithCapacityOverride(host, target.id, sarahRequest.id);

      expect(approved.status).toBe('APPROVED');
      expect(approved.capacityOverrideApprovedAt).toBeNull();
      expect(approved.capacityBeforeOverride).toBeNull();
      expect(approved.capacityAfterOverride).toBeNull();
      expect((await events.getEvent(host, target.id)).capacityMax).toBe(3); // untouched
    });

    it('override approval copies guestCount normally into the EventParticipant row', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 2 });

      await requests.approveWithCapacityOverride(host, target.id, request.id);

      const [row] = await participants(target.id);
      expect(row.guest_count).toBe(2);
    });

    it('final reservedSeatCount equals the adjusted capacityMax after an exact-fill override, and the Event becomes FULL', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 }); // needs 2, exceeds by 1

      await requests.approveWithCapacityOverride(host, target.id, request.id);

      const state = await events.getEvent(host, target.id);
      expect(state.reservedSeatCount).toBe(state.capacityMax);
      expect(state.status).toBe('FULL');
    });

    it('leaving after an override releases the party seats but does NOT shrink capacityMax; FULL -> ACTIVE still applies', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 }); // exceeds by 1
      await requests.approveWithCapacityOverride(host, target.id, request.id); // capacityMax 2 -> 3, FULL

      await requests.leave(traveller, target.id);

      const state = await events.getEvent(host, target.id);
      expect(state.capacityMax).toBe(3); // NOT restored to 2
      expect(state.reservedSeatCount).toBe(1); // host only
      expect(state.status).toBe('ACTIVE'); // seat_freed bounce-back still applies
    });

    it('removing after an override releases the party seats but does NOT shrink capacityMax', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 });
      await requests.approveWithCapacityOverride(host, target.id, request.id); // capacityMax 2 -> 3

      await requests.remove(host, target.id, traveller);

      expect((await events.getEvent(host, target.id)).capacityMax).toBe(3);
    });

    it('concurrent explicit overrides serialize through the Event lock — no lost update', async () => {
      const target = await event({ capacityMax: 3 }); // host reserves 1, 2 remain
      const daniel = await user();
      const sarah = await user();
      const danielRequest = await requests.create(daniel, target.id, { guestCount: 1 }); // needs 2, exceeds
      const sarahRequest = await requests.create(sarah, target.id, { guestCount: 2 }); // needs 3, exceeds

      const [danielResult, sarahResult] = await Promise.allSettled([
        requests.approveWithCapacityOverride(host, target.id, danielRequest.id),
        requests.approveWithCapacityOverride(host, target.id, sarahRequest.id),
      ]);

      expect(danielResult.status).toBe('fulfilled');
      expect(sarahResult.status).toBe('fulfilled');
      const state = await events.getEvent(host, target.id);
      // Whatever order they serialized in, the final state must be exact:
      // host(1) + daniel party(2) + sarah party(3) = 6, no lost update.
      expect(state.reservedSeatCount).toBe(1 + 2 + 3);
      expect(state.capacityMax).toBe(state.reservedSeatCount);
    });

    it('the DTO field guestCount is the only client-owned field on the override action — no body at all is accepted', async () => {
      const target = await event({ capacityMax: 2 });
      const request = await requests.create(traveller, target.id, { guestCount: 1 });

      await expect(
        requests.approveWithCapacityOverride(host, target.id, request.id, { message: 'please' }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});
