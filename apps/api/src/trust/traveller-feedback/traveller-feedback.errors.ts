import { AppError, ConflictError, ForbiddenError, ValidationError } from '../../common/errors/app-error';

export class SelfFeedbackError extends AppError {
  constructor() {
    super('SELF_FEEDBACK_NOT_ALLOWED', 'You cannot give feedback about yourself.', 422);
  }
}

/** A client-side batch defect (same target twice), caught before any DB access. */
export class DuplicateFeedbackTargetError extends ValidationError {
  constructor() {
    super('Each target may appear at most once per feedback submission.', { field: 'feedback' });
  }
}

export class TravellerFeedbackEventNotFoundError extends AppError {
  constructor() {
    super('EVENT_NOT_FOUND', 'Event not found.', 404);
  }
}

/**
 * Covers both "the event has not ended yet" and "the event was cancelled" —
 * deliberately undifferentiated, same reasoning as ReviewNotEligibleError:
 * a client should not be able to probe which specific fact failed.
 */
export class EventNotEligibleForFeedbackError extends ForbiddenError {
  constructor() {
    super(
      'EVENT_NOT_ELIGIBLE_FOR_FEEDBACK',
      'This event is not yet eligible for traveller feedback.',
    );
  }
}

/**
 * Covers "the reviewer is not an Event Feedback Member" and "a selected
 * target is not an Event Feedback Member" alike (WS8.3A) — Event Feedback
 * Member = the event's USER host, or an active (non-cancelled)
 * EventParticipant. Both failures mean the same thing to a client: this is
 * not yet an authoritative shared platform interaction.
 */
export class ParticipantNotEligibleError extends ForbiddenError {
  constructor() {
    super(
      'PARTICIPANT_NOT_ELIGIBLE',
      'Feedback requires both the reviewer and every selected traveller to belong to this event (its USER host, or an active, non-cancelled participant).',
    );
  }
}

/**
 * WS8.3A: raised ONLY when a stored answer for this exact
 * (reviewer, target, event) DIFFERS from the one just submitted — an
 * attempted edit of immutable feedback. An identical retry (same
 * wouldTravelAgain) is NOT an error; see TravellerFeedbackRepository's
 * safe-retry handling. Also used as the rare defense-in-depth backstop if
 * the advisory lock is ever bypassed and a genuine insert race occurs.
 */
export class TravellerFeedbackAnswerConflictError extends ConflictError {
  constructor() {
    super(
      'TRAVELLER_FEEDBACK_ANSWER_CONFLICT',
      'Feedback for one or more selected travellers already exists with a different answer for this event.',
    );
  }
}
