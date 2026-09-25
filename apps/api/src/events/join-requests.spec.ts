import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserAccountStatus } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { type AuthenticatedUser, TripWithAuthGuard } from '../auth';
import { ChatRepository } from '../chat/chat.repository';
import { createValidationPipe } from '../common/pipes/create-validation-pipe';
import {
  AccountRestrictionEntity, EventEntity, EventJoinRequestEntity,
  EventParticipantEntity, UserEntity,
} from '../database/entities';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';
import { EventJoinRequestsController, HostJoinRequestsController, MyJoinRequestsController } from './join-requests.controller';
import { translateJoinConflict } from './join-requests.errors';
import { JoinRequestsService } from './join-requests.service';

const user = { id: 'authenticated-user', accountStatus: UserAccountStatus.Active } as AuthenticatedUser;
const protectedFields = [
  'userId', 'status', 'paymentId', 'requestedAt', 'expiresAt', 'approvedAt',
  'rejectedAt', 'cancelledAt', 'expiredAt', 'decidedByUserId', 'participantCount',
  'isHost', 'eventId', 'unknown',
];

function mockChat(): jest.Mocked<
  Pick<ChatRepository, 'ensureEventRoom' | 'activateEventMember' | 'deactivateEventMember' | 'findEventRoomId'>
> {
  return {
    ensureEventRoom: jest.fn().mockResolvedValue('room-id'),
    activateEventMember: jest.fn().mockResolvedValue(undefined),
    deactivateEventMember: jest.fn().mockResolvedValue(undefined),
    findEventRoomId: jest.fn().mockResolvedValue('room-id'),
  };
}

