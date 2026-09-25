import { randomUUID } from 'node:crypto';

import {
  EventHostType,
  EventStatus,
  EventVisibility,
} from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import type { EventCategoryEntity, EventEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import type { CreateEventDto } from './dto';
import {
  EmptyEventPatchError,
  EventAlreadyStartedError,
  EventCancelNotAllowedError,
  EventCategoryNotFoundError,
  EventDraftRequiredError,
  EventNotFoundError,
  EventPublishNotAllowedError,
  InactiveEventCategoryError,
  InvalidEventValueError,
  ProtectedEventFieldError,
} from './events.errors';
import type { EventsRepository } from './events.repository';
import { EventsService } from './events.service';

const USER_ID = randomUUID();
const OTHER_USER_ID = randomUUID();
const EVENT_ID = randomUUID();
const NOW = new Date('2089-12-20T00:00:00Z');
const manager = { query: jest.fn() } as unknown as EntityManager;

const category = {
  id: 7,
  code: 'trek',
  label: 'Trek',
  icon: 'mountain',
  isActive: true,
  sortOrder: 1,
} as EventCategoryEntity;

const createDto = (overrides: Partial<CreateEventDto> = {}): CreateEventDto => ({
  categoryId: category.id,
  title: '  Desert sunrise walk  ',
  capacityMax: 20,
  startsAt: '2090-01-10T06:00:00Z',
  endsAt: '2090-01-10T09:00:00Z',
  latitude: 31.5,
  longitude: 35.4,
  ...overrides,
});

function eventFixture(overrides: Partial<EventEntity> = {}): EventEntity {
  return {
    id: EVENT_ID,
    hostType: EventHostType.User,
    hostUserId: USER_ID,
    hostProviderId: null,
    categoryId: category.id,
    category,
    title: 'Desert sunrise walk',
    description: null,
    status: EventStatus.Draft,
    visibility: EventVisibility.Public,
    capacityMax: 20,
    capacityMin: null,
    participantCount: 0,
    hostGuestCount: 0,
    reservedSeatCount: 1,
    priceMinor: 0,
    depositMinor: 0,
    currency: 'EUR',
    startsAt: new Date('2090-01-10T06:00:00Z'),
    endsAt: new Date('2090-01-10T09:00:00Z'),
    timeRange: '[2090-01-10 06:00:00+00,2090-01-10 09:00:00+00)',
    meetingPoint: { type: 'Point', coordinates: [35.4, 31.5] },
    meetingPointLabel: null,
    minTrustScore: 0,
    joinApprovalRequired: true,
    cancellationPolicy: null,
    createdAt: new Date('2089-12-01T00:00:00Z'),
    updatedAt: new Date('2089-12-01T00:00:00Z'),
    cancelledAt: null,
    completedAt: null,
    ...overrides,
  } as EventEntity;
}

describe('EventsService', () => {
  let repository: jest.Mocked<EventsRepository>;
  let service: EventsService;

  beforeEach(() => {
    repository = {
      transaction: jest.fn(async (work: (entityManager: EntityManager) => Promise<unknown>) =>
        work(manager)),
      findOwnedEvents: jest.fn().mockResolvedValue([]),
      findOwnedEvent: jest.fn(),
      findOwnedEventView: jest.fn(),
      findCategory: jest.fn().mockResolvedValue(category),
      createEvent: jest.fn((_manager: EntityManager, values: Partial<EventEntity>) =>
        eventFixture(values)),
      saveEvent: jest.fn(async (_manager: EntityManager, event: EventEntity) => event),
      setTransitionContext: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<EventsRepository>;
    service = new EventsService(repository, new GeoService());
  });

  it('creates only a USER-hosted DRAFT from the authenticated identity and schema defaults', async () => {
    const result = await service.createEvent(USER_ID, createDto());

    expect(repository.createEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        hostType: EventHostType.User,
        hostUserId: USER_ID,
        hostProviderId: null,
        status: EventStatus.Draft,
        visibility: EventVisibility.Public,
        priceMinor: 0,
        depositMinor: 0,
        currency: 'EUR',
      }),
    );
    expect(result).toMatchObject({
      hostType: EventHostType.User,
      title: 'Desert sunrise walk',
      status: EventStatus.Draft,
      participantCount: 0,
      meetingPoint: { latitude: 31.5, longitude: 35.4 },
    });
    expect(result).not.toHaveProperty('hostUserId');
    expect(result).not.toHaveProperty('timeRange');
  });

  // WS8.5B
  it('defaults hostGuestCount to 0 and consumes exactly one physical seat', async () => {
    const result = await service.createEvent(USER_ID, createDto());
    expect(repository.createEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ hostGuestCount: 0 }),
    );
    expect(result.hostGuestCount).toBe(0);
  });

  // WS8.5B
  it('accepts an explicit hostGuestCount — host + 2 guests occupies three seats', async () => {
    const result = await service.createEvent(USER_ID, createDto({ hostGuestCount: 2, capacityMax: 10 }));
    expect(repository.createEvent).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ hostGuestCount: 2 }),
    );
    expect(result.hostGuestCount).toBe(2);
  });

  // WS8.5B
  it('rejects a negative, non-integer, or out-of-bound hostGuestCount', async () => {
    await expect(
      service.createEvent(USER_ID, createDto({ hostGuestCount: -1 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
    await expect(
      service.createEvent(USER_ID, createDto({ hostGuestCount: 1.5 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
    await expect(
      service.createEvent(USER_ID, createDto({ hostGuestCount: 10_000 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
  });

  // WS8.5B
  it('rejects a host party (1 + hostGuestCount) larger than capacityMax', async () => {
    await expect(
      service.createEvent(USER_ID, createDto({ capacityMax: 3, hostGuestCount: 3 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
  });

  // WS8.5B
  it('accepts a host party that exactly fills capacityMax', async () => {
    const result = await service.createEvent(USER_ID, createDto({ capacityMax: 3, hostGuestCount: 2 }));
    expect(result.hostGuestCount).toBe(2);
  });

  it('rejects client-selected host/projection fields even if service is called directly', async () => {
    await expect(
      service.createEvent(USER_ID, {
        ...createDto(),
        hostUserId: OTHER_USER_ID,
      } as CreateEventDto),
    ).rejects.toBeInstanceOf(ProtectedEventFieldError);
    expect(repository.transaction).not.toHaveBeenCalled();
  });

  it('rejects unknown categories and invalid money, time, and location', async () => {
    repository.findCategory.mockResolvedValueOnce(null);
    await expect(service.createEvent(USER_ID, createDto())).rejects.toBeInstanceOf(
      EventCategoryNotFoundError,
    );
    await expect(
      service.createEvent(USER_ID, createDto({ priceMinor: 100, depositMinor: 101 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
    await expect(
      service.createEvent(
        USER_ID,
        createDto({
          startsAt: '2090-01-10T10:00:00Z',
          endsAt: '2090-01-10T09:00:00Z',
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
    await expect(
      service.createEvent(USER_ID, createDto({ latitude: 91 })),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
  });

  it('returns the same not-found boundary for absent and cross-owner resources', async () => {
    repository.findOwnedEventView.mockResolvedValue(null);
    repository.findOwnedEvent.mockResolvedValue(null);
    await expect(service.getEvent(OTHER_USER_ID, EVENT_ID)).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
    await expect(
      service.updateEvent(OTHER_USER_ID, EVENT_ID, { title: 'Attacker edit' }),
    ).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(
      service.publishEvent(OTHER_USER_ID, EVENT_ID),
    ).rejects.toBeInstanceOf(EventNotFoundError);
    await expect(
      service.cancelEvent(OTHER_USER_ID, EVENT_ID),
    ).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it('updates mutable DRAFT fields while rejecting empty, protected, and published patches', async () => {
    const draft = eventFixture();
    repository.findOwnedEvent.mockResolvedValue(draft);
    const updated = await service.updateEvent(USER_ID, EVENT_ID, {
      title: '  Updated sunrise walk  ',
      priceMinor: 5_000,
      depositMinor: 1_500,
      latitude: 31.6,
      longitude: 35.5,
    });
    expect(updated).toMatchObject({
      title: 'Updated sunrise walk',
      priceMinor: 5_000,
      depositMinor: 1_500,
      meetingPoint: { latitude: 31.6, longitude: 35.5 },
    });

    await expect(service.updateEvent(USER_ID, EVENT_ID, {})).rejects.toBeInstanceOf(
      EmptyEventPatchError,
    );
    await expect(
      service.updateEvent(USER_ID, EVENT_ID, {
        status: EventStatus.Active,
      } as never),
    ).rejects.toBeInstanceOf(ProtectedEventFieldError);

    repository.findOwnedEvent.mockResolvedValue(eventFixture({ status: EventStatus.Active }));
    await expect(
      service.updateEvent(USER_ID, EVENT_ID, { title: 'Too late to edit' }),
    ).rejects.toBeInstanceOf(EventDraftRequiredError);
  });

  // WS8.5B
  it('lets hostGuestCount be edited while DRAFT', async () => {
    repository.findOwnedEvent.mockResolvedValue(eventFixture());
    const updated = await service.updateEvent(USER_ID, EVENT_ID, { hostGuestCount: 3 });
    expect(updated.hostGuestCount).toBe(3);
  });

  // WS8.5B
  it('rejects editing hostGuestCount once the Event is no longer DRAFT (frozen at publish)', async () => {
    repository.findOwnedEvent.mockResolvedValue(eventFixture({ status: EventStatus.Active }));
    await expect(
      service.updateEvent(USER_ID, EVENT_ID, { hostGuestCount: 3 }),
    ).rejects.toBeInstanceOf(EventDraftRequiredError);
  });

  // WS8.5B
  it('rejects an edited hostGuestCount that would no longer fit the (possibly also-edited) capacityMax', async () => {
    repository.findOwnedEvent.mockResolvedValue(eventFixture({ hostGuestCount: 1 }));
    await expect(
      service.updateEvent(USER_ID, EVENT_ID, { capacityMax: 1 }),
    ).rejects.toBeInstanceOf(InvalidEventValueError);
  });

  it('publishes exactly DRAFT to ACTIVE after locking and setting trigger context', async () => {
    const draft = eventFixture();
    repository.findOwnedEvent.mockResolvedValue(draft);

    const published = await service.publishEvent(USER_ID, EVENT_ID, NOW);

    expect(repository.findOwnedEvent).toHaveBeenCalledWith(manager, USER_ID, EVENT_ID, true);
    expect(repository.findCategory).toHaveBeenCalledWith(manager, category.id, true);
    expect(repository.setTransitionContext).toHaveBeenCalledWith(
      manager,
      USER_ID,
      'host_publish',
    );
    expect(published.status).toBe(EventStatus.Active);
    expect(repository.setTransitionContext.mock.invocationCallOrder[0]).toBeLessThan(
      repository.saveEvent.mock.invocationCallOrder[0]!,
    );
  });

  // WS8.5B: DRAFT -> FULL when the host party alone fills capacityMax.
  it('publishes straight to FULL when the host party (1 + hostGuestCount) alone fills capacityMax', async () => {
    const draft = eventFixture({ capacityMax: 3, hostGuestCount: 2, participantCount: 0 });
    repository.findOwnedEvent.mockResolvedValue(draft);

    const published = await service.publishEvent(USER_ID, EVENT_ID, NOW);

    expect(published.status).toBe(EventStatus.Full);
  });

  // WS8.5B: the ordinary case — host party alone does not fill capacity.
  it('publishes to ACTIVE, not FULL, when the host party does not alone fill capacityMax', async () => {
    const draft = eventFixture({ capacityMax: 3, hostGuestCount: 0, participantCount: 0 });
    repository.findOwnedEvent.mockResolvedValue(draft);

    const published = await service.publishEvent(USER_ID, EVENT_ID, NOW);

    expect(published.status).toBe(EventStatus.Active);
  });

  it('rejects inactive, already-started, repeated, and illegal publish attempts', async () => {
    repository.findOwnedEvent.mockResolvedValue(eventFixture());
    repository.findCategory.mockResolvedValue({ ...category, isActive: false });
    await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
      InactiveEventCategoryError,
    );

    repository.findCategory.mockResolvedValue(category);
    repository.findOwnedEvent.mockResolvedValue(
      eventFixture({ startsAt: new Date('2089-12-19T00:00:00Z') }),
    );
    await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
      EventAlreadyStartedError,
    );

    for (const status of [EventStatus.Active, EventStatus.Cancelled, EventStatus.Completed]) {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ status }));
      await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
        EventPublishNotAllowedError,
      );
    }
  });

  it('cancels permitted states atomically and rejects terminal states', async () => {
    for (const status of [
      EventStatus.Draft,
      EventStatus.Active,
      EventStatus.Full,
      EventStatus.InProgress,
    ]) {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ status }));
      const cancelled = await service.cancelEvent(USER_ID, EVENT_ID, NOW);
      expect(cancelled).toMatchObject({
        status: EventStatus.Cancelled,
        cancelledAt: NOW.toISOString(),
      });
    }
    expect(repository.setTransitionContext).toHaveBeenLastCalledWith(
      manager,
      USER_ID,
      'host_cancel',
    );

    for (const status of [EventStatus.Cancelled, EventStatus.Completed]) {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ status }));
      await expect(service.cancelEvent(USER_ID, EVENT_ID, NOW)).rejects.toBeInstanceOf(
        EventCancelNotAllowedError,
      );
    }
  });

  describe('Group Formation Step 2: provider-hosted sessions', () => {
    const PROVIDER_ID = randomUUID();
    const providerSession = (overrides: Partial<EventEntity> = {}) =>
      eventFixture({
        hostType: EventHostType.Provider,
        hostUserId: null,
        hostProviderId: PROVIDER_ID,
        hostGuestCount: 0,
        reservedSeatCount: 0,
        ...overrides,
      });

    it('publishes a one-seat provider session as ACTIVE: the owner occupies no seat', async () => {
      repository.findOwnedEvent.mockResolvedValue(providerSession({ capacityMax: 1 }));

      const published = await service.publishEvent(USER_ID, EVENT_ID, NOW);

      expect(published.status).toBe(EventStatus.Active);
      expect(repository.setTransitionContext).toHaveBeenCalledWith(manager, USER_ID, 'host_publish');
    });

    it('still publishes a one-seat USER-hosted Event straight to FULL (host takes the seat)', async () => {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ capacityMax: 1 }));

      await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).resolves.toMatchObject({
        status: EventStatus.Full,
      });
    });

    it('rejects giving a provider session a host party', async () => {
      repository.findOwnedEvent.mockResolvedValue(providerSession());

      await expect(
        service.updateEvent(USER_ID, EVENT_ID, { hostGuestCount: 2 }),
      ).rejects.toMatchObject({ details: { field: 'hostGuestCount' } });
      expect(repository.saveEvent).not.toHaveBeenCalled();
    });

    it('serializes a fresh provider session as FORMING from 0 reserved seats', async () => {
      repository.findOwnedEventView.mockResolvedValue(
        providerSession({ status: EventStatus.Active, capacityMin: 8, capacityMax: 12 }),
      );

      await expect(service.getEvent(USER_ID, EVENT_ID)).resolves.toMatchObject({
        hostType: EventHostType.Provider,
        reservedSeatCount: 0,
        groupState: 'FORMING',
        seatsToConfirm: 8,
        remainingSeats: 12,
      });
    });
  });

  describe('Group Formation: capacityMin', () => {
    it('persists an explicit capacityMin and serializes it with its derived fields', async () => {
      const result = await service.createEvent(
        USER_ID,
        createDto({ capacityMin: 8, capacityMax: 12 }),
      );

      expect(repository.createEvent).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ capacityMin: 8, capacityMax: 12 }),
      );
      // A DRAFT forms no group yet; the arithmetic gap is still reported
      // (host alone reserves 1 of the 8 required seats).
      expect(result).toMatchObject({ capacityMin: 8, groupState: null, seatsToConfirm: 7 });
    });

    it('defaults capacityMin to null — no minimum — when omitted or explicitly null', async () => {
      await service.createEvent(USER_ID, createDto());
      await service.createEvent(USER_ID, createDto({ capacityMin: null }));

      for (const [, values] of repository.createEvent.mock.calls) {
        expect(values).toMatchObject({ capacityMin: null });
      }
    });

    it('rejects a capacityMin greater than capacityMax', async () => {
      await expect(
        service.createEvent(USER_ID, createDto({ capacityMin: 13, capacityMax: 12 })),
      ).rejects.toMatchObject({ details: { field: 'capacityMin' } });
      expect(repository.createEvent).not.toHaveBeenCalled();
    });

    it('rejects a capacityMin of 0, a negative, or a non-integer', async () => {
      for (const capacityMin of [0, -1, 2.5]) {
        await expect(
          service.createEvent(USER_ID, createDto({ capacityMin })),
        ).rejects.toBeInstanceOf(InvalidEventValueError);
      }
      expect(repository.createEvent).not.toHaveBeenCalled();
    });

    it('accepts capacityMin equal to capacityMax', async () => {
      const result = await service.createEvent(
        USER_ID,
        createDto({ capacityMin: 12, capacityMax: 12 }),
      );
      expect(result.capacityMin).toBe(12);
    });

    it('rejects lowering capacityMax below the stored capacityMin on update', async () => {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ capacityMin: 8, capacityMax: 12 }));

      await expect(
        service.updateEvent(USER_ID, EVENT_ID, { capacityMax: 7 }),
      ).rejects.toMatchObject({ details: { field: 'capacityMin' } });
      expect(repository.saveEvent).not.toHaveBeenCalled();
    });

    it('accepts an update that changes both halves of the pair into a valid state', async () => {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ capacityMin: 8, capacityMax: 12 }));

      const updated = await service.updateEvent(USER_ID, EVENT_ID, { capacityMax: 6, capacityMin: 4 });

      expect(updated).toMatchObject({ capacityMax: 6, capacityMin: 4 });
    });

    it('clears the minimum when capacityMin is patched to null, and keeps it when omitted', async () => {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ capacityMin: 8 }));
      const cleared = await service.updateEvent(USER_ID, EVENT_ID, { capacityMin: null });
      expect(cleared).toMatchObject({ capacityMin: null, seatsToConfirm: null });

      repository.findOwnedEvent.mockResolvedValue(eventFixture({ capacityMin: 8 }));
      const kept = await service.updateEvent(USER_ID, EVENT_ID, { title: 'Renamed walk' });
      expect(kept.capacityMin).toBe(8);
    });

    it('refuses to publish a drifted pair where capacityMin exceeds capacityMax', async () => {
      repository.findOwnedEvent.mockResolvedValue(eventFixture({ capacityMin: 30, capacityMax: 20 }));

      await expect(service.publishEvent(USER_ID, EVENT_ID, NOW)).rejects.toMatchObject({
        details: { field: 'capacityMin' },
      });
      expect(repository.saveEvent).not.toHaveBeenCalled();
    });

    it('serializes FORMING / CONFIRMED from the stored counters, never from client input', async () => {
      repository.findOwnedEventView.mockResolvedValue(
        eventFixture({ status: EventStatus.Active, capacityMin: 8, capacityMax: 12, reservedSeatCount: 6 }),
      );
      await expect(service.getEvent(USER_ID, EVENT_ID)).resolves.toMatchObject({
        groupState: 'FORMING',
        seatsToConfirm: 2,
        remainingSeats: 6,
      });

      repository.findOwnedEventView.mockResolvedValue(
        eventFixture({ status: EventStatus.Active, capacityMin: 8, capacityMax: 12, reservedSeatCount: 9 }),
      );
      await expect(service.getEvent(USER_ID, EVENT_ID)).resolves.toMatchObject({
        groupState: 'CONFIRMED',
        seatsToConfirm: 0,
      });
    });

    it('leaves an existing Event without a minimum unchanged apart from reporting OPEN', async () => {
      const legacy = eventFixture({ status: EventStatus.Active, reservedSeatCount: 5 });
      repository.findOwnedEventView.mockResolvedValue(legacy);

      const view = await service.getEvent(USER_ID, EVENT_ID);

      expect(view).toMatchObject({
        capacityMin: null,
        groupState: 'OPEN',
        seatsToConfirm: null,
        status: EventStatus.Active,
        capacityMax: 20,
        reservedSeatCount: 5,
        remainingSeats: 15,
      });
    });
  });
});
