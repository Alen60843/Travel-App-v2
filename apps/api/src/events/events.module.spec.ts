import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { ChatRepository } from '../chat/chat.repository';
import { ConfigModule } from '../config/config.module';
import { CACHE_REDIS, QUEUE_REDIS } from '../redis/redis.tokens';
import { EventsModule } from './events.module';
import { JoinRequestsService } from './join-requests.service';

/**
 * Mechanically proves the real WS5 module graph resolves:
 *
 *   EventsModule -> ChatModule -> ChatRepository (exported) -> JoinRequestsService
 *
 * This compiles the ACTUAL EventsModule/ChatModule classes (not stand-ins)
 * through Nest's real DI container, so it fails the way production would if
 * someone:
 *   - removes ChatRepository from ChatModule.exports (JoinRequestsService's
 *     constructor injection becomes unresolvable -> compile() rejects)
 *   - removes ChatModule from EventsModule.imports (same failure mode)
 *   - introduces an EventsModule <-> ChatModule cycle (compile() rejects
 *     with a circular-dependency error; no forwardRef is used anywhere in
 *     this graph, so a cycle cannot silently resolve)
 *   - accidentally provides a second, competing ChatRepository somewhere in
 *     the graph (the identity assertion below would then fail, since the
 *     instance actually injected into JoinRequestsService would no longer
 *     be the same object moduleRef.get(ChatRepository) resolves to)
 *
 * Only genuinely external infrastructure is overridden (Postgres, Redis) —
 * DataSource because DatabaseModule's real TypeOrmModule.forRootAsync(...)
 * would otherwise attempt a real Postgres connection during compile(), and
 * CACHE_REDIS/QUEUE_REDIS for the same reason via ChatModule's realtimeModule
 * import (RealtimeModule.forRoot() -> RedisModule). Neither override touches
 * the EventsModule/ChatModule/ChatRepository/JoinRequestsService wiring
 * itself. ChatRepository is deliberately NOT provided directly in this test
 * module: it must come from the real ChatModule export, or this test proves
 * nothing about the wiring under review. This mirrors the existing
 * auth.module.spec.ts / realtime-wiring.spec.ts convention in this repo of
 * compiling real modules with only leaf infrastructure tokens overridden.
 */
describe('EventsModule wiring: WS5 EVENT chat integration', () => {
  function fakeDataSource() {
    return {
      options: { type: 'postgres' },
      isInitialized: true,
      entityMetadatas: [],
      // TypeOrmModule.forFeature(...)'s repository providers (used by both
      // EventsModule and AuthModule, which EventsModule/ChatModule import)
      // call dataSource.getRepository(entity) — no functional repository
      // behavior is needed for a pure wiring test, just a value to resolve.
      getRepository: () => ({}),
      query: async () => [],
      initialize: async function initialize() { return this; },
      destroy: async () => {},
    };
  }

  function fakeCacheRedis() {
    // Same minimal shape as realtime-wiring.spec.ts's fake: enough for
    // RedisLifecycleService's onModuleDestroy (status: 'end' short-circuits
    // closeRedisGracefully) without a real ioredis connection.
    return { status: 'end' };
  }

  it('resolves JoinRequestsService with a real ChatRepository obtained through ChatModule\'s export, not a stand-in', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, EventsModule],
    })
      .overrideProvider(getDataSourceToken())
      .useValue(fakeDataSource())
      .overrideProvider(CACHE_REDIS)
      .useValue(fakeCacheRedis())
      .overrideProvider(QUEUE_REDIS)
      .useValue(fakeCacheRedis())
      .compile();

    const joinRequests = moduleRef.get(JoinRequestsService);
    const chatRepository = moduleRef.get(ChatRepository);

    expect(joinRequests).toBeInstanceOf(JoinRequestsService);
    expect(chatRepository).toBeInstanceOf(ChatRepository);

    // JoinRequestsService's `chat` constructor param is TypeScript-private
    // only (compiled JS has no real field privacy), so this reads the exact
    // instance the real DI graph injected — proving it is the SAME
    // ChatRepository singleton the container resolves via ChatModule's
    // export, not merely "some instance of the right class" from an
    // accidental second provider elsewhere in the graph.
    expect((joinRequests as unknown as { chat: ChatRepository }).chat).toBe(chatRepository);

    await moduleRef.close();
  });
});
