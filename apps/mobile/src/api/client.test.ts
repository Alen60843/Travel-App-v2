import { buildUrl, createApiClient } from './client';
import { presentApiError } from './error-message';
import { ApiError } from './errors';
import { parseApiUrl } from '../config/env';

const CONFIG = { ok: true as const, baseUrl: 'http://192.168.1.50:3000/api' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function capture(response: Response) {
  const fetchImpl = jest.fn().mockResolvedValue(response);
  const headersOf = () => (fetchImpl.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
  return { fetchImpl, headersOf };
}

describe('API client auth header', () => {
  it('sends Authorization: Bearer <token> when the token provider returns one', async () => {
    const { fetchImpl, headersOf } = capture(jsonResponse(200, { id: 'user-1' }));
    const api = createApiClient({ config: CONFIG, fetchImpl, getAuthToken: async () => 'firebase-id-token' });

    await expect(api.get<{ id: string }>('/v1/me')).resolves.toEqual({ id: 'user-1' });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://192.168.1.50:3000/api/v1/me');
    expect(headersOf().Authorization).toBe('Bearer firebase-id-token');
  });

  it('sends no Authorization header when there is no token (or no provider)', async () => {
    for (const getAuthToken of [async () => null, undefined]) {
      const { fetchImpl, headersOf } = capture(jsonResponse(200, {}));
      const api = createApiClient({ config: CONFIG, fetchImpl, ...(getAuthToken ? { getAuthToken } : {}) });
      await api.get('/v1/me');
      expect(headersOf()).not.toHaveProperty('Authorization');
    }
  });

  it('asks the provider for a token on every request (Firebase stays the token authority)', async () => {
    const getAuthToken = jest.fn().mockResolvedValue('t');
    const fetchImpl = jest.fn().mockImplementation(async () => jsonResponse(200, {}));
    const api = createApiClient({ config: CONFIG, fetchImpl, getAuthToken });
    await api.get('/v1/me');
    await api.post('/v1/events/e/join-requests', { guestCount: 1 });
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[1]![1] as RequestInit).body).toBe('{"guestCount":1}');
  });
});

describe('API client errors', () => {
  it('parses the backend error envelope into an ApiError', async () => {
    const { fetchImpl } = capture(jsonResponse(403, {
      error: {
        code: 'AUTH_ACCOUNT_NOT_PROVISIONED',
        message: 'This Firebase identity does not have a TripWith account.',
        correlationId: 'corr-123',
        timestamp: '2026-09-25T00:00:00.000Z',
      },
    }));
    const api = createApiClient({ config: CONFIG, fetchImpl });
    await expect(api.get('/v1/me')).rejects.toMatchObject({
      code: 'AUTH_ACCOUNT_NOT_PROVISIONED', status: 403, correlationId: 'corr-123',
    });
  });

  it('fails as API_NOT_CONFIGURED without making a request when the URL is missing', async () => {
    const fetchImpl = jest.fn();
    const api = createApiClient({ config: parseApiUrl(undefined), fetchImpl });
    await expect(api.get('/v1/me')).rejects.toMatchObject({ code: 'API_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an unreachable API as NETWORK_ERROR', async () => {
    const api = createApiClient({ config: CONFIG, fetchImpl: jest.fn().mockRejectedValue(new TypeError('Network request failed')) });
    await expect(api.get('/v1/me')).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: 0 });
  });

  it('builds repeated-key query arrays', () => {
    expect(buildUrl('http://h/api', 'v1/x', { categoryCodes: ['a', 'b'], limit: 5, skip: undefined }))
      .toBe('http://h/api/v1/x?categoryCodes=a&categoryCodes=b&limit=5');
  });
});

describe('presentApiError (ApiError rendering)', () => {
  it('explains a valid Firebase identity without a TripWith account, with a reference', () => {
    expect(presentApiError(new ApiError('AUTH_ACCOUNT_NOT_PROVISIONED', 'x', 403, 'corr-1'))).toEqual({
      title: 'No TripWith account yet',
      message: 'You are signed in to Firebase, but this identity has not been set up in TripWith yet.',
      reference: 'corr-1',
      requiresSignIn: false,
    });
  });

  it('asks to sign in again for rejected tokens', () => {
    for (const code of ['AUTH_TOKEN_MISSING', 'AUTH_TOKEN_EXPIRED', 'AUTH_TOKEN_WRONG_AUDIENCE']) {
      expect(presentApiError(new ApiError(code, 'x', 401))).toMatchObject({ requiresSignIn: true, title: 'Session not accepted' });
    }
  });

  it('shows connectivity problems and passes other backend messages through', () => {
    expect(presentApiError(new ApiError('NETWORK_ERROR', 'Could not reach the TripWith API.', 0)))
      .toMatchObject({ title: 'Cannot reach TripWith', message: 'Could not reach the TripWith API.' });
    expect(presentApiError(new ApiError('EVENT_NOT_JOINABLE', 'The Event is not available for joining.', 409, 'c')))
      .toMatchObject({ message: 'The Event is not available for joining.', reference: 'c' });
    expect(presentApiError(new Error('boom'))).toMatchObject({ title: 'Something went wrong' });
  });
});
