# Local Secrets Restore Checklist

**This file only contains names, paths, status, and where to get values. It must never contain a real value.**
Both env files are git-ignored and are **lost when a machine is formatted**. Recreate them from the `.env.example` files and the sources below.

Status as of **2026-09-26** on the old machine. It was checked by name only, and no values were read into this document.

---

## `apps/mobile/.env.local`

Template: `apps/mobile/.env.example`. It's ignored by `apps/mobile/.gitignore`.
`EXPO_PUBLIC_*` values are compiled into the app bundle and are **public**. Never put server secrets here.

| Variable | Status | Where to recover / regenerate |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | **EMPTY, needs configuration** | Machine-specific: `http://<LAN-IP>:3000/api` or `https://<dev-tunnel-host>/api` (see NEW_COMPUTER_SETUP §12). Never commit it. |
| `EXPO_PUBLIC_FIREBASE_API_KEY` | SET | Firebase console → TripWith → Project settings → Your apps → **TripWith Mobile** (Web) → SDK config `apiKey` |
| `EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN` | SET | same place, `authDomain` |
| `EXPO_PUBLIC_FIREBASE_PROJECT_ID` | SET | same place, `projectId`. Must equal the API's `FIREBASE_PROJECT_ID`. |
| `EXPO_PUBLIC_FIREBASE_APP_ID` | SET | same place, `appId` |

Restart Metro with `--clear` after editing.

## `apps/api/.env`

Template: `apps/api/.env.example`. It's ignored by the root `.gitignore`.
**Status: the file exists but is identical to `.env.example`. It is NOT populated, and the API won't boot with it** (it fails validation on the S3 keys).

### Required to boot or to prove auth

| Variable | Status | Where to recover / regenerate |
|---|---|---|
| `NODE_ENV` | SET (example default) | `development` for local |
| `PORT` | SET | `3000` (the mobile URL assumes it) |
| `DB_HOST` | SET | local Docker: `localhost` |
| `DB_PORT` | SET | local Docker: `5432` |
| `DB_USER` | SET | `POSTGRES_USER` in `infra/docker-compose.yml` |
| `DB_PASSWORD` | **EMPTY, needs configuration** | `POSTGRES_PASSWORD` in `infra/docker-compose.yml` (local-only Docker value) |
| `DB_NAME` | SET | `POSTGRES_DB` in `infra/docker-compose.yml` |
| `DB_SSL` | SET | `false` locally |
| `REDIS_QUEUE_URL` | SET | local Docker: redis-queue on port 6379 |
| `REDIS_CACHE_URL` | SET | local Docker: redis-cache on port 6380 |
| `CURRENT_TOS_VERSION` | SET (example value) | Server-owned policy version. Provisioning must send exactly this value. |
| `CURRENT_PRIVACY_POLICY_VERSION` | SET (example value) | Same as above |
| `FIREBASE_PROJECT_ID` | **PLACEHOLDER, needs configuration** | The TripWith Firebase project ID (Firebase console → Project settings → General) |
| `FIREBASE_CLIENT_EMAIL` | **EMPTY, needs configuration** | Firebase console → Project settings → **Service accounts** → *Generate new private key* (JSON `client_email`). Alternative: Application Default Credentials, leaving both of these empty. |
| `FIREBASE_PRIVATE_KEY` | **EMPTY, needs configuration** | The same JSON's `private_key`, on one line with literal `\n`, quoted. **This is a real secret.** Never commit it, paste it into chat or issues, or put it in the mobile app. Store the JSON outside the repo, or regenerate it (and delete the old key in the console). |
| `S3_ACCESS_KEY_ID` | **EMPTY, needs configuration** | No storage is used yet. **Any non-empty local placeholder** lets the API boot. |
| `S3_SECRET_ACCESS_KEY` | **EMPTY, needs configuration** | Same as above |

### Other variables in `.env.example` (example defaults are fine locally)

| Variable | Status | Note |
|---|---|---|
| `API_PREFIX`, `API_DEFAULT_VERSION` | SET | `api` / `1`, so routes are `/api/v1/...` |
| `SHUTDOWN_TIMEOUT_MS`, `DEPENDENCY_CHECK_TIMEOUT_MS`, `BODY_LIMIT` | SET | defaults |
| `DB_SSL_CA` | EMPTY | only for production TLS |
| `DB_SSL_INSECURE_LOCAL`, `DB_LOGGING`, `DB_POOL_MAX` | SET | defaults |
| `QUEUE_PREFIX` | SET | default |
| `OUTBOX_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS` | SET | defaults |
| `MATCHING_ANCHOR_RADIUS_KM`, `MATCHING_PAIR_DESTINATION_WEIGHT`, `MATCHING_PAIR_TEMPORAL_WEIGHT`, `MATCHING_PAIR_GEOGRAPHIC_WEIGHT`, `MATCHING_BREADTH_BETA`, `MATCHING_CANDIDATE_CAP`, `MATCHING_MAX_PAGE_SIZE`, `MATCHING_FEED_TTL_SECONDS` | SET | defaults (the weights must sum to 1) |
| `MATCHING_CURSOR_SECRET` | EMPTY | Optional in development, **required (≥ 32 chars) in production**. Generate a random value if you use the matching feed. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | SET | local placeholders |
| `LOG_LEVEL`, `LOG_PRETTY`, `SERVICE_NAME` | SET | defaults |

### Shell-only variables (not in `.env`)

| Variable | Used by | Note |
|---|---|---|
| `DB_HOST` (and the other `DB_*`) exported in the shell | `db:seed:prototype` | The seed guard reads the shell env before `.env` loads (NEW_COMPUTER_SETUP §9) |
| `PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB` | seed | Leave it unset. Only for a disposable non-local dev DB. |
| `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD`, `TEST_REDIS_QUEUE_URL`, `TEST_REDIS_CACHE_URL` | `test:integration` | Point the integration tests at the local Docker stack (NEW_COMPUTER_SETUP §8) |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PG_CONTAINER` | `db:verify` | Optional. The defaults match the local Docker stack. |

---

## Accounts (no credentials stored anywhere in the repo)

| Service | Identity | Recovery |
|---|---|---|
| GitHub | repo `Alen60843/Travel-App-v2` | Shahaf's GitHub account |
| Firebase | project **TripWith** | Shahaf's Google account (owner) |
| Expo | account `shahaf123` | Shahaf's Expo login |
| Firebase test user | email/password user in Firebase Auth | Reset its password in the Firebase console if you don't know it. **Never write the password into the repo.** |

## Before wiping a machine

- [ ] Commit and push all code (check `git status` is clean, or push a WIP branch).
- [ ] Don't copy `.env` files into the repo. Recreate them from this checklist instead.
- [ ] If you're keeping a service-account JSON, move it to a password manager or secure storage outside the repo. Otherwise plan to regenerate it.
