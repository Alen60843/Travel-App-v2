import {
  AttendanceStatus,
  EventHostType,
  EventParticipantCancellationReason,
  EventStatus,
  EventVisibility,
  JoinRequestStatus,
} from '@tripwith/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { GeoPoint } from '../geo/geo-point';
import { numericTransformer } from './transformers';

/**
 * EVENTS domain — event_categories is an editorial lookup table (like
 * interests/provider_category_types); events carry exactly one category via
 * a direct FK, unlike providers' many-to-many. event_status_history is
 * written exclusively by database triggers (tw_event_status_guard /
 * tw_event_status_seed) — this entity is read-only from the application's
 * side by construction (no code path here ever inserts into it).
 */

@Entity('event_categories')
export class EventCategoryEntity {
  @PrimaryColumn({ type: 'integer', name: 'id', generated: 'identity', generatedIdentity: 'ALWAYS' })
  readonly id!: number;

  @Column({ type: 'text', name: 'code' })
  code!: string;

  @Column({ type: 'text', name: 'label' })
  label!: string;

  @Column({ type: 'text', name: 'icon', nullable: true })
  icon!: string | null;

  @Column({ type: 'boolean', name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'smallint', name: 'sort_order' })
  sortOrder!: number;
}

@Entity('events')
export class EventEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({
    type: 'enum',
    enum: EventHostType,
    enumName: 'event_host_type',
    name: 'host_type',
  })
  hostType!: EventHostType;

  @Column({ type: 'uuid', name: 'host_user_id', nullable: true })
  hostUserId!: string | null;

  @Column({ type: 'uuid', name: 'host_provider_id', nullable: true })
  hostProviderId!: string | null;

  @Column({ type: 'integer', name: 'category_id' })
  categoryId!: number;

  @Column({ type: 'text', name: 'title' })
  title!: string;

  @Column({ type: 'text', name: 'description', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    name: 'status',
  })
  status!: EventStatus;

  @Column({
    type: 'enum',
    enum: EventVisibility,
    enumName: 'event_visibility',
    name: 'visibility',
  })
  visibility!: EventVisibility;

  /**
   * WS8.5B: maximum TOTAL physical people (host + host's guests +
   * participants + their guests), not a count of registered rows. See
   * reservedSeatCount below for the counter this actually bounds.
   */
  @Column({ type: 'integer', name: 'capacity_max' })
  capacityMax!: number;

  /** Trigger-maintained (tw_sync_participant_count) — never write.
   * Registered-membership count only: how many EventParticipant rows are
   * active. Unchanged meaning (WS8.5B deliberately does not redefine this)
   * — it does NOT include the host and does NOT count guests. */
  @Column({
    type: 'integer',
    name: 'participant_count',
    insert: false,
    update: false,
  })
  readonly participantCount!: number;

  /**
   * WS8.5B: DRAFT-only editable (frozen at publish — enforced in
   * EventsService, not here). The USER host's own party size; irrelevant
   * for provider-hosted events (always 0 there, never interpreted as a
   * physical host seat — see reservedSeatCount).
   */
  @Column({ type: 'integer', name: 'host_guest_count' })
  hostGuestCount!: number;

  /**
   * WS8.5B: trigger-maintained (tw_seed_reserved_seat_count /
   * tw_adjust_reserved_seat_count_for_host / tw_sync_reserved_seat_count) —
   * never write. Total physical seats currently occupied: for a USER-hosted
   * event, (1 + hostGuestCount) + SUM(1 + guest_count) over active
   * EventParticipants; for a provider-hosted event, the participant sum
   * only — no manufactured provider-host seat.
   */
  @Column({
    type: 'integer',
    name: 'reserved_seat_count',
    insert: false,
    update: false,
  })
  readonly reservedSeatCount!: number;

  @Column({ type: 'integer', name: 'price_minor' })
  priceMinor!: number;

  @Column({ type: 'integer', name: 'deposit_minor' })
  depositMinor!: number;

  @Column({ type: 'character', length: 3, name: 'currency' })
  currency!: string;

  @Column({ type: 'timestamptz', name: 'starts_at' })
  startsAt!: Date;

  @Column({ type: 'timestamptz', name: 'ends_at' })
  endsAt!: Date;

  /**
   * GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED.
   * Same representation choice as trip_segments.date_range: the raw
   * PostgreSQL range literal text, read-only, never written by the app.
   */
  @Column({ type: 'tstzrange', name: 'time_range', nullable: true, insert: false, update: false })
  readonly timeRange!: string | null;

  /** A public meeting point the host chose — the only coordinate Explorer ever reads. */
  @Column({ type: 'geography', spatialFeatureType: 'Point', srid: 4326, name: 'meeting_point' })
  meetingPoint!: GeoPoint;

  @Column({ type: 'text', name: 'meeting_point_label', nullable: true })
  meetingPointLabel!: string | null;

  @Column({
    type: 'numeric',
    name: 'min_trust_score',
    precision: 5,
    scale: 2,
    transformer: numericTransformer,
  })
  minTrustScore!: number;

  @Column({ type: 'boolean', name: 'join_approval_required' })
  joinApprovalRequired!: boolean;

  @Column({ type: 'text', name: 'cancellation_policy', nullable: true })
  cancellationPolicy!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  @ManyToOne(() => EventCategoryEntity)
  @JoinColumn({ name: 'category_id' })
  category?: EventCategoryEntity;

  @OneToMany(() => EventStatusHistoryEntity, (history) => history.event)
  statusHistory?: EventStatusHistoryEntity[];
}

