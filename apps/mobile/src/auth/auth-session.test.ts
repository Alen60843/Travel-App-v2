import {
  createAuthSession,
  createUnavailableAuthSession,
  describeAuthError,
  resolveAuthRoute,
  SignInInputError,
  type AuthAdapter,
  type AuthUser,
} from './auth-session';

/** A controllable stand-in for Firebase: the test decides when a user appears. */
function fakeAdapter() {
  let emit: (user: AuthUser | null) => void = () => undefined;
  const adapter: AuthAdapter & { emit(user: AuthUser | null): void } = {
    onUserChanged: jest.fn((listener) => {
      emit = listener;
      return () => undefined;
    }),
    signInWithEmailPassword: jest.fn().mockResolvedValue(undefined),
    signOut: jest.fn().mockResolvedValue(undefined),
    getIdToken: jest.fn().mockResolvedValue('firebase-id-token'),
    emit: (user) => emit(user),
  };
  return adapter;
}

const USER: AuthUser = { uid: 'firebase-uid-1', email: 'traveller@example.com' };

describe('auth session state', () => {
  it('starts initializing, then follows Firebase: signed out -> signed in -> signed out', () => {
    const adapter = fakeAdapter();
    const session = createAuthSession(adapter);
    const changes = jest.fn();
    session.subscribe(changes);

    expect(session.getState()).toEqual({ status: 'initializing' });
    adapter.emit(null);
    expect(session.getState()).toEqual({ status: 'signed_out' });
    adapter.emit(USER);
    expect(session.getState()).toEqual({ status: 'signed_in', user: USER });
    adapter.emit(null);
    expect(session.getState()).toEqual({ status: 'signed_out' });
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('signs in through Firebase only, and only Firebase can make the user signed in', async () => {
    const adapter = fakeAdapter();
    const session = createAuthSession(adapter);
    adapter.emit(null);

    await session.signIn('  traveller@example.com ', 'correct horse');
    expect(adapter.signInWithEmailPassword).toHaveBeenCalledWith('traveller@example.com', 'correct horse');
    // A resolved sign-in call alone never flips state: Firebase must report the user.
    expect(session.getState()).toEqual({ status: 'signed_out' });
  });

  it('rejects empty credentials without calling Firebase', async () => {
    const adapter = fakeAdapter();
    const session = createAuthSession(adapter);
    await expect(session.signIn(' ', 'x')).rejects.toBeInstanceOf(SignInInputError);
    await expect(session.signIn('a@b.co', '')).rejects.toBeInstanceOf(SignInInputError);
    expect(adapter.signInWithEmailPassword).not.toHaveBeenCalled();
  });

  it('signs out through Firebase', async () => {
    const adapter = fakeAdapter();
    const session = createAuthSession(adapter);
    adapter.emit(USER);
    await session.signOut();
    expect(adapter.signOut).toHaveBeenCalledTimes(1);
  });
});

describe('API token provider', () => {
  it('returns no token while initializing or signed out, so no Authorization header is sent', async () => {
    const adapter = fakeAdapter();
    const session = createAuthSession(adapter);
    await expect(session.getIdToken()).resolves.toBeNull();
    adapter.emit(null);
    await expect(session.getIdToken()).resolves.toBeNull();
    expect(adapter.getIdToken).not.toHaveBeenCalled();
  });

  it('asks Firebase for a current ID token when signed in (never caches it itself)', async () => {
    const adapter = fakeAdapter();
    const session = createAuthSession(adapter);
    adapter.emit(USER);
    await expect(session.getIdToken()).resolves.toBe('firebase-id-token');
    await session.getIdToken();
    expect(adapter.getIdToken).toHaveBeenCalledTimes(2);
  });
});

describe('auth gate routing', () => {
  it('maps each state to exactly one area; only a signed-in user reaches the app', () => {
    expect(resolveAuthRoute({ status: 'initializing' })).toBe('loading');
    expect(resolveAuthRoute({ status: 'signed_out' })).toBe('login');
    expect(resolveAuthRoute({ status: 'signed_in', user: USER })).toBe('app');
    expect(resolveAuthRoute({ status: 'unavailable', issue: 'x' })).toBe('config-error');
  });

  it('without Firebase config nobody can sign in and no token exists', async () => {
    const session = createUnavailableAuthSession('Firebase is not configured');
    expect(resolveAuthRoute(session.getState())).toBe('config-error');
    await expect(session.signIn('a@b.co', 'pw')).rejects.toThrow('Firebase is not configured');
    await expect(session.getIdToken()).resolves.toBeNull();
  });
});

describe('describeAuthError', () => {
  it.each([
    ['auth/invalid-credential', 'Email or password is incorrect.'],
    ['auth/invalid-email', 'That email address is not valid.'],
    ['auth/too-many-requests', 'Too many attempts. Wait a moment and try again.'],
    ['auth/network-request-failed', 'No connection to Firebase. Check your network and try again.'],
    ['auth/operation-not-allowed', 'Email/password sign-in is not enabled for this Firebase project.'],
  ])('maps %s to a user message', (code, message) => {
    expect(describeAuthError({ code })).toBe(message);
  });

  it('falls back to a generic message and never echoes input', () => {
    expect(describeAuthError(new Error('secret-password leaked?'))).toBe('Sign-in failed. Please try again.');
    expect(describeAuthError(new SignInInputError('Enter your email and password.'))).toBe('Enter your email and password.');
  });
});
