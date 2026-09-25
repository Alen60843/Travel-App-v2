import { apiUrlConfig, type ApiUrlConfig } from '../config/env';
import { ApiError, toApiError } from './errors';

/**
 * Supplies a bearer token per request. 7.2 plugs Firebase ID-token
 * acquisition in here; until then no token is sent.
 */
export type AuthTokenProvider = () => Promise<string | null>;

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;

export interface RequestOptions {
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly signal?: AbortSignal;
}

export interface ApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

export interface ApiClientOptions {
  readonly config?: ApiUrlConfig;
  readonly getAuthToken?: AuthTokenProvider;
  readonly fetchImpl?: typeof fetch;
}

/** Appends repeated keys for arrays (?categoryCodes=a&categoryCodes=b), matching the API's query DTOs. */
export function buildUrl(baseUrl: string, path: string, query?: Readonly<Record<string, QueryValue>>): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((entry) => params.append(key, String(entry)));
    else params.append(key, String(value));
  }
  const search = params.toString();
  return `${baseUrl}${normalizedPath}${search ? `?${search}` : ''}`;
}

/**
 * Thin JSON transport over fetch. It knows nothing about TripWith business
 * rules: it sends the request, attaches a bearer token when one is provided,
 * parses JSON, and turns every failure into an ApiError.
 */
export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const config = options.config ?? apiUrlConfig;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body: unknown, requestOptions?: RequestOptions): Promise<T> {
    if (!config.ok) throw new ApiError('API_NOT_CONFIGURED', config.issue, 0);

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = await options.getAuthToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(config.baseUrl, path, requestOptions?.query), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: requestOptions?.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new ApiError('NETWORK_ERROR', 'Could not reach the TripWith API. Check EXPO_PUBLIC_API_URL and your network.', 0);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError('INVALID_RESPONSE', 'The TripWith API returned a non-JSON response.', response.status);
      }
    }
    if (!response.ok) throw toApiError(response.status, parsed);
    return parsed as T;
  }

  return {
    get: (path, requestOptions) => request('GET', path, undefined, requestOptions),
    post: (path, body, requestOptions) => request('POST', path, body, requestOptions),
    patch: (path, body, requestOptions) => request('PATCH', path, body, requestOptions),
    delete: (path, requestOptions) => request('DELETE', path, undefined, requestOptions),
  };
}
