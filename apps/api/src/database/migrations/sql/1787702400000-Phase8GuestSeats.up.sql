-- Phase 8 (WS8.5B): PARTY SIZE / GUEST SEATS — physical capacity.
--
-- Product decision: capacityMax now means the maximum TOTAL number of
-- physical human beings (registered TripWith users + their non-TripWith
-- guests), not the count of registered EventParticipant rows. That existing
-- count (participant_count) keeps its exact current meaning and trigger —
-- untouched below — because it is still what it always was: "how many
-- registered TripWith accounts are active participants." A new, separate
-- counter (reserved_seat_count) tracks physical occupancy.
--
-- Guests are NEVER platform identities: no users/user_profiles rows, no
-- event_participants rows, no chat_members rows are created for them
-- anywhere in this migration or the application code that uses it. A guest
-- exists only as an integer attached to the registered person bringing them.

-- ============================================================================
-- 1. guest_count on the historical request and the current membership row
-- ============================================================================
--
-- event_join_requests.guest_count is part of the immutable historical record
-- (WS8.4B's JoinRequest-vs-EventParticipant split is unchanged and preserved
-- here): once a request is decided, its guest_count must never be rewritten,
-- exactly like its message or requested_at. event_participants.guest_count is
-- the CURRENT membership's party size, copied from the approving request at
-- INSERT time and never updated again afterwards (there is no application
-- code path that writes it post-insert) — leave/remove cancels the whole row,
-- guests included, for free; it never needs its own cancellation record.

ALTER TABLE event_join_requests
  ADD COLUMN guest_count INT NOT NULL DEFAULT 0;
ALTER TABLE event_join_requests
  ADD CONSTRAINT event_join_requests_guest_count_chk CHECK (guest_count BETWEEN 0 AND 9999);

ALTER TABLE event_participants
  ADD COLUMN guest_count INT NOT NULL DEFAULT 0;
ALTER TABLE event_participants
  ADD CONSTRAINT event_participants_guest_count_chk CHECK (guest_count BETWEEN 0 AND 9999);

-- ============================================================================
-- 2. host_guest_count + reserved_seat_count on events
-- ============================================================================
--
-- host_guest_count is deliberately NOT an EventParticipant column — the USER
-- host still never gets an EventParticipant row (WS8.3A/WS8.4B decision,
-- unchanged) — it lives directly on events because the host's own party has
-- no other row to live on. It is application-editable only while DRAFT
-- (enforced in EventsService, same boundary as every other mutable Event
-- field) and frozen at publish; the column itself carries no such
-- restriction at the DB level, matching how capacity_max/title/etc. are
-- likewise DB-writable at any time but app-restricted to DRAFT.
--
-- reserved_seat_count is server/DB-owned only — no application code ever
-- writes it directly, exactly like participant_count. It represents total
-- physical occupancy:
--   USER-hosted:     (1 + host_guest_count) + SUM(1 + guest_count) over
--                     active (cancelled_at IS NULL) event_participants
--   provider-hosted: SUM(1 + guest_count) over active event_participants
--                     only — deliberately NO manufactured "provider host"
--                     physical seat; provider-hosted capacity semantics are
--                     out of scope for this workstream and are left exactly
--                     as capable/incapable as they were before this
--                     migration, just expressed through the same neutral
--                     counter rather than a second one.

ALTER TABLE events
  ADD COLUMN host_guest_count INT NOT NULL DEFAULT 0;
ALTER TABLE events
  ADD CONSTRAINT events_host_guest_count_chk CHECK (host_guest_count BETWEEN 0 AND 9999);

ALTER TABLE events
  ADD COLUMN reserved_seat_count INT NOT NULL DEFAULT 0;

-- Backfill: every existing event_participants.guest_count row is 0 (just
-- added above), so SUM(1 + guest_count) over active participants is exactly
-- today's participant_count — this is an exact, lossless restatement of
-- current occupancy under the new counter, not a guess.
UPDATE events
   SET reserved_seat_count =
         (CASE WHEN host_type = 'USER' THEN 1 + host_guest_count ELSE 0 END)
         + participant_count;

