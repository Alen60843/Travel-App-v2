/**
 * Mirrors the backend's single error envelope (apps/api
 * common/errors/error-response.ts):
 *   { "error": { code, message, correlationId, timestamp, details? } }
 * Every failure the client surfaces is an ApiError, so screens write one
 * error path. Network/parse failures get client-side codes.
 */
export type ApiErrorCode =
  | string
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'API_NOT_CONFIGURED';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    /** HTTP status, or 0 when no response was received. */
    readonly status: number,
    readonly correlationId: string | null = null,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Builds an ApiError from a non-2xx response body, tolerating non-envelope bodies. */
export function toApiError(status: number, body: unknown): ApiError {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (envelope && typeof envelope.code === 'string' && typeof envelope.message === 'string') {
    return new ApiError(
      envelope.code,
      envelope.message,
      status,
      typeof envelope.correlationId === 'string' ? envelope.correlationId : null,
      isRecord(envelope.details) ? envelope.details : null,
    );
  }
  return new ApiError('INVALID_RESPONSE', `Unexpected ${status} response from the TripWith API.`, status);
}
