-- Phase 8: TRUST & REVIEWS — reviewer capacity.
--
-- The existing reviews table can express WHO is reviewed (target_type /
-- target_user_id / target_provider_id) but not WHAT CAPACITY the reviewer
-- acted in. A provider owner reviewing a traveller and an ordinary
-- traveller reviewing that same traveller for the same event are currently
-- indistinguishable: both are just reviewer_user_id -> target_user_id. That
-- collapses a materially different domain fact (the review carries the
-- provider's authority, not just the individual's) into an ordinary peer
-- review. Provider -> Traveller review requires this be preserved.

CREATE TYPE review_reviewer_type AS ENUM ('TRAVELLER', 'PROVIDER');

ALTER TABLE reviews
  ADD COLUMN reviewer_type review_reviewer_type NOT NULL DEFAULT 'TRAVELLER',
  ADD COLUMN reviewer_provider_id UUID REFERENCES providers(id) ON DELETE CASCADE,
  -- Direction-specific advisory signals (wouldTravelAgain, wouldRecommend...).
  -- Not fixed columns: the question set differs per direction, none of them
  -- are individually queried, aggregated, or moderated (only `rating` and
  -- `moderation_state` are), and shape is validated by the application DTO
  -- layer. Same design already used for provider_external_sources'
  -- cached_opening_hours — an allowlisted, non-authoritative JSON blob, not
  -- a raw payload dump.
  ADD COLUMN signals JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE reviews ALTER COLUMN reviewer_type DROP DEFAULT;

ALTER TABLE reviews
  ADD CONSTRAINT reviews_reviewer_provider_chk CHECK (
    (reviewer_type = 'PROVIDER' AND reviewer_provider_id IS NOT NULL) OR
    (reviewer_type = 'TRAVELLER' AND reviewer_provider_id IS NULL)
  ),
  -- Providers review travellers only; there is no provider-vs-provider
  -- review relationship in the domain.
  ADD CONSTRAINT reviews_provider_reviewer_target_chk CHECK (
    reviewer_type <> 'PROVIDER' OR target_type = 'USER'
  );

-- The old per-event uniqueness collapsed "reviewed as a fellow traveller"
-- and "reviewed as the event's provider" into the same key, which would
-- silently block the second review once §6's reviewer_type exists. Replace
-- it with a reviewer_type-aware index so both can coexist for one event.
DROP INDEX reviews_user_per_event_uk;
CREATE UNIQUE INDEX reviews_user_per_event_uk
  ON reviews (reviewer_user_id, reviewer_type, event_id, target_user_id)
  WHERE target_type = 'USER' AND event_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX reviews_reviewer_provider_idx
  ON reviews (reviewer_provider_id, created_at DESC)
  WHERE reviewer_provider_id IS NOT NULL;


-- Review immutability (H2 / Product Decision C).
--
-- A review is submitted evidence: once written, the AUTHOR must never be
-- able to see the counterparty's review and rewrite their own rating/body/
-- signals in response. That is the only thing this trigger protects.
--
-- Deliberately narrower than tw_forbid_mutation (reviews is not a pure
-- append-only table like trust_score_events): moderation_state,
-- deleted_at, and updated_at are all system-managed lifecycle metadata
-- that must remain writable (PENDING -> APPROVED/REJECTED, soft-delete).
--
-- is_verified is ALSO excluded from this guard, deliberately, on the same
-- reasoning: it records a system fact about the interaction ("did this
-- happen, per the evidence we have"), not the author's submission. If
-- stronger or disputing evidence arrives later, the system must be able to
-- revise it — this trigger only forbids the AUTHOR-submitted content
-- (identity/target/event, rating, body, signals) and the row's original
-- created_at from ever changing. No code path writes is_verified after
-- INSERT today; this only removes a database-level obstacle to a future
-- one that a later, explicitly-approved evidence-processing phase would
-- add — it does not itself add that phase.
CREATE OR REPLACE FUNCTION tw_forbid_review_content_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reviewer_user_id     IS DISTINCT FROM OLD.reviewer_user_id
  OR NEW.reviewer_type        IS DISTINCT FROM OLD.reviewer_type
  OR NEW.reviewer_provider_id IS DISTINCT FROM OLD.reviewer_provider_id
  OR NEW.target_type          IS DISTINCT FROM OLD.target_type
  OR NEW.target_user_id       IS DISTINCT FROM OLD.target_user_id
  OR NEW.target_provider_id   IS DISTINCT FROM OLD.target_provider_id
  OR NEW.event_id             IS DISTINCT FROM OLD.event_id
  OR NEW.rating                 IS DISTINCT FROM OLD.rating
  OR NEW.body                   IS DISTINCT FROM OLD.body
  OR NEW.signals                IS DISTINCT FROM OLD.signals
  OR NEW.created_at              IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'reviews.% author-submitted content is immutable once submitted; only is_verified, moderation_state, deleted_at and updated_at may change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER reviews_forbid_content_mutation
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION tw_forbid_review_content_mutation();
