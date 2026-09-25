import { EventVisibility } from '@tripwith/shared';
import type { DataSource } from 'typeorm';

import { ChatRepository } from '../../../chat/chat.repository';
import { EventsRepository } from '../../../events/events.repository';
import { EventsService } from '../../../events/events.service';
import type { EventView } from '../../../events/events.types';
import { JoinRequestsService } from '../../../events/join-requests.service';
import { GeoService } from '../../geo';

/**
 * Touchable Prototype Step 6 — safe, repeatable LOCAL/DEV demo seed (Cusco).
 *
 * OWNERSHIP BOUNDARY. The seed owns exactly:
 *   - the users whose id is in PROTOTYPE_SEED_USER_IDS AND whose firebase_uid
 *     starts with PROTOTYPE_SEED_UID_PREFIX (both must hold);
 *   - the providers whose id is in PROTOTYPE_SEED_PROVIDER_IDS;
 *   - the events hosted by one of those users or providers, and everything
 *     that hangs off those events (participants, join requests, the EVENT
 *     chat room and its members/messages, status history).
 * Cleanup never matches by name, email, title or pattern alone, so unrelated
 * developer data — even an identically named "Andes Adventures" — is never
 * touched. Interactions a developer makes WITH a seeded event (e.g. joining
 * it from the app) are reset along with that event on the next run.
 *
 * DERIVED STATE IS NEVER WRITTEN. Provider sessions are inserted as DRAFT rows
 * (no provider-session creation API exists yet); everything else goes through
 * the real services: EventsService.createEvent/publishEvent, and
 * JoinRequestsService.create (auto-approval), which provisions participants,
 * EVENT chat rooms and members. reserved_seat_count / participant_count come
 * only from the database triggers, and FULL only from the join logic.
 *
 * Seed accounts are data-only: no Firebase user exists for any
 * PROTOTYPE_SEED_UID_PREFIX uid, so nobody can sign in as them.
 */

export const PROTOTYPE_SEED_UID_PREFIX = 'prototype-seed-';
const EMAIL_DOMAIN = 'prototype-seed.tripwith.invalid';

/** Fixed, valid v4 UUIDs so ids stay stable across reruns. */
export const PROTOTYPE_SEED_USERS = {
  andesOwner: { id: '5eed0000-0000-4000-8000-000000000001', key: 'andes-owner', displayName: 'Mateo · Andes Adventures' },
  ana: { id: '5eed0000-0000-4000-8000-000000000002', key: 'ana', displayName: 'Ana' },
  ben: { id: '5eed0000-0000-4000-8000-000000000003', key: 'ben', displayName: 'Ben' },
  carla: { id: '5eed0000-0000-4000-8000-000000000004', key: 'carla', displayName: 'Carla' },
  diego: { id: '5eed0000-0000-4000-8000-000000000005', key: 'diego', displayName: 'Diego' },
  elif: { id: '5eed0000-0000-4000-8000-000000000006', key: 'elif', displayName: 'Elif' },
  sofia: { id: '5eed0000-0000-4000-8000-000000000007', key: 'sofia', displayName: 'Sofía' },
  lucas: { id: '5eed0000-0000-4000-8000-000000000008', key: 'lucas', displayName: 'Lucas' },
  farah: { id: '5eed0000-0000-4000-8000-000000000009', key: 'farah', displayName: 'Farah' },
} as const;
export const PROTOTYPE_SEED_USER_IDS: readonly string[] = Object.values(PROTOTYPE_SEED_USERS).map((user) => user.id);

export const PROTOTYPE_SEED_PROVIDER = {
  id: '5eed0000-0000-4000-8000-000000000101',
  slug: 'prototype-seed-andes-adventures',
  name: 'Andes Adventures',
} as const;
export const PROTOTYPE_SEED_PROVIDER_IDS: readonly string[] = [PROTOTYPE_SEED_PROVIDER.id];

/** Provider sessions are inserted directly (no creation API yet), so their ids are fixed too. */
export const PROTOTYPE_SEED_SESSIONS = {
  rainbow: { id: '5eed0000-0000-4000-8000-000000000201', title: 'Rainbow Mountain (Vinicunca)' },
  humantay: { id: '5eed0000-0000-4000-8000-000000000202', title: 'Humantay Lake' },
} as const;

// ---------------------------------------------------------------------------
// Safety guard
// ---------------------------------------------------------------------------

