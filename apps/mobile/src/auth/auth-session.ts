/**
 * Framework-free auth core. Firebase is the only authority for identity and
 * ID tokens: this module never stores a token, never fabricates a user, and
 * has no bypass. It turns Firebase's user stream into a small state machine
 * that the React layer (AuthProvider) and the API client both read.
 */

export interface AuthUser {
  readonly uid: string;
  readonly email: string | null;
}

export type AuthState =
  | { readonly status: 'initializing' }
  | { readonly status: 'signed_out' }
  | { readonly status: 'signed_in'; readonly user: AuthUser }
  /** Firebase client config is missing: nobody can sign in, and nothing is bypassed. */
  | { readonly status: 'unavailable'; readonly issue: string };

/** The only Firebase surface the app depends on (implemented in firebase-adapter.ts). */
export interface AuthAdapter {
  /** Emits the current user (or null) now and on every change; returns an unsubscribe. */
  onUserChanged(listener: (user: AuthUser | null) => void): () => void;
  signInWithEmailPassword(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** A current Firebase ID token for the signed-in user (Firebase refreshes it), or null. */
  getIdToken(): Promise<string | null>;
}

export type AuthRoute = 'loading' | 'login' | 'app' | 'config-error';

/** Which part of the app the gate may show. Only a real Firebase user reaches 'app'. */
export function resolveAuthRoute(state: AuthState): AuthRoute {
  switch (state.status) {
    case 'initializing':
      return 'loading';
    case 'signed_out':
      return 'login';
    case 'signed_in':
      return 'app';
    case 'unavailable':
      return 'config-error';
  }
}

export class SignInInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInInputError';
  }
}

export interface AuthSession {
  getState(): AuthState;
  subscribe(listener: () => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  /** Token provider for the API client: null whenever nobody is signed in. */
  getIdToken(): Promise<string | null>;
}

export function createUnavailableAuthSession(issue: string): AuthSession {
  const state: AuthState = { status: 'unavailable', issue };
  const refuse = () => Promise.reject(new SignInInputError(issue));
  return {
    getState: () => state,
    subscribe: () => () => undefined,
    signIn: refuse,
    signOut: () => Promise.resolve(),
    getIdToken: () => Promise.resolve(null),
  };
}

export function createAuthSession(adapter: AuthAdapter): AuthSession {
  let state: AuthState = { status: 'initializing' };
  const listeners = new Set<() => void>();

  adapter.onUserChanged((user) => {
    state = user ? { status: 'signed_in', user } : { status: 'signed_out' };
    listeners.forEach((listener) => listener());
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signIn(email, password) {
      const trimmedEmail = email.trim();
      if (!trimmedEmail || !password) throw new SignInInputError('Enter your email and password.');
      // State changes only through onUserChanged — i.e. only once Firebase
      // itself reports the signed-in user.
      await adapter.signInWithEmailPassword(trimmedEmail, password);
    },
    signOut: () => adapter.signOut(),
    getIdToken: () => (state.status === 'signed_in' ? adapter.getIdToken() : Promise.resolve(null)),
  };
}

const FIREBASE_AUTH_MESSAGES: Readonly<Record<string, string>> = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'Email or password is incorrect.',
  'auth/invalid-email': 'That email address is not valid.',
  'auth/missing-password': 'Enter your password.',
  'auth/user-disabled': 'This account has been disabled.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/network-request-failed': 'No connection to Firebase. Check your network and try again.',
  'auth/operation-not-allowed': 'Email/password sign-in is not enabled for this Firebase project.',
};

/** A user-facing sign-in error message. Never echoes credentials. */
export function describeAuthError(error: unknown): string {
  if (error instanceof SignInInputError) return error.message;
  const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
  return (typeof code === 'string' && FIREBASE_AUTH_MESSAGES[code]) || 'Sign-in failed. Please try again.';
}