/** Append-only audit trail (§12), populated exclusively by database triggers. */
@Entity('event_status_history')
export class EventStatusHistoryEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    name: 'from_status',
    nullable: true,
  })
  fromStatus!: EventStatus | null;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'event_status',
    name: 'to_status',
  })
  toStatus!: EventStatus;

  /** NULL means a system job made the transition, not a user. */
  @Column({ type: 'uuid', name: 'actor_user_id', nullable: true })
  actorUserId!: string | null;

  @Column({ type: 'text', name: 'reason', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne(() => EventEntity, (event) => event.statusHistory)
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;
}

@Entity('event_join_requests')
export class EventJoinRequestEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'join_request_status',
    name: 'status',
  })
  status!: JoinRequestStatus;

  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'text', name: 'message', nullable: true })
  message!: string | null;

  /** WS8.5B: immutable historical record of the party size requested. Never rewritten after the request is decided — see EventParticipantEntity.guestCount for CURRENT membership. */
  @Column({ type: 'integer', name: 'guest_count' })
  readonly guestCount!: number;

  /**
   * WS8.5C/WS8.5D: immutable server-derived snapshot of the Event's capacity
   * state at the moment this request was created (read under the same
   * Event-row lock create() already holds). Never rewritten. Combined with
   * guestCount, this is what lets "did this exceed capacity when
   * submitted, and by how much" stay answerable forever, independent of
   * whatever capacityMax/reservedSeatCount are NOW.
   *
   * Nullable: a JoinRequest created before this snapshot feature existed has
   * no historically-true value to record — the WS8.6A audit found that
   * backfilling it from the Event's CURRENT capacity would fabricate
   * historical evidence, so legacy rows instead leave BOTH columns NULL
   * (never one without the other — see
   * event_join_requests_capacity_snapshot_chk) and the API surfaces this as
   * capacitySnapshotAvailable=false rather than a fake answer. Every
   * JoinRequest created from WS8.5D onward always has both populated.
   */
  @Column({ type: 'integer', name: 'capacity_max_at_request', nullable: true })
  readonly capacityMaxAtRequest!: number | null;

  @Column({ type: 'integer', name: 'reserved_seat_count_at_request', nullable: true })
  readonly reservedSeatCountAtRequest!: number | null;

  /**
   * WS8.5C: capacity-override audit evidence. All four NULL together is the
   * overwhelmingly common case (no override was needed, or none was used);
   * all four set together means the USER host explicitly approved this
   * exact request despite it not fitting current capacity, atomically
   * raising capacityMax from capacityBeforeOverride to
   * capacityAfterOverride. Set once, at approval time, never rewritten —
   * capacityOverrideApprovedByUserId uses ON DELETE RESTRICT (see the
   * migration comment) for the same reason EventParticipant's
   * cancelledByUserId does: NULL has exactly one meaning here ("no
   * override"), so a hard-deleted actor could never silently produce it.
   */
  // Not readonly: set once by JoinRequestsService.approveWithCapacityOverride
  // at approval time (mirroring how approvedAt/decidedByUserId below are
  // themselves mutated directly, not readonly) — but no code path ever
  // writes them a second time for the same row.
  @Column({ type: 'timestamptz', name: 'capacity_override_approved_at', nullable: true })
  capacityOverrideApprovedAt!: Date | null;

  @Column({ type: 'uuid', name: 'capacity_override_approved_by_user_id', nullable: true })
  capacityOverrideApprovedByUserId!: string | null;

  @Column({ type: 'integer', name: 'capacity_before_override', nullable: true })
  capacityBeforeOverride!: number | null;

  @Column({ type: 'integer', name: 'capacity_after_override', nullable: true })
  capacityAfterOverride!: number | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'requested_at' })
  readonly requestedAt!: Date;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'approved_at', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'rejected_at', nullable: true })
  rejectedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'expired_at', nullable: true })
  expiredAt!: Date | null;

  @Column({ type: 'uuid', name: 'decided_by_user_id', nullable: true })
  decidedByUserId!: string | null;

  /** Duplicate of requested_at in the schema (both DEFAULT now()); kept 1:1 with the DB. */
  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;
}

