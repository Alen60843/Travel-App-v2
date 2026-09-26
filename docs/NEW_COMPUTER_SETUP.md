# New Computer Setup: TripWith

This is the step-by-step way to restore TripWith development on a fresh machine. Read `docs/PROJECT_HANDOFF_SHAHAF.md` first for context.
Secrets are **never** in Git. See `docs/LOCAL_SECRETS_RESTORE_CHECKLIST.md` for every env var name and where to get it.

The commands assume **Git Bash** on Windows (the repo's scripts use `bash`, `cp`, and `mkdir -p`). They also work in macOS/Linux shells.

---

## 1. Install the tools

| Tool | Version / note |
|---|---|
| Git | any recent version |
| Node.js | **≥ 20.11** (root `package.json` `engines`). The last machine used **v24.19.0**. An LTS (22.x or 24.x) is fine. |
| pnpm | **9.12.0** exactly (`packageManager` field). Easiest: `corepack enable && corepack prepare pnpm@9.12.0 --activate`, or `npm i -g pnpm@9.12.0` |
| Docker Desktop | for Postgres/PostGIS + two Redis containers |
| VS Code | optional, the editor used so far |
| Claude Code | CLI or VS Code extension. Sign in with Shahaf's account |
| Expo Go | on the iPhone (App Store). It must support **Expo SDK 57** |
| ngrok or cloudflared | *optional*, only if the phone can't reach the API over LAN (step 12) |

A host `psql` is **not** required. `db:verify` falls back to `docker exec` into the Postgres container.

## 2. Clone

```sh
git clone https://github.com/Alen60843/Travel-App-v2
cd Travel-App-v2
```

## 3. Check out `main` and check for 7.2.1

```sh
git checkout main
git log --oneline -5
git branch -a
ls apps/mobile/app/login.tsx apps/mobile/src/auth/   # 7.2.1 auth work — present?
```

If `login.tsx` / `src/auth/` are **missing**, the 7.2.1 auth work didn't reach GitHub. Look for another branch before you rewrite anything (handoff §7 lists the full file inventory).

## 4. Install dependencies

```sh
pnpm install
```

## 5. Start the infrastructure

Start Docker Desktop first, then:

```sh
pnpm db:up          # postgis 17-3.6 on :5432, redis-queue :6379, redis-cache :6380
docker ps           # expect infra-postgres-1, infra-redis-queue-1, infra-redis-cache-1 (healthy)
```

## 6. Restore the API env **before** migrating

`pnpm db:migrate` reads `apps/api/.env` (via `dotenv` in `data-source.ts`), so create it first:

```sh
cp apps/api/.env.example apps/api/.env
```

Then edit `apps/api/.env`. At a minimum for a local database:

- `DB_PASSWORD`: set it to the `POSTGRES_PASSWORD` value in `infra/docker-compose.yml` (a local-only Docker value).
- `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`: **any non-empty local placeholder**. They're required for the API to boot, but no object storage is used yet.
- `FIREBASE_PROJECT_ID`: the TripWith Firebase project ID (the same as the mobile `EXPO_PUBLIC_FIREBASE_PROJECT_ID`).
- `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY`: from a Firebase service-account key (needed for provisioning, see the checklist). Alternatively, use Google Application Default Credentials.

The full list is in `docs/LOCAL_SECRETS_RESTORE_CHECKLIST.md`.

## 7. Run migrations

```sh
pnpm db:migrate
```

Expect 7 migrations (InitialSchema … GroupFormationCapacityMin).

## 8. Verify

```sh
pnpm --filter @tripwith/api db:verify           # expect "118 passed, 0 failed" + concurrency PASS
./node_modules/.bin/turbo run typecheck --force  # expect 4/4 successful
pnpm --filter @tripwith/api test:unit            # expect 61 suites / 640 tests
pnpm --filter @tripwith/mobile test              # expect 27 tests (with 7.2.1 present)
```

Optional integration tests against the local Docker stack. They leave test fixtures in the dev DB:

```sh
TEST_DB_PORT=5432 TEST_DB_USER=tripwith TEST_DB_PASSWORD=<POSTGRES_PASSWORD from infra/docker-compose.yml> \
TEST_REDIS_QUEUE_URL=redis://localhost:6379 TEST_REDIS_CACHE_URL=redis://localhost:6380 \
pnpm --filter @tripwith/api test:integration     # expect 32 suites / 307 tests
```

`pnpm check:enums` **fails** on a known pre-existing issue (handoff §14). This is expected.

## 9. Restore the demo data

**Gotcha:** the seed's safety guard reads `DB_HOST` from the *shell environment*, before `apps/api/.env` is loaded. So export the API env into the shell first (Git Bash):

```sh
set -a; . apps/api/.env; set +a
pnpm --filter @tripwith/api db:seed:prototype
```

If sourcing the file fails (for example because of quoting in `FIREBASE_PRIVATE_KEY`), export just the DB variables instead: `DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME DB_SSL`.
Expected output lists Rainbow Mountain FORMING (7/8, needs 1), Humantay Lake CONFIRMED, Cusco Sunset Meetup OPEN, and Sacred Valley Cooking Class FULL. It's safe to rerun.

## 10. Restore the mobile env

```sh
cp apps/mobile/.env.example apps/mobile/.env.local
```

Fill in the four `EXPO_PUBLIC_FIREBASE_*` values from Firebase console → Project settings → Your apps → **TripWith Mobile** (Web app) → SDK config. Set `EXPO_PUBLIC_API_URL` in step 12.

**Don't expect `apps/mobile/.env.local` or `apps/api/.env` from Git.** Both are git-ignored.

## 11. Accounts

- **Expo:** `npx expo login` with Shahaf's Expo account (`shahaf123`). Log in to the same account in Expo Go on the iPhone.
- **Firebase:** open https://console.firebase.google.com with Shahaf's Google account and confirm the **TripWith** project is listed and opens.
- **GitHub:** confirm push access to `Alen60843/Travel-App-v2`.
- **Claude Code:** sign in, open the repo, and say: *"Read docs/PROJECT_HANDOFF_SHAHAF.md and continue."*

## 12. Run the API and give the phone a route to it

```sh
pnpm --filter @tripwith/api start:dev             # listens on PORT (3000), all interfaces
curl http://localhost:3000/health/ready            # dependencies OK?
```

Pick one way for the iPhone to reach the API, then put it in `apps/mobile/.env.local` (**never commit it**):

- **LAN:** find the IP with `ipconfig`, allow inbound TCP 3000 in the Windows Defender Firewall, and set `EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000/api`.
- **Dev tunnel:** `ngrok http 3000` (or `cloudflared tunnel --url http://localhost:3000`), then set `EXPO_PUBLIC_API_URL=https://<tunnel-host>/api`. Stop it when you're done.

The Expo tunnel (step 13) does **not** expose the API.

## 13. Start the mobile app

From the repo root, use the tunnel. It's the path verified on the iPhone, because LAN Metro timed out:

```sh
pnpm --filter @tripwith/shared build && pnpm --filter @tripwith/mobile exec expo start --tunnel --clear
```

The equivalent is `cd apps/mobile && npx expo start --tunnel --clear` (build `@tripwith/shared` first). On a network where LAN works, `pnpm --filter @tripwith/mobile start` is enough.
`--clear` makes sure the new `.env.local` values get inlined.

## 14. Verify on the physical iPhone

1. Scan the QR code with the iPhone camera, and it opens in Expo Go.
2. You should see the **TripWith Login** screen. If you see *"Sign-in is not configured"*, one of the `EXPO_PUBLIC_FIREBASE_*` values is missing.
3. Sign in with the Firebase test user. You should land on the tab shell.
4. Open the **Me** tab:
   - *Connected to TripWith API* + display name means **7.2 is proven**. Go to handoff §9.5 (commit and push).
   - *No TripWith account yet* means you need to provision the user (handoff §9.4 / `apps/mobile/README.md`).
   - *Session not accepted* means the API's `FIREBASE_PROJECT_ID` doesn't match the mobile project.
   - *Cannot reach TripWith* means `EXPO_PUBLIC_API_URL`, the firewall, or the tunnel is wrong.