describe('join request input and controller boundary', () => {
  const repository = { transaction: jest.fn() };
  const service = new JoinRequestsService(repository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);

  it.each(protectedFields)('rejects %s in both the DTO and service before any write', async (field) => {
    const body = { message: 'hello', [field]: 'attacker-controlled' };
    await expect(createValidationPipe().transform(body, { type: 'body', metatype: CreateJoinRequestDto }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    await expect(service.create(user.id, 'event', body))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it.each(['x'.repeat(501), 123, {}, ['hello']])('rejects invalid messages: %p', async (message) => {
    const body = { message } as CreateJoinRequestDto;
    await expect(createValidationPipe().transform(body, { type: 'body', metatype: CreateJoinRequestDto }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.create(user.id, 'event', body)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it.each([{}, { message: null }, { message: '' }, { message: '😀'.repeat(500) }])('accepts schema-bounded optional text: %p', async (body) => {
    await expect(createValidationPipe().transform(body, { type: 'body', metatype: CreateJoinRequestDto })).resolves.toEqual(body);
  });

  it.each([null, [], 'hello', { message: 'contains\0nul' }])('fails closed for malformed bodies: %p', async (body) => {
    await expect(service.create(user.id, 'event', body as CreateJoinRequestDto)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('forbids all fields on explicit decision/cancel commands', async () => {
    await expect(service.approve(user.id, 'event', 'request', { paymentId: 'arbitrary' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.reject(user.id, 'event', 'request', { status: 'APPROVED' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(service.cancel(user.id, 'request', { userId: 'other' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('guards every controller and preserves the runtime creation DTO', () => {
    for (const controller of [EventJoinRequestsController, MyJoinRequestsController, HostJoinRequestsController]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([TripWithAuthGuard]);
    }
    expect(Reflect.getMetadata('design:paramtypes', EventJoinRequestsController.prototype, 'create')[2]).toBe(CreateJoinRequestDto);
  });

  it('passes authenticated identity and the exact event/request pair on every route', async () => {
    const commands = {
      create: jest.fn(), listMine: jest.fn(), listForHost: jest.fn(),
      approve: jest.fn(), reject: jest.fn(), cancel: jest.fn(),
      leave: jest.fn(), remove: jest.fn(),
    };
    const requests = commands as unknown as JoinRequestsService;
    const events = new EventJoinRequestsController(requests);
    const mine = new MyJoinRequestsController(requests);
    const host = new HostJoinRequestsController(requests);
    await events.create(user, 'event', { message: 'hi' });
    await events.leave(user, 'event');
    await mine.list(user);
    await mine.cancel(user, 'request', {});
    await host.list(user, 'event');
    await host.approve(user, 'event', 'request', {});
    await host.reject(user, 'event', 'request', {});
    await host.removeParticipant(user, 'event', 'target-user');
    expect(commands.create).toHaveBeenCalledWith(user.id, 'event', { message: 'hi' });
    expect(commands.leave).toHaveBeenCalledWith(user.id, 'event');
    expect(commands.listMine).toHaveBeenCalledWith(user.id);
    expect(commands.cancel).toHaveBeenCalledWith(user.id, 'request', {});
    expect(commands.listForHost).toHaveBeenCalledWith(user.id, 'event');
    expect(commands.approve).toHaveBeenCalledWith(user.id, 'event', 'request', {});
    expect(commands.reject).toHaveBeenCalledWith(user.id, 'event', 'request', {});
    expect(commands.remove).toHaveBeenCalledWith(user.id, 'event', 'target-user');
  });

  it('never accepts userId in the body for self-leave — the authenticated user is always the leaver', () => {
    expect(Reflect.getMetadata('design:paramtypes', EventJoinRequestsController.prototype, 'leave')).toEqual([
      Object, String,
    ]);
  });
});

describe('join request database conflicts', () => {
  it.each([
    // WS8.4B: renamed to event_join_requests_pending_uk — see join-requests.errors.ts.
    ['23505', 'event_join_requests_pending_uk', 'JOIN_REQUEST_ALREADY_EXISTS'],
    ['23505', 'event_participants_active_uk', 'EVENT_ALREADY_JOINED'],
    ['23505', 'event_participants_join_request_uk', 'EVENT_ALREADY_JOINED'],
    ['23514', 'events_capacity_not_exceeded_chk', 'EVENT_CAPACITY_REACHED'],
  ])('maps %s/%s without returning database details', (code, constraint, expected) => {
    const result = translateJoinConflict({ driverError: { code, constraint, detail: 'private SQL' } });
    expect(result).toMatchObject({ code: expected, status: 409 });
    expect(JSON.stringify(result)).not.toContain('private SQL');
  });

  it('leaves unexpected failures to the global exception filter', () => {
    const error = new Error('unexpected');
    expect(translateJoinConflict(error)).toBe(error);
  });
});

describe('join command expiry transaction boundary', () => {
  it.each(['approve', 'reject', 'cancel'] as const)('%s commits EXPIRED before returning its domain failure', async (command) => {
    const row = {
      id: 'request', eventId: 'event', userId: user.id, status: 'PENDING',
      expiresAt: new Date(Date.now() - 1), expiredAt: null,
    };
    const requestRepository = { findOne: jest.fn().mockResolvedValue(row), findOneBy: jest.fn().mockResolvedValue(row), save: jest.fn().mockResolvedValue(row) };
    const eventRepository = { findOne: jest.fn().mockResolvedValue({ id: 'event' }) };
    const manager = { getRepository: (entity: unknown) => entity === EventJoinRequestEntity ? requestRepository : eventRepository } as unknown as EntityManager;
    let committed = false;
    const repository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
        const result = await work(manager);
        committed = true;
        return result;
      },
      findOwnedEvent: jest.fn().mockResolvedValue({ id: 'event' }),
    };
    const service = new JoinRequestsService(repository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);
    const result = command === 'cancel'
      ? service.cancel(user.id, row.id)
      : service[command](user.id, row.eventId, row.id);
    await expect(result).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED', status: 409 });
    expect(committed).toBe(true);
    expect(requestRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'EXPIRED', expiredAt: expect.any(Date) }));
  });

  it('expires after waiting for user eligibility even when that account becomes unavailable', async () => {
    const row = { id: 'request', eventId: 'event', userId: user.id, status: 'PENDING', expiresAt: new Date(Date.now() + 60_000) };
    const requestRepository = { findOne: jest.fn().mockResolvedValue(row), save: jest.fn().mockResolvedValue(row) };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === UserEntity) return { findOne: async () => {
          row.expiresAt = new Date(Date.now() - 1);
          return { accountStatus: 'SUSPENDED' };
        } };
        if (entity === AccountRestrictionEntity) return { exists: jest.fn().mockResolvedValue(false) };
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    let committed = false;
    const repository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => {
        const result = await work(manager);
        committed = true;
        return result;
      },
      findOwnedEvent: jest.fn().mockResolvedValue({ id: 'event', hostUserId: 'host' }),
    };
    const service = new JoinRequestsService(repository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);
    await expect(service.approve('host', 'event', 'request')).rejects.toMatchObject({ code: 'JOIN_REQUEST_EXPIRED' });
    expect(committed).toBe(true);
    expect(row.status).toBe('EXPIRED');
  });
});

describe('WS5 EVENT chat provisioning on approval', () => {
  const hostUserId = 'host-user';
  const participantUserId = 'participant-user';
  const eventId = 'event-1';
  const roomId = 'event-chat-room-1';

  function buildApprovableEvent() {
    return {
      id: eventId, hostType: 'USER', visibility: 'PUBLIC', hostUserId, joinApprovalRequired: true,
      status: 'ACTIVE', participantCount: 0, capacityMax: 10,
      hostGuestCount: 0, reservedSeatCount: 1, // WS8.5C: host alone, plenty of room
      minTrustScore: 0, depositMinor: 0, startsAt: new Date(Date.now() + 60_000),
    };
  }

  function buildManager(calls: string[], event: ReturnType<typeof buildApprovableEvent>, chat: ReturnType<typeof mockChat>) {
    const requestRow = {
      id: 'request-1', eventId, userId: participantUserId, status: 'PENDING',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), message: null,
      approvedAt: null, rejectedAt: null, cancelledAt: null, expiredAt: null,
    };
    const requestRepository = {
      findOne: jest.fn(async () => requestRow),
      findOneBy: jest.fn(async () => requestRow),
      save: jest.fn(async (row: typeof requestRow) => { calls.push(`request.save:${row.status}`); return row; }),
      create: jest.fn((values: Partial<typeof requestRow>) => ({ ...requestRow, ...values })),
    };
    const eventRepository = {
      findOne: jest.fn(async () => event),
      findOneByOrFail: jest.fn(async () => event),
      update: jest.fn(async () => { calls.push('event.update'); }),
    };
    const participantRepository = {
      exists: jest.fn(async () => false),
      insert: jest.fn(async () => { calls.push('participant.insert'); }),
    };
    const userRepository = { findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })) };
    const restrictionRepository = { exists: jest.fn(async () => false) };
    // These stand in for the caller's shared EntityManager: the same manager
    // instance is threaded through the request/participant/event writes AND
    // the chat calls below, so identity comparisons in the tests are real.
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === EventEntity) return eventRepository;
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return restrictionRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    chat.ensureEventRoom.mockImplementation(async (m: EntityManager, id: string) => {
      expect(m).toBe(manager);
      calls.push(`ensureEventRoom:${id}`);
      return roomId;
    });
    chat.activateEventMember.mockImplementation(async (m: EntityManager, room: string, userId: string) => {
      expect(m).toBe(manager);
      calls.push(`activateEventMember:${room}:${userId}`);
    });
    return { manager, requestRepository, eventRepository, participantRepository, requestRow };
  }

  function buildEventsRepository(manager: EntityManager, event: ReturnType<typeof buildApprovableEvent>) {
    return {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
      findOwnedEvent: jest.fn().mockResolvedValue(event),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    };
  }

  it('manual approval provisions the EVENT chat room and activates host + participant, in order, after the participant insert', async () => {
    const calls: string[] = [];
    const event = buildApprovableEvent();
    const chat = mockChat();
    const { manager } = buildManager(calls, event, chat);
    const events = buildEventsRepository(manager, event);
    const service = new JoinRequestsService(events as unknown as EventsRepository, chat as unknown as ChatRepository);

    await service.approve(hostUserId, eventId, 'request-1');

    expect(calls).toEqual([
      'request.save:APPROVED',
      'participant.insert',
      `ensureEventRoom:${eventId}`,
      `activateEventMember:${roomId}:${hostUserId}`,
      `activateEventMember:${roomId}:${participantUserId}`,
    ]);
  });

  it('the roomId returned by ensureEventRoom is the exact roomId passed to both activateEventMember calls', async () => {
    const calls: string[] = [];
    const event = buildApprovableEvent();
    const chat = mockChat();
    const { manager } = buildManager(calls, event, chat);
    const events = buildEventsRepository(manager, event);
    const service = new JoinRequestsService(events as unknown as EventsRepository, chat as unknown as ChatRepository);

    await service.approve(hostUserId, eventId, 'request-1');

    await expect(chat.ensureEventRoom.mock.results[0]?.value).resolves.toBe(roomId);
    expect(chat.activateEventMember).toHaveBeenNthCalledWith(1, manager, roomId, hostUserId);
    expect(chat.activateEventMember).toHaveBeenNthCalledWith(2, manager, roomId, participantUserId);
  });

  it('every chat call receives the exact same EntityManager instance the transaction handed to the command', async () => {
    const calls: string[] = [];
    const event = buildApprovableEvent();
    const chat = mockChat();
    const { manager } = buildManager(calls, event, chat);
    const events = buildEventsRepository(manager, event);
    const service = new JoinRequestsService(events as unknown as EventsRepository, chat as unknown as ChatRepository);

    await service.approve(hostUserId, eventId, 'request-1');

    for (const call of chat.ensureEventRoom.mock.calls) expect(call[0]).toBe(manager);
    for (const call of chat.activateEventMember.mock.calls) expect(call[0]).toBe(manager);
  });

  it('auto-approval (joinApprovalRequired=false) runs the identical chat provisioning sequence as manual approval', async () => {
    const calls: string[] = [];
    const event = { ...buildApprovableEvent(), joinApprovalRequired: false };
    const chat = mockChat();
    const participantRepository = { exists: jest.fn(async () => false), insert: jest.fn(async () => { calls.push('participant.insert'); }) };
    const eventRepository = {
      findOne: jest.fn(async () => event),
      findOneByOrFail: jest.fn(async () => event),
      update: jest.fn(async () => { calls.push('event.update'); }),
    };
    const requestRepository = {
      findOne: jest.fn(async () => null),
      save: jest.fn(async (row: Record<string, unknown>) => { calls.push(`request.save:${row.status as string}`); return row; }),
      create: jest.fn((values: Record<string, unknown>) => ({ id: 'request-auto', eventId, userId: participantUserId, ...values })),
    };
    const userRepository = { findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })) };
    const restrictionRepository = { exists: jest.fn(async () => false) };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === EventEntity) return eventRepository;
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return restrictionRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    chat.ensureEventRoom.mockImplementation(async (m: EntityManager, id: string) => {
      expect(m).toBe(manager);
      calls.push(`ensureEventRoom:${id}`);
      return roomId;
    });
    chat.activateEventMember.mockImplementation(async (m: EntityManager, room: string, userId: string) => {
      expect(m).toBe(manager);
      calls.push(`activateEventMember:${room}:${userId}`);
    });
    const events = buildEventsRepository(manager, event);
    const service = new JoinRequestsService(events as unknown as EventsRepository, chat as unknown as ChatRepository);

    await service.create(participantUserId, eventId, { message: null });

    expect(calls).toEqual([
      // create() persists the PENDING request first (the payment-guard UPDATE
      // trigger requires a PENDING row to exist before it can be approved),
      // then approveAndParticipate flips it to APPROVED in the same transaction.
      'request.save:PENDING',
      'request.save:APPROVED',
      'participant.insert',
      `ensureEventRoom:${eventId}`,
      `activateEventMember:${roomId}:${hostUserId}`,
      `activateEventMember:${roomId}:${participantUserId}`,
    ]);
  });

  it('a chat provisioning failure propagates out of the command and aborts the approval (no capacity update follows)', async () => {
    const calls: string[] = [];
    const event = buildApprovableEvent();
    const chat = mockChat();
    const { manager, eventRepository } = buildManager(calls, event, chat);
    chat.activateEventMember.mockImplementationOnce(async () => {
      throw new Error('chat provisioning unavailable');
    });
    const events = buildEventsRepository(manager, event);
    const service = new JoinRequestsService(events as unknown as EventsRepository, chat as unknown as ChatRepository);

    await expect(service.approve(hostUserId, eventId, 'request-1')).rejects.toThrow('chat provisioning unavailable');
    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  describe('Group Formation Step 2: provider-hosted session', () => {
    const providerOwnerId = 'provider-owner-user';
    const providerId = 'provider-1';

    // Typed as the shared USER fixture only so the existing builders accept it;
    // hostUserId is genuinely null on a PROVIDER row.
    function buildProviderSession(overrides: Record<string, unknown> = {}): ReturnType<typeof buildApprovableEvent> {
      return {
        ...buildApprovableEvent(),
        hostType: 'PROVIDER', hostUserId: null, hostProviderId: providerId,
        reservedSeatCount: 0, // no host seat on a provider session
        ...overrides,
      } as unknown as ReturnType<typeof buildApprovableEvent>;
    }

    function withProviderOwner(manager: EntityManager, ownerUserId: string | null) {
      const query = jest.fn(async (sql: string) =>
        (/FROM providers/.test(sql) ? [{ owner_user_id: ownerUserId }] : []));
      Object.assign(manager, { query });
      return query;
    }

    it('manual approval by the provider owner activates the OWNER (never the Provider row) as chat host', async () => {
      const calls: string[] = [];
      const event = buildProviderSession();
      const chat = mockChat();
      const { manager } = buildManager(calls, event, chat);
      const events = buildEventsRepository(manager, event);
      const service = new JoinRequestsService(events as unknown as EventsRepository, chat as unknown as ChatRepository);

      await service.approve(providerOwnerId, eventId, 'request-1');

      expect(events.findOwnedEvent).toHaveBeenCalledWith(manager, providerOwnerId, eventId, true);
      expect(chat.activateEventMember.mock.calls.map((call) => call[2])).toEqual([
        providerOwnerId, participantUserId,
      ]);
      expect(calls).not.toContain(`activateEventMember:${roomId}:${providerId}`);
    });

    it('auto-approval resolves providers.owner_user_id as the chat host', async () => {
      const calls: string[] = [];
      const event = buildProviderSession({ joinApprovalRequired: false });
      const chat = mockChat();
      const { manager, requestRepository } = buildManager(calls, event, chat);
      requestRepository.findOne.mockResolvedValue(null as never);
      const query = withProviderOwner(manager, providerOwnerId);
      const service = new JoinRequestsService(
        buildEventsRepository(manager, event) as unknown as EventsRepository,
        chat as unknown as ChatRepository,
      );

      await service.create(participantUserId, eventId, { message: null, guestCount: 3 });

      expect(query).toHaveBeenCalledWith(expect.stringMatching(/FROM providers/), [providerId]);
      expect(chat.activateEventMember.mock.calls.map((call) => call[2])).toEqual([
        providerOwnerId, participantUserId,
      ]);
    });

    it('the provider owner cannot join their own session as a participant', async () => {
      const calls: string[] = [];
      const event = buildProviderSession();
      const chat = mockChat();
      const { manager, requestRepository } = buildManager(calls, event, chat);
      requestRepository.findOne.mockResolvedValue(null as never);
      withProviderOwner(manager, providerOwnerId);
      const service = new JoinRequestsService(
        buildEventsRepository(manager, event) as unknown as EventsRepository,
        chat as unknown as ChatRepository,
      );

      await expect(service.create(providerOwnerId, eventId, { message: null })).rejects.toMatchObject({
        code: 'EVENT_SELF_JOIN',
      });
      expect(calls).toEqual([]);
    });

    it('an unclaimed provider session (owner_user_id NULL) is not joinable and provisions no chat', async () => {
      const calls: string[] = [];
      const event = buildProviderSession({ joinApprovalRequired: false });
      const chat = mockChat();
      const { manager } = buildManager(calls, event, chat);
      withProviderOwner(manager, null);
      const service = new JoinRequestsService(
        buildEventsRepository(manager, event) as unknown as EventsRepository,
        chat as unknown as ChatRepository,
      );

      await expect(service.create(participantUserId, eventId, { message: null })).rejects.toBeInstanceOf(
        EventNotFoundError,
      );
      expect(calls).toEqual([]);
      expect(chat.ensureEventRoom).not.toHaveBeenCalled();
    });
  });

  it('ChatRepository is declared as a real constructor dependency of JoinRequestsService (Nest DI wiring)', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', JoinRequestsService) as unknown[];
    expect(paramTypes).toEqual([EventsRepository, ChatRepository]);
  });
});

describe('WS8.4B participant leave / organizer remove', () => {
  const hostUserId = 'host-user';
  const participantUserId = 'participant-user';
  const otherUserId = 'other-user';
  const eventId = 'event-1';
  const roomId = 'event-chat-room-1';

  function buildEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: eventId, hostType: 'USER', visibility: 'PUBLIC', hostUserId, status: 'ACTIVE',
      participantCount: 5, capacityMax: 10,
      // WS8.5B: hostGuestCount=0 -> reservedSeatCount mirrors participantCount
      // by default in these fixtures (one seat per participant, no guests) —
      // individual tests override both together where they diverge.
      hostGuestCount: 0, reservedSeatCount: 5,
      startsAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  function buildParticipant(overrides: Record<string, unknown> = {}) {
    return {
      id: 'participant-row-1', eventId, userId: participantUserId,
      joinRequestId: 'request-1', paymentId: null, isHost: false,
      attendanceStatus: 'UNKNOWN', cancelledAt: null,
      cancelledByUserId: null, cancellationReason: null,
      guestCount: 0,
      ...overrides,
    };
  }

  function buildManager(opts: {
    event: ReturnType<typeof buildEvent>;
    participant: ReturnType<typeof buildParticipant> | null;
    calls: string[];
    eventAfterCancel?: Partial<ReturnType<typeof buildEvent>>;
  }) {
    const participantRepository = {
      findOne: jest.fn(async () => opts.participant),
      update: jest.fn(async (_criteria: unknown, partial: Record<string, unknown>) => {
        opts.calls.push(`participant.update:${JSON.stringify(partial)}`);
        if (opts.participant) Object.assign(opts.participant, partial);
      }),
    };
    const eventRepository = {
      findOne: jest.fn(async () => opts.event),
      findOneByOrFail: jest.fn(async () => ({ ...opts.event, ...opts.eventAfterCancel })),
      update: jest.fn(async (_id: string, partial: Record<string, unknown>) => {
        opts.calls.push(`event.update:${JSON.stringify(partial)}`);
        Object.assign(opts.event, partial);
      }),
    };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === EventEntity) return eventRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    return { manager, participantRepository, eventRepository };
  }

  function buildEventsRepository(manager: EntityManager, event: ReturnType<typeof buildEvent>) {
    return {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
      findOwnedEvent: jest.fn(async (_m: EntityManager, userId: string) => (userId === hostUserId ? event : null)),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    };
  }

  // 1. participant may leave an ACTIVE event before starts_at.
  it('lets a participant leave an ACTIVE event before starts_at', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'ACTIVE' });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    const result = await service.leave(participantUserId, eventId);

    expect(result.cancellationReason).toBe('VOLUNTARY_LEAVE');
    expect(result.cancelledByUserId).toBe(participantUserId);
    expect(participant.cancelledAt).toBeInstanceOf(Date);
    expect(participant.attendanceStatus).toBe('CANCELLED');
  });

  // Real-Postgres correction: a leave-then-rejoin cycle (WS8.4B) deliberately
  // leaves multiple EventParticipant rows for the same (event, user) as
  // truthful history. Without an explicit order, the lookup could
  // non-deterministically target an already-cancelled historical row instead
  // of the current active one, silently no-op'ing instead of actually
  // cancelling the active membership. joinedAt DESC deterministically
  // selects the most recently created row.
  it('selects the most recently created participant row (joinedAt DESC), not an arbitrary one', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'ACTIVE' });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager, participantRepository } = buildManager({
      event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 },
    });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    expect(participantRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ order: { joinedAt: 'DESC' } }),
    );
  });

  // 2. participant may leave a FULL event before starts_at.
  it('lets a participant leave a FULL event before starts_at', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'FULL', participantCount: 10, capacityMax: 10 });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 9, reservedSeatCount: 9 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    const result = await service.leave(participantUserId, eventId);

    expect(result.cancellationReason).toBe('VOLUNTARY_LEAVE');
  });

  // 3. USER host may remove a participant before starts_at.
  it('lets the USER host remove a participant before starts_at', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    const result = await service.remove(hostUserId, eventId, participantUserId);

    expect(result.cancellationReason).toBe('HOST_REMOVAL');
    expect(result.cancelledByUserId).toBe(hostUserId);
  });

  // 4. non-host cannot remove a participant.
  it('rejects a non-host attempting to remove a participant', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.remove(otherUserId, eventId, participantUserId)).rejects.toBeInstanceOf(EventNotFoundError);
  });

  // 5. host cannot remove self via the participant endpoint.
  it('rejects the host attempting to remove themselves', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant: null, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.remove(hostUserId, eventId, hostUserId)).rejects.toMatchObject({
      code: 'HOST_CANNOT_REMOVE_SELF',
    });
  });

  // 6. USER host cannot use the participant self-leave endpoint.
  it('rejects the USER host using the self-leave endpoint', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant: null, calls });
    const service = new JoinRequestsService(
      { transaction: (work: (m: EntityManager) => Promise<unknown>) => work(manager) } as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.leave(hostUserId, eventId)).rejects.toMatchObject({
      code: 'HOST_CANNOT_LEAVE_VIA_PARTICIPANT_ENDPOINT',
    });
  });

  // 7. leave rejected at/after starts_at.
  it('rejects leave once starts_at has been reached', async () => {
    const calls: string[] = [];
    const event = buildEvent({ startsAt: new Date(Date.now() - 1) });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.leave(participantUserId, eventId)).rejects.toMatchObject({ code: 'EVENT_MEMBERSHIP_LOCKED' });
    expect(participant.cancelledAt).toBeNull();
  });

  // 8. remove rejected at/after starts_at.
  it('rejects remove once starts_at has been reached', async () => {
    const calls: string[] = [];
    const event = buildEvent({ startsAt: new Date(Date.now() - 1) });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.remove(hostUserId, eventId, participantUserId)).rejects.toMatchObject({
      code: 'EVENT_MEMBERSHIP_LOCKED',
    });
    expect(participant.cancelledAt).toBeNull();
  });

  // 9. CANCELLED event rejects normal leave/remove.
  it('rejects leave/remove for a CANCELLED event', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'CANCELLED' });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.leave(participantUserId, eventId)).rejects.toMatchObject({ code: 'EVENT_MEMBERSHIP_LOCKED' });
    await expect(service.remove(hostUserId, eventId, participantUserId)).rejects.toMatchObject({
      code: 'EVENT_MEMBERSHIP_LOCKED',
    });
  });

  // 10. leave sets attendance_status/cancelled_at/reason/cancelled_by correctly.
  it('a voluntary leave writes attendance_status=CANCELLED, cancelled_at, reason=VOLUNTARY_LEAVE, cancelled_by=participant', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    expect(participant.attendanceStatus).toBe('CANCELLED');
    expect(participant.cancelledAt).toBeInstanceOf(Date);
    expect(participant.cancellationReason).toBe('VOLUNTARY_LEAVE');
    expect(participant.cancelledByUserId).toBe(participantUserId);
  });

  // 11. host remove sets reason=HOST_REMOVAL, cancelled_by=host.
  it('a host removal writes reason=HOST_REMOVAL, cancelled_by=host', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.remove(hostUserId, eventId, participantUserId);

    expect(participant.cancellationReason).toBe('HOST_REMOVAL');
    expect(participant.cancelledByUserId).toBe(hostUserId);
  });

  // 12 + 14. duplicate leave is a safe idempotent no-op and never overwrites
  // the original audit metadata.
  it('a duplicate leave is a safe idempotent no-op and never overwrites the original cancellation metadata', async () => {
    const calls: string[] = [];
    const firstCancelledAt = new Date(Date.now() - 5000);
    const event = buildEvent();
    const participant = buildParticipant({
      cancelledAt: firstCancelledAt, attendanceStatus: 'CANCELLED',
      cancelledByUserId: participantUserId, cancellationReason: 'VOLUNTARY_LEAVE',
    });
    const chat = mockChat();
    const { manager, participantRepository, eventRepository } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    const result = await service.leave(participantUserId, eventId);

    expect(result.cancelledAt).toBe(firstCancelledAt.toISOString());
    expect(participantRepository.update).not.toHaveBeenCalled();
    expect(eventRepository.update).not.toHaveBeenCalled();
    expect(chat.deactivateEventMember).not.toHaveBeenCalled();
  });

  // 13. duplicate remove is idempotent.
  it('a duplicate remove is a safe idempotent no-op', async () => {
    const calls: string[] = [];
    const firstCancelledAt = new Date(Date.now() - 5000);
    const event = buildEvent();
    const participant = buildParticipant({
      cancelledAt: firstCancelledAt, attendanceStatus: 'CANCELLED',
      cancelledByUserId: hostUserId, cancellationReason: 'HOST_REMOVAL',
    });
    const chat = mockChat();
    const { manager, participantRepository } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    const result = await service.remove(hostUserId, eventId, participantUserId);

    expect(result.cancelledByUserId).toBe(hostUserId);
    expect(result.cancellationReason).toBe('HOST_REMOVAL');
    expect(participantRepository.update).not.toHaveBeenCalled();
  });

  // 15. payment_id != NULL rejects normal leave/remove.
  it('rejects leave/remove for a participation with a financial commitment (payment_id set)', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant({ paymentId: 'payment-1' });
    const chat = mockChat();
    const { manager, participantRepository } = buildManager({ event, participant, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.leave(participantUserId, eventId)).rejects.toMatchObject({
      code: 'PAID_PARTICIPATION_CANCELLATION_NOT_SUPPORTED',
    });
    expect(participantRepository.update).not.toHaveBeenCalled();
  });

  // No participation record at all: honest not-found/not-member, not a
  // pretend success.
  it('rejects leave when no participation record for this user/event has ever existed', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant: null, calls });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await expect(service.leave(participantUserId, eventId)).rejects.toMatchObject({ code: 'EVENT_NOT_A_MEMBER' });
  });

  // 16. Event Chat member is deactivated in the same command/transaction.
  it('deactivates the EVENT chat member in the same transaction as the cancellation', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    chat.findEventRoomId.mockResolvedValue(roomId);
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    expect(chat.findEventRoomId).toHaveBeenCalledWith(manager, eventId);
    expect(chat.deactivateEventMember).toHaveBeenCalledWith(manager, roomId, participantUserId);
  });

  it('does not call deactivateEventMember when the event never had a chat room provisioned', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    chat.findEventRoomId.mockResolvedValue(null);
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    expect(chat.deactivateEventMember).not.toHaveBeenCalled();
  });

  // 17. participant_count is not manually written by application code —
  // only events.status is ever written here; participant_count itself is
  // only ever read back (findOneByOrFail), never included in an update().
  it('never writes participant_count directly — only re-reads the trigger-maintained value', async () => {
    const calls: string[] = [];
    const event = buildEvent();
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager, eventRepository } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4 } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    for (const call of eventRepository.update.mock.calls) {
      expect(call[1]).not.toHaveProperty('participantCount');
    }
  });

  // 18. FULL -> ACTIVE occurs when a seat is freed.
  it('transitions FULL -> ACTIVE when a leave drops participant_count below capacity', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'FULL', participantCount: 10, capacityMax: 10 });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager, eventRepository } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 9, reservedSeatCount: 9, capacityMax: 10, status: 'FULL' } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    expect(eventRepository.update).toHaveBeenCalledWith(eventId, { status: 'ACTIVE' });
    expect(event.status).toBe('ACTIVE');
  });

  it('uses the seat_freed transition reason for the FULL -> ACTIVE bounce-back', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'FULL', participantCount: 10, capacityMax: 10 });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 9, reservedSeatCount: 9, capacityMax: 10, status: 'FULL' } });
    const eventsRepository = buildEventsRepository(manager, event);
    const service = new JoinRequestsService(eventsRepository as unknown as EventsRepository, chat as unknown as ChatRepository);

    await service.leave(participantUserId, eventId);

    expect(eventsRepository.setTransitionContext).toHaveBeenCalledWith(manager, participantUserId, 'seat_freed');
  });

  // 19. ACTIVE stays ACTIVE when a seat is freed (no spurious transition attempt).
  it('leaves status as ACTIVE (no transition call) when an ACTIVE event has a participant leave', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'ACTIVE', participantCount: 5, capacityMax: 10 });
    const participant = buildParticipant();
    const chat = mockChat();
    const { manager, eventRepository } = buildManager({ event, participant, calls, eventAfterCancel: { participantCount: 4, reservedSeatCount: 4, capacityMax: 10, status: 'ACTIVE' } });
    const service = new JoinRequestsService(
      buildEventsRepository(manager, event) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );

    await service.leave(participantUserId, eventId);

    expect(eventRepository.update).not.toHaveBeenCalled();
  });

  // 25. no Traveller Feedback policy/code change was required — its own
  // repository already filters on cancelled_at IS NULL. Nothing to test
  // here structurally beyond confirming this module never imports it.
  it('does not import or reference the Traveller Feedback module', () => {
    const source = JoinRequestsService.toString();
    expect(source).not.toMatch(/traveller-feedback/i);
  });
});