export class PrototypeSeedRefusedError extends Error {
  constructor(reason: string) {
    super(`Prototype seed refused: ${reason}`);
    this.name = 'PrototypeSeedRefusedError';
  }
}

const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Runs BEFORE any database connection is opened. Refuses:
 *   - NODE_ENV=production (the app's own production switch);
 *   - any DB_HOST other than localhost/127.0.0.1/::1, unless the operator
 *     explicitly opts in with PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB=true (e.g. a
 *     dev container named "postgres") — and even then never in production.
 */
export function assertPrototypeSeedAllowed(env: NodeJS.ProcessEnv): void {
  if ((env.NODE_ENV ?? 'development') === 'production') {
    throw new PrototypeSeedRefusedError('NODE_ENV=production. This seed is for local/dev databases only.');
  }
  const host = (env.DB_HOST ?? '').trim().toLowerCase();
  if (!host) {
    throw new PrototypeSeedRefusedError('DB_HOST is not set; refusing to guess which database to seed.');
  }
  if (!LOCAL_DB_HOSTS.has(host) && env.PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB !== 'true') {
    throw new PrototypeSeedRefusedError(
      `DB_HOST "${host}" is not local. Set PROTOTYPE_SEED_ALLOW_NON_LOCAL_DB=true only for a disposable dev database.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cleanup (seed-owned rows only)
// ---------------------------------------------------------------------------

const SEED_USERS_SQL = `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND firebase_uid LIKE $2`;
const SEED_EVENTS_SQL = `
  SELECT id FROM events
   WHERE host_provider_id = ANY($3::uuid[])
      OR host_user_id IN (${SEED_USERS_SQL})`;

/**
 * Deletes seed-owned rows only, in one transaction (all-or-nothing). Event
 * children cascade from events; event_status_history is append-only in
 * production, so its guard trigger is disabled only inside this transaction
 * (the established fixture-cleanup pattern) and re-enabled before commit.
 */
export async function cleanupPrototypeSeed(dataSource: DataSource): Promise<void> {
  const params = [PROTOTYPE_SEED_USER_IDS, `${PROTOTYPE_SEED_UID_PREFIX}%`, PROTOTYPE_SEED_PROVIDER_IDS];
  await dataSource.transaction(async (manager) => {
    await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
    await manager.query(`DELETE FROM event_status_history WHERE event_id IN (${SEED_EVENTS_SQL})`, params);
    await manager.query(`DELETE FROM events WHERE id IN (${SEED_EVENTS_SQL})`, params);
    await manager.query('DELETE FROM providers WHERE id = ANY($1::uuid[])', [PROTOTYPE_SEED_PROVIDER_IDS]);
    await manager.query(`DELETE FROM users WHERE id IN (${SEED_USERS_SQL})`, params.slice(0, 2));
    await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
  });
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** Cusco meeting points (the only coordinates written; all public by design). */
const CUSCO = {
  plazaSanFrancisco: { latitude: -13.5195, longitude: -71.9812, label: 'Plaza San Francisco, Cusco' },
  plazaRegocijo: { latitude: -13.5170, longitude: -71.9804, label: 'Plaza Regocijo, Cusco' },
  sanCristobal: { latitude: -13.5139, longitude: -71.9819, label: 'Mirador de San Cristóbal' },
  sanBlas: { latitude: -13.5153, longitude: -71.9747, label: 'Plaza San Blas' },
} as const;

/** Day offset from today (UTC) at a fixed UTC hour — always at least a day ahead of `now`. */
function futureAt(now: Date, daysAhead: number, utcHour: number, utcMinute = 0): Date {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(day + daysAhead * 86_400_000 + (utcHour * 60 + utcMinute) * 60_000);
}

export interface PrototypeSeedResult {
  readonly providerId: string;
  readonly events: {
    readonly rainbow: EventView;
    readonly humantay: EventView;
    readonly sunset: EventView;
    readonly cooking: EventView;
  };
  readonly rainbowChatRoomId: string;
}

export async function runPrototypeSeed(dataSource: DataSource, now = new Date()): Promise<PrototypeSeedResult> {
  await cleanupPrototypeSeed(dataSource);

  const repository = new EventsRepository(dataSource);
  const chat = new ChatRepository(dataSource);
  const events = new EventsService(repository, new GeoService());
  const joins = new JoinRequestsService(repository, chat);
  const [category] = (await dataSource.query(
    `SELECT id FROM event_categories WHERE is_active ORDER BY (code = 'trek') DESC, id LIMIT 1`,
  )) as Array<{ id: number }>;
  if (!category) throw new Error('No active event category: run migrations first.');

  // 1. Seed-owned accounts (data only) + public display profiles.
  for (const user of Object.values(PROTOTYPE_SEED_USERS)) {
    await dataSource.query(
      `INSERT INTO users (id, firebase_uid, email, date_of_birth, account_status)
       VALUES ($1, $2, $3, DATE '1994-05-17', 'ACTIVE')`,
      [user.id, `${PROTOTYPE_SEED_UID_PREFIX}${user.key}`, `${user.key}@${EMAIL_DOMAIN}`],
    );
    await dataSource.query(
      `INSERT INTO user_profiles (user_id, display_name, travel_style) VALUES ($1, $2, 3)`,
      [user.id, user.displayName],
    );
  }
  const U = PROTOTYPE_SEED_USERS;

  // 2. Provider, owned through the legitimate providers.owner_user_id link.
  await dataSource.query(
    `INSERT INTO providers (id, slug, name, owner_user_id, city, country_code, currency)
     VALUES ($1, $2, $3, $4, 'Cusco', 'PE', 'PEN')`,
    [PROTOTYPE_SEED_PROVIDER.id, PROTOTYPE_SEED_PROVIDER.slug, PROTOTYPE_SEED_PROVIDER.name, U.andesOwner.id],
  );

  // 3. Provider sessions: DRAFT rows only, then the real publish path.
  const insertSession = async (
    id: string, title: string, description: string, startsAt: Date, hours: number,
    capacityMin: number, capacityMax: number, priceMinor: number,
    point: { latitude: number; longitude: number; label: string },
  ) => {
    await dataSource.query(
      `INSERT INTO events (
         id, host_type, host_provider_id, category_id, title, description, status, visibility,
         capacity_min, capacity_max, price_minor, deposit_minor, currency,
         starts_at, ends_at, meeting_point, meeting_point_label, join_approval_required, min_trust_score
       ) VALUES (
         $1, 'PROVIDER', $2, $3, $4, $5, 'DRAFT', 'PUBLIC',
         $6, $7, $8, 0, 'PEN',
         $9, $10, ST_SetSRID(ST_MakePoint($11, $12), 4326)::geography, $13, FALSE, 0
       )`,
      [
        id, PROTOTYPE_SEED_PROVIDER.id, category.id, title, description,
        capacityMin, capacityMax, priceMinor,
        startsAt, new Date(startsAt.getTime() + hours * 3_600_000),
        point.longitude, point.latitude, point.label,
      ],
    );
    await events.publishEvent(U.andesOwner.id, id, now);
  };

  // Rainbow Mountain: 04:00 Cusco time (09:00 UTC), five days out.
  await insertSession(
    PROTOTYPE_SEED_SESSIONS.rainbow.id, PROTOTYPE_SEED_SESSIONS.rainbow.title,
    'Full-day trek to Vinicunca at 5,036 m. Transport, breakfast and guide included.',
    futureAt(now, 5, 9), 12, 8, 12, 12_000, CUSCO.plazaSanFrancisco,
  );
  await joins.create(U.ana.id, PROTOTYPE_SEED_SESSIONS.rainbow.id, { guestCount: 3, message: 'Four of us from Lisbon!' });
  await joins.create(U.ben.id, PROTOTYPE_SEED_SESSIONS.rainbow.id, { guestCount: 2 });

  // Humantay Lake: 04:30 Cusco time, three days out — 4 + 4 + 3 = 11 of min 10.
  await insertSession(
    PROTOTYPE_SEED_SESSIONS.humantay.id, PROTOTYPE_SEED_SESSIONS.humantay.title,
    'Turquoise glacier lake under Salkantay. Early pickup from Cusco.',
    futureAt(now, 3, 9, 30), 11, 10, 14, 10_000, CUSCO.plazaRegocijo,
  );
  await joins.create(U.carla.id, PROTOTYPE_SEED_SESSIONS.humantay.id, { guestCount: 3 });
  await joins.create(U.diego.id, PROTOTYPE_SEED_SESSIONS.humantay.id, { guestCount: 3 });
  await joins.create(U.elif.id, PROTOTYPE_SEED_SESSIONS.humantay.id, { guestCount: 2 });

  // 4. USER-hosted OPEN meetup through the real create/publish path.
  const sunsetStart = futureAt(now, 2, 22, 30); // 17:30 Cusco time
  const sunsetDraft = await events.createEvent(U.sofia.id, {
    categoryId: category.id,
    title: 'Cusco Sunset Meetup',
    description: 'Casual sunset over the rooftops — meet other travellers, no plans required.',
    visibility: EventVisibility.Public,
    capacityMax: 10,
    priceMinor: 0,
    currency: 'PEN',
    startsAt: sunsetStart.toISOString(),
    endsAt: new Date(sunsetStart.getTime() + 2 * 3_600_000).toISOString(),
    latitude: CUSCO.sanCristobal.latitude,
    longitude: CUSCO.sanCristobal.longitude,
    meetingPointLabel: CUSCO.sanCristobal.label,
    joinApprovalRequired: false,
  });
  const sunset = await events.publishEvent(U.sofia.id, sunsetDraft.id, now);

  // 5. FULL example: host party of 2 + Farah's party of 2 = capacity 4; the
  //    join logic itself moves it to FULL.
  const cookingStart = futureAt(now, 4, 16); // 11:00 Cusco time
  const cookingDraft = await events.createEvent(U.lucas.id, {
    categoryId: category.id,
    title: 'Sacred Valley Cooking Class',
    description: 'Small-group Peruvian cooking class — ceviche and lomo saltado.',
    visibility: EventVisibility.Public,
    capacityMax: 4,
    hostGuestCount: 1,
    priceMinor: 15_000,
    currency: 'PEN',
    startsAt: cookingStart.toISOString(),
    endsAt: new Date(cookingStart.getTime() + 3 * 3_600_000).toISOString(),
    latitude: CUSCO.sanBlas.latitude,
    longitude: CUSCO.sanBlas.longitude,
    meetingPointLabel: CUSCO.sanBlas.label,
    joinApprovalRequired: false,
  });
  await events.publishEvent(U.lucas.id, cookingDraft.id, now);
  await joins.create(U.farah.id, cookingDraft.id, { guestCount: 1 });

  // 6. One welcome message from the provider owner, through the real chat write path.
  const [room] = (await dataSource.query(
    `SELECT id FROM chat_rooms WHERE event_id = $1 AND type = 'EVENT'`, [PROTOTYPE_SEED_SESSIONS.rainbow.id],
  )) as Array<{ id: string }>;
  if (!room) throw new Error('Rainbow Mountain chat room was not provisioned by the join flow.');
  await chat.sendTextMessage(
    room.id, U.andesOwner.id, 'prototype-seed-rainbow-welcome',
    'Welcome! Pickup is at 04:00 from Plaza San Francisco — bring layers, it is cold at the top.',
  );

  // 7. Read everything back from DB truth via the manager views.
  return {
    providerId: PROTOTYPE_SEED_PROVIDER.id,
    events: {
      rainbow: await events.getEvent(U.andesOwner.id, PROTOTYPE_SEED_SESSIONS.rainbow.id),
      humantay: await events.getEvent(U.andesOwner.id, PROTOTYPE_SEED_SESSIONS.humantay.id),
      sunset: await events.getEvent(U.sofia.id, sunset.id),
      cooking: await events.getEvent(U.lucas.id, cookingDraft.id),
    },
    rainbowChatRoomId: room.id,
  };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function groupLine(event: EventView): string {
  switch (event.groupState) {
    case 'FORMING':
      return `FORMING · ${event.reservedSeatCount} / ${event.capacityMin} minimum · needs ${event.seatsToConfirm} more · ${event.remainingSeats} seats remaining`;
    case 'CONFIRMED':
      return `CONFIRMED · ${event.reservedSeatCount} joined · ${event.remainingSeats} seats remaining`;
    case 'FULL':
      return `FULL · ${event.reservedSeatCount} / ${event.capacityMax}`;
    default:
      return `${event.groupState ?? event.status} · ${event.reservedSeatCount} / ${event.capacityMax}`;
  }
}

/** IDs and group states only — never credentials, emails or uids. */
export function formatPrototypeSeedSummary(result: PrototypeSeedResult): string {
  const lines = ['Prototype seed ready', ''];
  lines.push(`Provider  ${PROTOTYPE_SEED_PROVIDER.name}  ${result.providerId}`, '');
  for (const event of Object.values(result.events)) {
    lines.push(`${event.title}`, `  ${groupLine(event)}`, `  starts ${event.startsAt}`, `  event ${event.id}`, '');
  }
  lines.push(`Rainbow Mountain chat room  ${result.rainbowChatRoomId}`);
  return lines.join('\n');
}
