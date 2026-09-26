import { ApiError } from './errors';

export interface ApiErrorPresentation {
  readonly title: string;
  readonly message: string;
  /** Shown so a reported problem can be found in API logs. */
  readonly reference: string | null;
  /** The user should sign in again to recover. */
  readonly requiresSignIn: boolean;
}

/**
 * Turns any failure from the API client into screen copy. Backend codes come
 * from the API's single error envelope; nothing here re-implements a backend
 * rule — it only chooses wording.
 */
export function presentApiError(error: unknown): ApiErrorPresentation {
  if (!(error instanceof ApiError)) {
    return { title: 'Something went wrong', message: 'Please try again.', reference: null, requiresSignIn: false };
  }
  const reference = error.correlationId;
  switch (error.code) {
    case 'AUTH_ACCOUNT_NOT_PROVISIONED':
      return {
        title: 'No TripWith account yet',
        message: 'You are signed in to Firebase, but this identity has not been set up in TripWith yet.',
        reference,
        requiresSignIn: false,
      };
    case 'AUTH_TOKEN_MISSING':
    case 'AUTH_BEARER_MALFORMED':
    case 'AUTH_TOKEN_INVALID':
    case 'AUTH_TOKEN_EXPIRED':
    case 'AUTH_TOKEN_REVOKED':
    case 'AUTH_TOKEN_WRONG_AUDIENCE':
      return {
        title: 'Session not accepted',
        message: 'TripWith could not verify your sign-in. Sign out and sign in again.',
        reference,
        requiresSignIn: true,
      };
    case 'API_NOT_CONFIGURED':
    case 'NETWORK_ERROR':
      return { title: 'Cannot reach TripWith', message: error.message, reference: null, requiresSignIn: false };
    default:
      return { title: 'Something went wrong', message: error.message, reference, requiresSignIn: false };
  }
}
