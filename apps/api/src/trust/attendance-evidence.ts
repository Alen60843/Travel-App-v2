import { AttendanceStatus } from '@tripwith/shared';

/**
 * Attendance evidence, separated from the decisions it feeds (H4).
 *
 * `event_participants.attendance_status` is Phase 6's column, not Phase 8's
 * — this module never writes it, only reads it. Today it carries no
 * confidence gradient: nothing in this codebase distinguishes "the
 * traveller says they attended" from "the host/system confirmed it," so
 * CONFIRMED here means exactly one thing — ATTENDED — until a future phase
 * introduces a graded model (the product brief's own UNCONFIRMED /
 * SELF_CONFIRMED / VERIFIED / DISPUTED sketch, or something else — those
 * names are deliberately NOT encoded here).
 *
 * The two functions below evaluate to the same result today because only
 * one evidence tier exists. They are kept as separate, independently named
 * decision points — not one shared boolean — specifically so that when a
 * lower-confidence tier is approved (e.g. "may submit a review" but "not
 * strong enough to verify"), only the relevant function changes and every
 * call site keeps working unmodified.
 *
 * A third boundary — "is this evidence strong enough to affect trust?" — is
 * deliberately NOT defined here right now. Subjective review ratings do not
 * currently produce any trust_score_events at all (see reviews.repository.ts
 * — no reputation/trust projection policy exists yet), so a function
 * answering that question today would have no caller and no real meaning:
 * it would just be a second name for isEligibleForVerification, which is
 * exactly the kind of misleading dead boundary this module exists to avoid.
 * Reintroduce it, as its own decision point, when that projection policy is
 * actually built.
 */
export type AttendanceEvidence = 'NONE' | 'CONFIRMED';

export function attendanceEvidenceFor(status: AttendanceStatus): AttendanceEvidence {
  return status === AttendanceStatus.Attended ? 'CONFIRMED' : 'NONE';
}

/** C. May this actor submit a review at all? */
export function isEligibleToSubmitReview(evidence: AttendanceEvidence): boolean {
  return evidence === 'CONFIRMED';
}

/** D. Is this review backed by strong enough evidence to be marked is_verified? */
export function isEligibleForVerification(evidence: AttendanceEvidence): boolean {
  return evidence === 'CONFIRMED';
}
