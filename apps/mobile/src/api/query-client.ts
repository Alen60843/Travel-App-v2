import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './errors';

/**
 * One QueryClient for the app. Client errors (4xx: validation, not-found,
 * forbidden) are final answers from the API and are not retried; network
 * failures and 5xx get one retry.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 1;
        },
      },
      mutations: { retry: false },
    },
  });
}
