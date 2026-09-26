import { parseFirebaseConfig } from './firebase-config';

const complete = {
  EXPO_PUBLIC_FIREBASE_API_KEY: ' public-api-key ',
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'example-project',
  EXPO_PUBLIC_FIREBASE_APP_ID: '1:123:ios:abc',
};

describe('parseFirebaseConfig', () => {
  it('accepts a complete public client config (trimmed)', () => {
    expect(parseFirebaseConfig(complete)).toEqual({
      ok: true,
      config: {
        apiKey: 'public-api-key',
        authDomain: 'example.firebaseapp.com',
        projectId: 'example-project',
        appId: '1:123:ios:abc',
      },
    });
  });

  it('reports every missing or blank variable instead of guessing', () => {
    const result = parseFirebaseConfig({ ...complete, EXPO_PUBLIC_FIREBASE_API_KEY: '  ', EXPO_PUBLIC_FIREBASE_APP_ID: undefined });
    expect(result).toMatchObject({
      ok: false,
      missing: ['EXPO_PUBLIC_FIREBASE_API_KEY', 'EXPO_PUBLIC_FIREBASE_APP_ID'],
    });
    expect(result.ok ? '' : result.issue).toContain('apps/mobile/.env.local');
  });

  it('treats an empty environment as unconfigured', () => {
    expect(parseFirebaseConfig({})).toMatchObject({ ok: false });
  });
});
