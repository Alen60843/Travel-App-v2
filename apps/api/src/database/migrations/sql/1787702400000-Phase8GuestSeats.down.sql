-- ----------------------------------------------------------------------------
-- Downgrade preflight (WS8.5C hardening) — fail loudly, never silently
-- destroy or falsify Guest Seats / capacity-override history.
--
-- A downgrade past this migration necessarily drops guest_count,
-- host_guest_count, the request-time capacity snapshot, and the
-- capacity-override audit trail. That is only acceptable if none of that
-- data carries real meaning yet. This block detects every concrete case
-- the task specifies and refuses outright if any exist — it never rewrites
-- a guest count to zero, deletes a historical request or participant, or
-- silently undoes a capacity change.
--
-- Deliberately NOT checked here (see the WS8.5B/WS8.5C reports' capacity-
-- semantics-downgrade analysis): capacity_max_at_request/
-- reserved_seat_count_at_request exist as NOT NULL on every row by this
-- point, so "any row has a snapshot" is true universally and would make
-- downgrade permanently impossible even on a pristine, untouched database —
-- over-strict beyond what the task asks ("at minimum detect" the concrete
-- list below). The snapshot columns are still dropped below; on a database
-- where none of the concrete conditions fire, their loss is provably inert
-- (no override was ever exceptional, so the snapshot was never actually
-- consulted for anything beyond its own row).
--
-- Also deliberately NOT resolved here: whether an untouched capacity_max
-- value (host_guest_count = 0, no override) can be safely reinterpreted
-- under the OLD "excludes host" meaning. It cannot be proven either way
-- from stored data alone — the column has always been a plain integer, and
-- nothing records which semantic regime a given value was chosen under.
-- This migration does not attempt that proof and does not alter
-- capacity_max's numeric value in either direction; the interpretation gap
-- is a known, documented, unresolved risk of downgrading at all (see the
-- report), not something silently patched over here.
DO $$
DECLARE
  join_request_guests INT;
  participant_guests INT;
  hosted_guests INT;
  overrides_used INT;
BEGIN
  SELECT count(*) INTO join_request_guests FROM event_join_requests WHERE guest_count <> 0;
  SELECT count(*) INTO participant_guests FROM event_participants WHERE guest_count <> 0;
  SELECT count(*) INTO hosted_guests FROM events WHERE host_type = 'USER' AND host_guest_count <> 0;
  SELECT count(*) INTO overrides_used FROM event_join_requests WHERE capacity_override_approved_at IS NOT NULL;

  IF join_request_guests > 0 OR participant_guests > 0 OR hosted_guests > 0 OR overrides_used > 0 THEN
    RAISE EXCEPTION
      'Cannot downgrade Phase8GuestSeats: meaningful Guest Seats / capacity-override history exists (% JoinRequest guest_count<>0, % EventParticipant guest_count<>0, % USER-hosted host_guest_count<>0, % capacity overrides used). This migration will not zero out guest counts, delete historical requests or participants, or silently undo an organizer-approved capacity change. Resolve or accept this data before downgrading past Phase8GuestSeats.',
      join_request_guests, participant_guests, hosted_guests, overrides_used
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

ALTER TABLE event_join_requests
  DROP CONSTRAINT IF EXISTS event_join_requests_capacity_override_chk,
  DROP CONSTRAINT IF EXISTS event_join_requests_capacity_snapshot_chk,
  DROP COLUMN IF EXISTS capacity_after_override,
  DROP COLUMN IF EXISTS capacity_before_override,
  DROP COLUMN IF EXISTS capacity_override_approved_by_user_id,
  DROP COLUMN IF EXISTS capacity_override_approved_at,
  DROP COLUMN IF EXISTS reserved_seat_count_at_request,
  DROP COLUMN IF EXISTS capacity_max_at_request;

DROP TRIGGER IF EXISTS event_participants_sync_reserved_seats ON event_participants;
DROP FUNCTION IF EXISTS tw_sync_reserved_seat_count();

DROP TRIGGER IF EXISTS events_adjust_reserved_seat_count_for_host ON events;
DROP FUNCTION IF EXISTS tw_adjust_reserved_seat_count_for_host();

DROP TRIGGER IF EXISTS events_seed_reserved_seat_count ON events;
DROP FUNCTION IF EXISTS tw_seed_reserved_seat_count();

-- Restore the exact original transition allowlist (no DRAFT>FULL) from
-- 1787184000000-InitialSchema, byte-for-byte.
CREATE OR REPLACE FUNCTION tw_event_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed CONSTANT TEXT[] := ARRAY[
    'DRAFT>ACTIVE', 'DRAFT>CANCELLED',
    'ACTIVE>FULL', 'ACTIVE>IN_PROGRESS', 'ACTIVE>CANCELLED',
    'FULL>ACTIVE', 'FULL>IN_PROGRESS', 'FULL>CANCELLED',
    'IN_PROGRESS>COMPLETED', 'IN_PROGRESS>CANCELLED'
  ];
  transition TEXT := OLD.status::TEXT || '>' || NEW.status::TEXT;
BEGIN
  IF OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  IF NOT (transition = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal event status transition %', transition
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO event_status_history (event_id, from_status, to_status, actor_user_id, reason)
  VALUES (
    NEW.id,
    OLD.status,
    NEW.status,
    NULLIF(current_setting('tripwith.actor_user_id', TRUE), '')::UUID,
    NULLIF(current_setting('tripwith.transition_reason', TRUE), '')
  );

  RETURN NEW;
END $$;

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_host_party_capacity_chk,
  DROP CONSTRAINT IF EXISTS events_reserved_seat_count_capacity_chk,
  DROP CONSTRAINT IF EXISTS events_reserved_seat_count_chk,
  DROP CONSTRAINT IF EXISTS events_host_guest_count_chk,
  DROP COLUMN IF EXISTS reserved_seat_count,
  DROP COLUMN IF EXISTS host_guest_count;

ALTER TABLE event_participants
  DROP CONSTRAINT IF EXISTS event_participants_guest_count_chk,
  DROP COLUMN IF EXISTS guest_count;

ALTER TABLE event_join_requests
  DROP CONSTRAINT IF EXISTS event_join_requests_guest_count_chk,
  DROP COLUMN IF EXISTS guest_count;
