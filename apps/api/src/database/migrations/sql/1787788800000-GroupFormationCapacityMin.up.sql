-- Group Formation Step 1: an optional minimum group size for an Event.
--
-- capacity_min is the minimum number of PHYSICAL people (the same unit as
-- capacity_max and reserved_seat_count, per Phase8GuestSeats) that must be
-- committed before the Event is presented as confirmed. It is a planning
-- threshold, not a hard wall: nothing below it is rejected, and nothing here
-- adds a lifecycle status. FORMING / CONFIRMED are derived at read time from
-- (status, capacity_min, reserved_seat_count) in exactly one server-side
-- place (apps/api/src/events/event-group-state.ts) — never stored — so there
-- is no second state machine that could drift from the DB-owned seat counter.
--
-- NULL means the Event has no minimum group requirement. Every existing row
-- keeps that meaning, so no backfill is needed or performed.

ALTER TABLE events
  ADD COLUMN capacity_min INT;

-- capacity_min may never exceed capacity_max. A capacity override
-- (JoinRequestsService.approveWithCapacityOverride) only ever RAISES
-- capacity_max, so it can never invalidate this pair; lowering capacity_max
-- below an existing capacity_min is rejected here as the authoritative backstop
-- to the application's own validation.
ALTER TABLE events
  ADD CONSTRAINT events_capacity_min_chk
    CHECK (capacity_min IS NULL OR (capacity_min >= 1 AND capacity_min <= capacity_max));
