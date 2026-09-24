import { randomUUID } from 'node:crypto';

import { ChatRoomType } from '@tripwith/shared';
import type { DataSource, EntityManager } from 'typeorm';

import { ChatRoomNotFoundError } from './chat.errors';
import { ChatRepository } from './chat.repository';

/**
 * Unit-level coverage for the WS5 chat-side integration contract
 * (ensureEventRoom / activateEventMember / deactivateEventMember). These
 * mock EntityManager.query directly — they prove the repository issues the
 * correct SQL/params/EntityManager-usage, not that PostgreSQL's concurrency
 * behavior (the actual ON CONFLICT race, the actual partial-unique-index
 * enforcement) is correct. That proof is the deferred chat.int-spec.ts
 * coverage, which requires a real database and is marked accordingly there.
 */
describe('ChatRepository: WS5 chat-side integration contract', () => {
  function makeManager(): jest.Mocked<Pick<EntityManager, 'query'>> {
    return { query: jest.fn() };
  }

  function makeRepository(): { repository: ChatRepository; dataSourceQuery: jest.Mock } {
    const dataSourceQuery = jest.fn();
    const repository = new ChatRepository({ query: dataSourceQuery } as unknown as DataSource);
    return { repository, dataSourceQuery };
  }

  describe('ensureEventRoom', () => {
    it('returns the existing EVENT room id without inserting when one already exists', async () => {
      const { repository, dataSourceQuery } = makeRepository();
      const manager = makeManager();
      const eventId = randomUUID();
      const roomId = randomUUID();
      manager.query.mockResolvedValueOnce([{ id: roomId }]); // first SELECT finds it

      const result = await repository.ensureEventRoom(manager as unknown as EntityManager, eventId);

      expect(result).toBe(roomId);
      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT id FROM chat_rooms'),
        [eventId, ChatRoomType.Event],
      );
      // Never falls back to the repository's own DataSource — the whole
      // point of the contract is that the caller's transaction is used.
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('creates the room when none exists yet', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      const eventId = randomUUID();
      const newRoomId = randomUUID();
      manager.query
        .mockResolvedValueOnce([]) // SELECT finds nothing
        .mockResolvedValueOnce([{ id: newRoomId }]); // INSERT ... RETURNING id succeeds

      const result = await repository.ensureEventRoom(manager as unknown as EntityManager, eventId);

      expect(result).toBe(newRoomId);
      expect(manager.query).toHaveBeenCalledTimes(2);
      expect(manager.query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO chat_rooms'),
        [ChatRoomType.Event, eventId],
      );
    });

    it('re-selects the canonical room when a concurrent transaction wins the chat_rooms_event_uk race', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      const eventId = randomUUID();
      const canonicalRoomId = randomUUID();
      manager.query
        .mockResolvedValueOnce([]) // first SELECT: not there yet
        .mockResolvedValueOnce([]) // INSERT ... ON CONFLICT DO NOTHING: lost the race, 0 rows
        .mockResolvedValueOnce([{ id: canonicalRoomId }]); // re-SELECT: the winner's room

      const result = await repository.ensureEventRoom(manager as unknown as EntityManager, eventId);

      expect(result).toBe(canonicalRoomId);
      expect(manager.query).toHaveBeenCalledTimes(3);
    });

    it('throws if the canonical room cannot be found even after losing the race (defensive, should be unreachable)', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await expect(
        repository.ensureEventRoom(manager as unknown as EntityManager, randomUUID()),
      ).rejects.toThrow('Canonical EVENT chat room disappeared during creation');
    });
  });

  describe('activateEventMember', () => {
    it('issues a single idempotent INSERT ... ON CONFLICT DO UPDATE statement using the caller-provided manager', async () => {
      const { repository, dataSourceQuery } = makeRepository();
      const manager = makeManager();
      const roomId = randomUUID();
      const userId = randomUUID();
      manager.query.mockResolvedValueOnce(undefined);

      await repository.activateEventMember(manager as unknown as EntityManager, roomId, userId);

      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringMatching(/INSERT INTO chat_members[\s\S]*ON CONFLICT \(room_id, user_id\) DO UPDATE SET left_at = NULL/),
        [roomId, userId],
      );
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('repeated activation issues the same idempotent statement each time (no accumulating state, no error)', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      const roomId = randomUUID();
      const userId = randomUUID();
      manager.query.mockResolvedValue(undefined);

      await repository.activateEventMember(manager as unknown as EntityManager, roomId, userId);
      await repository.activateEventMember(manager as unknown as EntityManager, roomId, userId);
      await repository.activateEventMember(manager as unknown as EntityManager, roomId, userId);

      expect(manager.query).toHaveBeenCalledTimes(3);
      for (const call of manager.query.mock.calls) {
        expect(call[1]).toEqual([roomId, userId]);
      }
    });

    it('does not throw when the target row is already active or was previously left (single ON CONFLICT covers both — real-DB proof deferred)', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      manager.query.mockResolvedValueOnce(undefined);

      await expect(
        repository.activateEventMember(manager as unknown as EntityManager, randomUUID(), randomUUID()),
      ).resolves.toBeUndefined();
    });
  });

  describe('deactivateEventMember', () => {
    it('issues an UPDATE guarded by left_at IS NULL using the caller-provided manager', async () => {
      const { repository, dataSourceQuery } = makeRepository();
      const manager = makeManager();
      const roomId = randomUUID();
      const userId = randomUUID();
      manager.query.mockResolvedValueOnce(undefined);

      await repository.deactivateEventMember(manager as unknown as EntityManager, roomId, userId);

      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE chat_members[\s\S]*SET left_at = now\(\)[\s\S]*WHERE room_id = \$1 AND user_id = \$2 AND left_at IS NULL/),
        [roomId, userId],
      );
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('repeated deactivation is safe: the second call issues the same guarded UPDATE and does not throw', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      const roomId = randomUUID();
      const userId = randomUUID();
      manager.query.mockResolvedValue(undefined); // real Postgres: 0-row UPDATE on the 2nd call, no error either way

      await repository.deactivateEventMember(manager as unknown as EntityManager, roomId, userId);
      await expect(
        repository.deactivateEventMember(manager as unknown as EntityManager, roomId, userId),
      ).resolves.toBeUndefined();
      expect(manager.query).toHaveBeenCalledTimes(2);
    });

    it('a missing membership is a safe no-op: the guarded UPDATE runs and resolves without throwing', async () => {
      const { repository } = makeRepository();
      const manager = makeManager();
      manager.query.mockResolvedValueOnce(undefined); // real Postgres: 0 rows affected, no error

      await expect(
        repository.deactivateEventMember(manager as unknown as EntityManager, randomUUID(), randomUUID()),
      ).resolves.toBeUndefined();
    });
  });

  // Real-Postgres correction: TypeORM's manager.query() returns
  // [rows, rowCount] for a raw UPDATE/DELETE statement (even with
  // RETURNING), never a bare rows array — unlike INSERT/SELECT. These mock
  // that exact tuple shape rather than a plain array, so a regression back
  // to `const row = rows[0]` (reading the rows array itself as if it were
  // a row) fails loudly here instead of only against a real database.
  describe('advanceReadState', () => {
    function makeTransactionalRepository(): {
      repository: ChatRepository;
      manager: jest.Mocked<Pick<EntityManager, 'query'>>;
    } {
      const manager = makeManager();
      const dataSource = {
        transaction: jest.fn((work: (manager: EntityManager) => Promise<unknown>) =>
          work(manager as unknown as EntityManager)),
      };
      const repository = new ChatRepository(dataSource as unknown as DataSource);
      return { repository, manager };
    }

    it("unwraps TypeORM's [rows, rowCount] UPDATE result and returns the new last_read_seq", async () => {
      const { repository, manager } = makeTransactionalRepository();
      manager.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // assertActiveMember: active member found
        .mockResolvedValueOnce([[{ last_read_seq: '7' }], 1]); // real TypeORM UPDATE ... RETURNING shape

      const result = await repository.advanceReadState(randomUUID(), randomUUID(), 7);

      expect(result).toBe(7);
    });

    it('throws ChatRoomNotFoundError when the guarded UPDATE affects no row', async () => {
      const { repository, manager } = makeTransactionalRepository();
      manager.query
        .mockResolvedValueOnce([{ '?column?': 1 }]) // assertActiveMember: active member found
        .mockResolvedValueOnce([[], 0]); // real TypeORM UPDATE ... RETURNING shape, 0 rows

      await expect(repository.advanceReadState(randomUUID(), randomUUID(), 5)).rejects.toBeInstanceOf(
        ChatRoomNotFoundError,
      );
    });
  });
});
