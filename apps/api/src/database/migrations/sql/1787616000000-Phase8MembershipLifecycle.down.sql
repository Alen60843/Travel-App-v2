-- The UP migration intentionally permits multiple historical APPROVED
-- JoinRequests per (event_id, user_id) — the expected shape of repeated
-- approve -> leave -> rejoin cycles (WS8.4B). The legacy
-- event_join_requests_active_uk this DOWN migration would otherwise recreate
-- allowed at most ONE live PENDING-or-APPROVED row per (event_id, user_id).
-- If real WS8.4B usage has produced more than one APPROVED row for the same
-- pair, that legacy index can no longer be created at all — and CREATE
-- UNIQUE INDEX would fail with an opaque duplicate-key error that gives no
-- hint why, or (worse) an implementer could be tempted to silently delete or
-- rewrite the "extra" historical rows just to make it fit. Neither is
-- acceptable: valid membership history is never destroyed or falsified to
-- satisfy a rollback. Fail explicitly, before touching the index at all.
DO $$
DECLARE
  conflicting_pairs INT;
BEGIN
  SELECT count(*) INTO conflicting_pairs FROM (
    SELECT event_id, user_id
      FROM event_join_requests
     WHERE status IN ('PENDING', 'APPROVED')
     GROUP BY event_id, user_id
    HAVING count(*) > 1
  ) conflicts;

  IF conflicting_pairs > 0 THEN
    RAISE EXCEPTION
      'Cannot downgrade Phase8MembershipLifecycle: % (event_id, user_id) pair(s) have more than one PENDING/APPROVED event_join_requests row, produced by valid WS8.4B leave/rejoin cycles. Restoring the legacy event_join_requests_active_uk unique index (at most one PENDING-or-APPROVED row per pair) would require deleting or falsifying real historical JoinRequest rows, which this migration refuses to do. This downgrade cannot proceed while such history exists.',
      conflicting_pairs
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

DROP INDEX IF EXISTS event_join_requests_pending_uk;
CREATE UNIQUE INDEX event_join_requests_active_uk
  ON event_join_requests (event_id, user_id)
  WHERE status IN ('PENDING', 'APPROVED');

ALTER TABLE event_participants
  DROP CONSTRAINT IF EXISTS event_participants_cancel_consistency_chk;

ALTER TABLE event_participants
  ADD CONSTRAINT event_participants_cancel_consistency_chk
    CHECK ((attendance_status = 'CANCELLED') = (cancelled_at IS NOT NULL));

ALTER TABLE event_participants
  DROP COLUMN IF EXISTS cancellation_reason,
  DROP COLUMN IF EXISTS cancelled_by_user_id;

DROP TYPE IF EXISTS event_participant_cancellation_reason;