-- ----------------------------------------------------------------------------
-- Legacy safety preflight (explicit failure, never silent corruption).
--
-- Under the OLD meaning, capacity_max bounded participant_count alone and
-- excluded the host entirely. Under the NEW meaning, an existing USER-hosted
-- event that was already at capacity_max under the old accounting (e.g.
-- status FULL, participant_count = capacity_max) now has
-- reserved_seat_count = capacity_max + 1 — a genuine, real conflict with the
-- new events_reserved_seat_count_chk this migration is about to add.
--
-- This migration does NOT silently raise capacity_max (that is a business
-- decision about the event's real physical capacity, not something a
-- migration may assume) and does NOT delete/rewrite any historical
-- EventParticipant or JoinRequest row to make the numbers fit. It fails
-- loudly, before the CHECK is added, so the failure is legible and the
-- transaction rolls back leaving the database completely unchanged —
-- exactly the same "fail honestly rather than corrupt or silently succeed"
-- convention already established in 1787616000000-Phase8MembershipLifecycle
-- 's DOWN migration guard.
--
-- No PostgreSQL instance is available in this workstream to actually
-- exercise this preflight against real data; it is reviewed by inspection
-- only (see the WS8.5B report's legacy-migration-strategy section).
DO $$
DECLARE
  conflicting_events INT;
BEGIN
  SELECT count(*) INTO conflicting_events
    FROM events
   WHERE reserved_seat_count > capacity_max;

  IF conflicting_events > 0 THEN
    RAISE EXCEPTION
      'Cannot apply Phase8GuestSeats: % existing Event row(s) have more physical occupancy under the new capacityMax meaning (host + participants, all guest_count=0 for pre-existing rows) than their current capacity_max allows. This migration will not silently raise capacity_max or discard/rewrite historical EventParticipant or JoinRequest rows to make the numbers fit. Resolve each conflicting event''s capacity_max (a real product/business decision) before re-running this migration.',
      conflicting_events
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

ALTER TABLE events
  ADD CONSTRAINT events_reserved_seat_count_chk CHECK (reserved_seat_count >= 0);
ALTER TABLE events
  ADD CONSTRAINT events_reserved_seat_count_capacity_chk CHECK (reserved_seat_count <= capacity_max);
-- USER-hosted only: the host's own party alone may never exceed capacity —
-- checked here independently of participants, at the row level, so it is
-- caught even before any EventParticipant exists.
ALTER TABLE events
  ADD CONSTRAINT events_host_party_capacity_chk
    CHECK (host_type <> 'USER' OR (1 + host_guest_count) <= capacity_max);

-- ============================================================================
-- 3. reserved_seat_count maintenance triggers
-- ============================================================================
--
-- Three narrow triggers, mirroring tw_sync_participant_count's existing
-- philosophy exactly (server/DB-owned, never application-written), scoped to
-- only the column changes that can actually occur:
--   - new Event row: seed from host_type/host_guest_count (no participants
--     can exist yet for a just-inserted row).
--   - host_guest_count changes (application restricts this to DRAFT, but the
--     trigger itself is correct unconditionally): adjust by the exact delta.
--   - event_participants changes: identical shape to tw_sync_participant_count
--     but weighted by (1 + guest_count) instead of a flat 1. Scoped to
--     INSERT, UPDATE OF cancelled_at OR guest_count, DELETE.
--
-- WS8.5C hardening (was WS8.5B issue): application code never updates
-- guest_count after INSERT today, but reserved_seat_count is declared
-- DB-authoritative — a database-level mutation of guest_count (an admin
-- correction, a future feature, a direct SQL fix) must not silently desync
-- the counter. Explicitly covering UPDATE OF guest_count is defense in
-- depth for exactly that case; no application endpoint for editing an
-- approved participant's guestCount is added by this.

CREATE OR REPLACE FUNCTION tw_seed_reserved_seat_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.reserved_seat_count := CASE WHEN NEW.host_type = 'USER' THEN 1 + NEW.host_guest_count ELSE 0 END;
  RETURN NEW;
END $$;

CREATE TRIGGER events_seed_reserved_seat_count
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION tw_seed_reserved_seat_count();

CREATE OR REPLACE FUNCTION tw_adjust_reserved_seat_count_for_host() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.host_type = 'USER' THEN
    NEW.reserved_seat_count := NEW.reserved_seat_count - OLD.host_guest_count + NEW.host_guest_count;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER events_adjust_reserved_seat_count_for_host
  BEFORE UPDATE OF host_guest_count ON events
  FOR EACH ROW EXECUTE FUNCTION tw_adjust_reserved_seat_count_for_host();

CREATE OR REPLACE FUNCTION tw_sync_reserved_seat_count() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  delta INT := 0;
  target UUID := COALESCE(NEW.event_id, OLD.event_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    delta := CASE WHEN NEW.cancelled_at IS NULL THEN 1 + NEW.guest_count ELSE 0 END;
  ELSIF TG_OP = 'DELETE' THEN
    delta := CASE WHEN OLD.cancelled_at IS NULL THEN -(1 + OLD.guest_count) ELSE 0 END;
  ELSE
    delta := CASE WHEN NEW.cancelled_at IS NULL THEN 1 + NEW.guest_count ELSE 0 END
           - CASE WHEN OLD.cancelled_at IS NULL THEN 1 + OLD.guest_count ELSE 0 END;
  END IF;

  IF delta <> 0 THEN
    UPDATE events SET reserved_seat_count = reserved_seat_count + delta WHERE id = target;
  END IF;

  RETURN NULL;
END $$;

CREATE TRIGGER event_participants_sync_reserved_seats
  AFTER INSERT OR UPDATE OF cancelled_at, guest_count OR DELETE ON event_participants
  FOR EACH ROW EXECUTE FUNCTION tw_sync_reserved_seat_count();

-- ============================================================================
-- 4. Event status transition graph: allow DRAFT -> FULL
-- ============================================================================
--
-- A USER host whose own party (1 + host_guest_count) already equals
-- capacity_max fills the Event before anyone else can ever join. Publishing
-- such an Event must land it in FULL, not ACTIVE (which would incorrectly
-- advertise it as joinable). DRAFT -> FULL did not previously exist in the
-- transition allowlist; this is a minimal, additive extension of the
-- existing discrete allowlist (packages/shared/src/enums.ts's
-- EVENT_STATUS_TRANSITIONS is extended identically), not a weakening of the
-- state machine — every other transition remains exactly as strict as
-- before. tw_event_status_guard is redefined here via CREATE OR REPLACE
-- (the original definition in 1787184000000-InitialSchema is left
-- untouched on disk) because a trigger function, unlike a table, is safe
-- and idiomatic to evolve in a later migration.
CREATE OR REPLACE FUNCTION tw_event_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed CONSTANT TEXT[] := ARRAY[
    'DRAFT>ACTIVE', 'DRAFT>FULL', 'DRAFT>CANCELLED',
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

-- ============================================================================
-- 5. WS8.5C: flexible capacity overrides
-- ============================================================================
--
-- Product decision: capacityMax is a configured/planned limit, not always a
-- hard physical wall. A Join Request whose party does not fit CURRENT
-- remaining capacity may now still be CREATED (see JoinRequestsService —
-- the WS8.5B create()-time capacity rejection is removed); the USER host may
-- explicitly approve it, atomically raising capacityMax to the exact
-- minimum value required, never more, and never client-supplied.
--
-- Two independent pieces of immutable evidence, both living on
-- event_join_requests (never on event_participants — the override is a
-- fact about the DECISION, not the ongoing membership; WS8.4B's
-- JoinRequest = historical decision record / EventParticipant = current
-- membership split is preserved unchanged):
--
--   (a) capacity_max_at_request / reserved_seat_count_at_request — a
--       server-derived snapshot of what capacity looked like AT REQUEST
--       TIME, taken under the same Event-row lock create() already holds.
--       Written once, at INSERT, never rewritten — exactly like guest_count.
--       From these plus guest_count, "did this exceed capacity when
--       submitted, and by how much" is always reconstructible even after
--       capacityMax later changes for unrelated reasons (an override on a
--       DIFFERENT request, a seat freeing up, etc.).
--
--       WS8.5D: both columns are NULLABLE. A JoinRequest that already
--       existed before this migration has no historically-true value for
--       either column — the true capacity state at ITS request time was
--       never recorded anywhere, and nothing in this schema can recover it.
--       This migration deliberately leaves both NULL for every pre-existing
--       row rather than backfilling them from the Event's CURRENT
--       capacity_max/reserved_seat_count, which would fabricate a precise-
--       looking historical fact that was never actually true (see the
--       WS8.6A audit finding on this exact point). The two columns are
--       constrained to be NULL together or non-NULL together
--       (event_join_requests_capacity_snapshot_chk below) — "snapshot
--       unavailable" is a first-class, permanent, honest state, not an
--       artifact of migration timing. Every JoinRequest created by
--       JoinRequestsService.create() from this migration onward always
--       supplies both, non-null, read under the Event lock at INSERT time.
--
--   (b) capacity_override_approved_at / _by_user_id /
--       capacity_before_override / capacity_after_override — populated
--       together, exactly once, ONLY when an actual override was used to
--       approve this specific request (JoinRequestsService only sets these
--       when the party did not already fit at approval time — a request
--       that merely EXCEEDED capacity when submitted but fits again by
--       approval time, because someone left, is approved normally with
--       these left NULL). All four NULL together is the overwhelmingly
--       common case; all four NOT NULL together means "this exact
--       approval required the host to explicitly expand capacityMax."

ALTER TABLE event_join_requests
  ADD COLUMN capacity_max_at_request INT,
  ADD COLUMN reserved_seat_count_at_request INT,
  ADD COLUMN capacity_override_approved_at TIMESTAMPTZ,
  ADD COLUMN capacity_override_approved_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN capacity_before_override INT,
  ADD COLUMN capacity_after_override INT;

-- WS8.5D: deliberately NO backfill. Pre-existing rows keep both columns
-- NULL — see the column comments above and the WS8.6A audit finding this
-- corrects. No historical reconstruction, estimation, or approximation from
-- current Event state is performed.

ALTER TABLE event_join_requests
  ADD CONSTRAINT event_join_requests_capacity_snapshot_chk
    CHECK (
      (capacity_max_at_request IS NULL) = (reserved_seat_count_at_request IS NULL)
      AND (capacity_max_at_request IS NULL OR capacity_max_at_request >= 1)
      AND (reserved_seat_count_at_request IS NULL OR reserved_seat_count_at_request >= 0)
    );

ALTER TABLE event_join_requests
  ADD CONSTRAINT event_join_requests_capacity_override_chk CHECK (
    (capacity_override_approved_at IS NULL) = (capacity_override_approved_by_user_id IS NULL)
    AND (capacity_override_approved_at IS NULL) = (capacity_before_override IS NULL)
    AND (capacity_override_approved_at IS NULL) = (capacity_after_override IS NULL)
    -- When an override did happen, it must have actually raised capacity —
    -- never a no-op or a decrease recorded as "override" evidence.
    AND (capacity_after_override IS NULL OR capacity_after_override > capacity_before_override)
  );
