import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { CACHE_REDIS } from '../redis/redis.tokens';
import { PresenceState, type PresenceTransition } from './presence.types';

/**
 * A session not refreshed (heartbeat or activity) within this window is
 * considered dead — crash/network-loss recovery, not an explicit disconnect.
 * Kept comfortably above the gateway's own pingInterval/pingTimeout
 * (realtime.gateway.ts, 25s/20s) so ordinary network jitter never flips a
 * healthy connection to OFFLINE.
 */
const HEARTBEAT_TTL_SECONDS = 45;

/** How recent a session's last real user activity must be to count as
 * ONLINE rather than AFK. Distinct from the heartbeat TTL: a session can be
 * alive (heartbeat fresh) but AFK (no recent activity). */
const ACTIVE_WINDOW_SECONDS = 300;

/** TTL on the small last-broadcast-state marker — bounds unbounded key
 * growth for users who go offline and are never touched again; long enough
 * that it is effectively permanent for any user who reconnects within a
 * week. Not load-bearing for correctness (see maybeTransition). */
const LAST_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Ephemeral, Redis-backed, multi-session presence aggregation.
 *
 * PostgreSQL is never involved: presence is non-durable auxiliary state, not
 * business truth (unlike chat_members, which IS durable authorization
 * truth — see chat/chat.repository.ts). Every method here follows the same
 * fail-safe contract as CacheService (../redis/cache.service.ts): a Redis
 * failure is logged at `warn` and treated as the safe default (OFFLINE for
 * reads, "no transition" for writes) — it must never throw, and it must
 * never be able to affect chat send/history/sync/read-state, which do not
 * call this class at all.
 *
 * Reuses the existing CACHE_REDIS connection (not a new client): presence
 * data is exactly the kind of disposable, evictable-under-pressure data that
 * connection's allkeys-lru policy is already configured for (infra/docker-
 * compose.yml) — losing a presence key under memory pressure just means a
 * user looks OFFLINE a little early, which is the same "a miss is harmless"
 * property CacheService already relies on.
 *
 * Data model, one user with sessions A and B:
 *   presence:session:{userId}:{sessionId}  HASH {heartbeatAt, activityAt}  (TTL-bearing)
 *   presence:sessions:{userId}              ZSET  member=sessionId, score=heartbeatAt
 *   presence:laststate:{userId}             STRING  last broadcast aggregate state
 *
 * The ZSET's score-based staleness check (not Redis's own per-key EXPIRE) is
 * what the read path actually depends on for correctness — EXPIRE on the
 * per-session HASH is purely memory hygiene for crash cleanup, not something
 * getState()/computeAggregateState() trusts directly.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(@Inject(CACHE_REDIS) private readonly redis: Redis) {}

  /** A fresh connection counts as both a live session and initial activity. */
  async recordConnect(userId: string, sessionId: string): Promise<PresenceTransition> {
    const now = Date.now();
    await this.touchSession(userId, sessionId, now, now);
    return this.recomputeAndMaybeTransition(userId);
  }

  /** Proves the session is still alive. Does NOT count as user activity —
   * callers must not treat Socket.IO's own transport ping/pong as this. */
  async recordHeartbeat(userId: string, sessionId: string): Promise<PresenceTransition> {
    const now = Date.now();
    await this.touchSession(userId, sessionId, now, undefined);
    return this.recomputeAndMaybeTransition(userId);
  }

  /** A genuine user interaction. Implies liveness too, so it refreshes the
   * heartbeat alongside activity. */
  async recordActivity(userId: string, sessionId: string): Promise<PresenceTransition> {
    const now = Date.now();
    await this.touchSession(userId, sessionId, now, now);
    return this.recomputeAndMaybeTransition(userId);
  }

  /** Clean-path removal (explicit disconnect). Crash/network-loss cleanup is
   * handled by the session HASH's own TTL and the ZSET's score-based
   * staleness check, not by this method. */
  async recordDisconnect(userId: string, sessionId: string): Promise<PresenceTransition> {
    try {
      await this.redis.del(this.sessionHashKey(userId, sessionId));
      await this.redis.zrem(this.sessionIndexKey(userId), sessionId);
    } catch (error) {
      this.logAndIgnore('recordDisconnect', userId, error);
    }
    return this.recomputeAndMaybeTransition(userId);
  }

  /** On-demand read with no side effects — does not touch the
   * last-broadcast-state marker, so it cannot suppress or trigger a
   * presence:update on its own. */
  async getState(userId: string): Promise<PresenceState> {
    return this.computeAggregateState(userId);
  }

  async getStates(userIds: readonly string[]): Promise<ReadonlyMap<string, PresenceState>> {
    const entries = await Promise.all(
      userIds.map(async (userId) => [userId, await this.computeAggregateState(userId)] as const),
    );
    return new Map(entries);
  }

  private async touchSession(
    userId: string,
    sessionId: string,
    heartbeatAt: number,
    activityAt: number | undefined,
  ): Promise<void> {
    try {
      const hashKey = this.sessionHashKey(userId, sessionId);
      const fields: Record<string, string> = { heartbeatAt: String(heartbeatAt) };
      if (activityAt !== undefined) fields.activityAt = String(activityAt);
      await this.redis.hset(hashKey, fields);
      await this.redis.expire(hashKey, HEARTBEAT_TTL_SECONDS);
      await this.redis.zadd(this.sessionIndexKey(userId), heartbeatAt, sessionId);
    } catch (error) {
      this.logAndIgnore('touchSession', userId, error);
    }
  }

  private async recomputeAndMaybeTransition(userId: string): Promise<PresenceTransition> {
    const state = await this.computeAggregateState(userId);
    return this.maybeTransition(userId, state);
  }

  private async computeAggregateState(userId: string): Promise<PresenceState> {
    try {
      const now = Date.now();
      const heartbeatFloor = now - HEARTBEAT_TTL_SECONDS * 1000;
      const liveSessionIds = await this.redis.zrangebyscore(
        this.sessionIndexKey(userId),
        heartbeatFloor,
        '+inf',
      );
      if (liveSessionIds.length === 0) return PresenceState.Offline;

      const activeFloor = now - ACTIVE_WINDOW_SECONDS * 1000;
      for (const sessionId of liveSessionIds) {
        const activityAtRaw = await this.redis.hget(
          this.sessionHashKey(userId, sessionId),
          'activityAt',
        );
        if (activityAtRaw !== null && Number(activityAtRaw) >= activeFloor) {
          return PresenceState.Online;
        }
      }
      return PresenceState.Afk;
    } catch (error) {
      // Fail closed: never over-claim presence when Redis is unavailable.
      this.logAndIgnore('computeAggregateState', userId, error, 'treating as OFFLINE');
      return PresenceState.Offline;
    }
  }

  private async maybeTransition(userId: string, state: PresenceState): Promise<PresenceTransition> {
    try {
      const key = this.lastStateKey(userId);
      const previous = await this.redis.get(key);
      if (previous === state) return { state, changed: false };
      await this.redis.set(key, state, 'EX', LAST_STATE_TTL_SECONDS);
      return { state, changed: true };
    } catch (error) {
      // Fail safe: never emit on infrastructure failure we can't confirm.
      this.logAndIgnore('maybeTransition', userId, error, 'assuming unchanged');
      return { state, changed: false };
    }
  }

  private sessionHashKey(userId: string, sessionId: string): string {
    return `presence:session:${userId}:${sessionId}`;
  }

  private sessionIndexKey(userId: string): string {
    return `presence:sessions:${userId}`;
  }

  private lastStateKey(userId: string): string {
    return `presence:laststate:${userId}`;
  }

  private logAndIgnore(op: string, userId: string, error: unknown, note = 'ignoring'): void {
    const message = error instanceof Error ? error.message : 'unknown error';
    this.logger.warn(`presence ${op} failed, ${note}: user=${userId} error=${message}`);
  }
}
