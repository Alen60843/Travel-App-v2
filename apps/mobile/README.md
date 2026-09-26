# TripWith Mobile (prototype)

Expo SDK 57 + React Native + Expo Router, inside the pnpm workspace as
`@tripwith/mobile`. App shell, navigation, theme, API client, and Firebase
email/password sign-in against the real TripWith API (7.2.1). Real Explore /
Event / Chat / Inbox data arrives in later steps.

## Run it

From the repository root:

```sh
pnpm install                                   # once, uses the workspace lockfile
cp apps/mobile/.env.example apps/mobile/.env.local
# edit EXPO_PUBLIC_API_URL (see below)
pnpm --filter @tripwith/mobile start           # builds @tripwith/shared, then starts Metro
```

Then:

- **Physical phone:** install **Expo Go** (it must support SDK 57), make sure the
  phone is on the same Wi-Fi as your computer, and scan the QR code.
- **Android emulator:** press `a` in the Metro terminal (`pnpm --filter @tripwith/mobile android`).
- **iOS simulator (macOS):** press `i` (`pnpm --filter @tripwith/mobile ios`).

If the phone cannot reach Metro over LAN (the QR code times out, e.g. on
guest/corporate Wi-Fi or Windows firewall rules), start with a tunnel instead:

```sh
pnpm --filter @tripwith/shared build && pnpm --filter @tripwith/mobile exec expo start --tunnel
```

This is the path verified on a physical iPhone with Expo Go. Tunnel mode needs
`@expo/ngrok`, which is a local **devDependency** of this app, so `pnpm install`
provides it and Expo CLI loads it from `apps/mobile/node_modules`. Without it,
Expo CLI tries to install ngrok globally, which does not work reliably on this
Windows/pnpm setup. It is a development tool only and is never bundled into
the app. The tunnel exposes only the Metro dev server; the app's API calls
still use `EXPO_PUBLIC_API_URL`.

## API URL (`EXPO_PUBLIC_API_URL`)

The base URL of the TripWith API **including the `/api` prefix** (routes are
`/api/v1/...`). Start the API and database first (`pnpm db:up`, then run the API).

| Where the app runs  | Value                                   |
|---------------------|-----------------------------------------|
| Physical phone (LAN) | `http://<your-computer-LAN-IP>:3000/api` |
| Physical phone (tunnel) | `https://<your-dev-tunnel-host>/api` |
| Android emulator    | `http://10.0.2.2:3000/api`              |
| iOS simulator       | `http://localhost:3000/api`             |

`localhost` on a phone means the phone itself, so the app deliberately has no
localhost default: if the value is missing or malformed, the **Me** tab shows
the configuration problem.

**Physical phone.** The Expo tunnel only tunnels **Metro** — it does not expose
the API. The API (`app.listen(PORT)`, no host argument) listens on all
interfaces, so on a network where devices can see each other use your LAN IP
(`ipconfig` on Windows, `ipconfig getifaddr en0` on macOS) and allow inbound
TCP 3000 in the Windows firewall. If LAN does not work (as with Metro on this
setup), run a **separate, development-only HTTPS tunnel to port 3000** with a
tunnel tool you already have (for example `ngrok http 3000` or
`cloudflared tunnel --url http://localhost:3000`) and set
`EXPO_PUBLIC_API_URL=https://<tunnel-host>/api`. That exposes your local API
to the internet while it runs: every TripWith endpoint still requires a valid
Firebase ID token, but only use it against local dev data and stop the tunnel
when you are done. Never commit a LAN IP or tunnel host.

CORS is not involved: the native app is not a browser, and the API's CORS
policy (permissive in development, disabled in production) only affects
browsers.

`EXPO_PUBLIC_*` values are compiled into the app bundle and readable by anyone
with the app. Never put secrets, tokens or credentials in them.

Restart Metro after changing `.env.local`.

## Sign-in (Firebase email/password)

