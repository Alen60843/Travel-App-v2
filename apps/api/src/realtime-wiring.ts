import type { DynamicModule } from '@nestjs/common';

import { FirebaseSocketAuthenticator } from './auth';
import { RealtimeModule, SOCKET_AUTHENTICATOR } from './realtime';

/**
 * The single, shared instantiation of RealtimeModule.forRoot(...).
 *
 * RealtimeModule is a dynamic module: it has no usable static form, so any
 * consumer must call forRoot() to get providers at all. Calling it a second
 * time (e.g. from ChatModule) would construct an entirely separate
 * DynamicModule — a second RealtimeGateway, a second ConnectionTracker, and
 * (without this exact authenticatorProvider) a second, fail-closed
 * SOCKET_AUTHENTICATOR silently coexisting with the real one. Nest does not
 * deduplicate two structurally-similar-but-distinct forRoot() calls.
 *
 * The fix is to call forRoot() exactly once, here, and have every consumer
 * (AppModule, ChatModule) import this same object reference. Importing one
 * shared value into two modules' `imports` arrays registers one graph node
 * reused twice, not two instantiations.
 *
 * This lives outside both realtime/ and chat/ deliberately: realtime/ is
 * documented as Firebase-agnostic infrastructure (the concrete authenticator
 * is "meant to be swapped by whichever phase implements real verification,"
 * wired in by the composition root — baking FirebaseSocketAuthenticator into
 * realtime/ itself would undo that), and putting it inside chat/ would make
 * chat the unlikely owner of an app-wide composition decision. A small
 * composition-root-adjacent file, sibling to app.module.ts, is the correct
 * home — and the one a future WS3 (EVENT chat, which also needs
 * RealtimeGateway) should reuse rather than inventing a second sharing
 * mechanism.
 */
export const realtimeModule: DynamicModule = RealtimeModule.forRoot({
  authenticatorProvider: {
    provide: SOCKET_AUTHENTICATOR,
    useExisting: FirebaseSocketAuthenticator,
  },
});
