import { ModerationState } from '@tripwith/shared';

/**
 * Content-moderation decision, independent of interaction verification
 * (H1). is_verified answers "did this interaction really happen?";
 * moderation_state answers "is this content fit for public visibility and
 * aggregation?" — an attendance-verified review can still be harassment,
 * spam, or otherwise unfit to publish, so the two must never be set by the
 * same fact. `is_verified = TRUE, moderation_state = PENDING` is a normal,
 * expected state, not an edge case.
 *
 * Note this solves a different problem than Double-Blind: moderation asks
 * "is this content acceptable to publish at all?"; Double-Blind (not
 * implemented, deliberately deferred) asks "when may the counterparties see
 * each other's review?". Setting new reviews to PENDING here is not a
 * substitute for that — it does not hide a review from its author, gate it
 * on the counterparty's review existing, or introduce any reveal timing.
 *
 * There is no moderation queue/admin surface in Phase 8 (that is a Safety/
 * Moderation-phase concern), so this function has nothing to inspect yet —
 * it is the explicit, isolated policy boundary a future classifier or human
 * queue will replace. Until one exists, every new review starts PENDING:
 * attendance verification alone is not evidence that the *content* is fit
 * to publish or count toward a public aggregate, so nothing here may
 * auto-approve. `tw_sync_provider_rating` already only counts APPROVED
 * reviews, so a PENDING review correctly does not move provider rating
 * until something explicitly approves it.
 */
export function decideInitialModerationState(): ModerationState {
  return ModerationState.Pending;
}
