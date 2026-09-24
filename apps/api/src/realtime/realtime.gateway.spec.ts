import type { INestApplication, Provider } from '@nestjs/common';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';

import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CACHE_REDIS, QUEUE_REDIS } from '../redis/redis.tokens';

/**
 * RedisModule (pulled in transitively by RealtimeModule.forRoot() for
 * PresenceService's CACHE_REDIS dependency) also contains RedisReadinessCheck,
 * which injects APP_CONFIG directly — for a value it only reads inside
 * .check(), never called on this test's path. overrideProvider() can only
 * replace a token that is already registered somewhere in the compiled
 * graph, and nothing here imports the real (env-var-parsing) ConfigModule,
 * so APP_CONFIG needs an actual (fake, @Global()) provider, mirroring how
 * ConfigModule is @Global() in production and therefore ambiently visible
 * to every nested module once loaded once.
 */
@Global()
@Module({ providers: [{ provide: APP_CONFIG, useValue: {} as AppConfig }], exports: [APP_CONFIG] })
class FakeConfigModule {}
import { ConnectionTracker } from './connection-tracker.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';
import { userRoom } from './rooms';
import { SOCKET_AUTHENTICATOR } from './socket-authenticator';
import type { AuthenticatedPrincipal, SocketAuthenticator } from './socket-authenticator';

/**
 * A minimal in-memory fake for the CACHE_REDIS connection PresenceService
 * now depends on (RealtimeModule.forRoot() imports RedisModule for it).
 * These are e2e-style gateway wire-protocol tests, not presence-correctness
 * tests (see presence.service.spec.ts for that) — this fake exists only so
 * the connect/disconnect-driven presence calls the gateway now makes have
 * something to call instead of failing DI resolution or reaching a real
 * Redis. No external infrastructure required.
 */
function createFakeCacheRedis(): Redis {
  const hashes = new Map<string, Map<string, string>>();
  const sortedSets = new Map<string, Map<string, number>>();
  const strings = new Map<string, string>();
  return {
    async hset(key: string, fields: Record<string, string>): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fields)) hash.set(field, value);
      hashes.set(key, hash);
      return 1;
    },
    async hget(key: string, field: string): Promise<string | null> {
      return hashes.get(key)?.get(field) ?? null;
    },
    async expire(): Promise<number> {
      return 1;
    },
    async zadd(key: string, score: number, member: string): Promise<number> {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sortedSets.set(key, set);
      return 1;
    },
    async zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]> {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      return [...set.entries()].filter(([, score]) => score >= lo && score <= hi).map(([member]) => member);
    },
    async zrem(key: string, member: string): Promise<number> {
      return sortedSets.get(key)?.delete(member) ? 1 : 0;
    },
    async get(key: string): Promise<string | null> {
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<'OK'> {
      strings.set(key, value);
      return 'OK';
    },
    async del(key: string): Promise<number> {
      return hashes.delete(key) || strings.delete(key) ? 1 : 0;
    },
    // RedisLifecycleService.onModuleDestroy() checks `.status` before doing
    // anything else and returns immediately when it's already 'end' — this
    // fake never needs a real graceful-quit sequence.
    status: 'end',
  } as unknown as Redis;
}

/**
 * These tests drive a real, in-process Nest application over an actual
 * WebSocket connection. Neither `socket.io-client` nor `ws` are reachable
 * from apps/api's node_modules in this workspace (verified: pnpm did not
 * hoist either as this package has no direct dependency on them), so this
 * uses Node's built-in global `WebSocket` (stable since Node 21, confirmed
 * present under this repo's Jest "node" test environment) to speak the
 * engine.io v4 / socket.io v5 wire protocol directly:
 *
 *   -> connect to  ws://host:port/socket.io/?EIO=4&transport=websocket
 *   <- engine.io OPEN packet:              `0{"sid":...}`
 *   -> socket.io CONNECT packet with auth:  `40{"token":"..."}`
 *   <- socket.io CONNECT-ACK (accepted):    `40{"sid":...}`
 *      ...or the raw WebSocket closes (rejected)
 *
 * This was verified against this exact server setup before being relied on
 * here (see the task report for the raw frame trace).
 */

class FakeAuthenticator implements SocketAuthenticator {
  async authenticate(token: string | undefined): Promise<AuthenticatedPrincipal | null> {
    return token === 'good-token' ? { userId: 'user-123' } : null;
  }
}

function waitForFrame(ws: WebSocket, predicate: (frame: string) => boolean, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('timed out waiting for a matching frame'));
    }, timeoutMs);
    const handler = (ev: MessageEvent): void => {
      const frame = String(ev.data);
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(frame);
      }
    };
    ws.addEventListener('message', handler);
  });
}

// `CloseEvent` itself isn't part of @types/node's global surface (unlike
// `WebSocket`/`MessageEvent`, which are) -- `Event` is, and it's all the
// callers below need (they only check that a close event fired at all).
function waitForClose(ws: WebSocket, timeoutMs = 4000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve(ev);
    });
  });
}

async function openEngineIoSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  await waitForFrame(ws, (f) => f.startsWith('0'));
  return ws;
}

