import { Injectable } from '@nestjs/common';
import { AttendanceStatus, EventHostType, ModerationState, ReviewerType, ReviewTargetType } from '@tripwith/shared';
import { DataSource, type EntityManager } from 'typeorm';

import {
  attendanceEvidenceFor,
  isEligibleForVerification,
  isEligibleToSubmitReview,
  type AttendanceEvidence,
} from './attendance-evidence';
import { decideInitialModerationState } from './moderation-policy';
import {
  EventNotProviderHostedError,
  ProviderReviewerNotAuthorizedError,
  ReviewAlreadyExistsError,
  ReviewNotEligibleError,
} from './trust.errors';
import type { ReviewView } from './reviews.types';

interface ReviewRow {
  readonly id: string;
  readonly reviewer_user_id: string;
  readonly reviewer_type: string;
  readonly reviewer_provider_id: string | null;
  readonly target_type: string;
  readonly target_user_id: string | null;
  readonly target_provider_id: string | null;
  readonly event_id: string | null;
  readonly rating: number;
  readonly body: string | null;
  readonly signals: Record<string, boolean>;
  readonly is_verified: boolean;
  readonly moderation_state: string;
  readonly created_at: Date | string;
}

interface EventRow {
  readonly host_type: string;
  readonly host_provider_id: string | null;
}

interface InsertReviewParams {
  readonly reviewerUserId: string;
  readonly reviewerType: string;
  readonly reviewerProviderId: string | null;
  readonly targetType: string;
  readonly targetUserId: string | null;
  readonly targetProviderId: string | null;
  readonly eventId: string;
  readonly rating: number;
  readonly body: string | null;
  readonly signals: Record<string, boolean>;
  /** H1/H4: computed independently by the caller, never hardcoded here. */
  readonly isVerified: boolean;
  readonly moderationState: ModerationState;
}

/**
 * PostgreSQL authority for the review aggregate.
 *
 * Every write here goes through a transaction-scoped advisory lock keyed to
 * the exact unique-index tuple being claimed, then relies on that same
 * partial unique index as the correctness backstop (defense in depth, same
 * pattern as SwipesRepository) — a retried request either finds no row and
 * inserts once, or finds the row and is rejected as a duplicate.
 *
 * PRODUCT DECISION B: a submitted review is stored as evidence only. No
 * method here writes to trust_score_events. Trust Score projection from
 * review evidence is deliberately deferred until a real reputation/trust
 * policy — with evidence-confidence weighting, multi-review aggregation,
 * anti-farming protection, and a moderation/reversal lifecycle — is
 * designed and approved. When that lands, it will read APPROVED + verified
 * reviews and produce trust_score_events itself; it does not belong inside
 * review creation.
 */
@Injectable()
export class ReviewsRepository {
  constructor(private readonly dataSource: DataSource) {}

  async createProviderReview(
    reviewerUserId: string,
    eventId: string,
    rating: number,
    body: string | null,
    signals: Record<string, boolean>,
  ): Promise<ReviewView> {
    return this.dataSource.transaction(async (manager) => {
      const event = await this.loadEvent(manager, eventId);
      if (event.host_type !== EventHostType.Provider || !event.host_provider_id) {
        throw new EventNotProviderHostedError();
      }
      const targetProviderId = event.host_provider_id;

      await this.lock(manager, `review:provider:${reviewerUserId}:${eventId}:${targetProviderId}`);
      const reviewerEvidence = await this.assertReviewEligible(manager, eventId, reviewerUserId);

      const review = await this.insertReview(manager, {
        reviewerUserId,
        reviewerType: ReviewerType.Traveller,
        reviewerProviderId: null,
        targetType: ReviewTargetType.Provider,
        targetUserId: null,
        targetProviderId,
        eventId,
        rating,
        body,
        signals,
        isVerified: isEligibleForVerification(reviewerEvidence),
        moderationState: decideInitialModerationState(),
      });

      // Provider reputation is trigger-maintained (tw_sync_provider_rating)
      // off the review row itself. No trust_score_events row is written for
      // this direction — the ledger's user_id is NOT NULL and providers are
      // not a valid subject; a traveller's own trust score is not a
      // function of opinions they express about a provider.
      return this.toView(review);
    });
  }

  async createCustomerReview(
    reviewerUserId: string,
    providerId: string,
    eventId: string,
    targetUserId: string,
    rating: number,
    body: string | null,
    signals: Record<string, boolean>,
  ): Promise<ReviewView> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertProviderOwner(manager, providerId, reviewerUserId);

