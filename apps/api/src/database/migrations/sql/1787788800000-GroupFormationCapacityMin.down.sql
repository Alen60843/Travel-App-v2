-- Downgrade preflight — fail loudly, never silently discard a minimum group
-- requirement an organizer set. Same rollback-safety principle as the Phase 8
-- migrations: if dropping the column would lose meaningful data, refuse, and
-- rewrite nothing to force the downgrade through.
DO $$
DECLARE
  events_with_minimum INT;
BEGIN
  SELECT count(*) INTO events_with_minimum FROM events WHERE capacity_min IS NOT NULL;

  IF events_with_minimum > 0 THEN
    RAISE EXCEPTION
      'Cannot downgrade GroupFormationCapacityMin: % Event row(s) have a non-NULL capacity_min. Dropping the column would silently discard their minimum group requirement. No Event row will be rewritten to force this downgrade through; clear capacity_min deliberately first if that is truly intended.',
      events_with_minimum
      USING ERRCODE = 'restrict_violation';
  END IF;
END $$;

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_capacity_min_chk,
  DROP COLUMN IF EXISTS capacity_min;
