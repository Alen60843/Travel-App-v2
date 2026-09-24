import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';

import { RedisModule } from '../redis/redis.module';
import { ConnectionTracker } from './connection-tracker.service';
import { PresenceService } from './presence.service';
import { RealtimeGateway } from './realtime.gateway';
import { RejectingSocketAuthenticator, SOCKET_AUTHENTICATOR } from './socket-authenticator';

export interface RealtimeModuleOptions {
  /**
   * Provider bound to SOCKET_AUTHENTICATOR. Omit to keep the fail-closed
   * default (`RejectingSocketAuthenticator`). Phase 3 supplies its Firebase
   * implementation here, e.g.:
   *
   *   RealtimeModule.forRoot({
   *     authenticatorProvider: {
   *       provide: SOCKET_AUTHENTICATOR,
   *       useClass: FirebaseSocketAuthenticator,
   *     },
   *   })
   */
  authenticatorProvider?: Provider;
}

/**
 * Socket.IO infrastructure shell: the gateway, the auth extension point, and
 * connection tracking. No chat/messaging/domain logic — see the module-level
 * comments in `realtime.gateway.ts` and `rooms.ts` for what is deliberately
 * left out and why.
 *
 * A dynamic module (`forRoot()`) rather than a plain `@Module` because the
 * authenticator is meant to be swapped by whichever phase implements real
 * verification. Nest module encapsulation means a sibling module cannot
 * silently override a provider declared inside this one — the composition
 * root (AppModule) has to pass the real provider in here explicitly, which
 * is exactly the point: it's an explicit decision at the wiring site, not an
 * implicit one a later import order could accidentally change.
 */
@Module({})
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions = {}): DynamicModule {
    const authenticatorProvider: Provider = options.authenticatorProvider ?? {
      provide: SOCKET_AUTHENTICATOR,
      useClass: RejectingSocketAuthenticator,
    };

    return {
      module: RealtimeModule,
      // RedisModule (static, not @Global()) is imported here explicitly:
      // sibling imports in AppModule do not share providers with each other,
      // so PresenceService's CACHE_REDIS dependency needs this module to
      // pull it in directly. RedisModule is a plain static module, so Nest
      // deduplicates this against AppModule's own RedisModule import by
      // class reference — no second Redis connection is created, same as
      // ChatModule/AuthModule/DatabaseModule already being imported from
      // multiple places in this app.
      imports: [RedisModule],
      // PresenceService sits alongside ConnectionTracker/RealtimeGateway
      // rather than in its own module: it needs CACHE_REDIS (imported by
      // whatever composes this module, same as elsewhere in the app — see
      // app.module.ts), and its connect/disconnect/heartbeat lifecycle is
      // driven directly by RealtimeGateway, exactly like ConnectionTracker's
      // already is. A separate presence module would need RealtimeGateway
      // injected back into it for delivery, which — since RealtimeGateway
      // would in turn need that module's PresenceService — is a circular
      // dependency for no benefit; RealtimeGateway already owns `server`
      // and can emit presence:update directly.
      providers: [authenticatorProvider, ConnectionTracker, PresenceService, RealtimeGateway],
      // RealtimeGateway is exported so a single shared instance of this
      // dynamic module (see ../realtime-wiring.ts) can be imported by more
      // than one feature module without instantiating a second gateway.
      // PresenceService is exported for the same forward-compatibility
      // reason, even though nothing outside realtime/ consumes it yet.
      exports: [SOCKET_AUTHENTICATOR, ConnectionTracker, PresenceService, RealtimeGateway],
    };
  }
}
