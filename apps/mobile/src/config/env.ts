/**
 * Public runtime configuration. EXPO_PUBLIC_* variables are inlined into the
 * JS bundle at build time and are readable by anyone holding the app, so this
 * module only ever reads PUBLIC, non-secret values.
 *
 * EXPO_PUBLIC_API_URL is the API base INCLUDING the global prefix, e.g.
 * http://192.168.1.50:3000/api — routes are then /v1/... . There is
 * deliberately no localhost fallback: on a physical phone "localhost" is the
 * phone itself, so a silent default would fail in a confusing way. A missing
 * or malformed value is reported as a configuration issue instead.
 */
export type ApiUrlConfig =
  | { readonly ok: true; readonly baseUrl: string }
  | { readonly ok: false; readonly issue: string };

export function parseApiUrl(raw: string | undefined): ApiUrlConfig {
  const value = raw?.trim();
  if (!value) {
    return {
      ok: false,
      issue: 'EXPO_PUBLIC_API_URL is not set. Copy apps/mobile/.env.example to .env.local.',
    };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, issue: `EXPO_PUBLIC_API_URL is not a valid URL: "${value}".` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, issue: 'EXPO_PUBLIC_API_URL must use http or https.' };
  }
  if (url.search || url.hash) {
    return { ok: false, issue: 'EXPO_PUBLIC_API_URL must not contain a query string or fragment.' };
  }
  return { ok: true, baseUrl: value.replace(/\/+$/, '') };
}

// Must be referenced as a literal `process.env.EXPO_PUBLIC_*` member for
// Expo's bundler to inline it.
export const apiUrlConfig: ApiUrlConfig = parseApiUrl(process.env.EXPO_PUBLIC_API_URL);