      const event = await this.loadEvent(manager, eventId);
      if (event.host_type !== EventHostType.Provider || event.host_provider_id !== providerId) {
        throw new ReviewNotEligibleError();
      }

      await this.lock(manager, `review:customer:${reviewerUserId}:${eventId}:${targetUserId}`);
      const targetEvidence = await this.assertReviewEligible(manager, eventId, targetUserId);

      const review = await this.insertReview(manager, {
        reviewerUserId,
        reviewerType: ReviewerType.Provider,
        reviewerProviderId: providerId,
        targetType: ReviewTargetType.User,
        targetUserId,
        targetProviderId: null,
        eventId,
        rating,
        body,
        signals,
        isVerified: isEligibleForVerification(targetEvidence),
        moderationState: decideInitialModerationState(),
      });

      // No trust_score_events row is written here either (Product Decision
      // B) — a provider's subjective 1-5 rating of a traveller does not
      // currently move that traveller's Trust Score, for the same reason a
      // traveller's subjective rating of another traveller doesn't.
      return this.toView(review);
    });
  }

  private async lock(manager: EntityManager, key: string): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }

  private async loadEvent(manager: EntityManager, eventId: string): Promise<EventRow> {
    const rows = (await manager.query(
      `SELECT host_type, host_provider_id FROM events WHERE id = $1`,
      [eventId],
    )) as EventRow[];
    const event = rows[0];
    if (!event) throw new ReviewNotEligibleError();
    return event;
  }

  /**
   * H4: reads the raw participation relationship + attendance evidence,
   * then asks the one named question this call site actually needs
   * ("may this actor submit a review?"). Returns the evaluated evidence so
   * the caller can separately ask the verification question
   * (isEligibleForVerification) without re-querying — a deliberately
   * distinct decision (see attendance-evidence.ts), even though today it
   * resolves the same way off the same evidence.
   */
  private async assertReviewEligible(
    manager: EntityManager,
    eventId: string,
    userId: string,
  ): Promise<AttendanceEvidence> {
    const rows = (await manager.query(
      `SELECT attendance_status
         FROM event_participants
        WHERE event_id = $1 AND user_id = $2
        LIMIT 1`,
      [eventId, userId],
    )) as { readonly attendance_status: AttendanceStatus }[];

    const evidence = rows[0] ? attendanceEvidenceFor(rows[0].attendance_status) : 'NONE';
    if (!isEligibleToSubmitReview(evidence)) throw new ReviewNotEligibleError();
    return evidence;
  }

  private async assertProviderOwner(
    manager: EntityManager,
    providerId: string,
    userId: string,
  ): Promise<void> {
    const rows = await manager.query(
      `SELECT 1 FROM providers WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
      [providerId, userId],
    );
    if (rows.length === 0) throw new ProviderReviewerNotAuthorizedError();
  }

  private async insertReview(
    manager: EntityManager,
    params: InsertReviewParams,
  ): Promise<ReviewRow> {
    const inserted = (await manager.query(
      `INSERT INTO reviews (
         reviewer_user_id, reviewer_type, reviewer_provider_id,
         target_type, target_user_id, target_provider_id, event_id,
         rating, body, signals, is_verified, moderation_state
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       ON CONFLICT DO NOTHING
       RETURNING id, reviewer_user_id, reviewer_type, reviewer_provider_id,
                 target_type, target_user_id, target_provider_id, event_id,
                 rating, body, signals, is_verified, moderation_state, created_at`,
      [
        params.reviewerUserId,
        params.reviewerType,
        params.reviewerProviderId,
        params.targetType,
        params.targetUserId,
        params.targetProviderId,
        params.eventId,
        params.rating,
        params.body,
        JSON.stringify(params.signals),
        // H1: both computed independently by the caller (attendance
        // evidence vs. moderation-policy.ts) — never coupled here.
        params.isVerified,
        params.moderationState,
      ],
    )) as ReviewRow[];

    const review = inserted[0];
    if (!review) throw new ReviewAlreadyExistsError();
    return review;
  }

  private toView(row: ReviewRow): ReviewView {
    return {
      id: row.id,
      reviewerUserId: row.reviewer_user_id,
      reviewerType: row.reviewer_type,
      reviewerProviderId: row.reviewer_provider_id,
      targetType: row.target_type,
      targetUserId: row.target_user_id,
      targetProviderId: row.target_provider_id,
      eventId: row.event_id,
      rating: row.rating,
      body: row.body,
      signals: row.signals,
      isVerified: row.is_verified,
      moderationState: row.moderation_state,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    };
  }
}