describe('WS8.5B party size / guest seats', () => {
  const hostUserId = 'host-user';
  const participantUserId = 'participant-user';
  const eventId = 'event-1';
  const requestId = 'request-1';

  function buildEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: eventId, hostType: 'USER', visibility: 'PUBLIC', hostUserId, joinApprovalRequired: true,
      status: 'ACTIVE', capacityMax: 10, reservedSeatCount: 8,
      minTrustScore: 0, depositMinor: 0, startsAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  function buildCreateManager(opts: {
    event: ReturnType<typeof buildEvent>;
    calls: string[];
    participantExists?: boolean;
  }) {
    const requestRepository = {
      findOne: jest.fn(async () => null), // no live request
      save: jest.fn(async (row: Record<string, unknown>) => {
        opts.calls.push(`request.save:${JSON.stringify(row)}`);
        return row;
      }),
      create: jest.fn((values: Record<string, unknown>) => ({ id: requestId, ...values })),
    };
    const eventRepository = {
      findOne: jest.fn(async () => opts.event),
      findOneByOrFail: jest.fn(async () => opts.event),
      update: jest.fn(async () => { opts.calls.push('event.update'); }),
    };
    const participantRepository = {
      exists: jest.fn(async () => opts.participantExists ?? false),
      insert: jest.fn(async (values: Record<string, unknown>) => {
        opts.calls.push(`participant.insert:${JSON.stringify(values)}`);
      }),
    };
    const userRepository = {
      findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })),
    };
    const restrictionRepository = { exists: jest.fn(async () => false) };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === EventEntity) return eventRepository;
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return restrictionRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    return { manager, requestRepository, eventRepository, participantRepository };
  }

  function buildEventsRepository(manager: EntityManager) {
    return {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    };
  }

  function serviceFor(manager: EntityManager, chat = mockChat()) {
    return new JoinRequestsService(
      buildEventsRepository(manager) as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );
  }

  // 1. guestCount defaults to 0.
  it('defaults guestCount to 0 when omitted from the request body', async () => {
    const calls: string[] = [];
    const event = buildEvent({ joinApprovalRequired: true });
    const { manager, requestRepository } = buildCreateManager({ event, calls });

    await serviceFor(manager).create(participantUserId, eventId, {});

    expect(requestRepository.save).toHaveBeenCalledWith(expect.objectContaining({ guestCount: 0 }));
  });

  // 2. guestCount validation.
  it.each([-1, 1.5, 10_000])('rejects an invalid guestCount: %p', async (guestCount) => {
    const repository = { transaction: jest.fn() };
    const service = new JoinRequestsService(repository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);
    await expect(service.create(participantUserId, eventId, { guestCount })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  // 7. historical guestCount stored on the request.
  it('stores the requested guestCount on the JoinRequest and returns it in the view', async () => {
    const calls: string[] = [];
    const event = buildEvent(); // capacityMax:10, reservedSeatCount:8 -> 2 seats remaining
    const { manager } = buildCreateManager({ event, calls });

    const result = await serviceFor(manager).create(participantUserId, eventId, { guestCount: 1 }); // needs 2

    expect(result.guestCount).toBe(1);
  });

  // WS8.5C: creation no longer rejects on capacity at all — an over-capacity
  // party request is created as PENDING, explicitly flagged as exceeding.
  it('creates an over-capacity request instead of rejecting it (WS8.5C)', async () => {
    const calls: string[] = [];
    const event = buildEvent({ capacityMax: 10, reservedSeatCount: 9 }); // 1 seat remaining
    const { manager, requestRepository } = buildCreateManager({ event, calls });

    const result = await serviceFor(manager).create(participantUserId, eventId, { guestCount: 1 }); // needs 2 seats

    expect(requestRepository.save).toHaveBeenCalledWith(expect.objectContaining({ guestCount: 1, status: 'PENDING' }));
    expect(result.exceededCapacityAtRequest).toBe(true);
    expect(result.exceededByAtRequest).toBe(1);
    expect(result.availableSeatsAtRequest).toBe(1);
  });

  it('accepts a request whose party exactly fits the current remaining seats', async () => {
    const calls: string[] = [];
    const event = buildEvent({ capacityMax: 10, reservedSeatCount: 8, joinApprovalRequired: true }); // 2 remaining
    const { manager, requestRepository } = buildCreateManager({ event, calls });

    await serviceFor(manager).create(participantUserId, eventId, { guestCount: 1 }); // needs exactly 2

    expect(requestRepository.save).toHaveBeenCalledWith(expect.objectContaining({ guestCount: 1 }));
  });

  // 8. approval copies guestCount to EventParticipant.
  it('copies the requested guestCount into the EventParticipant row on approval', async () => {
    const event = buildEvent({ capacityMax: 10, reservedSeatCount: 5 });
    const requestRow = {
      id: requestId, eventId, userId: participantUserId, status: 'PENDING',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), message: null,
      guestCount: 3, approvedAt: null, rejectedAt: null, cancelledAt: null,
      expiredAt: null, decidedByUserId: null,
    };
    const requestRepository = {
      findOne: jest.fn(async () => requestRow),
      save: jest.fn(async (row: typeof requestRow) => row),
    };
    const eventRepository = {
      findOneByOrFail: jest.fn(async () => event),
      update: jest.fn(),
    };
    const participantRepository = { insert: jest.fn() };
    const userRepository = {
      findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })),
    };
    const restrictionRepository = { exists: jest.fn(async () => false) };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === EventEntity) return eventRepository;
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return restrictionRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    const eventsRepository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
      findOwnedEvent: jest.fn(async () => event),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    };
    const chat = mockChat();
    const service = new JoinRequestsService(eventsRepository as unknown as EventsRepository, chat as unknown as ChatRepository);

    await service.approve(hostUserId, eventId, requestId);

    expect(participantRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ guestCount: 3 }),
    );
  });

  // 11. approval re-checks remaining seats under lock — rejects if capacity
  // shrank since the request was created (even though creation's early
  // check passed at the time).
  it('re-checks party fit at approval time and rejects if capacity has since shrunk', async () => {
    const event = buildEvent({ capacityMax: 10, reservedSeatCount: 9 }); // 1 seat remaining now
    const requestRow = {
      id: requestId, eventId, userId: participantUserId, status: 'PENDING',
      requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), message: null,
      guestCount: 2, approvedAt: null, rejectedAt: null, cancelledAt: null,
      expiredAt: null, decidedByUserId: null,
    };
    const requestRepository = {
      findOne: jest.fn(async () => requestRow),
      save: jest.fn(async (row: typeof requestRow) => row),
    };
    const userRepository = {
      findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })),
    };
    const restrictionRepository = { exists: jest.fn(async () => false) };
    const participantRepository = { insert: jest.fn() };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return restrictionRepository;
        if (entity === EventParticipantEntity) return participantRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    const eventsRepository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
      findOwnedEvent: jest.fn(async () => event),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    };
    const service = new JoinRequestsService(eventsRepository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);

    await expect(service.approve(hostUserId, eventId, requestId)).rejects.toMatchObject({
      code: 'EVENT_CAPACITY_OVERRIDE_REQUIRED',
    });
    expect(participantRepository.insert).not.toHaveBeenCalled();
  });

  // WS8.5C: FULL no longer blocks request creation.
  it('creates a request even when the Event is already FULL', async () => {
    const calls: string[] = [];
    const event = buildEvent({ status: 'FULL', capacityMax: 10, reservedSeatCount: 10 });
    const { manager, requestRepository } = buildCreateManager({ event, calls });

    const result = await serviceFor(manager).create(participantUserId, eventId, {});

    expect(requestRepository.save).toHaveBeenCalledWith(expect.objectContaining({ status: 'PENDING' }));
    expect(result.currentOverrideRequired).toBe(true);
  });

  // WS8.5C: auto-approval never silently overrides capacity.
  it('does not auto-approve an over-capacity request even when joinApprovalRequired=false', async () => {
    const calls: string[] = [];
    const event = buildEvent({ joinApprovalRequired: false, capacityMax: 10, reservedSeatCount: 9 }); // 1 remains
    const { manager, participantRepository } = buildCreateManager({ event, calls });

    const result = await serviceFor(manager).create(participantUserId, eventId, { guestCount: 1 }); // needs 2

    expect(result.status).toBe('PENDING');
    expect(participantRepository.insert).not.toHaveBeenCalled();
  });

  it('still auto-approves normally when the party fits, with joinApprovalRequired=false', async () => {
    const calls: string[] = [];
    const event = buildEvent({ joinApprovalRequired: false, capacityMax: 10, reservedSeatCount: 5 });
    const { manager, participantRepository } = buildCreateManager({ event, calls });

    const result = await serviceFor(manager).create(participantUserId, eventId, {});

    expect(result.status).toBe('APPROVED');
    expect(participantRepository.insert).toHaveBeenCalled();
  });

  describe('approveWithCapacityOverride', () => {
    function buildOverrideManager(opts: {
      event: ReturnType<typeof buildEvent>;
      requestGuestCount: number;
    }) {
      const requestRow = {
        id: requestId, eventId, userId: participantUserId, status: 'PENDING',
        requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), message: null,
        guestCount: opts.requestGuestCount,
        approvedAt: null, rejectedAt: null, cancelledAt: null, expiredAt: null,
        decidedByUserId: null,
        capacityOverrideApprovedAt: null, capacityOverrideApprovedByUserId: null,
        capacityBeforeOverride: null, capacityAfterOverride: null,
      };
      const requestRepository = {
        findOne: jest.fn(async () => requestRow),
        save: jest.fn(async (row: typeof requestRow) => row),
      };
      const eventRepository = {
        findOneByOrFail: jest.fn(async () => opts.event),
        update: jest.fn(async (_id: string, partial: Record<string, unknown>) => {
          Object.assign(opts.event, partial);
        }),
      };
      const participantRepository = { insert: jest.fn() };
      const userRepository = {
        findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })),
      };
      const restrictionRepository = { exists: jest.fn(async () => false) };
      const manager = {
        getRepository: (entity: unknown) => {
          if (entity === EventJoinRequestEntity) return requestRepository;
          if (entity === EventEntity) return eventRepository;
          if (entity === EventParticipantEntity) return participantRepository;
          if (entity === UserEntity) return userRepository;
          if (entity === AccountRestrictionEntity) return restrictionRepository;
          throw new Error('Unexpected repository access');
        },
      } as unknown as EntityManager;
      return { manager, requestRepository, eventRepository, participantRepository };
    }

    function serviceForOverride(manager: EntityManager, event: ReturnType<typeof buildEvent>) {
      const eventsRepository = {
        transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
        findOwnedEvent: jest.fn(async (_m: EntityManager, userId: string) => (userId === hostUserId ? event : null)),
        setTransitionContext: jest.fn().mockResolvedValue(undefined),
      };
      return new JoinRequestsService(eventsRepository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);
    }

    // 11. host-only.
    it('is USER-host-only', async () => {
      const event = buildEvent({ capacityMax: 2, reservedSeatCount: 2 });
      const { manager } = buildOverrideManager({ event, requestGuestCount: 0 });

      await expect(serviceForOverride(manager, event).approveWithCapacityOverride('other-user', eventId, requestId))
        .rejects.toBeInstanceOf(EventNotFoundError);
    });

    // 13. client cannot supply a target capacity.
    it.each(['newCapacityMax', 'capacityIncrease', 'overrideSeats', 'reservedSeatCount', 'capacityMax'])(
      'rejects a client-supplied %s',
      async (field) => {
        const event = buildEvent({ capacityMax: 2, reservedSeatCount: 2 });
        const { manager } = buildOverrideManager({ event, requestGuestCount: 0 });

        await expect(
          serviceForOverride(manager, event).approveWithCapacityOverride(hostUserId, eventId, requestId, { [field]: 999 }),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      },
    );

    // 12. minimum required increase only.
    it('increases capacityMax by exactly the minimum required amount', async () => {
      const event = buildEvent({ capacityMax: 5, reservedSeatCount: 5 }); // full, 0 remaining
      const { manager, eventRepository } = buildOverrideManager({ event, requestGuestCount: 2 }); // needs 3

      const result = await serviceForOverride(manager, event).approveWithCapacityOverride(hostUserId, eventId, requestId);

      expect(eventRepository.update).toHaveBeenCalledWith(eventId, { capacityMax: 8 }); // 5 + 3
      expect(result.capacityBeforeOverride).toBe(5);
      expect(result.capacityAfterOverride).toBe(8);
    });

    // 14. technical ceiling.
    it('rejects the override if required capacity exceeds the technical ceiling', async () => {
      const event = buildEvent({ capacityMax: 5, reservedSeatCount: 5 });
      const { manager, eventRepository } = buildOverrideManager({ event, requestGuestCount: 9998 }); // needs 9999

      await expect(serviceForOverride(manager, event).approveWithCapacityOverride(hostUserId, eventId, requestId))
        .rejects.toMatchObject({ code: 'EVENT_CAPACITY_OVERRIDE_LIMIT_EXCEEDED' });
      expect(eventRepository.update).not.toHaveBeenCalled();
    });

    // 17. no override audit if the party already fits by decision time.
    it('writes no override audit evidence when the party already fits', async () => {
      const event = buildEvent({ capacityMax: 10, reservedSeatCount: 5 }); // 5 remaining
      const { manager, eventRepository } = buildOverrideManager({ event, requestGuestCount: 0 }); // needs 1

      const result = await serviceForOverride(manager, event).approveWithCapacityOverride(hostUserId, eventId, requestId);

      expect(eventRepository.update).not.toHaveBeenCalled();
      expect(result.capacityOverrideApprovedAt).toBeNull();
      expect(result.capacityBeforeOverride).toBeNull();
      expect(result.capacityAfterOverride).toBeNull();
    });
  });

  // WS8.5D: legacy capacity snapshot honesty (WS8.6A audit findings #1/#2).
  describe('legacy capacity snapshot (WS8.5D)', () => {
    function buildHostManager(opts: { event: ReturnType<typeof buildEvent>; requests: Record<string, unknown>[] }) {
      const requestRepository = { find: jest.fn(async () => opts.requests) };
      const manager = {
        getRepository: (entity: unknown) => {
          if (entity === EventJoinRequestEntity) return requestRepository;
          throw new Error('Unexpected repository access');
        },
      } as unknown as EntityManager;
      const eventsRepository = {
        transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
        findOwnedEvent: jest.fn(async () => opts.event),
      };
      return new JoinRequestsService(eventsRepository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);
    }

    function legacyRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'legacy-request', eventId, userId: participantUserId, status: 'APPROVED',
        message: null, guestCount: 1,
        requestedAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2026-01-02T00:00:00Z'),
        approvedAt: new Date('2026-01-01T01:00:00Z'), rejectedAt: null, cancelledAt: null, expiredAt: null,
        decidedByUserId: hostUserId,
        // WS8.5D: this JoinRequest predates the snapshot feature — both null.
        capacityMaxAtRequest: null, reservedSeatCountAtRequest: null,
        capacityOverrideApprovedAt: null, capacityOverrideApprovedByUserId: null,
        capacityBeforeOverride: null, capacityAfterOverride: null,
        ...overrides,
      };
    }

    // 1/2/3. legacy row: snapshot unavailable, both fields null together,
    // capacitySnapshotAvailable=false.
    it('reports capacitySnapshotAvailable=false for a legacy JoinRequest with no recorded snapshot', async () => {
      const event = buildEvent({ capacityMax: 10, reservedSeatCount: 7 });
      const service = buildHostManager({ event, requests: [legacyRow()] });

      const [view] = await service.listForHost(hostUserId, eventId);
      if (!view) throw new Error('expected exactly one JoinRequestView');

      expect(view.capacitySnapshotAvailable).toBe(false);
      expect(view.capacityMaxAtRequest).toBeNull();
      expect(view.reservedSeatCountAtRequest).toBeNull();
    });

    // 4. derived historical fields must not fabricate a value when the
    // snapshot is unavailable — never false/0/current-Event values.
    it('does not fabricate derived historical fields for a legacy request', async () => {
      const event = buildEvent({ capacityMax: 10, reservedSeatCount: 7 });
      const service = buildHostManager({ event, requests: [legacyRow()] });

      const [view] = await service.listForHost(hostUserId, eventId);
      if (!view) throw new Error('expected exactly one JoinRequestView');

      expect(view.availableSeatsAtRequest).toBeNull();
      expect(view.exceededCapacityAtRequest).toBeNull();
      expect(view.exceededByAtRequest).toBeNull();
    });

    // 7. current/dynamic capacity fields remain fully populated for a legacy
    // request — the missing historical snapshot does not affect NOW.
    it('still reports current/dynamic capacity fields for a legacy request', async () => {
      const event = buildEvent({ capacityMax: 10, reservedSeatCount: 7 }); // 3 remaining
      const service = buildHostManager({ event, requests: [legacyRow({ guestCount: 1 })] }); // needs 2

      const [view] = await service.listForHost(hostUserId, eventId);
      if (!view) throw new Error('expected exactly one JoinRequestView');

      expect(view.currentCapacityMax).toBe(10);
      expect(view.currentReservedSeatCount).toBe(7);
      expect(view.currentAvailableSeats).toBe(3);
      expect(view.currentlyFits).toBe(true);
      expect(view.currentOverrideRequired).toBe(false);
      expect(view.currentExceedsBy).toBe(0);
    });

    // 5/6. a freshly-created JoinRequest always stores a real, non-null
    // snapshot and reports capacitySnapshotAvailable=true.
    it('stores a real non-null snapshot and reports capacitySnapshotAvailable=true for a new request', async () => {
      const calls: string[] = [];
      const event = buildEvent({ capacityMax: 10, reservedSeatCount: 7 });
      const { manager, requestRepository } = buildCreateManager({ event, calls });

      const result = await serviceFor(manager).create(participantUserId, eventId, { guestCount: 0 });

      expect(requestRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ capacityMaxAtRequest: 10, reservedSeatCountAtRequest: 7 }),
      );
      expect(result.capacitySnapshotAvailable).toBe(true);
      expect(result.capacityMaxAtRequest).toBe(10);
      expect(result.reservedSeatCountAtRequest).toBe(7);
    });

    // A row that somehow had only one of the two fields null would violate
    // the both-or-neither invariant the DB CHECK constraint enforces
    // (event_join_requests_capacity_snapshot_chk) — the view layer treats
    // "either is missing" as "snapshot unavailable" rather than assuming
    // the other is trustworthy, as defense in depth alongside that CHECK.
    it('treats a partially-null snapshot as unavailable (defense in depth)', async () => {
      const event = buildEvent({ capacityMax: 10, reservedSeatCount: 7 });
      const service = buildHostManager({
        event,
        requests: [legacyRow({ capacityMaxAtRequest: 10, reservedSeatCountAtRequest: null })],
      });

      const [view] = await service.listForHost(hostUserId, eventId);
      if (!view) throw new Error('expected exactly one JoinRequestView');

      expect(view.capacitySnapshotAvailable).toBe(false);
      expect(view.availableSeatsAtRequest).toBeNull();
    });
  });
});

