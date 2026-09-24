import { randomUUID } from 'node:crypto';

import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server } from 'socket.io';

import { ConnectionTracker } from './connection-tracker.service';
import { PresenceService } from './presence.service';
import type { PresenceUpdate } from './presence.types';
import type { RealtimeSocket } from './realtime-socket.types';
import { userRoom } from './rooms';
import { extractHandshakeToken } from './socket-auth.util';
import { SOCKET_AUTHENTICATOR, type SocketAuthenticator } from './socket-authenticator';

/**
 * Socket.IO's own defaults are already 25s/20s; set explicitly so the value
 * is a deliberate, documented choice rather than an implicit library default
 * that could silently change on a dependency bump. Generous enough to
 * tolerate a mobile client's brief radio handoffs (Expo/React Native, per
 * the Phase 1 design doc) without flapping the connection.
 */
const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 20_000;

/**
 * 1 MB: enough for control/event frames, small enough that a single frame
 * can't be used to exhaust server memory. Message-payload limits proper are
 * Phase 7's concern once there is an actual chat payload shape to bound.
 */
const MAX_HTTP_BUFFER_SIZE_BYTES = 1_000_000;

const PRESENCE_UPDATE_EVENT = 'presence:update';

/**
 * Server-driven presence heartbeat cadence: for as long as a socket stays
 * connected, this refreshes the session's Redis TTL on its behalf, without
 * requiring the client to explicitly emit anything. This is what makes
 * presence crash/network-loss-safe for a client that never sends
 * presence:heartbeat at all — a connected socket alone is enough to keep a
 * session's TTL alive; only presence:activity (a genuine user interaction,
 * an explicit client-originated event) can move a user from AFK to ONLINE.
 * Reuses the same cadence as the gateway's own pingInterval rather than
 * inventing a new one.
 */
const PRESENCE_HEARTBEAT_INTERVAL_MS = PING_INTERVAL_MS;

@WebSocketGateway({
  transports: ['websocket', 'polling'],
  pingInterval: PING_INTERVAL_MS,
  pingTimeout: PING_TIMEOUT_MS,
  maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE_BYTES,
  cors: {
    // No origin allowlist exists in AppConfig yet (src/config/configuration.ts
    // is out of this module's scope — see FILES YOU MUST NOT TOUCH). `origin:
    // false` disables CORS headers entirely: browsers then block cross-origin
    // access by default (fail closed) rather than a wildcard leaving every
    // origin able to open a socket. Native mobile/server clients are
    // unaffected — CORS is a browser-enforced restriction, not a server-side
    // one. Revisit once an origin allowlist lands in configuration.ts.
    origin: false,
  },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  /** One heartbeat timer per currently-connected socket, keyed by socket id.
   * Kept here (not on the socket's own `data` bag) for the same reason
   * ConnectionTracker's count is a private field — implementation detail,
   * not per-connection application state. */
  private readonly presenceHeartbeatTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(SOCKET_AUTHENTICATOR) private readonly authenticator: SocketAuthenticator,
    private readonly connectionTracker: ConnectionTracker,
    private readonly presence: PresenceService,
  ) {}

  async handleConnection(client: RealtimeSocket): Promise<void> {
    try {
      const token = extractHandshakeToken(client.handshake);
      const principal = await this.authenticator.authenticate(token);

      if (!principal) {
        // Never log the token itself — only that a socket was rejected.
        this.logger.warn(`Socket ${client.id} rejected: authentication failed`);
        client.disconnect(true);
        return;
      }

      const sessionId = randomUUID();
      client.data.userId = principal.userId;
      client.data.sessionId = sessionId;
      await client.join(userRoom(principal.userId));
      this.connectionTracker.increment();

      await this.recordPresenceAndMaybeEmit(principal.userId, sessionId, 'connect');
      this.startPresenceHeartbeat(client, principal.userId, sessionId);

      this.logger.log(`Socket ${client.id} connected (user ${principal.userId})`);
    } catch (error) {
      // An authentication error is a rejected connection, never a crashed
      // gateway — one bad token or a transient verifier failure must not
      // take down every other socket on this process.
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Socket ${client.id} authentication error: ${message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: RealtimeSocket): void {
    const userId = client.data.userId;
    const sessionId = client.data.sessionId;
    this.stopPresenceHeartbeat(client.id);

    if (userId) {
      this.connectionTracker.decrement();
      this.logger.log(`Socket ${client.id} disconnected (user ${userId})`);
      if (sessionId) {
        // Fire-and-forget: disconnect must not be held up by presence
        // bookkeeping, and a failure here is caught/logged inside
        // PresenceService, never thrown.
        void this.recordPresenceAndMaybeEmit(userId, sessionId, 'disconnect');
      }
    } else {
      // Disconnected before/without ever authenticating — normal for a
      // rejected socket, not necessarily worth a warning.
      this.logger.log(`Socket ${client.id} disconnected (unauthenticated)`);
    }
  }

  /**
   * Explicit, client-originated signal of real user interaction — distinct
   * from Socket.IO's own transport-level ping/pong and from the server-
   * driven presence heartbeat above, neither of which count as activity.
   * Moves a user from AFK to ONLINE; never rejected/acked beyond the
   * implicit success of not disconnecting the socket, since presence is
   * non-durable auxiliary state (a dropped activity ping is harmless — the
   * next one, or the next heartbeat, keeps the session alive regardless).
   */
  @SubscribeMessage('presence:activity')
  async handlePresenceActivity(client: RealtimeSocket): Promise<void> {
    const userId = client.data.userId;
    const sessionId = client.data.sessionId;
    if (!userId || !sessionId) return;
    await this.recordPresenceAndMaybeEmit(userId, sessionId, 'activity');
  }

  private startPresenceHeartbeat(client: RealtimeSocket, userId: string, sessionId: string): void {
    const timer = setInterval(() => {
      void this.recordPresenceAndMaybeEmit(userId, sessionId, 'heartbeat');
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);
    // Never let this timer alone keep the Node process alive.
    timer.unref?.();
    this.presenceHeartbeatTimers.set(client.id, timer);
  }

  private stopPresenceHeartbeat(socketId: string): void {
    const timer = this.presenceHeartbeatTimers.get(socketId);
    if (timer) {
      clearInterval(timer);
      this.presenceHeartbeatTimers.delete(socketId);
    }
  }

  private async recordPresenceAndMaybeEmit(
    userId: string,
    sessionId: string,
    kind: 'connect' | 'disconnect' | 'heartbeat' | 'activity',
  ): Promise<void> {
    const transition =
      kind === 'connect'
        ? await this.presence.recordConnect(userId, sessionId)
        : kind === 'disconnect'
          ? await this.presence.recordDisconnect(userId, sessionId)
          : kind === 'activity'
            ? await this.presence.recordActivity(userId, sessionId)
            : await this.presence.recordHeartbeat(userId, sessionId);

    if (transition.changed) {
      const payload: PresenceUpdate = { userId, state: transition.state };
      this.server.to(userRoom(userId)).emit(PRESENCE_UPDATE_EVENT, payload);
    }
  }
}