describe('RealtimeGateway (real Nest app, real WebSocket wire protocol)', () => {
  let app: INestApplication | undefined;
  let port: number;
  let gateway: RealtimeGateway;
  let connectionTracker: ConnectionTracker;

  async function buildApp(authenticatorProvider?: Provider): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeConfigModule,
        RealtimeModule.forRoot(authenticatorProvider ? { authenticatorProvider } : {}),
      ],
    })
      .overrideProvider(CACHE_REDIS)
      .useValue(createFakeCacheRedis())
      // RedisModule (imported transitively for CACHE_REDIS) also provides
      // QUEUE_REDIS as part of the same unit; nothing on this gateway's
      // path uses it, but Nest still constructs it, so it needs a stand-in.
      .overrideProvider(QUEUE_REDIS)
      .useValue({ status: 'end' })
      .compile();

    const nestApp = moduleRef.createNestApplication();
    await nestApp.listen(0);
    app = nestApp;

    const address = nestApp.getHttpServer().address();
    port = typeof address === 'object' && address !== null ? address.port : 0;

    gateway = moduleRef.get(RealtimeGateway);
    connectionTracker = moduleRef.get(ConnectionTracker);
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('gateway boots and accepts a connection the authenticator approves', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('sends a connect ack and joins the socket to its user:{id} room', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"good-token"}');

      const ack = await waitForFrame(ws, (f) => f.startsWith('40'));
      expect(ack).toContain('"sid"');

      // handleConnection awaits client.join() before returning; give the
      // event loop one tick to let that resolve on the server side.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(connectionTracker.activeConnections).toBe(1);
      const room = gateway.server.sockets.adapter.rooms.get(userRoom('user-123'));
      expect(room?.size).toBe(1);

      const clientClosed = waitForClose(ws);
      ws.close();
      await clientClosed;
    });
  });

  describe('a socket is rejected when the authenticator returns null', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('closes the underlying connection and never joins a room or counts as connected', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"not-a-real-token"}');

      const closeEvent = await waitForClose(ws);

      expect(closeEvent).toBeDefined();
      expect(connectionTracker.activeConnections).toBe(0);
    });
  });

  describe('the default authenticator (no authenticatorProvider registered)', () => {
    beforeEach(async () => {
      await buildApp(); // no authenticatorProvider -> RejectingSocketAuthenticator
    });

    it('rejects every connection, proving fail-closed behaviour end to end', async () => {
      const ws = await openEngineIoSocket(port);
      // Even a token that would pass a real authenticator must still be rejected.
      ws.send('40{"token":"good-token"}');

      const closeEvent = await waitForClose(ws);

      expect(closeEvent).toBeDefined();
      expect(connectionTracker.activeConnections).toBe(0);
    });
  });

  describe('graceful shutdown', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('closes cleanly and disconnects live sockets without hanging', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"good-token"}');
      await waitForFrame(ws, (f) => f.startsWith('40'));

      const clientClosed = waitForClose(ws);

      // Promise.race doesn't cancel the loser: an uncleared timer here would
      // keep the process alive for the rest of its 5s even after app.close()
      // wins the race, which is itself exactly the kind of leaked handle
      // this test is trying to prove the *gateway* doesn't have.
      let timer: NodeJS.Timeout;
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('app.close() hung')), 5000);
      });
      try {
        await Promise.race([app!.close(), deadline]);
      } finally {
        clearTimeout(timer!);
      }
      app = undefined; // already closed; afterEach must not close it again

      await expect(clientClosed).resolves.toBeDefined();
    });
  });

  describe('WS4 presence: connect/activity over the real wire protocol', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('emits presence:update on connect (OFFLINE -> ONLINE) with a payload containing only userId and state', async () => {
      const ws = await openEngineIoSocket(port);
      const presenceUpdate = waitForFrame(ws, (f) => f.startsWith('42["presence:update"'));
      ws.send('40{"token":"good-token"}');

      const frame = await presenceUpdate;
      const [, payload] = JSON.parse(frame.slice(2)) as [string, Record<string, unknown>];
      expect(payload).toEqual({ userId: 'user-123', state: 'ONLINE' });
      expect(Object.keys(payload).sort()).toEqual(['state', 'userId']);

      const clientClosed = waitForClose(ws);
      ws.close();
      await clientClosed;
    });

    it('does not emit a duplicate presence:update for a presence:activity ping while already ONLINE', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"good-token"}');
      await waitForFrame(ws, (f) => f.startsWith('42["presence:update"'));

      let sawAnotherPresenceUpdate = false;
      const handler = (ev: MessageEvent): void => {
        if (String(ev.data).startsWith('42["presence:update"')) sawAnotherPresenceUpdate = true;
      };
      ws.addEventListener('message', handler);

      ws.send('42["presence:activity"]');
      // No further frame is expected; give the server a bounded window to
      // (incorrectly) emit one before asserting it didn't.
      await new Promise((resolve) => setTimeout(resolve, 150));
      ws.removeEventListener('message', handler);

      expect(sawAnotherPresenceUpdate).toBe(false);

      const clientClosed = waitForClose(ws);
      ws.close();
      await clientClosed;
    });
  });
});