// Real-Postgres correction: create()'s live-request lookup previously matched
// status IN (PENDING, APPROVED), contradicting event_join_requests_pending_uk
// (WHERE status = 'PENDING') and the WS8.4B product decision that a
// historical APPROVED request must never by itself block a rejoin — only an
// ACTIVE EventParticipant should (EVENT_ALREADY_JOINED, checked separately).
describe("JoinRequestsService.create() — live request scope (real-Postgres correction)", () => {
  const hostUserId = 'host-user-livescope';
  const participantUserId = 'participant-user-livescope';
  const eventId = 'event-livescope';

  function buildEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: eventId, hostType: 'USER', visibility: 'PUBLIC', hostUserId, joinApprovalRequired: true,
      status: 'ACTIVE', capacityMax: 10, reservedSeatCount: 1,
      minTrustScore: 0, depositMinor: 0, startsAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  function buildManager(opts: {
    event: ReturnType<typeof buildEvent>;
    liveRequest: Record<string, unknown> | null;
    participantExists: boolean;
  }) {
    const requestRepository = {
      findOne: jest.fn(async () => opts.liveRequest),
      save: jest.fn(async (row: Record<string, unknown>) => row),
      create: jest.fn((values: Record<string, unknown>) => ({ id: 'new-request', ...values })),
    };
    const eventRepository = {
      findOne: jest.fn(async () => opts.event),
      findOneByOrFail: jest.fn(async () => opts.event),
    };
    const participantRepository = {
      exists: jest.fn(async () => opts.participantExists),
    };
    const userRepository = {
      findOne: jest.fn(async () => ({ id: participantUserId, accountStatus: 'ACTIVE', trustScore: 100, deletedAt: null })),
    };
    const restrictionRepository = { exists: jest.fn(async () => false) };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === EventEntity) return eventRepository;
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return restrictionRepository;
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    const eventsRepository = {
      transaction: async (work: (manager: EntityManager) => Promise<unknown>) => work(manager),
    };
    const service = new JoinRequestsService(eventsRepository as unknown as EventsRepository, mockChat() as unknown as ChatRepository);
    return { service, requestRepository, participantRepository };
  }

  const pendingRow = {
    id: 'live-pending', status: 'PENDING',
    requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  };

  // 1. PENDING request blocks another request.
  it('a PENDING request blocks a new request with JOIN_REQUEST_ALREADY_EXISTS', async () => {
    const { service } = buildManager({ event: buildEvent(), liveRequest: pendingRow, participantExists: false });

    await expect(service.create(participantUserId, eventId, {})).rejects.toMatchObject({
      code: 'JOIN_REQUEST_ALREADY_EXISTS',
    });
  });

  // 2. historical APPROVED request does NOT by itself block create() — proven
  // directly by asserting the query only ever scopes to PENDING, a single
  // value, never In([PENDING, APPROVED]).
  it('scopes the live-request lookup to PENDING only, never APPROVED', async () => {
    const { service, requestRepository } = buildManager({ event: buildEvent(), liveRequest: null, participantExists: false });

    await service.create(participantUserId, eventId, {});

    expect(requestRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) }),
    );
  });

  // 3. an ACTIVE EventParticipant still blocks duplicate joining, independent
  // of JoinRequest status.
  it('an active EventParticipant still blocks creation with EVENT_ALREADY_JOINED, even with no PENDING request', async () => {
    const { service } = buildManager({ event: buildEvent(), liveRequest: null, participantExists: true });

    await expect(service.create(participantUserId, eventId, {})).rejects.toMatchObject({
      code: 'EVENT_ALREADY_JOINED',
    });
  });

  // 4. cancelled EventParticipant + historical APPROVED request allows
  // rejoin: no live PENDING request, no active participant — the exact
  // post-leave state a real rejoin is attempted from.
  it('allows a new request once the participant is cancelled, even with a historical APPROVED request on record', async () => {
    const { service, requestRepository } = buildManager({ event: buildEvent(), liveRequest: null, participantExists: false });

    const result = await service.create(participantUserId, eventId, {});

    expect(result.status).toBe('PENDING');
    expect(requestRepository.save).toHaveBeenCalled();
  });
});

