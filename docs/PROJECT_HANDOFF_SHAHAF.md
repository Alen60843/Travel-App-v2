# READ THIS FIRST

| | |
|---|---|
| **Owner/operator** | Shahaf |
| **Canonical repository** | `Alen60843/Travel-App-v2` (https://github.com/Alen60843/Travel-App-v2) |
| **Branch** | `main` |
| **Last pushed baseline** | `9c559fd` (`9c559fd665688e670f0ece2d5d9b28a8a0c2392d`, *feat(mobile): add Expo prototype foundation*) |
| **Current working tree** | **Must be inspected.** Firebase Auth 7.2.1 was uncommitted when this handoff was written (see §7). |
| **Current mission** | Finish 7.2 authentication end-to-end **without losing the existing 7.2.1 implementation**. |
| **First action on a new machine** | Read this handoff before you change any code. Then read `docs/NEW_COMPUTER_SETUP.md` and `docs/LOCAL_SECRETS_RESTORE_CHECKLIST.md`. |

> **Warning about 7.2.1:** if you are reading a fresh clone and `apps/mobile/app/login.tsx`
> and `apps/mobile/src/auth/` do **not** exist, the 7.2.1 work never reached GitHub.
> Check the branch list (`git branch -a`, `git log --all --oneline`) before you rebuild anything.
> §7 lists every file in 7.2.1, so you can tell whether it is present.

# EXACT NEXT STEP

**The next task is not Explore.**

The exact next task:

1. Finish the Firebase and API local environment (`apps/api/.env`, `apps/mobile/.env.local`; see §10 and the secrets checklist).
2. Manually provision a dev TripWith account for the Firebase test user (§9.4).
3. Prove this chain on the **physical iPhone**:

```
Email/password login (Firebase JS SDK)
 → Firebase ID token
 → TripWith API (Authorization: Bearer <token>)
 → FirebaseAuthGuard + TripWithAuthGuard (firebase_uid → internal user)
 → GET /api/v1/me  → Me tab shows "Connected to TripWith API" + display name
```

4. Only after that works, commit and push the 7.2 auth work. Then continue to real Explorer integration (7.3).

To continue with Claude Code on a new machine, say: *"Read docs/PROJECT_HANDOFF_SHAHAF.md and continue."*

---

## Contents

0. [How to read this document (evidence labels)](#0-how-to-read-this-document)
1. [Product vision](#1-product-vision)
2. [Domain invariants](#2-domain-invariants)
3. [Group formation](#3-group-formation)
4. [Repository map and architecture](#4-repository-map-and-architecture)
5. [Backend implementation history (Steps 1–6)](#5-backend-implementation-history)
6. [Mobile history: 7.1 foundation](#6-mobile-history-71-foundation)
7. [Current uncommitted work: 7.2.1 Mobile Firebase Auth](#7-current-uncommitted-work-721)
8. [Backend auth architecture](#8-backend-auth-architecture)
9. [End-to-end auth status and blockers](#9-end-to-end-auth-status-and-blockers)
10. [Firebase cloud state and local env state](#10-firebase-cloud-state-and-local-env-state)
11. [Test and verification state](#11-test-and-verification-state)
12. [Deferred / not implemented](#12-deferred--not-implemented)
13. [Roadmap](#13-roadmap)
14. [Known pre-existing issues](#14-known-pre-existing-issues)
15. [Where else to look](#15-where-else-to-look)

---

## 0. How to read this document

Every factual claim carries one of these labels:

| Label | Meaning |
|---|---|
| **[VERIFIED]** | Checked directly against the repository, the local database, or a command run on 2026-09-26 while writing this handoff. |
| **[MANUAL/CLOUD]** | State that lives outside Git (Firebase console, Expo account, phone), as reported by Alen/Shahaf. It can't be checked from the repo. |
| **[UNVERIFIED]** | Believed true, but not proven. Verify it before you rely on it. |
| **[DEFERRED]** | Deliberately not implemented yet. |

Current vs historical: sections 5–6 describe committed history. Section 7 describes the working tree as it was on 2026-09-26. When code and this document disagree, **the code wins**. Update this document when that happens.

---

## 1. Product vision

TripWith is **not primarily a provider directory.** The core marketplace idea is:

> **WHAT to do + WHO to do it with + HOW to do it.**

- The user mainly discovers and joins an **activity**, which is a scheduled **session / Event**.
- **The Session/Event is the matching object.** People are matched *by joining the same thing*, not by browsing a catalogue of providers.
- A **provider** (for example a tour operator) *operates* the activity. A **user** can also host an informal Event, such as a meetup.
- The activity group itself creates:
  - social connection,
  - shared participation,
  - an **EVENT group chat**.

**Parties.** Travellers arrive as parties:

```
Party A = 4 people   (1 registered leader + 3 guests)
Party B = 3 people   (1 registered leader + 2 guests)
Party C = 2 people   (1 registered leader + 1 guest)
                     ───────────────────────────────
                     9 physical travellers, 3 TripWith accounts
```

- The **registered party leader** has a TripWith account, appears in the Event chat, and takes part in reputation/feedback.
- **Guests** take up physical seats. They **do not** become fake users, and they get **no chat identity and no reputation identity**.

There is also a separate, older **traveller↔traveller matching** feature (trips, feed, swipes, MATCH chat rooms). It was built in earlier phases and is still in the backend (`apps/api/src/matching`, `swipes`, `trips`). The current prototype focuses on Event/Session group formation. **[VERIFIED]** that the modules exist. Their product priority is **[MANUAL/CLOUD]**.

---

## 2. Domain invariants

### 2.1 Event membership lifecycle **[VERIFIED]** (code + commit messages `6daaf09`, `62273e9`, `0be4f91`)

1. An organizer creates an Event (`POST /v1/me/events`, starts as `DRAFT`, then `POST /v1/me/events/:id/publish`).
2. A traveller requests to join (`POST /v1/events/:eventId/join-requests`, body `{ message?, guestCount? }`).
3. The organizer approves or rejects if approval is required (`POST /v1/me/events/:eventId/join-requests/:requestId/approve|reject`). If it isn't required, the request is auto-approved.
4. An approved traveller becomes an **EventParticipant** (current membership).
5. A participant may leave **before `starts_at`** (`DELETE /v1/events/:eventId/membership`).
6. The organizer may remove a participant **before `starts_at`** (`DELETE /v1/me/events/:eventId/participants/:participantUserId`).
7. After the start, normal leave and remove are blocked.
8. Payment and refund behaviour is **[DEFERRED]**.

Key rules:

- **`JoinRequest` is historical decision evidence.** **`EventParticipant` is CURRENT membership.**
- A historical `APPROVED` JoinRequest **does not** mean current membership. Membership is only an ACTIVE `event_participants` row. When participation ends, the participant row records it (`EventParticipantCancellationReason`: `VOLUNTARY_LEAVE` / `HOST_REMOVAL`), and the JoinRequest stays `APPROVED` (see the comment in `packages/shared/src/enums.ts`).
- **Rejoining creates a new JoinRequest and a new EventParticipant.**
- **Only a `PENDING` JoinRequest is live.** An overdue PENDING request is reported as `EXPIRED` by the Event Detail read model.
- JoinRequest statuses: `PENDING, APPROVED, REJECTED, EXPIRED, CANCELLED (traveller withdrew), PAYMENT_FAILED`.
- **Chat membership is deactivated when participation ends.** `chat_members.left_at` is set (see `apps/api/src/chat/chat.repository.ts`, `SET left_at = now()`). A rejoin reactivates it (`ON CONFLICT … SET left_at = NULL`).
- Event status machine (`packages/shared/src/enums.ts`, mirrored by the DB trigger `tw_event_status_guard()`):
  `DRAFT→ACTIVE|FULL|CANCELLED`, `ACTIVE→FULL|IN_PROGRESS|CANCELLED`, `FULL→ACTIVE|IN_PROGRESS|CANCELLED`, `IN_PROGRESS→COMPLETED|CANCELLED`. `COMPLETED` and `CANCELLED` are terminal.
- A scheduler that moves Events to `IN_PROGRESS`/`COMPLETED` automatically is **[DEFERRED]**.

### 2.2 Payments **[VERIFIED]**

- Paid joining is **not implemented**. Any Event with `depositMinor > 0` is rejected with `409 PAID_JOIN_NOT_AVAILABLE` (`apps/api/src/events/join-requests.service.ts`). Event Detail reports the same code as `joinUnavailableReason`.
- Payment-backed cancellation and refunds are **[DEFERRED]**. The architecture spec describes the intended ordering (see `docs/superpowers/specs/…phase-1-design.md` §4.1), but it isn't built.
- Prototype pricing is a static per-person `price_minor`. There's no dynamic pricing.

### 2.3 Trust **[VERIFIED]** (modules `apps/api/src/trust`, `trust/traveller-feedback`)

| Direction | Mechanism | Route |
|---|---|---|
| Traveller → Provider | normal review | `POST /v1/events/:eventId/provider-review` |
| Provider → Traveller | review | `POST /v1/providers/:providerId/events/:eventId/travellers/:targetUserId/reviews` |
| Traveller → Traveller | **two-step feedback only** | `GET /v1/events/:eventId/traveller-feedback/candidates`, `POST /v1/events/:eventId/traveller-feedback` |

Traveller → traveller feedback works in two steps:

1. *Who did you actually travel with / spend the event with?* The candidates come from the Event's HOST and PARTICIPANT members.
2. For the selected travellers only: *"Would you travel with them again?"*, stored as `wouldTravelAgain: boolean`.

Not in scope: **no traveller stars, no public traveller trust score yet, no attendance inference, and no KYC, liveness check, or real phone OTP.**

### 2.4 Capacity and parties **[VERIFIED]** (commits `6daaf09`, `c42ff6f`; `apps/api/src/events`)

- A registered account can bring guests: `guestCount` is 0–9999 per request. *Alen + 2 guests* means 1 account and 3 physical seats.
- **`capacityMax` = total physical humans.** The ceiling is **10,000** (`@Max(10_000)` in the DTOs and service validation).
- A **USER host** occupies `1 + hostGuestCount` seats.
- A **PROVIDER host** occupies **0** seats. A provider session rejects a non-zero `hostGuestCount`, and a provider session starts with 0 reserved seats.
- **`participantCount`** = active registered participants/party leaders only.
- **`reservedSeatCount`** = physical occupancy. It's owned by **DB triggers**, and application code never writes it.
- Guests take capacity but have no user identity.
- `FULL` may still accept JoinRequests (they stay pending, which works like a manual waitlist). The owner-only endpoint `…/approve-with-capacity-override` exists and records immutable host-approval audit evidence.
- Concurrency: `pnpm db:verify` races 24 joiners against 4 free seats and proves no overbooking (§11).

### 2.5 Event management authorization **[VERIFIED]** (`apps/api/src/events/event-management.ts`)

- A USER-hosted Event is managed by `events.host_user_id`.
- A PROVIDER-hosted session is managed by `providers.owner_user_id` of its non-deleted Provider. Only the exact owner can manage it, and there are no co-hosts.
- An **unclaimed Provider** (`owner_user_id IS NULL`) matches nobody, so its sessions **fail closed**. Nobody can manage them, nobody can join them, and they aren't discoverable.
- The owner can't join their own session. The owner becomes the Event chat host member. The Provider row itself never joins chat.

---

## 3. Group formation

**Model:** `Provider → Session (Event) → Parties`. **[VERIFIED]**

`events.capacity_min` is nullable (NULL means no minimum). A check constraint (`events_capacity_min_chk`) enforces `1 ≤ capacity_min ≤ capacity_max`.

Derived state (`apps/api/src/events/event-group-state.ts`, `deriveEventGroupFormation`, **the one place this is decided**, and it's never persisted):

| `groupState` | Condition |
|---|---|
| `CANCELLED` | `status = CANCELLED` |
| `FULL` | `status = FULL` |
| `OPEN` | `status = ACTIVE` and `capacityMin == null` |
| `FORMING` | `status = ACTIVE` and `reservedSeatCount < capacityMin` |
| `CONFIRMED` | `status = ACTIVE` and `reservedSeatCount >= capacityMin` |
| `null` | DRAFT, IN_PROGRESS, COMPLETED (group formation doesn't apply) |

- `seatsToConfirm = max(capacityMin − reservedSeatCount, 0)`, and it's `null` when there's no minimum.
- **CONFIRMED can revert to FORMING** if participants leave before the start. It's derived on every read.
- Provider sessions start with 0 reserved seats.
- Pricing is a static per-person price. There's no dynamic pricing and no payment.

**Why it's derived and not stored:** `events.status` stays the only lifecycle state machine, and `reserved_seat_count` stays DB-owned. A stored group state would be a second source of truth that could drift.

---

## 4. Repository map and architecture

**[VERIFIED]** pnpm 9.12.0 workspace + Turborepo. Root `package.json` sets `"engines": { "node": ">=20.11" }`. The machine used for this handoff ran Node **v24.19.0**.

```
Travel-App-v2/
├── apps/
│   ├── api/                  @tripwith/api     NestJS 11 + TypeORM (hand-written SQL migrations) + PostgreSQL/PostGIS
│   │   ├── src/auth/          Firebase ID-token verification, TripWithAuthGuard, user resolver
│   │   ├── src/users/         POST /v1/auth/provision, GET/PATCH /v1/me, profile, interests, age rules
│   │   ├── src/consent/       /v1/me/consents (authenticated)
│   │   ├── src/events/        Events, provider sessions, join requests, membership, Event Detail, group state
│   │   ├── src/explorer/      /v1/explorer/events (map pins/clusters), /v1/explorer/event-cards
│   │   ├── src/chat/          chat rooms, messages, read-state, presence, Inbox read model
│   │   ├── src/trust/         reviews, moderation policy, attendance evidence, traveller feedback
│   │   ├── src/matching, swipes, trips/   traveller↔traveller matching (earlier phases)
│   │   ├── src/outbox, queue, redis, realtime/   transactional outbox → BullMQ, Socket.IO + Redis adapter
│   │   ├── src/database/      data-source.ts, entities, migrations (+ sql/*.up|down.sql), scripts (verify, seed, benchmarks)
│   │   └── test/setup-env.ts  test env defaults (see §11 for the local integration override)
│   └── mobile/               @tripwith/mobile  Expo SDK 57, React Native 0.86.3, Expo Router, TanStack Query
├── packages/shared/          @tripwith/shared  shared enums (EventStatus, JoinRequestStatus, …) + date helpers
├── infra/docker-compose.yml  postgis/postgis:17-3.6-alpine (5432), redis-queue (6379, noeviction), redis-cache (6380, allkeys-lru)
├── scripts/check-enum-parity.mjs   SQL enum ↔ TS enum drift check (known issue, §14)
└── docs/
    ├── PROJECT_HANDOFF_SHAHAF.md          (this file)
    ├── NEW_COMPUTER_SETUP.md
    ├── LOCAL_SECRETS_RESTORE_CHECKLIST.md
    └── superpowers/specs/2026-08-20-tripwith-phase-1-design.md   architecture spec + phase addenda (Phases 1–5)
```

The **API URL shape** is `http(s)://<host>:3000/api/v1/...`. `API_PREFIX=api`, URI versioning is v1, and `/health/live` and `/health/ready` sit outside the prefix. **[VERIFIED]** (`apps/api/src/main.ts`)

**Error envelope** (every API error): `{ "error": { code, message, correlationId, timestamp, details? } }`. **[VERIFIED]**

**Major architecture decisions and why they were made** (details in the spec):

- **Schema is hand-written SQL**, and TypeORM `synchronize` is off. That's because invariants such as append-only ledgers, capacity triggers, and trust triggers can't be expressed as entity decorators (`apps/api/src/database/data-source.ts`).
- **Counters are trigger-owned** (`reserved_seat_count`, `participant_count`). Concurrency safety lives in the DB, and application code can't break it.
- **Two Redis instances.** The queue needs `noeviction` and the cache needs `allkeys-lru`, which is a server-level setting (`infra/docker-compose.yml`).
- **Transactional outbox → BullMQ** for side effects, so a committed business action is never lost.
- **Firebase is the identity authority.** TripWith keeps its own `users` row linked by `users.firebase_uid`, so TripWith owns consent, age, and account status.
- **Mobile uses the Firebase JS SDK (Web app registration)** because the Expo Go prototype can't load native Firebase modules. This does **not** make TripWith web-only.

---

## 5. Backend implementation history

All commits are on `main` and pushed. **[VERIFIED]** (`git log`, commit messages, code).

Earlier history, for context:

| SHA | What |
|---|---|
| `66b9671` | Initial repository (Phases 1–5: architecture, DB, auth/users, trips/matching, explorer map) |
| `6daaf09` | Phase 8: Trust/Reviews, Chat, Guest Seats, presence, JoinRequest vs EventParticipant split |
| `62273e9` | Phase 8 closure sync (capacity snapshot, rollback hardening, rejoin/participant-row/chat read fixes, portable `db:verify`) |

Commits `6daaf09` and `62273e9` say they were synced from "the main TripWith repo" (`Travel-App`, branch `phase8/trust-reviews-design @ d53dafc`). Local multi-agent tooling (`tools/agent-orchestrator`) was deliberately excluded. **[UNVERIFIED]** whether Shahaf has access to that older repo. **`Travel-App-v2` is the canonical repo.**

### STEP 1: Group Formation Minimum Capacity. `6a2dc0d797ec7c05da8c1604928b2654c69a596b`

- Migration `1787788800000-GroupFormationCapacityMin`: optional `events.capacity_min` and `events_capacity_min_chk` (`1 ≤ capacity_min ≤ capacity_max`). The DOWN migration refuses to drop the column while any Event has a minimum.
- `EventView` gains `capacityMin`, a server-derived `groupState`, and `seatsToConfirm` (see §3). Create, update, and publish validate the `capacityMin`/`capacityMax` pair.
- It also fixed Jest 29 script flags. `test:unit` now really excludes int-specs, and `test:integration` really selects them.
- DB verification: `verify-invariants.sql` section 5c covers the constraint. The migration is applied locally (7/7 migrations in `schema_migrations`). **[VERIFIED]**

### STEP 2: Provider-owned Sessions. `c42ff6fa470930a100c25f3fbfc7205ac6c5caf5`

- Management authorization is centralised in `event-management.ts` (see §2.5).
- The provider owner can list, get, edit, publish, and cancel sessions, list, approve, and reject JoinRequests, use the capacity override, and remove participants before the start.
- **EVENT chat:** the owner becomes the chat host member. The Provider row never joins chat, and guests are headcount only.
- **An unclaimed provider fails closed.** Sessions without a manager can't be joined.
- **A provider host takes no capacity.** Provider sessions publish as ACTIVE, and a non-zero `hostGuestCount` is rejected.
- No schema changes. Tests: `provider-sessions.int-spec.ts` (Andes Adventures 4 + 3 + 2 → CONFIRMED).

### STEP 3: Traveller Event Detail. `0be4f9144d2f2cdd40d83b86e8c0eb1498cac804`

**`GET /v1/events/:eventId`.** This is the traveller-facing read model. The owner-only `GET /v1/me/events/:eventId` is unchanged.

- **Visibility:** the manager can always see the Event. DRAFT is visible to nobody else. An active participant or a live pending requester can see the Event in any later lifecycle state. **Strangers** only see PUBLIC ACTIVE/FULL Events that have a manager. An Event the viewer can't access answers **exactly like a missing one** (`EventNotFoundError`).
- **Response** `{ event, host, viewer }`:
  - `event`: public fields plus group formation (via `deriveEventGroupFormation`).
  - `host`: a safe summary. USER host gives profile display fields. PROVIDER host gives `id` + `name` and **never `owner_user_id`**.
  - `viewer`: `isManager`, `isParticipant` + `partySize` (from the ACTIVE participant row only), the latest `joinRequest` (overdue PENDING shows as EXPIRED), `canRequestToJoin`, and `joinUnavailableReason` ∈ `EVENT_NOT_JOINABLE | PAID_JOIN_NOT_AVAILABLE | EVENT_TRUST_REQUIRED`, which are the same codes the join endpoint returns. It also has **`primaryAction`** ∈ `MANAGE | OPEN_CHAT | AWAITING_APPROVAL | REQUEST_TO_JOIN | NONE`, and `chatRoomId`, which is only set for the manager or an active participant.
- **Join privacy closure:** an unrelated user can only request to join a PUBLIC, published Event. PRIVATE, UNLISTED, and DRAFT Events answer like a missing Event before any other check, and nothing is written.

### STEP 4: Chat Inbox. `334660a7a05cfeb6fdf82207a731b22b3467cb1e`

**`GET /v1/chat/rooms`** (the caller's Inbox) and **`GET /v1/chat/rooms/:roomId`** (room header). The existing send, history, sync, presence, and read routes are unchanged:
`POST /v1/chat/rooms/:roomId/messages`, `GET …/messages`, `GET …/sync`, `GET …/presence`, `PATCH …/read`.

- **Authorization is active membership only.** Rows start from the caller's `chat_members` rows with `left_at IS NULL`. Left or removed members, pending or historical-APPROVED requesters, and unrelated users never see a room. A non-member gets the same `ChatRoomNotFoundError` as a missing room.
- **EVENT and MATCH read model** in a single SQL statement with no N+1 queries. It uses a LATERAL for the latest visible message. EVENT rooms get a public host summary (a **provider EVENT header** shows the provider `id` + `name`, never the owner). MATCH rooms get the *other* traveller, resolved from the canonical `matches` row.
- `unreadCount = last_seq − last_read_seq`.
- Ordering: the latest visible message time (otherwise `joined_at`) DESC, then room id ASC.
- **Membership removal behaviour:** when participation ends, `left_at` is set and the room disappears from the Inbox immediately.

### STEP 5: Group Formation Discovery. `cd63caa0c15ba65a90b156b7827c92bf8a8d783a`

**`GET /v1/explorer/event-cards`**, which serves "groups forming near you".

- **Cards are separate from map pins** (`GET /v1/explorer/events` + `zoom` gives pins and clusters). Both take the same area, time-window, and category query.
- **One shared discoverability rule** (`EXPLORER_DISCOVERABLE_EVENT_SQL` in `explorer.repository.ts`) drives both, so **map and cards share the same population**:
  - `visibility = 'PUBLIC'`
  - `status IN ('ACTIVE','FULL')`
  - USER-hosted, **or** the Provider has a valid owner (`owner_user_id IS NOT NULL AND deleted_at IS NULL`)
  - `starts_at > :discoveryNow`
  - This intentionally changed the map: unclaimed-provider sessions and ACTIVE/FULL Events that already started are no longer shown as pins.
- **Card fields:** title, description, category, safe host summary, time, public meeting point, `capacityMin`/`capacityMax`, `reservedSeatCount`, `remainingSeats`, `participantCount`, `groupState`, `seatsToConfirm`, price, and `joinApprovalRequired`. There's **no roster, request, chat, payment, or viewer data** on cards.
- **Filters** (`ExplorerAreaQueryDto`): a bounding box (`south`, `west`, `north`, `east`) or a centre + `radiusMeters` (100–500,000), a time window, category codes (repeated query key), and `limit` 1–200.
- **Ordering:** `starts_at ASC, id ASC`, which is deterministic. `hasMore` comes from fetching one extra row. **There's no ranking.**
- **PostGIS:** `meeting_point` geography with an `ST_*` spatial predicate plus a `time_range && tstzrange(...)` overlap. Both are backed by indexes. The benchmark and EXPLAIN evidence are in spec §25 and `src/database/scripts/explorer-postgis-benchmark.sql`.

### STEP 6: Safe Local Prototype Seed. `c0a14946f2601958907013804239e2f67622f8d2`

**Command:** `pnpm --filter @tripwith/api db:seed:prototype`. **Read the env gotcha in `NEW_COMPUTER_SETUP.md` §8.** The safety guard reads `DB_HOST` from the *shell* before `apps/api/.env` is loaded.

Demo data: the **Andes Adventures** provider (owner "Mateo · Andes Adventures") and seed travellers Ana, Ben, Carla, Diego, Elif, Sofía, Lucas, and Farah. All ids start with `5eed0000-…`, and all Firebase uids start with `prototype-seed-`.

| Event | Host | State | Numbers |
|---|---|---|---|
| Rainbow Mountain (Vinicunca) | Andes Adventures (provider) | **FORMING** | reserved 7 (Ana 1+3, Ben 1+2), participantCount 2, min 8, max 12, seatsToConfirm 1 |
| Humantay Lake | Andes Adventures (provider) | **CONFIRMED** | reserved 11 (Carla 4, Diego 4, Elif 3), participantCount 3, min 10, max 14 |
| Cusco Sunset Meetup | USER | **OPEN** | no minimum, max 10 |
| Sacred Valley Cooking Class | USER | **FULL** | host party 2 + Farah party 2 = 4 of max 4 |

The Rainbow and Humantay numbers were confirmed in the local DB on 2026-09-26. **[VERIFIED]**

- **Safety guard:** it refuses `NODE_ENV=production`, a missing `DB_HOST`, and any non-local `DB_HOST` unless `PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB=true`. It runs **before** a DB connection opens. It never truncates.
- **Idempotent rerun:** each run deletes only the seed-owned rows (by fixed id **and** uid prefix, never by name) in one transaction, then recreates them with fresh future dates and stable ids.
- **Real domain logic:** provider sessions are inserted as DRAFT (there's no provider session-creation API yet) and then published through `EventsService`. Joins, auto-approval, FULL, chat rooms and members, and the welcome message all go through the real services. **Counters stay trigger-owned. No fake guest users are created.**
- Seed users have **no real Firebase accounts**, so you can't sign in as them from the phone.

---

## 6. Mobile history: 7.1 foundation

**Commit `9c559fd665688e670f0ece2d5d9b28a8a0c2392d` (pushed).** **[VERIFIED]**

- **Stack:** Expo SDK 57 (`expo ~57.0.25`), React Native 0.86.3, React 19.2.3, Expo Router (typed routes), TypeScript, TanStack Query 5, `@tripwith/shared` (workspace). **`@expo/ngrok` is a local devDependency** so `expo start --tunnel` works on Windows/pnpm.
- **Tabs:** Explore · Travellers · Inbox · Me (`apps/mobile/app/(tabs)/`). They're all **placeholders**. Explore shows copy driven by `EventStatus` from `@tripwith/shared` as a shared-package proof.
- **Reserved routes:** `events/[eventId]` and `chat/[roomId]` are placeholders only.
- **API config:** `EXPO_PUBLIC_API_URL` = the API base **including `/api`**. Route paths are `/v1/...`, so full URLs look like `/api/v1/...`. It's validated in `src/config/env.ts`, with **no localhost fallback** on purpose.
- **API client** (`src/api/client.ts`): `get`, `post`, `patch`, `delete`, JSON parsing, repeated-key query arrays, an injectable `getAuthToken` (bearer), and every failure becomes an `ApiError` (`src/api/errors.ts`) that parses the backend envelope. Client-side codes are `NETWORK_ERROR`, `INVALID_RESPONSE`, and `API_NOT_CONFIGURED`. The QueryClient doesn't retry 4xx responses.
- UI kit: `src/components` (AppText, Screen, Card, StateView) and `src/theme/tokens.ts`.

**Manual verification [MANUAL/CLOUD]:** 7.1 opened on a **physical iPhone** with **Expo Go + Expo tunnel**. The LAN Metro connection timed out on that network. The tunnel worked after `@expo/ngrok` was added locally. The Expo account is **`shahaf123`** (Shahaf's). No password is stored anywhere.

---

## 7. Current uncommitted work: 7.2.1

**State on 2026-09-26: uncommitted in the working tree on `main`, based on `9c559fd`.** **[VERIFIED]** (`git status`)

### 7.1 File inventory

Modified (tracked):

| File | Change |
|---|---|
| `apps/mobile/.env.example` | Adds the `EXPO_PUBLIC_FIREBASE_*` names, and documents the tunnel/LAN options and that Metro tunnel ≠ API tunnel |
| `apps/mobile/README.md` | Sign-in section, dev account provisioning recipe, physical phone API access, test command, updated layout |
| `apps/mobile/app/(tabs)/me.tsx` | Real `GET /v1/me` proof, error presentation, Sign out button, API URL developer card |
| `apps/mobile/app/_layout.tsx` | `AuthProvider` + `AuthGate` with `Stack.Protected` guards |
| `apps/mobile/package.json` | Adds `firebase ^12.19.0`, `@react-native-async-storage/async-storage 2.2.0`, dev `jest`, `ts-jest`, `@types/jest`, and a `test` script |
| `pnpm-lock.yaml` | Lockfile for the above |

New (untracked):

| File | Purpose |
|---|---|
| `apps/mobile/app/login.tsx` | Email + password Login screen. No sign-up and no demo credentials |
| `apps/mobile/jest.config.js` | ts-jest, node env, **pure modules only** (it never imports react-native, expo, or firebase) |
| `apps/mobile/src/auth/auth-session.ts` | Framework-free auth state machine, `resolveAuthRoute`, `describeAuthError` |
| `apps/mobile/src/auth/auth-session.test.ts` | Tests for the above |
| `apps/mobile/src/auth/firebase-adapter.ts` | Firebase JS SDK adapter: `initializeAuth` with `getReactNativePersistence(AsyncStorage)`, sign-in, sign-out, `getIdToken` |
| `apps/mobile/src/auth/firebase-auth-react-native.d.ts` | Type declaration for `getReactNativePersistence` (RN build export missing from the default typings) |
| `apps/mobile/src/auth/session.ts` | The app's single `authSession`, or the *unavailable* session if the config is missing |
| `apps/mobile/src/auth/AuthProvider.tsx` | React context via `useSyncExternalStore`. Sign-out clears the Query cache |
| `apps/mobile/src/config/firebase-config.ts` | Parses the 4 `EXPO_PUBLIC_FIREBASE_*` vars and reports missing ones by name |
| `apps/mobile/src/config/firebase-config.test.ts` | Tests |
| `apps/mobile/src/api/tripwith-api.ts` | The app-wide API client with `getAuthToken: () => authSession.getIdToken()` |
| `apps/mobile/src/api/me.ts` | `fetchMe` / `MeResponse` (subset of the API's `CurrentUserView`) |
| `apps/mobile/src/api/error-message.ts` | `presentApiError`: maps API error codes to screen copy |
| `apps/mobile/src/api/client.test.ts` | API client tests (URL building, bearer header, envelope parsing, network errors) |

Local-only, git-ignored, **not** part of the commit: `apps/mobile/.env.local` (see §10).

### 7.2 Behaviour

Auth state machine (`auth-session.ts`), which `resolveAuthRoute` maps to the gate in `_layout.tsx`:

| `AuthState.status` | Route | UI |
|---|---|---|
| `initializing` | `loading` | "Starting TripWith…" |
| `signed_out` | `login` | Login screen only |
| `signed_in` | `app` | Tab shell + Event/Chat routes |
| `unavailable` (Firebase config missing) | `config-error` | "Sign-in is not configured" card listing the missing var **names**. **No bypass.** |

- State changes **only** when Firebase's `onAuthStateChanged` fires. The app never fabricates a user or stores a token.
- Firebase persists the session in AsyncStorage, so it survives app restarts. Firebase refreshes ID tokens itself.
- Empty email or password is rejected locally. Firebase error codes map to safe messages that never echo credentials.

**Token flow:**

```
Firebase user (JS SDK, AsyncStorage persistence)
 → auth.currentUser.getIdToken()            (Firebase-cached, auto-refreshed)
 → tripwithApi request: Authorization: Bearer <token>
 → API FirebaseAuthGuard  (verifyIdToken, checkRevoked=false)
 → TripWithAuthGuard      (users.firebase_uid lookup → internal user, account status checks)
 → GET /v1/me → CurrentUserView
```

When nobody is signed in, no Authorization header is sent.

**Me tab** shows one of:
- *Connected to TripWith API* with the display name, email, account status, and onboarding completeness.
- *No TripWith account yet* (`AUTH_ACCOUNT_NOT_PROVISIONED`).
- *Session not accepted* (`AUTH_TOKEN_*`, including `AUTH_TOKEN_WRONG_AUDIENCE` when the mobile and API Firebase projects differ).
- *Cannot reach TripWith* (`API_NOT_CONFIGURED` / `NETWORK_ERROR`).
- A correlation id "Reference" when the API returns one.

**Deliberately absent:** sign-up and onboarding (see §8.3), social providers, and demo credentials.

### 7.3 Local verification of 7.2.1 **[VERIFIED]** (2026-09-26)

- `pnpm --filter @tripwith/mobile test`: **3 suites, 27/27 tests pass**
- `pnpm --filter @tripwith/mobile typecheck`: pass
- `npx expo install --check`: dependencies up to date
- `npx expo-doctor`: **21/21** checks pass
- **Not verified:** the real end-to-end chain on the phone (§9).

---

## 8. Backend auth architecture

**[VERIFIED]** (`apps/api/src/auth`, `apps/api/src/users`)

### 8.1 Request authentication

- Header: `Authorization: Bearer <Firebase ID token>` (`bearer-token.ts`: exactly one Bearer token).
- **`FirebaseAuthGuard`** verifies the token with Firebase Admin (`verifyIdToken(token, false)`, using cached Google signing keys and no account lookup). It attaches `firebaseIdentity`.
- **`TripWithAuthGuard`** runs FirebaseAuthGuard, then `TripWithUserResolver` maps the identity to the internal user. **`users.firebase_uid` is the bridge.**
- **`RevocationCheckedFirebaseAuthGuard`** (`checkRevoked=true`) is used only for provisioning.
- Error codes (`auth.errors.ts`):
  - 401: `AUTH_TOKEN_MISSING`, `AUTH_BEARER_MALFORMED`, `AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_REVOKED`, `AUTH_TOKEN_WRONG_AUDIENCE`
  - 403: **`AUTH_ACCOUNT_NOT_PROVISIONED`** (valid Firebase identity, no `users` row), `AUTH_ACCOUNT_INACTIVE|DEACTIVATED|DELETED|SUSPENDED|FULLY_SUSPENDED`
- Firebase Admin credentials (`firebase-admin.service.ts`): if both `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` are set, it uses a service-account `cert`. Otherwise it uses `applicationDefault()`. The project is always `FIREBASE_PROJECT_ID`.

### 8.2 Provisioning: `POST /api/v1/auth/provision`

It's guarded by `RevocationCheckedFirebaseAuthGuard`. Body (`ProvisionAccountDto`):

```json
{
  "dateOfBirth": "YYYY-MM-DD",
  "displayName": "2–50 chars",
  "requiredConsents": [
    { "consentType": "TERMS_OF_SERVICE", "policyVersion": "<CURRENT_TOS_VERSION>" },
    { "consentType": "PRIVACY_POLICY",   "policyVersion": "<CURRENT_PRIVACY_POLICY_VERSION>" }
  ]
}
```

Requirements, all enforced server-side: a **verified Firebase email** (otherwise `VerifiedEmailRequiredError`), **age eligibility (18+)**, which the DB also enforces, a **display name**, **Terms of Service and Privacy Policy consent**, and the **CURRENT server policy versions** (from the API env). Mismatched versions are rejected.

Proof endpoint: **`GET /api/v1/me`** returns `CurrentUserView` (`id, email, emailVerified, accountStatus, profile{displayName, avatarUrl}, onboarding{complete, missingRequirements}`, …).

### 8.3 Explicit product/backend gap: signup and onboarding

7.2.1 **deliberately does not build sign-up or onboarding.** Legitimate provisioning needs the *current* policy versions, and **no unauthenticated endpoint currently exposes them**. `/v1/me/consents` requires an already-provisioned user (`TripWithAuthGuard`). **[VERIFIED]** A mobile onboarding flow needs a backend decision first. For example, a public `GET /v1/policies/current` (or an endpoint guarded only by Firebase) that returns the current ToS and Privacy versions and their text. Until then, dev accounts are provisioned manually (§9.4).

---

## 9. End-to-end auth status and blockers

**7.2.1 code is implemented and passes local tests, but the REAL chain is NOT verified. Don't claim it works yet.**

```
iPhone → Firebase Email/Password → Firebase ID token → TripWith API
      → TripWithAuthGuard → internal TripWith user → GET /v1/me       ← NOT YET PROVEN
```

### 9.1 Blocker A: the API environment isn't configured **[VERIFIED]** (2026-09-26)

`apps/api/.env` exists but is still **byte-identical to `apps/api/.env.example`**:

- **The API will not boot.** Config validation fails on `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` (both required and non-empty, even though no object storage is used yet).
- `FIREBASE_PROJECT_ID` is still the placeholder, **not** the project the mobile app uses. Tokens would get `AUTH_TOKEN_WRONG_AUDIENCE`.
- `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` are empty. **[UNVERIFIED], but likely:** normal token verification (`checkRevoked=false`) only needs the project id and Google's public keys, so it may work without them. **Provisioning** (`checkRevoked=true`) does an account lookup and needs credentials: either a service account key (Firebase console → Project settings → Service accounts → Generate new private key) or Application Default Credentials (`gcloud auth application-default login`).
- `DB_PASSWORD` is empty. Migrations and the running API connect with these values (`data-source.ts` loads `apps/api/.env`), so it must match the local Docker Postgres password (`POSTGRES_PASSWORD` in `infra/docker-compose.yml`).

### 9.2 Blocker B: the Firebase test user has no TripWith account

The local DB was checked on 2026-09-26. None of the 451 `users` rows is a real Firebase user. They're all test fixtures (`travfb-`, `settings-`, `fb-`, `chat-`, …) or the 9 `prototype-seed-` users. **[VERIFIED]** So the Firebase test user **[MANUAL/CLOUD]** would get `AUTH_ACCOUNT_NOT_PROVISIONED` until it's provisioned (§9.4). Its email must also be **verified** in Firebase first.

### 9.3 Blocker C: the phone has no route to the API

`EXPO_PUBLIC_API_URL` is **empty** in `apps/mobile/.env.local`. **[VERIFIED]** **The Expo tunnel only exposes Metro, not API port 3000.** Options:

- **Option A (LAN):** `EXPO_PUBLIC_API_URL=http://<LAN-IP>:3000/api`. The API listens on all interfaces. Allow inbound TCP 3000 in the Windows firewall. The phone must be on the same network, and LAN already failed for Metro on the old network.
- **Option B (dev HTTPS tunnel to `localhost:3000`):** for example `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000`. Then `EXPO_PUBLIC_API_URL=https://<tunnel-host>/api`. It exposes the local API publicly while it runs, so stop it when you're done.
- **Never commit a LAN IP or tunnel host.** It belongs in `.env.local` only. Restart Metro after changing it (`expo start --clear` is safest, because env values are inlined at bundle time).

### 9.4 Manual dev provisioning (once per Firebase test user)

The full recipe is in `apps/mobile/README.md` → "Dev account setup". In short:

1. Firebase console → Authentication → Users: the test user exists **[MANUAL/CLOUD]**. It must use an inbox you control.
2. Get an ID token through the Identity Toolkit REST API (`accounts:signInWithPassword` with the Web API key), send `VERIFY_EMAIL` (`accounts:sendOobCode`), and click the link.
3. Sign in again to get a fresh token (so `email_verified=true` is in it).
4. `POST <API>/v1/auth/provision` with `dateOfBirth` (18+), `displayName`, and both consents using exactly the API's `CURRENT_TOS_VERSION` / `CURRENT_PRIVACY_POLICY_VERSION`.
5. Sign in on the phone. The Me tab should show **Connected to TripWith API**.

Don't paste tokens, passwords, or keys into any committed file, issue, or this document.

### 9.5 Definition of done for 7.2

- [ ] The API boots locally with a completed `apps/api/.env` and `GET /health/ready` is OK
- [ ] The API's `FIREBASE_PROJECT_ID` equals the mobile `EXPO_PUBLIC_FIREBASE_PROJECT_ID`
- [ ] The Firebase test user is email-verified and provisioned (`POST /v1/auth/provision` → 200)
- [ ] The phone can reach the API (`EXPO_PUBLIC_API_URL` via LAN or a dev tunnel)
- [ ] On the physical iPhone: Login → tab shell → Me tab shows *Connected to TripWith API* + display name
- [ ] Sign out returns to Login. Relaunching the app keeps you signed in (persistence).
- [ ] Mobile tests, typecheck, expo-doctor, and turbo typecheck still pass
- [ ] Commit (for example `feat(mobile): add Firebase email/password auth (7.2)`) and push. Update this handoff (§7 → history).

---

## 10. Firebase cloud state and local env state

### 10.1 Firebase **[MANUAL/CLOUD]** (reported, not checkable from Git)

- Project name **TripWith**, project ID **`tripwith-ffbc8`**. The mobile `.env.local` project id matches it. **[VERIFIED]** by comparison, without printing it from the file.
- Owners include **Alen** and **Shahaf**. Shahaf confirmed he can open the project with his own Google account.
- **Spark (free) plan.**
- **Email/Password** sign-in is enabled. **Email-link (passwordless) is not enabled.**
- A **Firebase test user** was created manually.
- A **Web app** is registered with the nickname **"TripWith Mobile"**. *Why Web:* the Expo React Native prototype uses the Firebase **JavaScript SDK**, which uses Web app config. That doesn't make TripWith web-only. Native iOS/Android apps can be registered later when the app moves to dev builds.
- **Future sign-in methods:** Email, Google, Apple, and Facebook, for users to choose from. Phone auth may come later. **Instagram is not planned** as a first-class Firebase provider.

### 10.2 Expo **[MANUAL/CLOUD]**

- Account: **`shahaf123`** (Shahaf). The physical iPhone uses **Expo Go**. No EAS project or dev build is configured in `app.json`. **[VERIFIED]**

### 10.3 Local env files **[VERIFIED]** (existence and SET/EMPTY status only, values never printed)

| File | Git | State on 2026-09-26 |
|---|---|---|
| `apps/mobile/.env.local` | ignored (`apps/mobile/.gitignore`) | 4 `EXPO_PUBLIC_FIREBASE_*` **SET**, `EXPO_PUBLIC_API_URL` **EMPTY** |
| `apps/api/.env` | ignored (root `.gitignore`) | **Identical to `.env.example`**, not populated (see §9.1) |

**Neither file is in Git, and neither will survive formatting the machine.** The mobile values can be recovered from the Firebase console (Project settings → Your apps → TripWith Mobile → Config). Details are in `docs/LOCAL_SECRETS_RESTORE_CHECKLIST.md`.

**The next engineer or Claude must check `apps/api/.env` rather than assume it's ready.**

---

## 11. Test and verification state

All of these were run on 2026-09-26 against the working tree (including the uncommitted 7.2.1). **[VERIFIED]**

| Check | Command | Result |
|---|---|---|
| Mobile unit tests | `pnpm --filter @tripwith/mobile test` | **27/27** (3 suites) PASS |
| Mobile typecheck | `pnpm --filter @tripwith/mobile typecheck` | PASS |
| Expo deps | `cd apps/mobile && npx expo install --check` | up to date |
| Expo doctor | `cd apps/mobile && npx expo-doctor` | **21/21** PASS |
| Workspace typecheck | `./node_modules/.bin/turbo run typecheck --force` | **4/4** tasks PASS |
| Backend unit | `pnpm --filter @tripwith/api test:unit` | **61/61 suites, 640/640 tests** PASS |
| Backend integration | see the command below | **32/32 suites, 307/307 tests** PASS |
| DB verification | `pnpm db:verify` | invariants **118/118**, concurrency PASS (24 racers, 4 seats, no overbooking) |
| Enum parity | `pnpm check:enums` | **FAILS**, a known pre-existing issue (§14) |

**Integration test command (important).** `apps/api/test/setup-env.ts` defaults to a test Postgres on port 55432 and Redis on 6399/6398, which aren't in `infra/docker-compose.yml`. To run against the local Docker stack, use (Git Bash):

```sh
TEST_DB_PORT=5432 TEST_DB_USER=tripwith TEST_DB_PASSWORD=<POSTGRES_PASSWORD from infra/docker-compose.yml> \
TEST_REDIS_QUEUE_URL=redis://localhost:6379 TEST_REDIS_CACHE_URL=redis://localhost:6380 \
pnpm --filter @tripwith/api test:integration
```

This writes test fixtures into the local dev DB (see the leaks in §14).

---

## 12. Deferred / not implemented

These are **[DEFERRED]**. None of them are built yet:

- **Mobile:**
  - Mobile Explore real API integration
  - Event Detail real mobile integration
  - Join UI
  - Party-size UI
  - Real Chat Room mobile UI
  - Real Inbox mobile API integration
  - Participant roster UI
- **Auth:**
  - Mobile signup/onboarding (needs the backend policy-versions endpoint, §8.3)
  - Google Sign-In
  - Apple Sign-In
  - Facebook Sign-In
  - Phone/SMS auth
  - Instagram auth (not planned)
- **Money:**
  - Payment
  - Refunds
  - Dynamic pricing
- **Platform:**
  - Push notifications
  - Production deployment
  - Recommendation/ranking
- **Providers:**
  - Provider self-service session creation (the seed inserts DRAFT rows directly)
  - Provider directory/detail
  - An Offering/Activity table (sessions are Events today, with no reusable "activity" entity)
- **Trust:** KYC/liveness
- **Lifecycle:** a scheduler that drives the `IN_PROGRESS` / `COMPLETED` lifecycle

---

## 13. Roadmap

- **Completed:** backend Steps 1–6 and Mobile 7.1.
- **Current:** **7.2 Authentication + real API connection** (7.2.1 code done, end-to-end proof pending).
- **After auth is proven, 7.3 Explore with real data:**
  - Connect `GET /v1/explorer/event-cards`.
  - Show the real Cusco seed cards. The seed is centred on Cusco, Peru, so query that area.
  - Show the FORMING / CONFIRMED / OPEN / FULL states with `seatsToConfirm`.
- **Then:** Event Detail (`GET /v1/events/:eventId`, driven by `viewer.primaryAction`) → Join with party size (`POST /v1/events/:eventId/join-requests` with `guestCount`) → Group Chat (existing chat routes plus Socket.IO) → Inbox (`GET /v1/chat/rooms`).

**Principle:** keep the product tangible. Avoid backend housekeeping unless it blocks the prototype.

---

## 14. Known pre-existing issues

These aren't blockers for prototype work:

- **`pnpm check:enums` fails** on `EventParticipantCancellationReason` and `ReviewerType`. `scripts/check-enum-parity.mjs` only reads the initial migration (`1787184000000-InitialSchema.up.sql`), but these enums were added in later migrations (the SQL type is `review_reviewer_type`, for example). Because of this, the root `pnpm verify` script also fails at its first step. **Don't fix it as part of unrelated work.** It's a small, separate task.
- **Test-data leaks in the local DB from integration tests:** `settings-test` users, `fb` users, and orphan MATCH rooms from the round-trip integration test. (Counted 2026-09-26: `travfb` 158, `settings` 144, `fb` 72, `chat` 68.)
- **The seed CLI reads `DB_HOST` from the shell,** not from `apps/api/.env`. `assertPrototypeSeedAllowed(process.env)` runs before `data-source.ts` loads dotenv, so it refuses unless the DB_* vars are exported. **[VERIFIED]** The workaround is in `NEW_COMPUTER_SETUP.md` §8.
- **The API requires non-empty `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`** even though no object storage runs locally. Use obviously fake local placeholders, like the test setup does.

---

## 15. Where else to look

- `docs/superpowers/specs/2026-08-20-tripwith-phase-1-design.md` is the architecture spec: data model (§11), delivery semantics (§6), security and privacy (§8), matching maths (§9), and the phase addenda (Phase 2–5 verification and review findings).
- `apps/mobile/README.md` covers running mobile, the tunnel, API URL options, sign-in setup, and dev provisioning curl commands.
- `apps/api/.env.example` and `apps/mobile/.env.example` document every env var.
- Commit messages (`git log`) are detailed and are part of the design record.
