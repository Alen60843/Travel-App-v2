import { Injectable } from '@nestjs/common';
import { EventHostType, EventStatus } from '@tripwith/shared';
import { DataSource, type EntityManager } from 'typeorm';

import {
  EventNotEligibleForFeedbackError,
  ParticipantNotEligibleError,
  TravellerFeedbackAnswerConflictError,
  TravellerFeedbackEventNotFoundError,
} from './traveller-feedback.errors';
import type { TravellerFeedbackCandidateView, TravellerFeedbackView } from './traveller-feedback.types';

export interface TravellerFeedbackItem {
  readonly targetUserId: string;
  readonly wouldTravelAgain: boolean;
}

interface EventRow {
  readonly status: string;
  readonly ends_at: Date | string;
  readonly host_type: string;
  readonly host_user_id: string | null;
}

interface FeedbackRow {
  readonly id: string;
  readonly reviewer_user_id: string;
  readonly target_user_id: string;
  readonly event_id: string;
  readonly would_travel_again: boolean;
  readonly created_at: Date | string;
}

interface CandidateRow {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly role: 'HOST' | 'PARTICIPANT';
}

/**
 * PostgreSQL authority for Traveller -> Traveller feedback (WS8.3, WS8.3A).
 *
 * "Event Feedback Member" (WS8.3A) = the event's USER host OR an active
 * (cancelled_at IS NULL) EventParticipant. The host is deliberately NEVER
 * inserted into event_participants (that would change capacity/join-request
 * semantics this module must not touch) — membership for a host is derived
 * purely by comparing a user id against events.host_user_id when
 * host_type = 'USER'. Provider-hosted events have no Traveller Feedback
 * host at all; that direction is served by the separate Traveller<->Provider
 * review flows in ../reviews.repository.ts.
 *
 * Eligibility is deliberately NOT attendance_status = ATTENDED (WS8.2/8.3):
 * membership proves "belongs to the authoritative event group," not
 * "was physically present." The reviewer's own Step-1 selection supplies
 * the subjective "I personally interacted with this person" claim; this
 * repository never writes or reads attendance_status, and implements
 * nothing resembling organizer attendance confirmation.
 *
 * Safe retry (WS8.3A): submitting the exact same (reviewer, target, event,
 * wouldTravelAgain) answer again is treated as an idempotent success — the
 * existing row is returned, nothing new is written. Submitting a DIFFERENT
 * answer for an (reviewer, target, event) that already has one is an
 * attempted edit of immutable content and is rejected, rolling back the
 * whole batch (all-or-nothing), never partially applied. The transaction-
 * scoped advisory lock below (keyed to reviewer+event) serializes every
 * submission from the same reviewer for the same event, so the
 * read-existing-then-decide sequence below is race-free without needing a
 * database-level UPSERT — which would fire the table's tw_forbid_mutation
 * trigger regardless of whether the value actually changed, since that
 * trigger has no IS DISTINCT FROM check (it forbids every UPDATE
 * unconditionally, by design, for a strictly append-only table).
 */
@Injectable()
export class TravellerFeedbackRepository {
  constructor(private readonly dataSource: DataSource) {}

  async submitFeedback(
    reviewerUserId: string,
    eventId: string,
    items: readonly TravellerFeedbackItem[],
  ): Promise<readonly TravellerFeedbackView[]> {
    if (items.length === 0) return [];

    return this.dataSource.transaction(async (manager) => {
      await this.lock(manager, `traveller-feedback:${reviewerUserId}:${eventId}`);

      const event = await this.loadEvent(manager, eventId);
      this.assertEventEligible(event);
      await this.assertMember(manager, event, eventId, reviewerUserId);
      await this.assertAllMembers(
        manager,
        event,
        eventId,
        items.map((item) => item.targetUserId),
      );

      const existing = await this.loadExisting(
        manager,
        reviewerUserId,
        eventId,
        items.map((item) => item.targetUserId),
      );

      // Validate the complete request before any write: a differing stored
      // answer aborts the WHOLE batch, including targets that would
      // otherwise have been brand new — nothing is written in that case.
      const toInsert: TravellerFeedbackItem[] = [];
      for (const item of items) {
        const existingRow = existing.get(item.targetUserId);
        if (existingRow && existingRow.would_travel_again !== item.wouldTravelAgain) {
          throw new TravellerFeedbackAnswerConflictError();
        }
        if (!existingRow) toInsert.push(item);
      }

      const insertedRows = toInsert.length > 0 ? await this.insertFeedback(manager, reviewerUserId, eventId, toInsert) : [];
      // ON CONFLICT DO NOTHING is a defense-in-depth backstop only: under
      // the advisory lock above, nothing should race between loadExisting
      // and this insert. If it ever does, treat it the same as an answer
      // conflict rather than silently guessing which value won.
      if (insertedRows.length !== toInsert.length) throw new TravellerFeedbackAnswerConflictError();

      const byTarget = new Map<string, FeedbackRow>();
      for (const row of existing.values()) byTarget.set(row.target_user_id, row);
      for (const row of insertedRows) byTarget.set(row.target_user_id, row);

      // Original request order, not insertion order — identical-retry rows
      // and newly-inserted rows are returned side by side transparently.
      return items.map((item) => this.toView(byTarget.get(item.targetUserId)!));
    });
  }

