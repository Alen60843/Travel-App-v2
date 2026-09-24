import { ModerationState, ReviewerType, ReviewTargetType, TrustEventType } from '@tripwith/shared';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { numericTransformer } from './transformers';

/**
 * TRUST, REVIEWS domain. trust_score_events is the append-only ledger
 * (tw_forbid_mutation forbids UPDATE/DELETE at the database level) and the
 * sole writer of users.trust_score_raw via tw_apply_trust_delta — this
 * entity only ever supports INSERT from the application; there is no
 * update-shaped operation that would make sense to call on it.
 */

@Entity('reviews')
export class ReviewEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  // Everything below down to signals is author-submitted content and is
  // immutable after INSERT (tw_forbid_review_content_mutation, H2 / Product
  // Decision C) — marked readonly here to mirror that DB invariant at the
  // type level. isVerified, moderationState, and the inherited soft-delete/
  // updated-at columns are system-managed lifecycle metadata and may still
  // be written by a future evidence-processing or moderation action.

  @Column({ type: 'uuid', name: 'reviewer_user_id' })
  readonly reviewerUserId!: string;

  /** The capacity the authenticated reviewer acted in. See providers.entity.ts ownerUserId for authorization. */
  @Column({
    type: 'enum',
    enum: ReviewerType,
    enumName: 'review_reviewer_type',
    name: 'reviewer_type',
  })
  readonly reviewerType!: ReviewerType;

  /** Set only when reviewerType is PROVIDER — the provider whose authority the review carries. */
  @Column({ type: 'uuid', name: 'reviewer_provider_id', nullable: true })
  readonly reviewerProviderId!: string | null;

  @Column({
    type: 'enum',
    enum: ReviewTargetType,
    enumName: 'review_target_type',
    name: 'target_type',
  })
  readonly targetType!: ReviewTargetType;

  @Column({ type: 'uuid', name: 'target_user_id', nullable: true })
  readonly targetUserId!: string | null;

  @Column({ type: 'uuid', name: 'target_provider_id', nullable: true })
  readonly targetProviderId!: string | null;

  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  readonly eventId!: string | null;

  @Column({ type: 'smallint', name: 'rating' })
  readonly rating!: number;

  @Column({ type: 'text', name: 'body', nullable: true })
  readonly body!: string | null;

  /**
   * Direction-specific advisory signals (e.g. wouldTravelAgain,
   * wouldRecommendProvider). Never authoritative on its own — shape is
   * validated by the DTO for the specific review direction, not the
   * database. See the migration comment for why this is JSONB rather than
   * a column per question.
   */
  @Column({ type: 'jsonb', name: 'signals' })
  readonly signals!: Record<string, boolean>;

  /**
   * TRUE only when the reviewer's evidence cleared review-verification
   * eligibility (see trust/attendance-evidence.ts) — a system-owned fact
   * about the interaction, not part of the author's submission. Independent
   * of moderationState below: a verified review can still be rejected by
   * moderation, and moderation approval never implies verification.
   * Deliberately NOT readonly — unlike the author-content fields above, the
   * database allows this to change if stronger or disputing evidence
   * arrives later (tw_forbid_review_content_mutation does not guard it). No
   * code path writes it after INSERT today.
   */
  @Column({ type: 'boolean', name: 'is_verified' })
  isVerified!: boolean;

  /**
   * Content-acceptability, not authenticity — orthogonal to isVerified
   * above. Starts PENDING for every new review (moderation-policy.ts);
   * only a future moderation action may transition it toward APPROVED/
   * REJECTED/AUTO_FLAGGED (tw_forbid_review_content_mutation permits writes
   * to this column specifically). This is a moderation-visibility concern
   * only — it is not Double-Blind (which is about when counterparties may
   * see each other's review) and does not implement that separately-scoped
   * feature.
   */
  @Column({
    type: 'enum',
    enum: ModerationState,
    enumName: 'moderation_state',
    name: 'moderation_state',
  })
  moderationState!: ModerationState;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt!: Date | null;
}

/**
 * Traveller -> Traveller positive-interaction-confirmation + "would travel
 * again" (WS8.3, Option T2). Deliberately NOT a `ReviewEntity` row: no
 * rating, no body, no moderation_state, no is_verified — every column here
 * is author-submitted and the whole row is immutable from INSERT
 * (tw_forbid_mutation, the same generic append-only guard trust_score_events
 * uses), so there is no system-managed lifecycle metadata to separate out.
 *
 * Row existence IS the positive-interaction confirmation — there is
 * deliberately no `interacted` column. Omission of a row for a given
 * (reviewer, target, event) carries no meaning beyond "no positive
 * confirmation was submitted"; it must never be read as absence, a
 * no-show, or negative evidence (WS8.2/WS8.3 product decision).
 */
@Entity('traveller_feedback')
export class TravellerFeedbackEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'reviewer_user_id' })
  readonly reviewerUserId!: string;

  @Column({ type: 'uuid', name: 'target_user_id' })
  readonly targetUserId!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  readonly eventId!: string;

  @Column({ type: 'boolean', name: 'would_travel_again' })
  readonly wouldTravelAgain!: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}

/**
 * The trust ledger. Append-only; see the class-level comment above.
 *
 * No Phase 8 review currently writes a row here (Product Decision B):
 * subjective review ratings are stored as evidence only, not projected into
 * Trust Score, until a real reputation/trust policy is designed and
 * approved. When that policy exists, it will need to stamp each row it
 * produces with which policy version generated it (a dedicated column, not
 * an encoding inside `reason`) so historical rows stay explainable after
 * the policy changes — add that column at that time, scoped to whatever
 * that policy's writers actually are, rather than pre-emptively now.
 */
@Entity('trust_score_events')
export class TrustScoreEventEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  /** Subject whose score this event affects. */
  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  /** Counterparty, if any (e.g. the reviewer who triggered this event). */
  @Column({ type: 'uuid', name: 'source_user_id', nullable: true })
  sourceUserId!: string | null;

  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  eventId!: string | null;

  @Column({ type: 'uuid', name: 'review_id', nullable: true })
  reviewId!: string | null;

  @Column({
    type: 'enum',
    enum: TrustEventType,
    enumName: 'trust_event_type',
    name: 'type',
  })
  type!: TrustEventType;

  @Column({
    type: 'numeric',
    name: 'delta',
    precision: 6,
    scale: 3,
    transformer: numericTransformer,
  })
  delta!: number;

  @Column({ type: 'text', name: 'reason', nullable: true })
  reason!: string | null;

  /** Moderation reverses by inserting a compensating row pointing here — nothing is ever edited. */
  @Column({ type: 'uuid', name: 'reverses_event_id', nullable: true })
  reversesEventId!: string | null;

  /** §4.4: replaying the same domain occurrence cannot double-count. */
  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}
