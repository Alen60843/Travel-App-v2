import { authSession } from '../auth/session';
import { createApiClient } from './client';

/**
 * The app-wide TripWith API client. Every request asks the auth session for a
 * current Firebase ID token and sends it as `Authorization: Bearer <token>`;
 * when nobody is signed in no header is sent (and protected endpoints answer
 * 401). Screens never handle tokens themselves.
 */
export const tripwithApi = createApiClient({ getAuthToken: () => authSession.getIdToken() });
