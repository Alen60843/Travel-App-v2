/**
 * A stored row IS the positive-interaction confirmation — there is no
 * `interacted` field to expose because there is no FALSE state to represent
 * (see traveller_feedback migration comment). Omitted targets never appear
 * here at all; their absence carries no meaning this view could encode.
 */
export interface TravellerFeedbackView {
  readonly id: string;
  readonly reviewerUserId: string;
  readonly targetUserId: string;
  readonly eventId: string;
  readonly wouldTravelAgain: boolean;
  readonly createdAt: string;
}

/**
 * WS8.3A: whether this member belongs to the event as its USER host or as
 * an ordinary (non-cancelled) participant. Purely descriptive for the
 * Step-1 UI — it is NOT an attendance/interaction claim (candidate !=
 * interaction confirmed; see traveller-feedback.repository.ts).
 */
export type TravellerFeedbackMemberRole = 'HOST' | 'PARTICIPANT';

/**
 * One Step-1 candidate: an "Event Feedback Member" other than the
 * requester. Deliberately the smallest existing safe public profile shape
 * already used elsewhere (see matching/candidates/candidate.types.ts's
 * CandidateCoarseResult) — userId + displayName + avatarUrl — with no
 * email/phone/firebase_uid/date-of-birth/trust_score_raw/account metadata.
 */
export interface TravellerFeedbackCandidateView {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly role: TravellerFeedbackMemberRole;
}
