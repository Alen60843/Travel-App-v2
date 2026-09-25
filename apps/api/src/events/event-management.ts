import { EventHostType } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import type { EventEntity } from '../database/entities';

/**
 * Group Formation Step 2: the ONE event-management authorization rule.
 * Exactly one account may manage an Event (view it as owner, edit, publish,
 * cancel, decide/override Join Requests, remove participants):
 *
 *   USER-hosted     -> events.host_user_id
 *   PROVIDER-hosted -> providers.owner_user_id of the (non-deleted) host
 *                      Provider. An unclaimed Provider (owner_user_id IS
 *                      NULL) matches nobody, so its sessions are never
 *                      manageable as owned sessions.
 *
 * No co-hosts, no provider staff. Both exports below encode this same rule —
 * one as a SQL predicate for owner-scoped queries (alias `event`, parameter
 * `:userId`), one as a resolver for an already-loaded Event — so services
 * never re-implement a slightly different ownership check.
 */
export const EVENT_MANAGED_BY_USER_SQL = `(
  (event.host_type = 'USER'
    AND event.host_user_id = :userId
    AND event.host_provider_id IS NULL)
  OR
  (event.host_type = 'PROVIDER'
    AND event.host_user_id IS NULL
    AND EXISTS (
      SELECT 1
        FROM providers provider
       WHERE provider.id = event.host_provider_id
         AND provider.owner_user_id = :userId
         AND provider.deleted_at IS NULL))
)`;

/**
 * The single account that manages `event` under EVENT_MANAGED_BY_USER_SQL,
 * or null when nobody can (a session of an unclaimed or deleted Provider).
 * Used for host-side facts that are not an owner-scoped query of their own:
 * self-join prevention, the host "leave" guard, and the host's EVENT chat
 * membership. A USER-hosted Event needs no query at all.
 */
export async function findEventManagerUserId(
  manager: EntityManager,
  event: Pick<EventEntity, 'hostType' | 'hostUserId' | 'hostProviderId'>,
): Promise<string | null> {
  if (event.hostType === EventHostType.User) return event.hostUserId;
  if (event.hostType !== EventHostType.Provider || !event.hostProviderId) return null;
  const rows = (await manager.query(
    `SELECT owner_user_id FROM providers WHERE id = $1 AND deleted_at IS NULL`,
    [event.hostProviderId],
  )) as Array<{ owner_user_id: string | null }>;
  return rows[0]?.owner_user_id ?? null;
}
