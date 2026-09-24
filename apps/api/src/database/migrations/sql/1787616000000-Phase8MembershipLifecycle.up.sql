-- Phase 8 (WS8.4B): PARTICIPANT LEAVE / ORGANIZER REMOVE — membership lifecycle.
--
-- Two independent, additive changes. Neither touches InitialSchema's tables
-- structurally beyond ALTER; nothing here rewrites history.

-- ============================================================================
-- 1. Cancellation audit metadata on event_participants
-- ============================================================================
--
-- WS8.4A found no actor/reason fields existed. V1 needs exactly two: who
-- ended the membership, and which of exactly two reasons. Both are NULL for
-- an active participant and NOT NULL together for a cancelled one — the
-- existing event_participants_cancel_consistency_chk (cancelled_at <=>
-- attendance_status = 'CANCELLED') is extended, not replaced twice, so all
-- three facts (cancelled_at, attendance_status, and this new audit pair)
-- stay provably in lockstep at the database level, not just by application
-- discipline.

CREATE TYPE event_participant_cancellation_reason AS ENUM ('VOLUNTARY_LEAVE', 'HOST_REMOVAL');

-- cancelled_by_user_id is ON DELETE RESTRICT, not SET NULL, and deliberately
-- so: NULL only ever means "not cancelled" here — the CHECK below requires
-- cancelled_by_user_id IS NOT NULL whenever cancelled_at IS NOT NULL, so a
-- hard DELETE of the actor user would otherwise silently produce a row that
-- violates that CHECK (a cancelled participation with no recorded actor).
-- This is the opposite situation from event_status_history.actor_user_id or
-- trust_score_events.source_user_id, both ON DELETE SET NULL, because NULL
-- is an independently valid, meaningful state for THOSE columns ("system
-- job", "no counterparty") — it is not a valid state here once cancelled_at
-- is set. RESTRICT also matches this schema's own user-deletion model:
-- accounts are never hard-deleted (GDPR erasure anonymises the users row;
-- see InitialSchema's soft-delete comment on users.deleted_at), so RESTRICT
-- should never actually fire in practice — it exists to fail loudly instead
-- of silently corrupting audit evidence if that model is ever violated.
ALTER TABLE event_participants
  ADD COLUMN cancelled_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN cancellation_reason event_participant_cancellation_reason;

ALTER TABLE event_participants
  DROP CONSTRAINT event_participants_cancel_consistency_chk;

ALTER TABLE event_participants
  ADD CONSTRAINT event_participants_cancel_consistency_chk CHECK (
    (attendance_status = 'CANCELLED') = (cancelled_at IS NOT NULL)
    AND (cancelled_at IS NOT NULL) = (cancellation_reason IS NOT NULL)
    AND (cancelled_at IS NOT NULL) = (cancelled_by_user_id IS NOT NULL)
  );

-- ============================================================================
-- 2. JoinRequest uniqueness: PENDING blocks a new request; APPROVED does not
-- ============================================================================
--
-- WS8.4A's central finding: event_join_requests_active_uk (event_id, user_id)
-- WHERE status IN ('PENDING','APPROVED') meant a historical APPROVED request
-- would block a rejoin FOREVER once its EventParticipant was later cancelled,
-- because nothing ever transitions an APPROVED request's status (that would
-- falsify history — WS8.4B's product decision explicitly forbids it).
--
-- Current membership is event_participants.cancelled_at IS NULL
-- (event_participants_active_uk already protects that correctly — untouched
-- here). JoinRequest uniqueness now protects exactly what it should:
-- "at most one OUTSTANDING (undecided) request per (event, user)". Multiple
-- APPROVED requests over time for the same (event, user) pair are the
-- expected shape of a leave-then-rejoin cycle, not a bug.
DROP INDEX event_join_requests_active_uk;
CREATE UNIQUE INDEX event_join_requests_pending_uk
  ON event_join_requests (event_id, user_id)
  WHERE status = 'PENDING';