  /**
   * Step-1 candidate list: every OTHER Event Feedback Member (host +
   * active participants). Answers only "who MAY be selected" — it asserts
   * nothing about attendance or interaction (WS8.3A: candidate !=
   * interaction confirmed). The requester must themselves be a member;
   * an unrelated authenticated user gets ParticipantNotEligibleError, same
   * as an ineligible submission attempt.
   */
  async listCandidates(
    requesterUserId: string,
    eventId: string,
  ): Promise<readonly TravellerFeedbackCandidateView[]> {
    return this.dataSource.transaction(async (manager) => {
      const event = await this.loadEvent(manager, eventId);
      this.assertEventEligible(event);
      await this.assertMember(manager, event, eventId, requesterUserId);

      return (await manager.query(
        `SELECT DISTINCT ON (member."userId")
                member."userId"      AS "userId",
                up.display_name      AS "displayName",
                up.avatar_url        AS "avatarUrl",
                member.role          AS "role"
           FROM (
             SELECT ep.user_id AS "userId", 'PARTICIPANT' AS role
               FROM event_participants ep
              WHERE ep.event_id = $1 AND ep.cancelled_at IS NULL
             UNION ALL
             SELECT e.host_user_id AS "userId", 'HOST' AS role
               FROM events e
              WHERE e.id = $1 AND e.host_type = 'USER' AND e.host_user_id IS NOT NULL
           ) member
           JOIN user_profiles up ON up.user_id = member."userId"
          WHERE member."userId" <> $2
          ORDER BY member."userId", member.role`,
        [eventId, requesterUserId],
      )) as CandidateRow[];
    });
  }

  private async lock(manager: EntityManager, key: string): Promise<void> {
    await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
  }

  private async loadEvent(manager: EntityManager, eventId: string): Promise<EventRow> {
    const rows = (await manager.query(
      `SELECT status, ends_at, host_type, host_user_id FROM events WHERE id = $1`,
      [eventId],
    )) as EventRow[];
    const event = rows[0];
    if (!event) throw new TravellerFeedbackEventNotFoundError();
    return event;
  }

  /**
   * V1 event-end boundary (deliberate): `current time >= event.ends_at`,
   * not `status = COMPLETED` — no lifecycle scheduler exists today to ever
   * reach COMPLETED (see WS8.0B), so requiring it would make this feature
   * permanently unreachable. `ends_at` is the practical, always-available
   * boundary; CANCELLED is rejected outright regardless of timing. Shared
   * by both submission and the candidate list — the list must not be
   * offered any earlier than submission itself would be accepted.
   */
  private assertEventEligible(event: EventRow): void {
    if (event.status === EventStatus.Cancelled) throw new EventNotEligibleForFeedbackError();
    const endsAt = event.ends_at instanceof Date ? event.ends_at : new Date(event.ends_at);
    if (Date.now() < endsAt.getTime()) throw new EventNotEligibleForFeedbackError();
  }

  /** True for the event's USER host, or an ACTIVE (non-cancelled) EventParticipant. Never both by construction (the host is never inserted into event_participants). */
  private isHost(event: EventRow, userId: string): boolean {
    return event.host_type === EventHostType.User && event.host_user_id === userId;
  }

  private async assertMember(
    manager: EntityManager,
    event: EventRow,
    eventId: string,
    userId: string,
  ): Promise<void> {
    if (this.isHost(event, userId)) return;
    const rows = await manager.query(
      `SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2 AND cancelled_at IS NULL LIMIT 1`,
      [eventId, userId],
    );
    if (rows.length === 0) throw new ParticipantNotEligibleError();
  }

  private async assertAllMembers(
    manager: EntityManager,
    event: EventRow,
    eventId: string,
    userIds: readonly string[],
  ): Promise<void> {
    const nonHostIds = userIds.filter((id) => !this.isHost(event, id));
    if (nonHostIds.length === 0) return;
    const rows = (await manager.query(
      `SELECT user_id FROM event_participants
        WHERE event_id = $1 AND user_id = ANY($2::uuid[]) AND cancelled_at IS NULL`,
      [eventId, nonHostIds],
    )) as { readonly user_id: string }[];
    const active = new Set(rows.map((row) => row.user_id));
    if (nonHostIds.some((id) => !active.has(id))) throw new ParticipantNotEligibleError();
  }

  private async loadExisting(
    manager: EntityManager,
    reviewerUserId: string,
    eventId: string,
    targetUserIds: readonly string[],
  ): Promise<Map<string, FeedbackRow>> {
    const rows = (await manager.query(
      `SELECT id, reviewer_user_id, target_user_id, event_id, would_travel_again, created_at
         FROM traveller_feedback
        WHERE reviewer_user_id = $1 AND event_id = $2 AND target_user_id = ANY($3::uuid[])`,
      [reviewerUserId, eventId, targetUserIds],
    )) as FeedbackRow[];
    return new Map(rows.map((row) => [row.target_user_id, row]));
  }

  private async insertFeedback(
    manager: EntityManager,
    reviewerUserId: string,
    eventId: string,
    items: readonly TravellerFeedbackItem[],
  ): Promise<FeedbackRow[]> {
    const params: unknown[] = [reviewerUserId, eventId];
    const valueRows = items.map((item) => {
      const targetIdx = params.push(item.targetUserId);
      const wouldTravelAgainIdx = params.push(item.wouldTravelAgain);
      return `($1, $2, $${targetIdx}, $${wouldTravelAgainIdx})`;
    });

    return (await manager.query(
      `INSERT INTO traveller_feedback (reviewer_user_id, event_id, target_user_id, would_travel_again)
       VALUES ${valueRows.join(', ')}
       ON CONFLICT DO NOTHING
       RETURNING id, reviewer_user_id, target_user_id, event_id, would_travel_again, created_at`,
      params,
    )) as FeedbackRow[];
  }

  private toView(row: FeedbackRow): TravellerFeedbackView {
    return {
      id: row.id,
      reviewerUserId: row.reviewer_user_id,
      targetUserId: row.target_user_id,
      eventId: row.event_id,
      wouldTravelAgain: row.would_travel_again,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    };
  }
}
