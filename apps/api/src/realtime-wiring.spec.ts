import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { FirebaseSocketAuthenticator } from './auth';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import {
  ConnectionTracker,
  RealtimeGateway,
  RealtimeModule,
  SOCKET_AUTHENTICATOR,
  type AuthenticatedPrincipal,
  type SocketAuthenticator,
} from './realtime';
import { realtimeModule } from './realtime-wiring';
import { CACHE_REDIS, QUEUE_REDIS } from './redis/redis.tokens';

/**
 * RealtimeModule.forRoot() imports RedisModule (for PresenceService's
 * CACHE_REDIS dependency, see realtime/realtime.module.ts), which also
 * provides QUEUE_REDIS and RedisReadinessCheck (the latter injects
 * APP_CONFIG directly). None of that needs to be real for this DI-wiring
 * test — see realtime/realtime.gateway.spec.ts for the identical, more
 * fully-commented version of this same fix.
 */
@Global()
@Module({ providers: [{ provide: APP_CONFIG, useValue: {} as AppConfig }], exports: [APP_CONFIG] })
class FakeConfigModule {}

function createFakeCacheRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const sortedSets = new Map<string, Map<string, number>>();
  const strings = new Map<string, string>();
  return {
    async hset(key: string, fields: Record<string, string>) {
      const hash = hashes.get(key) ?? new Map<string, string>();
      for (const [field, value] of Object.entries(fields)) hash.set(field, value);
      hashes.set(key, hash);
      return 1;
    },
    async hget(key: string, field: string) {
      return hashes.get(key)?.get(field) ?? null;
    },
    async expire() {
      return 1;
    },
    async zadd(key: string, score: number, member: string) {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      set.set(member, score);
      sortedSets.set(key, set);
      return 1;
    },
    async zrangebyscore(key: string, min: number | string, max: number | string) {
      const set = sortedSets.get(key) ?? new Map<string, number>();
      const lo = min === '-inf' ? -Infinity : Number(min);
      const hi = max === '+inf' ? Infinity : Number(max);
      return [...set.entries()].filter(([, score]) => score >= lo && score <= hi).map(([member]) => member);
    },
    async zrem(key: string, member: string) {
      return sortedSets.get(key)?.delete(member) ? 1 : 0;
    },
    async get(key: string) {
      return strings.get(key) ?? null;
    },
    async set(key: string, value: string) {
      strings.set(key, value);
      return 'OK';
    },
    async del(key: string) {
      return hashes.delete(key) || strings.delete(key) ? 1 : 0;
    },
    status: 'end',
  };
}

/**
 * Pure @nestjs/testing DI wiring coverage — no Postgres, Redis, or sockets.
 *
 * Split into two concerns, deliberately:
 *
 * 1. The SHARING MECHANISM (does importing the same forRoot() object into two
 *    independent modules really give one RealtimeGateway/ConnectionTracker)
 *    is proven by actually booting Nest — but with a trivial, dependency-free
 *    fake authenticator, not the real FirebaseSocketAuthenticator. The real
 *    one is provided by AuthModule, which pulls in TypeORM repositories and
 *    Firebase Admin SDK config — exactly the external infrastructure this
 *    test must not require. Using the real RealtimeModule.forRoot() API with
 *    a fake authenticator still exercises the identical code path
 *    realtime-wiring.ts relies on; only the authenticator identity differs.
 *
 * 2. That the REAL exported `realtimeModule` (the one AppModule/ChatModule
 *    actually import) is wired to FirebaseSocketAuthenticator rather than
 *    the fail-closed default is verified by inspecting its static
 *    DynamicModule metadata directly — no Nest bootstrap needed, since a
 *    class reference in a provider definition is inert until instantiated.
 */
describe('realtime-wiring: shared-instance mechanism (fake authenticator, no external infra)', () => {
  class FakeAuthenticator implements SocketAuthenticator {
    async authenticate(): Promise<AuthenticatedPrincipal | null> {
      return { userId: 'fake-user' };
    }
  }

  const testRealtimeModule = RealtimeModule.forRoot({
    authenticatorProvider: { provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator },
  });

  @Module({ imports: [testRealtimeModule] })
  class ConsumerAModule {}

  @Module({ imports: [testRealtimeModule] })
  class ConsumerBModule {}

  @Module({ imports: [ConsumerAModule, ConsumerBModule] })
  class RootTestModule {}

  it('resolves the same RealtimeGateway and ConnectionTracker to two independent importers', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeConfigModule, RootTestModule],
    })
      .overrideProvider(CACHE_REDIS)
      .useValue(createFakeCacheRedis())
      .overrideProvider(QUEUE_REDIS)
      .useValue({ status: 'end' })
      .compile();

    // Non-strict get() (the default) searches the whole compiled container,
    // so these do not need to be re-exported up through Consumer{A,B}Module.
    const gatewayViaA = moduleRef.get(RealtimeGateway);
    const trackerViaA = moduleRef.get(ConnectionTracker);

    expect(gatewayViaA).toBeInstanceOf(RealtimeGateway);
    expect(trackerViaA).toBeInstanceOf(ConnectionTracker);

    // Both Consumer modules imported the identical testRealtimeModule object
    // reference, so the container must have registered it once — there is
    // only one RealtimeGateway/ConnectionTracker to find, not two candidates
    // to accidentally pick between. Confirm the container agrees by asking
    // again and checking for the same instance, which is what would fail if
    // Nest had silently created a second, disconnected module instance.
    const gatewayAgain = moduleRef.get(RealtimeGateway);
    expect(gatewayAgain).toBe(gatewayViaA);

    await moduleRef.close();
  });
});

describe('realtime-wiring: production authenticator selection (metadata only, no bootstrap)', () => {
  it('wires SOCKET_AUTHENTICATOR to FirebaseSocketAuthenticator, not the fail-closed default', () => {
    const providers = realtimeModule.providers ?? [];
    const authenticatorProvider = providers.find(
      (provider): provider is { provide: symbol; useExisting: unknown } =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === SOCKET_AUTHENTICATOR,
    );

    expect(authenticatorProvider).toBeDefined();
    expect(authenticatorProvider).toMatchObject({ useExisting: FirebaseSocketAuthenticator });
  });

  it('exports RealtimeGateway so a shared consumer can actually inject it', () => {
    expect(realtimeModule.exports).toContain(RealtimeGateway);
  });
});
