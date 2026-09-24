import { randomUUID } from 'node:crypto';

import { ChatRoomType, MessageType } from '@tripwith/shared';

import { PresenceState, type PresenceService } from '../realtime';
import type { ChatBroadcastService } from './chat-broadcast.service';
import { ChatRoomNotFoundError } from './chat.errors';
import type { BroadcastTargets, ChatRepository, SendMessageResult } from './chat.repository';
import { ChatService } from './chat.service';
import type { MessagePage, PersistedMessage } from './chat.types';
import { HISTORY_DEFAULT_LIMIT } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SYNC_DEFAULT_LIMIT } from './dto/sync-messages-query.dto';

function makeFakePresenceService(): { getStates: jest.Mock } {
  return { getStates: jest.fn().mockResolvedValue(new Map()) };
}

function makePersistedMessage(overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    id: randomUUID(),
    roomId: randomUUID(),
    seq: 1,
    senderUserId: randomUUID(),
    type: MessageType.Text,
    body: 'hi',
    clientMessageId: randomUUID(),
    createdAt: new Date('2026-09-06T12:00:00.000Z'),
    ...overrides,
  };
}

describe('ChatService', () => {
  const roomId = randomUUID();
  const senderUserId = randomUUID();

  function makeService(
    repositoryOverrides: Partial<jest.Mocked<ChatRepository>> = {},
  ): {
    service: ChatService;
    repository: jest.Mocked<
      Pick<ChatRepository, 'sendTextMessage' | 'getBroadcastTargets' | 'getActiveMemberIds'>
    >;
    broadcast: { emitToUsers: jest.Mock };
    presence: { getStates: jest.Mock };
  } {
    const repository = {
      sendTextMessage: jest.fn(),
      getBroadcastTargets: jest.fn(),
      getActiveMemberIds: jest.fn(),
      ...repositoryOverrides,
    } as unknown as jest.Mocked<
      Pick<ChatRepository, 'sendTextMessage' | 'getBroadcastTargets' | 'getActiveMemberIds'>
    >;
    const broadcast = { emitToUsers: jest.fn() };
    const presence = makeFakePresenceService();
    const service = new ChatService(
      repository as unknown as ChatRepository,
      broadcast as unknown as ChatBroadcastService,
      presence as unknown as PresenceService,
    );
    return { service, repository, broadcast, presence };
  }

  function sendDto(clientMessageId: string = randomUUID()): SendMessageDto {
    return Object.assign(new SendMessageDto(), { clientMessageId, body: 'hi' });
  }

  it('maps a persisted message to its canonical view with an ISO date', async () => {
    const persisted = makePersistedMessage({ roomId, senderUserId, seq: 3 });
    const { service } = makeService({
      sendTextMessage: jest
        .fn()
        .mockResolvedValue({ message: persisted, created: true } satisfies SendMessageResult),
      getBroadcastTargets: jest
        .fn()
        .mockResolvedValue({ type: ChatRoomType.Match, activeMemberIds: [] } satisfies BroadcastTargets),
    });

    await expect(
      service.sendTextMessage(roomId, senderUserId, sendDto(persisted.clientMessageId)),
    ).resolves.toEqual({
      id: persisted.id,
      roomId,
      seq: 3,
      senderUserId,
      type: MessageType.Text,
      body: 'hi',
      clientMessageId: persisted.clientMessageId,
      createdAt: '2026-09-06T12:00:00.000Z',
    });
  });

  describe('idempotent send / broadcast gating', () => {
    it('broadcasts to active MATCH members when created is true', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const memberA = randomUUID();
      const memberB = randomUUID();
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockResolvedValue({
          type: ChatRoomType.Match,
          activeMemberIds: [memberA, memberB],
        }),
      });

      const view = await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
      expect(broadcast.emitToUsers).toHaveBeenCalledWith([memberA, memberB], view);
    });

    it('does not broadcast when created is false (a clientMessageId retry)', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const { service, broadcast, repository } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: false }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).not.toHaveBeenCalled();
      expect(repository.getBroadcastTargets).not.toHaveBeenCalled();
    });

    it('never broadcasts more than once across repeated identical retries', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const memberA = randomUUID();
      const sendTextMessage = jest
        .fn()
        .mockResolvedValueOnce({ message: persisted, created: true })
        .mockResolvedValue({ message: persisted, created: false });
      const { service, broadcast } = makeService({
        sendTextMessage,
        getBroadcastTargets: jest
          .fn()
          .mockResolvedValue({ type: ChatRoomType.Match, activeMemberIds: [memberA] }),
      });
      const dto = sendDto(persisted.clientMessageId);

      const first = await service.sendTextMessage(roomId, senderUserId, dto);
      const retryA = await service.sendTextMessage(roomId, senderUserId, dto);
      const retryB = await service.sendTextMessage(roomId, senderUserId, dto);

      expect(retryA).toEqual(first);
      expect(retryB).toEqual(first);
      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
    });

    it('does not broadcast a PROVIDER_INQUIRY-type room (fail-closed: only MATCH/EVENT are listed)', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockResolvedValue({
          type: ChatRoomType.ProviderInquiry,
          activeMemberIds: [randomUUID()],
        }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).not.toHaveBeenCalled();
    });

    it('takes broadcast targets from the fresh repository read, never from the request', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const authoritativeMember = randomUUID();
      const { service, broadcast, repository } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockResolvedValue({
          type: ChatRoomType.Match,
          activeMemberIds: [authoritativeMember],
        }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(repository.getBroadcastTargets).toHaveBeenCalledWith(roomId);
      expect(broadcast.emitToUsers).toHaveBeenCalledWith([authoritativeMember], expect.anything());
    });

    it('a broadcast-pipeline failure does not turn a successful send into a rejected promise', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const { service } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockRejectedValue(new Error('db hiccup')),
      });

      await expect(
        service.sendTextMessage(roomId, senderUserId, sendDto()),
      ).resolves.toMatchObject({ id: persisted.id });
    });

    it('a broadcaster throw does not turn a successful send into a rejected promise', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest
          .fn()
          .mockResolvedValue({ type: ChatRoomType.Match, activeMemberIds: [randomUUID()] }),
      });
      broadcast.emitToUsers.mockImplementation(() => {
        throw new Error('adapter unavailable');
      });

      await expect(
        service.sendTextMessage(roomId, senderUserId, sendDto()),
      ).resolves.toMatchObject({ id: persisted.id });
    });
  });

  describe('WS3: EVENT realtime', () => {
    it('delivers to all fresh active EVENT members when created is true', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const memberA = randomUUID();
      const memberB = randomUUID();
      const memberC = randomUUID();
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockResolvedValue({
          type: ChatRoomType.Event,
          activeMemberIds: [memberA, memberB, memberC],
        }),
      });

      const view = await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
      expect(broadcast.emitToUsers).toHaveBeenCalledWith([memberA, memberB, memberC], view);
    });

    it('does not broadcast an EVENT clientMessageId retry (created is false)', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const { service, broadcast, repository } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: false }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).not.toHaveBeenCalled();
      expect(repository.getBroadcastTargets).not.toHaveBeenCalled();
    });

    it('excludes a left/inactive EVENT member from the target list (repository already filters left_at)', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const stillActive = randomUUID();
      // The repository's getBroadcastTargets already filters left_at IS NULL
      // (chat.repository.ts) — this test asserts the service passes that
      // filtered list through unmodified, adding no member of its own and
      // dropping none the repository already excluded.
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest
          .fn()
          .mockResolvedValue({ type: ChatRoomType.Event, activeMemberIds: [stillActive] }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).toHaveBeenCalledWith([stillActive], expect.anything());
    });

    it("includes the sender's own id when they are a current active member, for their other devices", async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const otherMember = randomUUID();
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockResolvedValue({
          type: ChatRoomType.Event,
          activeMemberIds: [senderUserId, otherMember],
        }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      const [targets] = broadcast.emitToUsers.mock.calls[0] as [string[], unknown];
      expect(targets).toContain(senderUserId);
    });

    it('never broadcasts more than once across repeated identical EVENT retries', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const memberA = randomUUID();
      const sendTextMessage = jest
        .fn()
        .mockResolvedValueOnce({ message: persisted, created: true })
        .mockResolvedValue({ message: persisted, created: false });
      const { service, broadcast } = makeService({
        sendTextMessage,
        getBroadcastTargets: jest
          .fn()
          .mockResolvedValue({ type: ChatRoomType.Event, activeMemberIds: [memberA] }),
      });
      const dto = sendDto(persisted.clientMessageId);

      await service.sendTextMessage(roomId, senderUserId, dto);
      await service.sendTextMessage(roomId, senderUserId, dto);
      await service.sendTextMessage(roomId, senderUserId, dto);

      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
    });

    it('an EVENT realtime failure does not turn a successful send into a rejected promise', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const { service } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockRejectedValue(new Error('event broadcast db hiccup')),
      });

      await expect(
        service.sendTextMessage(roomId, senderUserId, sendDto()),
      ).resolves.toMatchObject({ id: persisted.id });
    });

    it('EVENT does not route through MATCH-only logic: a MATCH mock never gets EVENT-shaped targets', async () => {
      // Regression guard: EVENT and MATCH share the same delivery mechanism
      // by design (both are in FAN_OUT_DELIVERABLE_ROOM_TYPES), but they are
      // still two distinct type values passed straight through from
      // getBroadcastTargets — this asserts the service never substitutes or
      // hardcodes ChatRoomType.Match, it uses whatever the repository says.
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const eventMember = randomUUID();
      const { service, broadcast, repository } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest
          .fn()
          .mockResolvedValue({ type: ChatRoomType.Event, activeMemberIds: [eventMember] }),
      });

      await service.sendTextMessage(roomId, senderUserId, sendDto());

      const [roomIdArg] = repository.getBroadcastTargets.mock.calls[0] as [string];
      expect(roomIdArg).toBe(roomId);
      expect(broadcast.emitToUsers).toHaveBeenCalledWith([eventMember], expect.anything());
    });
  });

  describe('regression: MATCH realtime unchanged by WS3', () => {
    it('still broadcasts to active MATCH members exactly as before', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId });
      const memberA = randomUUID();
      const memberB = randomUUID();
      const { service, broadcast } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest.fn().mockResolvedValue({
          type: ChatRoomType.Match,
          activeMemberIds: [memberA, memberB],
        }),
      });

      const view = await service.sendTextMessage(roomId, senderUserId, sendDto());

      expect(broadcast.emitToUsers).toHaveBeenCalledTimes(1);
      expect(broadcast.emitToUsers).toHaveBeenCalledWith([memberA, memberB], view);
    });

    it('the public MessageView shape is unchanged by the WS3 routing change', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId, seq: 9 });
      const { service } = makeService({
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: true }),
        getBroadcastTargets: jest
          .fn()
          .mockResolvedValue({ type: ChatRoomType.Event, activeMemberIds: [] }),
      });

      const view = await service.sendTextMessage(roomId, senderUserId, sendDto(persisted.clientMessageId));

      expect(Object.keys(view).sort()).toEqual(
        ['body', 'clientMessageId', 'createdAt', 'id', 'roomId', 'seq', 'senderUserId', 'type'].sort(),
      );
    });
  });

  describe('history / sync / read-state mapping', () => {
    it('maps a history page to view shape, preserving hasMore', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId, seq: 5 });
      const page: MessagePage = { messages: [persisted], hasMore: true };
      const repository = {
        listMessagesBefore: jest.fn().mockResolvedValue(page),
      };
      const service = new ChatService(
        repository as unknown as ChatRepository,
        { emitToUsers: jest.fn() } as unknown as ChatBroadcastService,
        { getStates: jest.fn().mockResolvedValue(new Map()) } as unknown as PresenceService,
      );

      await expect(
        service.listHistory(roomId, senderUserId, { beforeSeq: 10, limit: 1 }),
      ).resolves.toEqual({
        messages: [
          {
            id: persisted.id,
            roomId,
            seq: 5,
            senderUserId,
            type: MessageType.Text,
            body: 'hi',
            clientMessageId: persisted.clientMessageId,
            createdAt: '2026-09-06T12:00:00.000Z',
          },
        ],
        hasMore: true,
      });
      expect(repository.listMessagesBefore).toHaveBeenCalledWith(roomId, senderUserId, 10, 1);
    });

    it('defaults an omitted history query to beforeSeq=null and the canonical HISTORY_DEFAULT_LIMIT', async () => {
      const page: MessagePage = { messages: [], hasMore: false };
      const repository = { listMessagesBefore: jest.fn().mockResolvedValue(page) };
      const service = new ChatService(
        repository as unknown as ChatRepository,
        { emitToUsers: jest.fn() } as unknown as ChatBroadcastService,
        { getStates: jest.fn().mockResolvedValue(new Map()) } as unknown as PresenceService,
      );

      await service.listHistory(roomId, senderUserId, {});

      expect(repository.listMessagesBefore).toHaveBeenCalledWith(
        roomId,
        senderUserId,
        null,
        HISTORY_DEFAULT_LIMIT,
      );
    });

    it('maps a sync page to view shape', async () => {
      const persisted = makePersistedMessage({ roomId, senderUserId, seq: 7 });
      const page: MessagePage = { messages: [persisted], hasMore: false };
      const repository = { listMessagesAfter: jest.fn().mockResolvedValue(page) };
      const service = new ChatService(
        repository as unknown as ChatRepository,
        { emitToUsers: jest.fn() } as unknown as ChatBroadcastService,
        { getStates: jest.fn().mockResolvedValue(new Map()) } as unknown as PresenceService,
      );

      const result = await service.syncMessages(roomId, senderUserId, { afterSeq: 3, limit: 20 });

      expect(result.hasMore).toBe(false);
      expect(result.messages).toHaveLength(1);
      expect(repository.listMessagesAfter).toHaveBeenCalledWith(roomId, senderUserId, 3, 20);
    });

    it('defaults an omitted sync limit to the canonical SYNC_DEFAULT_LIMIT, passing afterSeq through unchanged', async () => {
      const page: MessagePage = { messages: [], hasMore: false };
      const repository = { listMessagesAfter: jest.fn().mockResolvedValue(page) };
      const service = new ChatService(
        repository as unknown as ChatRepository,
        { emitToUsers: jest.fn() } as unknown as ChatBroadcastService,
        { getStates: jest.fn().mockResolvedValue(new Map()) } as unknown as PresenceService,
      );

      await service.syncMessages(roomId, senderUserId, { afterSeq: 0 });

      expect(repository.listMessagesAfter).toHaveBeenCalledWith(
        roomId,
        senderUserId,
        0,
        SYNC_DEFAULT_LIMIT,
      );
    });

    it('returns the canonical final lastReadSeq, even for a stale request', async () => {
      const repository = { advanceReadState: jest.fn().mockResolvedValue(100) };
      const service = new ChatService(
        repository as unknown as ChatRepository,
        { emitToUsers: jest.fn() } as unknown as ChatBroadcastService,
        { getStates: jest.fn().mockResolvedValue(new Map()) } as unknown as PresenceService,
      );

      await expect(
        service.advanceReadState(roomId, senderUserId, { seq: 85 }),
      ).resolves.toEqual({ lastReadSeq: 100 });
      expect(repository.advanceReadState).toHaveBeenCalledWith(roomId, senderUserId, 85);
    });

    it('propagates repository authorization errors unchanged', async () => {
      const failure = new Error('not an active member');
      const repository = { advanceReadState: jest.fn().mockRejectedValue(failure) };
      const service = new ChatService(
        repository as unknown as ChatRepository,
        { emitToUsers: jest.fn() } as unknown as ChatBroadcastService,
        { getStates: jest.fn().mockResolvedValue(new Map()) } as unknown as PresenceService,
      );

      await expect(
        service.advanceReadState(roomId, senderUserId, { seq: 1 }),
      ).rejects.toBe(failure);
    });
  });

  describe('WS4.1: authorized cross-user presence snapshot', () => {
    it('returns presence for every active member using the repository-authorized member list', async () => {
      const requesterId = randomUUID();
      const memberA = randomUUID();
      const memberB = randomUUID();
      const { service, repository, presence } = makeService({
        getActiveMemberIds: jest.fn().mockResolvedValue([requesterId, memberA, memberB]),
      });
      presence.getStates.mockResolvedValue(
        new Map([
          [requesterId, PresenceState.Online],
          [memberA, PresenceState.Afk],
          [memberB, PresenceState.Offline],
        ]),
      );

      const result = await service.getPresenceSnapshot(roomId, requesterId);

      expect(repository.getActiveMemberIds).toHaveBeenCalledWith(roomId, requesterId);
      expect(presence.getStates).toHaveBeenCalledWith([requesterId, memberA, memberB]);
      expect(result).toEqual([
        { userId: requesterId, state: PresenceState.Online },
        { userId: memberA, state: PresenceState.Afk },
        { userId: memberB, state: PresenceState.Offline },
      ]);
    });

    it('propagates the repository authorization rejection unchanged for a non-member/left member', async () => {
      const requesterId = randomUUID();
      const failure = new ChatRoomNotFoundError();
      const { service } = makeService({
        getActiveMemberIds: jest.fn().mockRejectedValue(failure),
      });

      await expect(service.getPresenceSnapshot(roomId, requesterId)).rejects.toBe(failure);
    });

    it('never accepts or forwards a target user id from anywhere but the authorized member list', async () => {
      // getPresenceSnapshot's only parameters are roomId and requesterId —
      // there is no third "target ids" parameter for a caller to widen the
      // query with. This test documents/enforces that at the call-site
      // level: presence.getStates is called with exactly what the
      // repository returned, nothing added, nothing client-supplied.
      const requesterId = randomUUID();
      const onlyAuthorizedMember = randomUUID();
      const { service, presence } = makeService({
        getActiveMemberIds: jest.fn().mockResolvedValue([onlyAuthorizedMember]),
      });

      await service.getPresenceSnapshot(roomId, requesterId);

      // requesterId itself is never included unless the repository's
      // authorization query also returned it as an active member (it
      // deliberately did not, here) — proving nothing is added client-side.
      expect(presence.getStates).toHaveBeenCalledTimes(1);
      expect(presence.getStates).toHaveBeenCalledWith([onlyAuthorizedMember]);
      expect((presence.getStates.mock.calls[0] as [string[]])[0]).not.toContain(requesterId);
    });

    it('is room-type agnostic: works identically for a MATCH-backed and an EVENT-backed member list', async () => {
      const requesterId = randomUUID();
      const eventMemberIds = [requesterId, randomUUID(), randomUUID()]; // e.g. a 3-person EVENT room
      const { service, presence } = makeService({
        getActiveMemberIds: jest.fn().mockResolvedValue(eventMemberIds),
      });
      presence.getStates.mockResolvedValue(new Map(eventMemberIds.map((id) => [id, PresenceState.Online])));

      const result = await service.getPresenceSnapshot(roomId, requesterId);

      // The service never inspects chat_rooms.type at all for this
      // operation — it only ever sees the member id list the repository's
      // single authorization+listing query already resolved, which works
      // identically whether that room happens to be MATCH or EVENT.
      expect(result).toHaveLength(eventMemberIds.length);
      expect(result.every((entry) => entry.state === PresenceState.Online)).toBe(true);
    });

    it('defaults a member missing from the presence map to OFFLINE rather than dropping or crashing', async () => {
      const requesterId = randomUUID();
      const memberWithNoPresenceEntry = randomUUID();
      const { service, presence } = makeService({
        getActiveMemberIds: jest.fn().mockResolvedValue([requesterId, memberWithNoPresenceEntry]),
      });
      // Simulates PresenceService's own fail-safe-to-OFFLINE contract, or a
      // map that simply doesn't have an entry for some id.
      presence.getStates.mockResolvedValue(new Map([[requesterId, PresenceState.Online]]));

      const result = await service.getPresenceSnapshot(roomId, requesterId);

      expect(result).toContainEqual({ userId: memberWithNoPresenceEntry, state: PresenceState.Offline });
    });

    it('a presence lookup failure does not affect chat send/history/sync/read-state (independent call paths)', async () => {
      // getPresenceSnapshot and sendTextMessage are independent code paths —
      // this asserts a rejection from one has no bearing on the other,
      // documenting that presence lookup failures cannot leak into or
      // break unrelated chat operations.
      const requesterId = randomUUID();
      const persisted = makePersistedMessage({ roomId, senderUserId: requesterId });
      const { service, presence } = makeService({
        getActiveMemberIds: jest.fn().mockRejectedValue(new Error('redis/db hiccup')),
        sendTextMessage: jest.fn().mockResolvedValue({ message: persisted, created: false }),
      });

      await expect(service.getPresenceSnapshot(roomId, requesterId)).rejects.toThrow(
        'redis/db hiccup',
      );
      await expect(
        service.sendTextMessage(roomId, requesterId, sendDto(persisted.clientMessageId)),
      ).resolves.toMatchObject({ id: persisted.id });
      expect(presence.getStates).not.toHaveBeenCalled();
    });
  });
});
