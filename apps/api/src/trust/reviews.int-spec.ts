import { randomUUID } from 'node:crypto';

import { AttendanceStatus, EventHostType, ModerationState, ReviewerType, ReviewTargetType } from '@tripwith/shared';

import { AppDataSource } from '../database/data-source';
import { ReviewsRepository } from './reviews.repository';
import { ProviderReviewerNotAuthorizedError, ReviewAlreadyExistsError } from './trust.errors';

/**
 * PostgreSQL-dependent invariants for the Phase 8 review aggregate. Mirrors
 * swipes.int-spec.ts's convention (a live AppDataSource connection, no
 * mocks, cleanup keyed off a run-scoped firebase_uid prefix). NOT RUN as
 * part of this pass — node_modules and Postgres are both unavailable in
 * this environment.
 *
 * Product Decision B: review creation never writes to trust_score_events
 * today, so there is deliberately no "trust ledger" assertion left in this
 * file beyond confirming that absence.
 */

const RUN_ID = randomUUID().replace(/-/g, '');
const UID_PREFIX = `trust-int-${RUN_ID}`;

interface TestUser {
  readonly id: string;
  readonly firebaseUid: string;
}

async function createUser(suffix: string): Promise<TestUser> {
  const firebaseUid = `${UID_PREFIX}-${suffix}`;
  const [row] = await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth)
     VALUES ($1, $2, DATE '1995-01-01')
     RETURNING id`,
    [firebaseUid, `${firebaseUid}@example.test`],
  );
  return { id: row.id, firebaseUid };
}

async function createProvider(ownerUserId: string, suffix: string): Promise<string> {
  const [row] = await AppDataSource.query(
    `INSERT INTO providers (owner_user_id, slug, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [ownerUserId, `${UID_PREFIX}-${suffix}`, `Trust int provider ${suffix}`],
  );
  return row.id;
}

async function anyEventCategoryId(): Promise<number> {
  const [row] = await AppDataSource.query(`SELECT id FROM event_categories LIMIT 1`);
  return row.id;
}

interface CreateEventOptions {
  readonly hostUserId?: string;
  readonly hostProviderId?: string;
}

async function createEvent(options: CreateEventOptions): Promise<string> {
  const categoryId = await anyEventCategoryId();
  const hostType = options.hostProviderId ? EventHostType.Provider : EventHostType.User;
  const [row] = await AppDataSource.query(
    `INSERT INTO events (
       host_type, host_user_id, host_provider_id, category_id, title,
       capacity_max, starts_at, ends_at, meeting_point
     ) VALUES ($1,$2,$3,$4,$5,10,now() - interval '2 days',now() - interval '1 day',
               ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326)::geography)
     RETURNING id`,
    [hostType, options.hostUserId ?? null, options.hostProviderId ?? null, categoryId, `Trust int event ${RUN_ID}`],
  );
  return row.id;
}

