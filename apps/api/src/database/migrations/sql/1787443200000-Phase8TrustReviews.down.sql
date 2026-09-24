DROP TRIGGER IF EXISTS reviews_forbid_content_mutation ON reviews;
DROP FUNCTION IF EXISTS tw_forbid_review_content_mutation();

DROP INDEX IF EXISTS reviews_reviewer_provider_idx;

DROP INDEX IF EXISTS reviews_user_per_event_uk;
CREATE UNIQUE INDEX reviews_user_per_event_uk
  ON reviews (reviewer_user_id, event_id, target_user_id)
  WHERE target_type = 'USER' AND event_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_provider_reviewer_target_chk,
  DROP CONSTRAINT IF EXISTS reviews_reviewer_provider_chk,
  DROP COLUMN IF EXISTS signals,
  DROP COLUMN IF EXISTS reviewer_provider_id,
  DROP COLUMN IF EXISTS reviewer_type;

DROP TYPE IF EXISTS review_reviewer_type;
