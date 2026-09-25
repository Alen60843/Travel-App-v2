import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EventView } from '../../../events/events.types';
import {
  assertPrototypeSeedAllowed,
  formatPrototypeSeedSummary,
  PROTOTYPE_SEED_PROVIDER,
  PROTOTYPE_SEED_SESSIONS,
  PROTOTYPE_SEED_USER_IDS,
  PrototypeSeedRefusedError,
} from './prototype-seed';

describe('assertPrototypeSeedAllowed (production guard)', () => {
  it('refuses NODE_ENV=production, even against localhost', () => {
    expect(() => assertPrototypeSeedAllowed({ NODE_ENV: 'production', DB_HOST: 'localhost' }))
      .toThrow(PrototypeSeedRefusedError);
    expect(() => assertPrototypeSeedAllowed({
      NODE_ENV: 'production', DB_HOST: 'postgres', PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB: 'true',
    })).toThrow(/NODE_ENV=production/);
  });

  it('refuses a non-local database host unless explicitly opted in, and a missing host always', () => {
    expect(() => assertPrototypeSeedAllowed({ DB_HOST: 'db.prod.example.com' })).toThrow(/not local/);
    expect(() => assertPrototypeSeedAllowed({ DB_HOST: 'postgres', PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB: 'yes' }))
      .toThrow(/not local/);
    expect(() => assertPrototypeSeedAllowed({})).toThrow(/DB_HOST is not set/);
    expect(() => assertPrototypeSeedAllowed({ DB_HOST: 'postgres', PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB: 'true' }))
      .not.toThrow();
  });

  it.each(['localhost', '127.0.0.1', '::1', ' LOCALHOST '])('allows the local host %s in development/test', (host) => {
    expect(() => assertPrototypeSeedAllowed({ DB_HOST: host })).not.toThrow();
    expect(() => assertPrototypeSeedAllowed({ NODE_ENV: 'test', DB_HOST: host })).not.toThrow();
  });
});

describe('prototype seed source contract', () => {
  // Executable code only: the module's doc comments legitimately name the
  // trigger-owned counters they promise never to write.
  const source = readFileSync(join(__dirname, 'prototype-seed.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('never writes derived counters or lifecycle status directly', () => {
    expect(source).not.toMatch(/reserved_seat_count|participant_count/);
    expect(source).not.toMatch(/UPDATE\s+events/i);
    expect(source).not.toMatch(/INSERT INTO (event_participants|event_join_requests|chat_rooms|chat_members|messages)/i);
    // Only provider sessions are inserted directly, always as DRAFT, then published by the real service.
    expect(source.match(/INSERT INTO events/g)).toHaveLength(1);
    expect(source).toMatch(/'PROVIDER', \$2, \$3, \$4, \$5, 'DRAFT'/);
  });

  it('owns rows only by fixed ids (and uid prefix), never by name or title', () => {
    expect(new Set(PROTOTYPE_SEED_USER_IDS).size).toBe(PROTOTYPE_SEED_USER_IDS.length);
    for (const id of [...PROTOTYPE_SEED_USER_IDS, PROTOTYPE_SEED_PROVIDER.id, PROTOTYPE_SEED_SESSIONS.rainbow.id]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // The ownership SQL and the whole cleanup function.
    const cleanup = source.slice(source.indexOf('const SEED_USERS_SQL'), source.indexOf('const CUSCO'));
    expect(cleanup).toContain('DELETE FROM users WHERE id IN');
    expect(cleanup).not.toMatch(/\bname\b|\btitle\b|\bemail\b|\bslug\b/);
    expect(source).not.toMatch(/TRUNCATE|DROP\s/i);
  });
});

describe('formatPrototypeSeedSummary', () => {
  const view = (overrides: Partial<EventView>): EventView => ({
    id: 'event-id', title: 'Event', status: 'ACTIVE', capacityMin: null, capacityMax: 10,
    reservedSeatCount: 1, remainingSeats: 9, groupState: 'OPEN', seatsToConfirm: null,
    startsAt: '2090-01-01T00:00:00.000Z',
    ...overrides,
  } as EventView);

  it('prints group states and ids only — no uids, emails or credentials', () => {
    const text = formatPrototypeSeedSummary({
      providerId: PROTOTYPE_SEED_PROVIDER.id,
      rainbowChatRoomId: 'room-1',
      events: {
        rainbow: view({ title: 'Rainbow Mountain', capacityMin: 8, capacityMax: 12, reservedSeatCount: 7, remainingSeats: 5, groupState: 'FORMING', seatsToConfirm: 1 }),
        humantay: view({ title: 'Humantay Lake', capacityMin: 10, capacityMax: 14, reservedSeatCount: 11, remainingSeats: 3, groupState: 'CONFIRMED', seatsToConfirm: 0 }),
        sunset: view({ title: 'Cusco Sunset Meetup' }),
        cooking: view({ title: 'Cooking', capacityMax: 4, reservedSeatCount: 4, remainingSeats: 0, groupState: 'FULL', status: 'FULL' }),
      },
    });
    expect(text).toContain('Prototype seed ready');
    expect(text).toContain('FORMING · 7 / 8 minimum · needs 1 more · 5 seats remaining');
    expect(text).toContain('CONFIRMED · 11 joined');
    expect(text).toContain('OPEN · 1 / 10');
    expect(text).toContain('FULL · 4 / 4');
    expect(text).toContain(PROTOTYPE_SEED_PROVIDER.id);
    expect(text).not.toMatch(/prototype-seed-|@|password|DB_/i);
  });
});
