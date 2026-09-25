import { EventStatus, UserAccountStatus } from '@tripwith/shared';

import type { AuthenticatedUser } from '../auth';
import { createValidationPipe } from '../common/pipes/create-validation-pipe';
import { GeoService } from '../database/geo';
import { ExplorerAreaQueryDto } from './dto/get-explorer-events-query.dto';
import { normalizeExplorerQuery } from './explorer-query';
import { ExplorerController } from './explorer.controller';
import { ExplorerRepository } from './explorer.repository';
import { ExplorerService } from './explorer.service';
import type { NormalizedExplorerQuery } from './explorer.types';

const QUERY: NormalizedExplorerQuery = {
  spatial: { kind: 'radius', center: { latitude: -13.5, longitude: -71.9 }, radiusMeters: 50_000 },
  now: new Date('2090-09-01T00:00:00Z'),
  windowStart: new Date('2090-09-01T00:00:00Z'),
  windowEnd: new Date('2090-10-01T00:00:00Z'),
  categoryCodes: ['trek'],
  zoom: 22,
  limit: 2,
};

function rawCard(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'event-rainbow', title: 'Rainbow Mountain', description: 'Sunrise hike',
    hostType: 'PROVIDER', status: 'ACTIVE',
    categoryCode: 'trek', categoryLabel: 'Trek', categoryIcon: 'mountain',
    startsAt: new Date('2090-09-26T05:00:00Z'), endsAt: new Date('2090-09-26T15:00:00Z'),
    latitude: -13.517, longitude: -71.9785, meetingPointLabel: 'Plaza de Armas',
    capacityMin: 8, capacityMax: 12, reservedSeatCount: 7, participantCount: 2,
    priceMinor: 4500, currency: 'USD', joinApprovalRequired: false,
    hostUserId: null, hostDisplayName: null, hostAvatarUrl: null,
    hostProviderId: 'provider-andes', hostProviderName: 'Andes Adventures',
    ...overrides,
  };
}

function repositoryReturning(rows: readonly Record<string, unknown>[]) {
  const database = { query: jest.fn().mockResolvedValue(rows) };
  return { database, repository: new ExplorerRepository(database, new GeoService()) };
}