The app signs in with the Firebase JS SDK (Auth persisted by Firebase in
AsyncStorage) and sends `Authorization: Bearer <Firebase ID token>` on every API
request. The API verifies the token with Firebase Admin, then maps
`firebase_uid` to an internal TripWith user. Signed-out users only see Login.

1. In the Firebase console (the **same project** as the API's
   `FIREBASE_PROJECT_ID`): enable **Authentication → Sign-in method →
   Email/Password**, add a **Web app**, and copy its `apiKey`, `authDomain`,
   `projectId` and `appId` into `EXPO_PUBLIC_FIREBASE_*` in `.env.local`.
2. The API needs its Firebase Admin settings (`FIREBASE_PROJECT_ID`, and
   locally `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`) in its own env —
   never in the mobile app.

### Dev account setup (no in-app sign-up yet)

A Firebase account is not yet a TripWith account. Until an onboarding screen
exists, a signed-in identity without a TripWith user sees **"No TripWith
account yet"** on the Me tab (`AUTH_ACCOUNT_NOT_PROVISIONED`). Provision a dev
account once through the API's existing `POST /v1/auth/provision`, which
requires a **verified email**, an 18+ date of birth and the API's current
policy versions:

```sh
KEY=<EXPO_PUBLIC_FIREBASE_API_KEY>   API=<EXPO_PUBLIC_API_URL>
# 1. Create the user: Firebase console → Authentication → Users → Add user
#    (use an inbox you control).
# 2. Get an ID token, then send the verification email and click its link:
curl -s "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$KEY" \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"<password>","returnSecureToken":true}'   # -> idToken
curl -s "https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=$KEY" \
  -H 'Content-Type: application/json' -d '{"requestType":"VERIFY_EMAIL","idToken":"<idToken>"}'
# 3. After verifying, sign in again (step 2's first call) for a fresh idToken, then provision.
#    policyVersion values must equal the API's CURRENT_TOS_VERSION / CURRENT_PRIVACY_POLICY_VERSION.
curl -s -X POST "$API/v1/auth/provision" \
  -H "Authorization: Bearer <fresh idToken>" -H 'Content-Type: application/json' \
  -d '{"dateOfBirth":"1995-04-12","displayName":"Your Name","requiredConsents":[
        {"consentType":"TERMS_OF_SERVICE","policyVersion":"<CURRENT_TOS_VERSION>"},
        {"consentType":"PRIVACY_POLICY","policyVersion":"<CURRENT_PRIVACY_POLICY_VERSION>"}]}'
```

Then sign in on the phone: the Me tab shows **Connected to TripWith API** with
your display name from `GET /v1/me`.

## Demo data

Seed the local database with the Cusco demo (Rainbow Mountain FORMING, Humantay
Lake CONFIRMED, Cusco Sunset Meetup OPEN, a FULL cooking class):

```sh
pnpm --filter @tripwith/api db:seed:prototype
```

## Checks

```sh
pnpm --filter @tripwith/mobile typecheck
pnpm --filter @tripwith/mobile test           # Jest unit tests (auth core, API client, config)
pnpm --filter @tripwith/mobile config:check   # resolved public Expo config
```

## Layout

```
app/                    Expo Router routes
  _layout.tsx           providers (SafeArea, React Query, Auth) + auth-gated root stack
  login.tsx             email/password sign-in (signed-out only)
  (tabs)/               Explore · Travellers · Inbox · Me   (signed-in only)
  events/[eventId].tsx  reserved: Event Detail            (signed-in only)
  chat/[roomId].tsx     reserved: Chat Room               (signed-in only)
src/
  api/                  API client, error envelope + presentation, QueryClient, /v1/me
  auth/                 auth session core, Firebase adapter, AuthProvider
  config/               public env parsing (API URL, Firebase client config)
  components/           AppText, Screen, Card, loading/empty/error states
  domain/               app-level constants built on @tripwith/shared
  theme/                design tokens
```
