import { randomUUID } from 'node:crypto';

import { EventHostType } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { EVENT_MANAGED_BY_USER_SQL, findEventManagerUserId } from './event-management';

const HOST_ID = randomUUID();
const OWNER_ID = randomUUID();
const PROVIDER_ID = randomUUID();

function managerReturning(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue(rows);
  return { manager: { query } as unknown as EntityManager, query };
}

describe('findEventManagerUserId', () => {
  it('resolves a USER-hosted Event to its host without touching the database', async () => {
    const { manager, query } = managerReturning([]);

    await expect(
      findEventManagerUserId(manager, {
        hostType: EventHostType.User, hostUserId: HOST_ID, hostProviderId: null,
      }),
    ).resolves.toBe(HOST_ID);
    expect(query).not.toHaveBeenCalled();
  });

  it('resolves a PROVIDER session to providers.owner_user_id of a non-deleted Provider', async () => {
    const { manager, query } = managerReturning([{ owner_user_id: OWNER_ID }]);

    await expect(
      findEventManagerUserId(manager, {
        hostType: EventHostType.Provider, hostUserId: null, hostProviderId: PROVIDER_ID,
      }),
    ).resolves.toBe(OWNER_ID);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/owner_user_id FROM providers WHERE id = \$1 AND deleted_at IS NULL/),
      [PROVIDER_ID],
    );
  });

  it('resolves an unclaimed Provider (owner_user_id NULL) to nobody', async () => {
    const { manager } = managerReturning([{ owner_user_id: null }]);

    await expect(
      findEventManagerUserId(manager, {
        hostType: EventHostType.Provider, hostUserId: null, hostProviderId: PROVIDER_ID,
      }),
    ).resolves.toBeNull();
  });

  it('resolves a deleted/missing Provider to nobody', async () => {
    const { manager } = managerReturning([]);

    await expect(
      findEventManagerUserId(manager, {
        hostType: EventHostType.Provider, hostUserId: null, hostProviderId: PROVIDER_ID,
      }),
    ).resolves.toBeNull();
  });

  it('never treats a stray host_user_id on a PROVIDER row as its manager', async () => {
    const { manager } = managerReturning([{ owner_user_id: null }]);

    await expect(
      findEventManagerUserId(manager, {
        hostType: EventHostType.Provider, hostUserId: HOST_ID, hostProviderId: PROVIDER_ID,
      }),
    ).resolves.toBeNull();
  });
});

describe('EVENT_MANAGED_BY_USER_SQL', () => {
  const sql = EVENT_MANAGED_BY_USER_SQL.replace(/\s+/g, ' ');

  it('keeps the USER-host branch exactly as before', () => {
    expect(sql).toContain(
      "(event.host_type = 'USER' AND event.host_user_id = :userId AND event.host_provider_id IS NULL)",
    );
  });

  it('grants PROVIDER sessions only to the exact, non-deleted owner — no NULL match, no co-hosts', () => {
    expect(sql).toContain("event.host_type = 'PROVIDER' AND event.host_user_id IS NULL");
    expect(sql).toContain('provider.id = event.host_provider_id');
    expect(sql).toContain('provider.owner_user_id = :userId');
    expect(sql).toContain('provider.deleted_at IS NULL');
    expect(sql).not.toMatch(/owner_user_id IS NULL|co_host|staff/i);
  });
});
