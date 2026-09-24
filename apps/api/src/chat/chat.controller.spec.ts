import { randomUUID } from 'node:crypto';

import { MessageType, UserAccountStatus } from '@tripwith/shared';
import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../auth';
import { PresenceState, type PresenceUpdate } from '../realtime';
import { ChatController } from './chat.controller';
import { ChatRoomNotFoundError } from './chat.errors';
import { ChatService } from './chat.service';
import type { MessagePageView, MessageView, ReadStateView } from './chat.types';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SyncMessagesQueryDto } from './dto/sync-messages-query.dto';
import { UpdateReadStateDto } from './dto/update-read-state.dto';

function currentUser(id: string): AuthenticatedUser {
  return {
    id,
    firebaseUid: 'server-verified-only',
    accountStatus: UserAccountStatus.Active,
    firebaseIdentity: {
      firebaseUid: 'server-verified-only',
      email: 'traveller@example.com',
      emailVerified: true,
      authTime: new Date(),
    },
  };
}

describe('chat send-message API boundary', () => {
  const senderUserId = randomUUID();
  const roomId = randomUUID();
  const clientMessageId = randomUUID();
  const persistedView: MessageView = {
    id: randomUUID(),
    roomId,
    seq: 1,
    senderUserId,
    type: MessageType.Text,
    body: 'hello',
    clientMessageId,
    createdAt: '2026-09-06T10:00:00.000Z',
  };

  function makeController() {
    const service = {
      sendTextMessage: jest.fn().mockResolvedValue(persistedView),
      listHistory: jest.fn(),
      syncMessages: jest.fn(),
      advanceReadState: jest.fn(),
    };
    const controller = new ChatController(service as unknown as ChatService);
    return { controller, service };
  }

  it('takes the sender exclusively from the authenticated user, never the payload', async () => {
    const { controller, service } = makeController();
    const user = currentUser(senderUserId);
    // SendMessageDto has no senderUserId/userId field at all; a client that
    // sends one anyway must have it silently ignored, not honoured.
    const impersonating = Object.assign(new SendMessageDto(), {
      clientMessageId,
      body: 'hello',
      senderUserId: randomUUID(),
      userId: randomUUID(),
    });

    await expect(controller.sendMessage(user, roomId, impersonating)).resolves.toEqual(
      persistedView,
    );
    expect(service.sendTextMessage).toHaveBeenCalledWith(roomId, senderUserId, impersonating);
  });

  it('propagates a non-member/non-existent-room rejection unchanged', async () => {
    const { controller, service } = makeController();
    service.sendTextMessage.mockRejectedValueOnce(new ChatRoomNotFoundError());

    await expect(
      controller.sendMessage(
        currentUser(senderUserId),
        roomId,
        Object.assign(new SendMessageDto(), { clientMessageId, body: 'hello' }),
      ),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('requires a v4 UUID clientMessageId', async () => {
    const missing = Object.assign(new SendMessageDto(), { body: 'hello' });
    expect((await validate(missing)).map((e) => e.property)).toContain('clientMessageId');

    const invalid = Object.assign(new SendMessageDto(), {
      clientMessageId: 'not-a-uuid',
      body: 'hello',
    });
    expect((await validate(invalid)).map((e) => e.property)).toContain('clientMessageId');

    const valid = Object.assign(new SendMessageDto(), { clientMessageId, body: 'hello' });
    await expect(validate(valid)).resolves.toHaveLength(0);
  });

  it('requires a non-empty, bounded TEXT body', async () => {
    const empty = Object.assign(new SendMessageDto(), { clientMessageId, body: '' });
    expect((await validate(empty)).map((e) => e.property)).toContain('body');

    const tooLong = Object.assign(new SendMessageDto(), {
      clientMessageId,
      body: 'x'.repeat(4001),
    });
    expect((await validate(tooLong)).map((e) => e.property)).toContain('body');

    const atLimit = Object.assign(new SendMessageDto(), {
      clientMessageId,
      body: 'x'.repeat(4000),
    });
    await expect(validate(atLimit)).resolves.toHaveLength(0);
  });
});

describe('chat history API boundary', () => {
  const userId = randomUUID();
  const roomId = randomUUID();
  const page: MessagePageView = { messages: [], hasMore: false };

  function makeController() {
    const service = {
      sendTextMessage: jest.fn(),
      listHistory: jest.fn().mockResolvedValue(page),
      syncMessages: jest.fn(),
      advanceReadState: jest.fn(),
    };
    const controller = new ChatController(service as unknown as ChatService);
    return { controller, service };
  }

  it('passes the authenticated user and validated query through to the service', async () => {
    const { controller, service } = makeController();
    const query = Object.assign(new ListMessagesQueryDto(), { beforeSeq: 42, limit: 10 });

    await expect(controller.listHistory(currentUser(userId), roomId, query)).resolves.toEqual(
      page,
    );
    expect(service.listHistory).toHaveBeenCalledWith(roomId, userId, query);
  });

  it('propagates a non-member/non-existent-room rejection unchanged', async () => {
    const { controller, service } = makeController();
    service.listHistory.mockRejectedValueOnce(new ChatRoomNotFoundError());

    await expect(
      controller.listHistory(currentUser(userId), roomId, new ListMessagesQueryDto()),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('bounds beforeSeq and limit', async () => {
    const negativeBeforeSeq = Object.assign(new ListMessagesQueryDto(), { beforeSeq: -1 });
    expect((await validate(negativeBeforeSeq)).map((e) => e.property)).toContain('beforeSeq');

    const overLimit = Object.assign(new ListMessagesQueryDto(), { limit: 1000 });
    expect((await validate(overLimit)).map((e) => e.property)).toContain('limit');

    const valid = Object.assign(new ListMessagesQueryDto(), { beforeSeq: 5, limit: 20 });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const omitted = new ListMessagesQueryDto();
    await expect(validate(omitted)).resolves.toHaveLength(0);
  });
});

describe('chat sync API boundary', () => {
  const userId = randomUUID();
  const roomId = randomUUID();
  const page: MessagePageView = { messages: [], hasMore: true };

  function makeController() {
    const service = {
      sendTextMessage: jest.fn(),
      listHistory: jest.fn(),
      syncMessages: jest.fn().mockResolvedValue(page),
      advanceReadState: jest.fn(),
    };
    const controller = new ChatController(service as unknown as ChatService);
    return { controller, service };
  }

  it('passes the authenticated user and validated query through to the service', async () => {
    const { controller, service } = makeController();
    const query = Object.assign(new SyncMessagesQueryDto(), { afterSeq: 12, limit: 30 });

    await expect(controller.syncMessages(currentUser(userId), roomId, query)).resolves.toEqual(
      page,
    );
    expect(service.syncMessages).toHaveBeenCalledWith(roomId, userId, query);
  });

  it('requires afterSeq and bounds limit', async () => {
    const missing = new SyncMessagesQueryDto();
    expect((await validate(missing)).map((e) => e.property)).toContain('afterSeq');

    const overLimit = Object.assign(new SyncMessagesQueryDto(), { afterSeq: 0, limit: 1000 });
    expect((await validate(overLimit)).map((e) => e.property)).toContain('limit');

    const valid = Object.assign(new SyncMessagesQueryDto(), { afterSeq: 0, limit: 25 });
    await expect(validate(valid)).resolves.toHaveLength(0);
  });
});

describe('chat read-state API boundary', () => {
  const userId = randomUUID();
  const roomId = randomUUID();
  const readState: ReadStateView = { lastReadSeq: 100 };

  function makeController() {
    const service = {
      sendTextMessage: jest.fn(),
      listHistory: jest.fn(),
      syncMessages: jest.fn(),
      advanceReadState: jest.fn().mockResolvedValue(readState),
    };
    const controller = new ChatController(service as unknown as ChatService);
    return { controller, service };
  }

  it('passes the authenticated user and validated body through, returning the canonical value', async () => {
    const { controller, service } = makeController();
    const dto = Object.assign(new UpdateReadStateDto(), { seq: 85 });

    await expect(controller.advanceReadState(currentUser(userId), roomId, dto)).resolves.toEqual(
      readState,
    );
    expect(service.advanceReadState).toHaveBeenCalledWith(roomId, userId, dto);
  });

  it('propagates a non-member/non-existent-room rejection unchanged', async () => {
    const { controller, service } = makeController();
    service.advanceReadState.mockRejectedValueOnce(new ChatRoomNotFoundError());

    await expect(
      controller.advanceReadState(
        currentUser(userId),
        roomId,
        Object.assign(new UpdateReadStateDto(), { seq: 1 }),
      ),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('requires a non-negative integer seq', async () => {
    const missing = new UpdateReadStateDto();
    expect((await validate(missing)).map((e) => e.property)).toContain('seq');

    const negative = Object.assign(new UpdateReadStateDto(), { seq: -1 });
    expect((await validate(negative)).map((e) => e.property)).toContain('seq');

    const valid = Object.assign(new UpdateReadStateDto(), { seq: 0 });
    await expect(validate(valid)).resolves.toHaveLength(0);
  });
});

describe('chat presence snapshot API boundary (WS4.1)', () => {
  const userId = randomUUID();
  const roomId = randomUUID();
  const snapshot: readonly PresenceUpdate[] = [
    { userId, state: PresenceState.Online },
    { userId: randomUUID(), state: PresenceState.Afk },
  ];

  function makeController() {
    const service = {
      sendTextMessage: jest.fn(),
      listHistory: jest.fn(),
      syncMessages: jest.fn(),
      advanceReadState: jest.fn(),
      getPresenceSnapshot: jest.fn().mockResolvedValue(snapshot),
    };
    const controller = new ChatController(service as unknown as ChatService);
    return { controller, service };
  }

  it('takes the requester exclusively from the authenticated user, with no target-id input', async () => {
    const { controller, service } = makeController();

    await expect(controller.getPresenceSnapshot(currentUser(userId), roomId)).resolves.toEqual(
      snapshot,
    );
    expect(service.getPresenceSnapshot).toHaveBeenCalledWith(roomId, userId);
    // The controller method itself takes no third parameter at all — there
    // is no way for a caller to pass target ids through this route.
    expect(controller.getPresenceSnapshot).toHaveLength(2);
  });

  it('propagates a non-member/left-member rejection unchanged (same generic boundary as every other chat route)', async () => {
    const { controller, service } = makeController();
    service.getPresenceSnapshot.mockRejectedValueOnce(new ChatRoomNotFoundError());

    await expect(
      controller.getPresenceSnapshot(currentUser(userId), roomId),
    ).rejects.toBeInstanceOf(ChatRoomNotFoundError);
  });

  it('returns only userId and state per entry — no session/socket/device/IP fields', async () => {
    const { controller } = makeController();

    const result = await controller.getPresenceSnapshot(currentUser(userId), roomId);

    for (const entry of result) {
      expect(Object.keys(entry).sort()).toEqual(['state', 'userId']);
    }
  });
});
