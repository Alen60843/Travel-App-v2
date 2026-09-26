/**
 * Firebase WEB/client configuration for the mobile app. These values are
 * public identifiers (they ship inside every Firebase client app), NOT server
 * secrets — but they are still supplied through EXPO_PUBLIC_* environment
 * variables, never committed. The Firebase Admin credentials (service account
 * email/private key) belong to the API only and must never appear here.
 */
export interface FirebaseClientConfig {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly appId: string;
}

export type FirebaseConfigResult =
  | { readonly ok: true; readonly config: FirebaseClientConfig }
  | { readonly ok: false; readonly issue: string; readonly missing: readonly string[] };

export interface FirebaseEnv {
  readonly EXPO_PUBLIC_FIREBASE_API_KEY?: string | undefined;
  readonly EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN?: string | undefined;
  readonly EXPO_PUBLIC_FIREBASE_PROJECT_ID?: string | undefined;
  readonly EXPO_PUBLIC_FIREBASE_APP_ID?: string | undefined;
}

const REQUIRED: readonly (keyof FirebaseEnv)[] = [
  'EXPO_PUBLIC_FIREBASE_API_KEY',
  'EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'EXPO_PUBLIC_FIREBASE_PROJECT_ID',
  'EXPO_PUBLIC_FIREBASE_APP_ID',
];

export function parseFirebaseConfig(env: FirebaseEnv): FirebaseConfigResult {
  const value = (key: keyof FirebaseEnv) => env[key]?.trim() ?? '';
  const missing = REQUIRED.filter((key) => value(key) === '');
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      issue: `Firebase is not configured: set ${missing.join(', ')} in apps/mobile/.env.local.`,
    };
  }
  return {
    ok: true,
    config: {
      apiKey: value('EXPO_PUBLIC_FIREBASE_API_KEY'),
      authDomain: value('EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN'),
      projectId: value('EXPO_PUBLIC_FIREBASE_PROJECT_ID'),
      appId: value('EXPO_PUBLIC_FIREBASE_APP_ID'),
    },
  };
}

// Each variable must be referenced as a literal `process.env.EXPO_PUBLIC_*`
// member for Expo's bundler to inline it.
export const firebaseConfig: FirebaseConfigResult = parseFirebaseConfig({
  EXPO_PUBLIC_FIREBASE_API_KEY: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  EXPO_PUBLIC_FIREBASE_APP_ID: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
});