async function addParticipant(
  eventId: string,
  userId: string,
  attendanceStatus: AttendanceStatus,
): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO event_participants (event_id, user_id, attendance_status) VALUES ($1,$2,$3)`,
    [eventId, userId, attendanceStatus],
  );
}

async function approveReview(reviewId: string): Promise<void> {
  // Standing in for a future moderation action — not part of Phase 8's own
  // API surface, just proving the DB permits the transition this pass
  // relies on.
  await AppDataSource.query(`UPDATE reviews SET moderation_state = $2 WHERE id = $1`, [
    reviewId,
    ModerationState.Approved,
  ]);
}

describe('reviews (real PostgreSQL)', () => {
  let repository: ReviewsRepository;

  beforeAll(async () => {
    await AppDataSource.initialize();
    repository = new ReviewsRepository(AppDataSource);
  });

  afterAll(async () => {
    try {
      // Fixture-only cleanup, same pattern as join-requests.int-spec.ts:
      // event_status_history is append-only (event_status_history_append_only
      // forbids UPDATE/DELETE unconditionally, including cascade-induced
      // deletes from event_id ON DELETE CASCADE), so a plain `DELETE FROM
      // events` is rejected by production protection this suite must never
      // weaken. The trigger is disabled only for the duration of this one
      // transaction, scoped to exactly this suite's own tracked rows
      // (UID_PREFIX); if any statement here fails, the whole transaction —
      // including the DISABLE TRIGGER — rolls back, so the trigger is never
      // left disabled outside this block.
      //
      // A second, independent obstacle: reviews.event_id is
      // `REFERENCES events(id) ON DELETE SET NULL`, but
      // reviews_forbid_content_mutation forbids ANY change to event_id
      // (append-only content, not just append-only rows) — including a
      // SET NULL cascade. Deleting this suite's own event-linked reviews
      // explicitly, BEFORE deleting the events, means that cascade is never
      // triggered at all, so the content-immutability trigger never needs
      // touching (unlike event_status_history, it is not disabled here).
      await AppDataSource.transaction(async (manager) => {
        await manager.query('ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only');
        await manager.query(
          `DELETE FROM event_status_history WHERE event_id IN (
             SELECT id FROM events
              WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)
                 OR host_provider_id IN (
                      SELECT id FROM providers WHERE owner_user_id IN (
                        SELECT id FROM users WHERE firebase_uid LIKE $1
                      )
                    )
           )`,
          [`${UID_PREFIX}%`],
        );
        await manager.query(
          `DELETE FROM reviews WHERE event_id IN (
             SELECT id FROM events
              WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)
                 OR host_provider_id IN (
                      SELECT id FROM providers WHERE owner_user_id IN (
                        SELECT id FROM users WHERE firebase_uid LIKE $1
                      )
                    )
           )`,
          [`${UID_PREFIX}%`],
        );
        await manager.query(
          `DELETE FROM events
            WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)
               OR host_provider_id IN (
                    SELECT id FROM providers WHERE owner_user_id IN (
                      SELECT id FROM users WHERE firebase_uid LIKE $1
                    )
                  )`,
          [`${UID_PREFIX}%`],
        );
        await manager.query(
          `DELETE FROM providers WHERE owner_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)`,
          [`${UID_PREFIX}%`],
        );
        await manager.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${UID_PREFIX}%`]);
        await manager.query('ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only');
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  describe('review immutability (H2 / Product Decision C)', () => {
    it('rejects an UPDATE that changes rating/body/signals after submission', async () => {
      const reviewer = await createUser('immut-reviewer');
      const providerId = await createProvider(reviewer.id, 'immut-provider');
      const eventId = await createEvent({ hostProviderId: providerId });
      await addParticipant(eventId, reviewer.id, AttendanceStatus.Attended);
      const review = await repository.createProviderReview(reviewer.id, eventId, 5, 'great trip', {});

      await expect(
        AppDataSource.query(`UPDATE reviews SET rating = 1 WHERE id = $1`, [review.id]),
      ).rejects.toThrow(/immutable/i);
      await expect(
        AppDataSource.query(`UPDATE reviews SET body = 'edited after the fact' WHERE id = $1`, [review.id]),
      ).rejects.toThrow(/immutable/i);
    });

    it('still permits a moderation_state transition (moderation is not blocked by the immutability guard)', async () => {
      const reviewer = await createUser('immut-mod-reviewer');
      const providerId = await createProvider(reviewer.id, 'immut-mod-provider');
      const eventId = await createEvent({ hostProviderId: providerId });
      await addParticipant(eventId, reviewer.id, AttendanceStatus.Attended);
      const review = await repository.createProviderReview(reviewer.id, eventId, 2, null, {});

      await expect(
        AppDataSource.query(`UPDATE reviews SET moderation_state = $2 WHERE id = $1`, [
          review.id,
          ModerationState.Rejected,
        ]),
      ).resolves.toBeDefined();
    });

    it('permits a system update to is_verified (system-managed metadata, not author content)', async () => {
      const reviewer = await createUser('immut-verif-reviewer');
      const providerId = await createProvider(reviewer.id, 'immut-verif-provider');
      const eventId = await createEvent({ hostProviderId: providerId });
      await addParticipant(eventId, reviewer.id, AttendanceStatus.Attended);
      const review = await repository.createProviderReview(reviewer.id, eventId, 4, null, {});
      expect(review.isVerified).toBe(true);

      // Standing in for a future evidence-processing action, not part of
      // Phase 8's own API surface — proving the DB permits it.
      await expect(
        AppDataSource.query(`UPDATE reviews SET is_verified = FALSE WHERE id = $1`, [review.id]),
      ).resolves.toBeDefined();

      const [row] = await AppDataSource.query(`SELECT is_verified FROM reviews WHERE id = $1`, [review.id]);
      expect(row.is_verified).toBe(false);
    });
  });

  describe('traveller -> provider', () => {
    it('never writes a trust_score_events row, and provider rating does not move while the review is PENDING', async () => {
      const owner = await createUser('t2p-owner');
      const reviewer = await createUser('t2p-reviewer');
      const providerId = await createProvider(owner.id, 't2p-provider');
      const eventId = await createEvent({ hostProviderId: providerId });
      await addParticipant(eventId, reviewer.id, AttendanceStatus.Attended);

      const review = await repository.createProviderReview(reviewer.id, eventId, 5, null, {});
      expect(review.targetType).toBe(ReviewTargetType.Provider);
      expect(review.moderationState).toBe(ModerationState.Pending);

      const ledgerRows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM trust_score_events WHERE review_id = $1`,
        [review.id],
      );
      expect(ledgerRows[0].n).toBe(0);

      const [pendingProviderRow] = await AppDataSource.query(
        `SELECT rating_avg, rating_count FROM providers WHERE id = $1`,
        [providerId],
      );
      expect(Number(pendingProviderRow.rating_count)).toBe(0);
      expect(pendingProviderRow.rating_avg).toBeNull();

      // Once (a stand-in for a future moderation action) approves it, the
      // pre-existing tw_sync_provider_rating trigger is what picks it up —
      // this proves the trigger's `moderation_state = 'APPROVED'` predicate
      // still correctly excludes PENDING and correctly includes APPROVED.
      await approveReview(review.id);
      const [approvedProviderRow] = await AppDataSource.query(
        `SELECT rating_avg, rating_count FROM providers WHERE id = $1`,
        [providerId],
      );
      expect(Number(approvedProviderRow.rating_count)).toBe(1);
      expect(Number(approvedProviderRow.rating_avg)).toBe(5);
    });
  });

  describe('provider -> traveller', () => {
    it('rejects when the authenticated user does not own the provider', async () => {
      const owner = await createUser('p2t-owner');
      const impostor = await createUser('p2t-impostor');
      const target = await createUser('p2t-target');
      const providerId = await createProvider(owner.id, 'p2t-provider');
      const eventId = await createEvent({ hostProviderId: providerId });
      await addParticipant(eventId, target.id, AttendanceStatus.Attended);

      await expect(
        repository.createCustomerReview(impostor.id, providerId, eventId, target.id, 3, null, {}),
      ).rejects.toBeInstanceOf(ProviderReviewerNotAuthorizedError);
    });

    it('carries reviewer_provider_id, stays PENDING, and never affects provider rating or the trust ledger', async () => {
      const owner = await createUser('p2t-rating-owner');
      const target = await createUser('p2t-rating-target');
      const providerId = await createProvider(owner.id, 'p2t-rating-provider');
      const eventId = await createEvent({ hostProviderId: providerId });
      await addParticipant(eventId, target.id, AttendanceStatus.Attended);

      const review = await repository.createCustomerReview(owner.id, providerId, eventId, target.id, 1, null, {});
      expect(review.reviewerType).toBe(ReviewerType.Provider);
      expect(review.reviewerProviderId).toBe(providerId);
      expect(review.moderationState).toBe(ModerationState.Pending);

      const [providerRow] = await AppDataSource.query(
        `SELECT rating_avg, rating_count FROM providers WHERE id = $1`,
        [providerId],
      );
      expect(Number(providerRow.rating_count)).toBe(0);
      expect(providerRow.rating_avg).toBeNull();

      const ledgerRows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM trust_score_events WHERE review_id = $1`,
        [review.id],
      );
      // A 1-star provider->traveller review must not move the target's
      // Trust Score at all right now (Product Decision B) — not "a small
      // bounded amount," none.
      expect(ledgerRows[0].n).toBe(0);
    });
  });
});