// Step 3 privacy closure: create() must not let an unrelated user turn a
// guessed PRIVATE/UNLISTED Event id into a PENDING request (and with it,
// related-viewer access to GET /v1/events/:eventId).
describe('JoinRequestsService.create() — V1 visibility gate', () => {
  const hostUserId = 'host-user-visibility';
  const travellerId = 'traveller-visibility';
  const eventId = 'event-visibility';

  function build(opts: {
    visibility: string;
    participantExists?: boolean;
    livePending?: boolean;
    trustScore?: number;
    overrides?: Record<string, unknown>;
  }) {
    const event = {
      id: eventId, hostType: 'USER', visibility: opts.visibility, hostUserId,
      joinApprovalRequired: true, status: 'ACTIVE', capacityMax: 10, reservedSeatCount: 1,
      minTrustScore: 5, depositMinor: 0, startsAt: new Date(Date.now() + 60_000),
      ...opts.overrides,
    };
    const pendingRow = {
      id: 'live-pending', status: 'PENDING', requestedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    };
    const requestRepository = {
      exists: jest.fn(async () => opts.livePending ?? false),
      findOne: jest.fn(async () => (opts.livePending ? pendingRow : null)),
      save: jest.fn(async (row: Record<string, unknown>) => row),
      create: jest.fn((values: Record<string, unknown>) => ({ id: 'new-request', ...values })),
    };
    const participantRepository = {
      exists: jest.fn(async () => opts.participantExists ?? false),
      insert: jest.fn(),
    };
    const userRepository = {
      findOne: jest.fn(async () => ({ id: travellerId, accountStatus: 'ACTIVE', trustScore: opts.trustScore ?? 9, deletedAt: null })),
    };
    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === EventJoinRequestEntity) return requestRepository;
        if (entity === EventEntity) return { findOne: jest.fn(async () => event), findOneByOrFail: jest.fn(async () => event) };
        if (entity === EventParticipantEntity) return participantRepository;
        if (entity === UserEntity) return userRepository;
        if (entity === AccountRestrictionEntity) return { exists: jest.fn(async () => false) };
        throw new Error('Unexpected repository access');
      },
    } as unknown as EntityManager;
    const chat = mockChat();
    const service = new JoinRequestsService(
      { transaction: async (work: (m: EntityManager) => Promise<unknown>) => work(manager) } as unknown as EventsRepository,
      chat as unknown as ChatRepository,
    );
    return { service, requestRepository, participantRepository, chat };
  }

  it('accepts a normal request on a PUBLIC ACTIVE Event without consulting the gate', async () => {
    const { service, requestRepository } = build({ visibility: 'PUBLIC' });

    await expect(service.create(travellerId, eventId, {})).resolves.toMatchObject({ status: 'PENDING' });
    expect(requestRepository.exists).not.toHaveBeenCalled();
  });

  it.each(['PRIVATE', 'UNLISTED'])(
    'answers an unrelated request on a %s Event exactly like a missing Event and writes nothing',
    async (visibility) => {
      const { service, requestRepository, participantRepository, chat } = build({ visibility });

      await expect(service.create(travellerId, eventId, { guestCount: 1 })).rejects.toBeInstanceOf(EventNotFoundError);
      expect(requestRepository.save).not.toHaveBeenCalled();
      expect(participantRepository.insert).not.toHaveBeenCalled();
      expect(chat.ensureEventRoom).not.toHaveBeenCalled();
      expect(chat.activateEventMember).not.toHaveBeenCalled();
    },
  );

  it('refuses before any other check, so trust/status/deposit errors cannot confirm a hidden Event exists', async () => {
    for (const opts of [
      { trustScore: 0 },
      { overrides: { status: 'CANCELLED' } },
      { overrides: { depositMinor: 500, priceMinor: 500 } },
    ]) {
      const { service } = build({ visibility: 'PRIVATE', ...opts });
      await expect(service.create(travellerId, eventId, {})).rejects.toBeInstanceOf(EventNotFoundError);
    }
  });

  it('keeps the existing outcomes for related users of a hidden Event', async () => {
    await expect(build({ visibility: 'PRIVATE' }).service.create(hostUserId, eventId, {}))
      .rejects.toMatchObject({ code: 'EVENT_SELF_JOIN' });
    await expect(build({ visibility: 'PRIVATE', participantExists: true }).service.create(travellerId, eventId, {}))
      .rejects.toMatchObject({ code: 'EVENT_ALREADY_JOINED' });
    await expect(build({ visibility: 'UNLISTED', livePending: true }).service.create(travellerId, eventId, {}))
      .rejects.toMatchObject({ code: 'JOIN_REQUEST_ALREADY_EXISTS' });
  });

  it('answers an unrelated request on a PUBLIC DRAFT like a missing Event, before any other check, and writes nothing', async () => {
    for (const extra of [{}, { minTrustScore: 11 }, { depositMinor: 500, priceMinor: 500 }]) {
      const { service, requestRepository, participantRepository, chat } = build({
        visibility: 'PUBLIC', overrides: { status: 'DRAFT', ...extra },
      });
      await expect(service.create(travellerId, eventId, { guestCount: 2 })).rejects.toBeInstanceOf(EventNotFoundError);
      expect(requestRepository.findOne).not.toHaveBeenCalled();
      expect(requestRepository.save).not.toHaveBeenCalled();
      expect(participantRepository.insert).not.toHaveBeenCalled();
      expect(chat.ensureEventRoom).not.toHaveBeenCalled();
    }
  });

  it('keeps the manager outcome on their own DRAFT and every non-DRAFT lifecycle answer unchanged', async () => {
    await expect(build({ visibility: 'PUBLIC', overrides: { status: 'DRAFT' } }).service.create(hostUserId, eventId, {}))
      .rejects.toMatchObject({ code: 'EVENT_SELF_JOIN' });
    for (const status of ['CANCELLED', 'IN_PROGRESS', 'COMPLETED']) {
      await expect(build({ visibility: 'PUBLIC', overrides: { status } }).service.create(travellerId, eventId, {}))
        .rejects.toMatchObject({ code: 'EVENT_NOT_JOINABLE' });
    }
    await expect(build({ visibility: 'PUBLIC', overrides: { status: 'FULL' } }).service.create(travellerId, eventId, {}))
      .resolves.toMatchObject({ status: 'PENDING' });
  });

  it('only counts a live (unexpired) PENDING request as a relationship', async () => {
    const { service, requestRepository } = build({ visibility: 'PRIVATE' });

    await expect(service.create(travellerId, eventId, {})).rejects.toBeInstanceOf(EventNotFoundError);
    expect(requestRepository.exists).toHaveBeenCalledWith({
      where: expect.objectContaining({ eventId, userId: travellerId, status: 'PENDING', expiresAt: expect.anything() }),
    });
  });
});