@Entity('event_participants')
export class EventParticipantEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'event_id' })
  eventId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'join_request_id', nullable: true })
  joinRequestId!: string | null;

  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'boolean', name: 'is_host' })
  isHost!: boolean;

  /** WS8.5B: current party size, copied from the approving JoinRequest at INSERT and never written again afterward — leave/remove cancels the whole row, guests included. */
  @Column({ type: 'integer', name: 'guest_count' })
  readonly guestCount!: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'joined_at' })
  readonly joinedAt!: Date;

  @Column({
    type: 'enum',
    enum: AttendanceStatus,
    enumName: 'attendance_status',
    name: 'attendance_status',
  })
  attendanceStatus!: AttendanceStatus;

  @Column({ type: 'timestamptz', name: 'checked_in_at', nullable: true })
  checkedInAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;

  /**
   * WS8.4B cancellation audit metadata. Both columns are NULL together with
   * cancelled_at for an active participant and NOT NULL together for a
   * cancelled one (event_participants_cancellation_audit_chk) — set once,
   * atomically, at cancellation time and never touched again: a retried
   * leave/remove is an idempotent no-op that reads this back unchanged
   * rather than rewriting it (see JoinRequestsService.cancelParticipation).
   */
  @Column({ type: 'uuid', name: 'cancelled_by_user_id', nullable: true })
  cancelledByUserId!: string | null;

  /** VOLUNTARY_LEAVE (cancelledByUserId = the participant) or HOST_REMOVAL (cancelledByUserId = the USER host). */
  @Column({
    type: 'enum',
    enum: EventParticipantCancellationReason,
    enumName: 'event_participant_cancellation_reason',
    name: 'cancellation_reason',
    nullable: true,
  })
  cancellationReason!: EventParticipantCancellationReason | null;

  /** Duplicate of joined_at in the schema (both DEFAULT now()); kept 1:1 with the DB. */
  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne(() => EventEntity)
  @JoinColumn({ name: 'event_id' })
  event?: EventEntity;
}
