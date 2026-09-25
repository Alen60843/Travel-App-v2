# TripWith Mobile (prototype)

Expo SDK 57 + React Native + Expo Router, inside the pnpm workspace as
`@tripwith/mobile`. This is the 7.1 foundation: app shell, navigation, theme,
config and API-client foundation. Sign-in and real data arrive in later steps.

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
| Physical phone      | `http://<your-computer-LAN-IP>:3000/api` |
| Android emulator    | `http://10.0.2.2:3000/api`              |
| iOS simulator       | `http://localhost:3000/api`             |

`localhost` on a phone means the phone itself, so the app deliberately has no
localhost default: if the value is missing or malformed, the **Me** tab shows
the configuration problem. Find your LAN IP with `ipconfig` (Windows) or
`ipconfig getifaddr en0` (macOS). The API must listen on all interfaces and
your firewall must allow port 3000.

`EXPO_PUBLIC_*` values are compiled into the app bundle and readable by anyone
with the app. Never put secrets, tokens or credentials in them.

Restart Metro after changing `.env.local`.

## Demo data

Seed the local database with the Cusco demo (Rainbow Mountain FORMING, Humantay
Lake CONFIRMED, Cusco Sunset Meetup OPEN, a FULL cooking class):

```sh
pnpm --filter @tripwith/api db:seed:prototype
```

## Checks

```sh
pnpm --filter @tripwith/mobile typecheck
pnpm --filter @tripwith/mobile config:check   # resolved public Expo config
```

## Layout

```
app/                    Expo Router routes
  _layout.tsx           providers (SafeArea, React Query) + root stack
  (tabs)/               Explore · Travellers · Inbox · Me
  events/[eventId].tsx  reserved: Event Detail
  chat/[roomId].tsx     reserved: Chat Room
src/
  api/                  fetch-based API client, error envelope, QueryClient
  config/               public env parsing (EXPO_PUBLIC_API_URL)
  components/           AppText, Screen, Card, loading/empty/error states
  domain/               app-level constants built on @tripwith/shared
  theme/                design tokens
```
