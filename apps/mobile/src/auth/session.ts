import { firebaseConfig } from '../config/firebase-config';
import { createAuthSession, createUnavailableAuthSession, type AuthSession } from './auth-session';
import { createFirebaseAuthAdapter } from './firebase-adapter';

/**
 * The app's single auth session. Without Firebase client config there is no
 * way to sign in — the gate shows the configuration problem instead of ever
 * letting anyone into the app.
 */
export const authSession: AuthSession = firebaseConfig.ok
  ? createAuthSession(createFirebaseAuthAdapter(firebaseConfig.config))
  : createUnavailableAuthSession(firebaseConfig.issue);
