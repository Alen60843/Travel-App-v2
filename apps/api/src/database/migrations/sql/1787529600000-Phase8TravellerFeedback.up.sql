-- Phase 8 (WS8.3): TRAVELLER FEEDBACK — Traveller -> Traveller.
--
-- WS8.2 concluded Traveller -> Traveller must NOT be a star review: it is
-- split into two distinct concepts a single reviews-table row cannot cleanly
-- express (rating is NOT NULL / CHECKed 1-5 there for the review-style
-- directions this table still serves — see 1787443200000-Phase8TrustReviews
-- and InitialSchema's `reviews` table). This is a NEW, ADDITIVE table
-- (Option T2), not a rewrite of `reviews`.
--
-- A row here represents exactly one fact:
--   "reviewer_user_id positively confirmed a meaningful interaction with
--    target_user_id during event_id, and answered whether they would
--    travel with them again."
--
-- Row existence IS the positive-interaction confirmation. There is
-- deliberately no `interacted BOOLEAN` column: a FALSE value there could
-- later be misread as "this person did not attend" or as negative evidence,
-- which is explicitly out of scope (no absence/no-show reporting in V1).
-- Omission (no row for a given reviewer/target/event) carries NO meaning
-- beyond "no positive confirmation was submitted" — never absence, never a
-- negative signal, never a Trust Score effect.
CREATE TABLE traveller_feedback (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  reviewer_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id             UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Mandatory: every stored row already implies positive interaction
  -- confirmation (via its own existence), so the only remaining question a
  -- row must answer is the reputation-feedback question itself.
  would_travel_again    BOOLEAN NOT NULL,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- No numeric rating, no body/text field, no moderation_state, no
  -- is_verified column in V1 — this is not a review and is not moderated
  -- content; it is a private evidence signal. No updated_at either: the row
  -- is fully immutable from the moment it exists (see the trigger below),
  -- so there is nothing for an updated_at column to ever record.
  CONSTRAINT traveller_feedback_no_self_chk
    CHECK (target_user_id <> reviewer_user_id)
);

-- At most one positive-interaction confirmation per (reviewer, target,
-- event) — the same defense-in-depth pattern as reviews_user_per_event_uk:
-- an application-level advisory lock (see TravellerFeedbackRepository)
-- serializes concurrent attempts, and this index is the correctness
-- backstop a retried/duplicate request always hits.
CREATE UNIQUE INDEX traveller_feedback_reviewer_target_event_uk
  ON traveller_feedback (reviewer_user_id, target_user_id, event_id);

-- Supports a future reputation policy reading "who has positively confirmed
-- interaction with this target" without a full table scan. No aggregation
-- is computed in V1 — this index only makes that future read cheap.
CREATE INDEX traveller_feedback_target_idx
  ON traveller_feedback (target_user_id, created_at DESC);

CREATE INDEX traveller_feedback_event_idx
  ON traveller_feedback (event_id);

-- Fully append-only: unlike `reviews` (which still permits system-managed
-- lifecycle columns like moderation_state/is_verified to change), a
-- traveller_feedback row has no lifecycle metadata at all — every column is
-- author-submitted content, so the whole row is immutable from INSERT.
-- Reuses the same generic guard trust_score_events/event_status_history
-- already use, rather than a bespoke column-list trigger.
CREATE TRIGGER traveller_feedback_append_only
  BEFORE UPDATE OR DELETE ON traveller_feedback
  FOR EACH ROW EXECUTE FUNCTION tw_forbid_mutation();
