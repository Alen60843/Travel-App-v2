import type { UserAccountStatus } from '@tripwith/shared';

import type { ApiClient } from './client';

/**
 * The subset of GET /v1/me (the API's CurrentUserView) that the app reads.
 * Only the fields used on screen are declared.
 */
export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly accountStatus: UserAccountStatus;
  readonly profile: { readonly displayName: string; readonly avatarUrl: string | null };
  readonly onboarding: { readonly complete: boolean; readonly missingRequirements: readonly string[] };
}

export const meQueryKey = ['me'] as const;

export function fetchMe(api: ApiClient, signal?: AbortSignal): Promise<MeResponse> {
  return api.get<MeResponse>('/v1/me', signal ? { signal } : {});
}
