import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { PresenceService } from './presence.service';
import { PresenceState } from './presence.types';

const HEARTBEAT_TTL_MS = 45_000;
const ACTIVE_WINDOW_MS = 300_000;

/**
 * A minimal in-memory fake standing in for the CACHE_REDIS connection —
 * proves PresenceService's own aggregation/transition logic, not real Redis
 * behavior (TTL/expiry, network failure) — those are the deferred
 * integration tests. Individual methods can be replaced with a throwing
 * jest.fn() per test to simulate a Redis failure.
 */
function createFakeRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const sortedSets = new Map<string, Map<string, number>>();
  const strings = new Map<string, string>();

  const fake = {
    hset: jest.fn(async (key: string, fields: Record<string, string>) => {
      const hash = hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fields)) hash.set(field, value);
      hashes.set(key, hash);
      return 1;
    }),
    hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
    expire: jest.fn(async () => 1),
    zadd: jest.fn(async (key: string, score: number, member: string) => {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sortedSets.set(key, set);
      return 1;
    }),
    zrangebyscore: jest.fn(async (key: string, min: number | string, max: number | string) => {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      return [...set.entries()]
        .filter(([, score]) => score >= lo && score <= hi)
        .map(([member]) => member);
    }),
    zrem: jest.fn(async (key: string, member: string) => (sortedSets.get(key)?.delete(member) ? 1 : 0)),
    get: jest.fn(async (key: string) => strings.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (key: string) => (hashes.delete(key) || strings.delete(key) ? 1 : 0)),
    // Test-only escape hatch for directly seeding a stale/crashed session's
    // score without going through touchSession — see the TTL tests below.
    __setSessionScore(userId: string, sessionId: string, score: number): void {
      const key = `presence:sessions:${userId}`;
      const set = sortedSets.get(key) ?? new Map<string, number>();
      set.set(sessionId, score);
      sortedSets.set(key, set);
    },
  };
  return fake;
}