describe('ExplorerRepository.findDiscoverableEventCards', () => {
  it('uses the map privacy boundary plus the operational-host rule, and deterministic order', async () => {
    const { database, repository } = repositoryReturning([]);
    await repository.findDiscoverableEventCards(QUERY);

    const [sql, values] = database.query.mock.calls[0] as [string, unknown[]];
    const flat = sql.replace(/\s+/g, ' ');
    expect(flat).toContain("event.visibility = 'PUBLIC' AND event.status IN ('ACTIVE', 'FULL')");
    expect(flat).toContain("event.host_type = 'USER' OR EXISTS");
    expect(flat).toContain('operational_provider.owner_user_id IS NOT NULL');
    expect(flat).toContain('operational_provider.deleted_at IS NULL');
    expect(flat).toContain('event.time_range && tstzrange(');
    expect(flat).toContain('ST_DWithin(event.meeting_point');
    expect(flat).toContain('category.code = ANY(');
    expect(flat.trim()).toMatch(/ORDER BY event\.starts_at ASC, event\.id ASC LIMIT \$\d+$/);
    expect(values).toEqual(expect.arrayContaining([QUERY.windowStart, QUERY.windowEnd, ['trek'], 3]));
  });

  it('selects only card-safe columns: no owner, contact, identity, roster, chat or payment data', async () => {
    const { database, repository } = repositoryReturning([]);
    await repository.findDiscoverableEventCards(QUERY);

    const sql = (database.query.mock.calls[0] as [string])[0];
    const selectList = sql.slice(sql.indexOf('SELECT'), sql.indexOf('FROM events event'));
    for (const forbidden of [
      'owner_user_id', 'email', 'firebase_uid', 'date_of_birth', 'contact_', 'trust_score',
      'payment', 'deposit', 'host_guest_count', 'visibility',
    ]) {
      expect(selectList).not.toContain(forbidden);
    }
    expect(sql).not.toMatch(/event_participants|event_join_requests|chat_rooms|chat_members|payments/);
  });

  it('maps FORMING (7 of min 8) with the Step 1 derivation and a PROVIDER host summary', async () => {
    const { repository } = repositoryReturning([rawCard()]);
    const { cards, hasMore } = await repository.findDiscoverableEventCards(QUERY);

    expect(hasMore).toBe(false);
    expect(cards).toEqual([{
      eventId: 'event-rainbow',
      title: 'Rainbow Mountain',
      description: 'Sunrise hike',
      category: { code: 'trek', label: 'Trek', icon: 'mountain' },
      hostType: 'PROVIDER',
      host: { type: 'PROVIDER', providerId: 'provider-andes', name: 'Andes Adventures' },
      status: EventStatus.Active,
      startsAt: '2090-09-26T05:00:00.000Z',
      endsAt: '2090-09-26T15:00:00.000Z',
      coordinate: { latitude: -13.517, longitude: -71.9785 },
      meetingPointLabel: 'Plaza de Armas',
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
    }]);
  });

  it.each([
    ['CONFIRMED (9 of min 8)', { reservedSeatCount: 9, participantCount: 3 }, { groupState: 'CONFIRMED', seatsToConfirm: 0, remainingSeats: 3 }],
    ['OPEN with no minimum', { capacityMin: null }, { groupState: 'OPEN', seatsToConfirm: null, remainingSeats: 5 }],
    ['FULL stays FULL', { status: 'FULL', reservedSeatCount: 12 }, { groupState: 'FULL', seatsToConfirm: 0, remainingSeats: 0 }],
  ])('maps %s', async (_label, overrides, expected) => {
    const { repository } = repositoryReturning([rawCard(overrides)]);
    const { cards } = await repository.findDiscoverableEventCards(QUERY);
    expect(cards[0]).toMatchObject(expected);
  });

  it('maps a USER host from safe profile fields only', async () => {
    const { repository } = repositoryReturning([rawCard({
      hostType: 'USER', hostUserId: 'host-noa', hostDisplayName: 'Noa', hostAvatarUrl: 'https://cdn.example/noa.png',
      hostProviderId: null, hostProviderName: null,
    })]);
    const { cards } = await repository.findDiscoverableEventCards(QUERY);
    expect(cards[0]!.host).toEqual({
      type: 'USER', userId: 'host-noa', displayName: 'Noa', avatarUrl: 'https://cdn.example/noa.png',
    });
  });

  it('returns at most limit cards and reports hasMore from the one extra row', async () => {
    const { repository } = repositoryReturning([
      rawCard({ eventId: 'e1' }), rawCard({ eventId: 'e2' }), rawCard({ eventId: 'e3' }),
    ]);
    const page = await repository.findDiscoverableEventCards(QUERY);
    expect(page.cards.map((card) => card.eventId)).toEqual(['e1', 'e2']);
    expect(page.hasMore).toBe(true);
  });
});

describe('Explorer map query (existing contract)', () => {
  it('excludes unclaimed provider sessions inside the privacy CTE, before any aggregate', async () => {
    const database = { query: jest.fn().mockResolvedValue([{ resultEventCount: 0, kind: null }]) };
    const repository = new ExplorerRepository(database, new GeoService());
    await repository.findDiscoverableMarkers(QUERY);

    const sql = (database.query.mock.calls[0] as [string])[0];
    const operational = sql.indexOf('operational_provider.owner_user_id IS NOT NULL');
    expect(operational).toBeGreaterThan(sql.indexOf('WITH discoverable AS MATERIALIZED'));
    expect(operational).toBeLessThan(sql.indexOf('discovery_stats AS'));
  });
});

