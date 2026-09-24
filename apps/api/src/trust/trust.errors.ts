import { AppError, ConflictError, ForbiddenError } from '../common/errors/app-error';

/**
 * Covers every case where the caller has no authoritative TripWith
 * interaction to review against: no shared event, not attended (only
 * APPROVED to join, not ATTENDED), wrong event host, etc. Deliberately
 * undifferentiated so a client cannot probe which specific fact failed.
 */
export class ReviewNotEligibleError extends ForbiddenError {
  constructor() {
    super(
      'REVIEW_NOT_ELIGIBLE',
      'This review is not backed by a verified interaction on this event.',
    );
  }
}

export class SelfReviewError extends AppError {
  constructor() {
    super('SELF_REVIEW_NOT_ALLOWED', 'You cannot review yourself.', 422);
  }
}

export class ReviewAlreadyExistsError extends ConflictError {
  constructor() {
    super('REVIEW_ALREADY_EXISTS', 'A review for this interaction already exists.');
  }
}

/** The authenticated user does not own (and so cannot act for) the provider. */
export class ProviderReviewerNotAuthorizedError extends ForbiddenError {
  constructor() {
    super(
      'PROVIDER_REVIEWER_NOT_AUTHORIZED',
      'You are not authorized to review on behalf of this provider.',
    );
  }
}

/** A traveller -> provider review was attempted against a user-hosted event. */
export class EventNotProviderHostedError extends AppError {
  constructor() {
    super('EVENT_NOT_PROVIDER_HOSTED', 'This event has no provider to review.', 422);
  }
}