describe('PresenceService', () => {
  let redis: ReturnType<typeof createFakeRedis>;
  let service: PresenceService;
  let now: number;

  beforeEach(() => {
    redis = createFakeRedis();
    service = new PresenceService(redis as unknown as Redis);
    now = Date.parse('2026-09-09T12:00:00.000Z');
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('single session', () => {
    it('connect transitions to ONLINE', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();

      await expect(service.recordConnect(userId, sessionId)).resolves.toEqual({
        state: PresenceState.Online,
        changed: true,
      });
      await expect(service.getState(userId)).resolves.toBe(PresenceState.Online);
    });

    it('an activity refresh within the active window keeps ONLINE without a duplicate transition', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await service.recordConnect(userId, sessionId);

      now += 60_000; // well within ACTIVE_WINDOW_MS
      await expect(service.recordActivity(userId, sessionId)).resolves.toEqual({
        state: PresenceState.Online,
        changed: false,
      });
    });

    it('no activity within the active window (but heartbeat still fresh) transitions to AFK', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await service.recordConnect(userId, sessionId);

      now += ACTIVE_WINDOW_MS + 1_000; // past activity window, still within heartbeat TTL
      await expect(service.recordHeartbeat(userId, sessionId)).resolves.toEqual({
        state: PresenceState.Afk,
        changed: true,
      });
    });

    it('disconnect transitions to OFFLINE', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await service.recordConnect(userId, sessionId);

      await expect(service.recordDisconnect(userId, sessionId)).resolves.toEqual({
        state: PresenceState.Offline,
        changed: true,
      });
      await expect(service.getState(userId)).resolves.toBe(PresenceState.Offline);
    });
  });

  describe('multi session (multi-device)', () => {
    it('two sessions connected -> ONLINE', async () => {
      const userId = randomUUID();
      await service.recordConnect(userId, randomUUID());
      await service.recordConnect(userId, randomUUID());

      await expect(service.getState(userId)).resolves.toBe(PresenceState.Online);
    });

    it('one of two sessions disconnecting leaves the user ONLINE (no duplicate transition)', async () => {
      const userId = randomUUID();
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      await service.recordConnect(userId, sessionA);
      await service.recordConnect(userId, sessionB);

      await expect(service.recordDisconnect(userId, sessionA)).resolves.toEqual({
        state: PresenceState.Online,
        changed: false,
      });
      await expect(service.getState(userId)).resolves.toBe(PresenceState.Online);
    });

    it('the final session disconnecting transitions to OFFLINE', async () => {
      const userId = randomUUID();
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      await service.recordConnect(userId, sessionA);
      await service.recordConnect(userId, sessionB);

      await service.recordDisconnect(userId, sessionA);
      await expect(service.recordDisconnect(userId, sessionB)).resolves.toEqual({
        state: PresenceState.Offline,
        changed: true,
      });
    });

    it('one active session + one AFK session aggregates to ONLINE', async () => {
      const userId = randomUUID();
      const activeSession = randomUUID();
      const afkSession = randomUUID();
      await service.recordConnect(userId, afkSession);

      now += ACTIVE_WINDOW_MS + 1_000; // afkSession's activity goes stale
      await service.recordHeartbeat(userId, afkSession); // still live, just not "active"
      await service.recordConnect(userId, activeSession); // fresh connect = fresh activity

      await expect(service.getState(userId)).resolves.toBe(PresenceState.Online);
    });

    it('all live sessions AFK aggregates to AFK, not ONLINE', async () => {
      const userId = randomUUID();
      const sessionA = randomUUID();
      const sessionB = randomUUID();
      await service.recordConnect(userId, sessionA);
      await service.recordConnect(userId, sessionB);

      now += ACTIVE_WINDOW_MS + 1_000;
      await service.recordHeartbeat(userId, sessionA);
      await service.recordHeartbeat(userId, sessionB);

      await expect(service.getState(userId)).resolves.toBe(PresenceState.Afk);
    });
  });

  describe('TTL / crash recovery', () => {
    it('a session whose heartbeat score is older than the TTL floor is ignored (treated as OFFLINE)', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      // Seed a "crashed" session directly: present in the index but with a
      // score far older than HEARTBEAT_TTL_MS — simulates a session whose
      // owning process died without ever calling recordDisconnect.
      redis.__setSessionScore(userId, sessionId, now - HEARTBEAT_TTL_MS - 60_000);

      await expect(service.getState(userId)).resolves.toBe(PresenceState.Offline);
    });

    it('a session that stops heartbeating eventually stops keeping the user online (no crash cleanup needed)', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await service.recordConnect(userId, sessionId);
      await expect(service.getState(userId)).resolves.toBe(PresenceState.Online);

      // Time passes with no further heartbeat/activity/disconnect at all —
      // exactly the "disconnect callback never fired" crash scenario.
      now += HEARTBEAT_TTL_MS + 1_000;
      await expect(service.getState(userId)).resolves.toBe(PresenceState.Offline);
    });

    it('a Redis read failure fails safe: getState returns OFFLINE, never throws', async () => {
      const userId = randomUUID();
      redis.zrangebyscore.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.getState(userId)).resolves.toBe(PresenceState.Offline);
    });

    it('a Redis write failure fails safe: recordConnect resolves without throwing', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      redis.hset.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.recordConnect(userId, sessionId)).resolves.toBeDefined();
    });

    it('every record* method swallows a total Redis outage rather than throwing (protects any future caller)', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      redis.hset.mockRejectedValue(new Error('down'));
      redis.hget.mockRejectedValue(new Error('down'));
      redis.expire.mockRejectedValue(new Error('down'));
      redis.zadd.mockRejectedValue(new Error('down'));
      redis.zrangebyscore.mockRejectedValue(new Error('down'));
      redis.zrem.mockRejectedValue(new Error('down'));
      redis.get.mockRejectedValue(new Error('down'));
      redis.set.mockRejectedValue(new Error('down'));
      redis.del.mockRejectedValue(new Error('down'));

      await expect(service.recordConnect(userId, sessionId)).resolves.toBeDefined();
      await expect(service.recordHeartbeat(userId, sessionId)).resolves.toBeDefined();
      await expect(service.recordActivity(userId, sessionId)).resolves.toBeDefined();
      await expect(service.recordDisconnect(userId, sessionId)).resolves.toBeDefined();
      await expect(service.getState(userId)).resolves.toBe(PresenceState.Offline);
    });
  });

  describe('transitions', () => {
    it('does not report a change on a repeated heartbeat while already ONLINE', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await service.recordConnect(userId, sessionId);

      await expect(service.recordHeartbeat(userId, sessionId)).resolves.toMatchObject({ changed: false });
      await expect(service.recordHeartbeat(userId, sessionId)).resolves.toMatchObject({ changed: false });
    });

    it('reports changed only on the actual OFFLINE transition, not on repeated disconnect-adjacent reads', async () => {
      const userId = randomUUID();
      const sessionId = randomUUID();
      await service.recordConnect(userId, sessionId);

      const disconnect = await service.recordDisconnect(userId, sessionId);
      expect(disconnect).toEqual({ state: PresenceState.Offline, changed: true });

      // A second disconnect call for a session already gone (e.g. a
      // duplicate socket close event) must not report another change.
      const secondDisconnect = await service.recordDisconnect(userId, sessionId);
      expect(secondDisconnect).toEqual({ state: PresenceState.Offline, changed: false });
    });

    it('getState/getStates never touch the last-broadcast-state marker (no side effects on a pure read)', async () => {
      const userId = randomUUID();
      await service.recordConnect(userId, randomUUID());
      redis.set.mockClear();

      await service.getState(userId);
      await service.getStates([userId]);

      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('security: payload shape', () => {
    it('PresenceState values are the only state vocabulary exposed', async () => {
      const userId = randomUUID();
      await service.recordConnect(userId, randomUUID());
      const state = await service.getState(userId);

      expect(Object.values(PresenceState)).toContain(state);
    });
  });
});
