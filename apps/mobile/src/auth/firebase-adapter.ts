import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  type Auth,
  getAuth,
  getReactNativePersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';

import type { FirebaseClientConfig } from '../config/firebase-config';
import type { AuthAdapter } from './auth-session';

let cachedAuth: Auth | null = null;

/**
 * Initializes the Firebase app and Auth exactly once. Auth uses Firebase's own
 * React Native persistence (AsyncStorage), so the signed-in user survives app
 * restarts; Firebase — not this app — stores and refreshes the session. On a
 * Fast Refresh re-evaluation Auth is already initialized, so reuse it.
 */
function firebaseAuth(config: FirebaseClientConfig): Auth {
  if (cachedAuth) return cachedAuth;
  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  try {
    cachedAuth = initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'auth/already-initialized') throw error;
    cachedAuth = getAuth(app);
  }
  return cachedAuth;
}

export function createFirebaseAuthAdapter(config: FirebaseClientConfig): AuthAdapter {
  const auth = firebaseAuth(config);
  return {
    onUserChanged: (listener) =>
      onAuthStateChanged(auth, (user) => listener(user ? { uid: user.uid, email: user.email } : null)),
    signInWithEmailPassword: async (email, password) => {
      await signInWithEmailAndPassword(auth, email, password);
    },
    signOut: () => signOut(auth),
    // getIdToken() returns Firebase's cached token and refreshes it when it is
    // close to expiry; nothing is cached on our side.
    getIdToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
  };
}