describe('Joinable-time closure: one shared discoverable rule for map and cards', () => {
  /** Returns the value bound to `event.starts_at > $n` and whether it sits in the map's privacy CTE. */
  function startsAfterBinding(sql: string, values: readonly unknown[]) {
    const match = /event\.starts_at > \$(\d+)/.exec(sql);
    if (!match) throw new Error('expected a parameterized starts_at lower bound');
    return { value: values[Number(match[1]) - 1], index: match.index };
  }

  it('binds starts_at > the normalized discovery instant in BOTH queries, from the same fragment', async () => {
    const later = { ...QUERY, windowStart: new Date('2090-09-05T00:00:00Z') };
    const map = repositoryReturning([{ resultEventCount: 0, kind: null }]);
    const list = repositoryReturning([]);
    await map.repository.findDiscoverableMarkers(later);
    await list.repository.findDiscoverableEventCards(later);

    const [mapSql, mapValues] = map.database.query.mock.calls[0] as [string, unknown[]];
    const [cardSql, cardValues] = list.database.query.mock.calls[0] as [string, unknown[]];
    // The discovery instant (now), not the later requested windowStart.
    expect(startsAfterBinding(mapSql, mapValues).value).toBe(QUERY.now);
    expect(startsAfterBinding(cardSql, cardValues).value).toBe(QUERY.now);

    const mapBinding = startsAfterBinding(mapSql, mapValues).index;
    expect(mapBinding).toBeGreaterThan(mapSql.indexOf('WITH discoverable AS MATERIALIZED'));
    expect(mapBinding).toBeLessThan(mapSql.indexOf('discovery_stats AS'));

    const rule = (sql: string) => {
      const flat = sql.replace(/\s+/g, ' ').replace(/\$\d+/g, '$n');
      return flat.slice(flat.indexOf("event.visibility = 'PUBLIC'"), flat.indexOf('event.starts_at > $n'));
    };
    expect(rule(mapSql)).toBe(rule(cardSql));
  });

  it('normalizes a single discovery instant and keeps it separate from a later requested window', () => {
    const now = new Date('2090-09-01T12:00:00Z');
    const normalized = normalizeExplorerQuery({
      south: 0, west: 0, north: 1, east: 1, zoom: 10,
      windowStart: '2090-09-05T00:00:00Z', windowEnd: '2090-09-10T00:00:00Z',
    }, now);
    expect(normalized.now).toBe(now);
    expect(normalized.windowStart).toEqual(new Date('2090-09-05T00:00:00Z'));
  });
});

describe('ExplorerAreaQueryDto (event cards query)', () => {
  const pipe = createValidationPipe();
  const metadata = { type: 'query' as const, metatype: ExplorerAreaQueryDto };

  it('accepts the map area/window/category/limit parameters without zoom', async () => {
    await expect(pipe.transform({
      centerLatitude: '-13.5', centerLongitude: '-71.9', radiusMeters: '50000',
      limit: '20', categoryCodes: 'trek',
    }, metadata)).resolves.toMatchObject({
      centerLatitude: -13.5, centerLongitude: -71.9, radiusMeters: 50_000, limit: 20, categoryCodes: ['trek'],
    });
  });

  it('rejects a client-supplied userId through the global whitelist', async () => {
    await expect(pipe.transform({
      south: '0', west: '0', north: '1', east: '1', userId: 'attacker',
    }, metadata)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });
});

describe('ExplorerService.discoverEventCards', () => {
  it('reuses the map normalizer and category validation, with no per-user ranking', async () => {
    const repository = {
      findKnownCategoryCodes: jest.fn().mockResolvedValue(['trek']),
      findDiscoverableEventCards: jest.fn().mockResolvedValue({ cards: [], hasMore: false }),
    };
    const service = new ExplorerService(repository as unknown as ExplorerRepository);
    const now = new Date('2090-09-01T00:00:00Z');

    await expect(service.discoverEventCards('viewer', {
      centerLatitude: -13.5, centerLongitude: -71.9, radiusMeters: 50_000, categoryCodes: ['trek'],
    }, now)).resolves.toEqual({
      spatialMode: 'radius',
      windowStart: '2090-09-01T00:00:00.000Z',
      windowEnd: '2090-10-01T00:00:00.000Z',
      cards: [],
      hasMore: false,
    });
    expect(repository.findDiscoverableEventCards).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, categoryCodes: ['trek'] }),
    );

    repository.findKnownCategoryCodes.mockResolvedValue([]);
    await expect(service.discoverEventCards('viewer', {
      south: 0, west: 0, north: 1, east: 1, categoryCodes: ['not_real'],
    }, now)).rejects.toMatchObject({ code: 'EXPLORER_QUERY_INVALID' });
  });
});

describe('ExplorerController.getEventCards', () => {
  it('passes only the guard-derived internal user id', async () => {
    const discoverEventCards = jest.fn().mockResolvedValue({ cards: [] });
    const controller = new ExplorerController({ discoverEventCards } as unknown as ExplorerService);
    const viewer = { id: 'viewer-id', firebaseUid: 'fb', accountStatus: UserAccountStatus.Active } as AuthenticatedUser;
    const query = { south: 30, west: 34, north: 33, east: 36 };

    await controller.getEventCards(viewer, query);
    expect(discoverEventCards).toHaveBeenCalledWith('viewer-id', query);
  });
});
