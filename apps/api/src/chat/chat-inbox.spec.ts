import { GUARDS_METADATA, PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { UserAccountStatus } from '@tripwith/shared';

import { type AuthenticatedUser, TripWithAuthGuard } from '../auth';
import { ChatInboxController } from './chat-inbox.controller';
import { INBOX_SQL, type ChatInboxRepository, type InboxRow } from './chat-inbox.repository';
import { ChatInboxService, toInboxRoomView } from './chat-inbox.service';
import { ChatRoomNotFoundError } from './chat.errors';

const JOINED = new Date('2090-01-01T08:00:00Z');

function row(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    room_id: 'room-1', type: 'EVENT', joined_at: JOINED, unread_count: '0',
    lm_id: null, lm_seq: null, lm_sender_user_id: null, lm_type: null, lm_body: null, lm_created_at: null,
    event_id: null, event_title: null, event_host_type: null, event_status: null, event_starts_at: null,
    event_capacity_min: null, event_capacity_max: null, event_reserved_seat_count: null,
    event_host_user_id: null, event_host_display_name: null, event_host_avatar_url: null,
    event_provider_id: null, event_provider_name: null,
    counterpart_user_id: null, counterpart_display_name: null, counterpart_avatar_url: null,
    room_provider_id: null, room_provider_name: null,
    ...overrides,
  };
}

const providerEventRow = (overrides: Partial<InboxRow> = {}) => row({
  event_id: 'event-rainbow', event_title: 'Rainbow Mountain', event_host_type: 'PROVIDER',
  event_status: 'ACTIVE', event_starts_at: new Date('2090-09-26T05:00:00Z'),
  event_capacity_min: 8, event_capacity_max: 12, event_reserved_seat_count: 9,
  event_provider_id: 'provider-andes', event_provider_name: 'Andes Adventures',
  ...overrides,
});

describe('toInboxRoomView', () => {
  it('presents a provider-hosted EVENT room as "Rainbow Mountain / Andes Adventures / 9 joined · CONFIRMED"', () => {
    expect(toInboxRoomView(providerEventRow())).toEqual({
      roomId: 'room-1',
      type: 'EVENT',
      title: 'Rainbow Mountain',
      subtitle: 'Andes Adventures',
      avatarUrl: null,
      eventId: 'event-rainbow',
      event: {
        id: 'event-rainbow',
        title: 'Rainbow Mountain',
        hostType: 'PROVIDER',
        status: 'ACTIVE',
        startsAt: '2090-09-26T05:00:00.000Z',
        capacityMin: 8,
        capacityMax: 12,
        reservedSeatCount: 9,
        groupState: 'CONFIRMED',
        seatsToConfirm: 0,
        host: { type: 'PROVIDER', providerId: 'provider-andes', name: 'Andes Adventures' },
      },
      counterpart: null,
      provider: null,
      lastMessage: null,
      lastActivityAt: JOINED.toISOString(),
      unreadCount: 0,
    });
  });

  it('reports FORMING with seatsToConfirm below the minimum', () => {
    expect(toInboxRoomView(providerEventRow({ event_reserved_seat_count: 7 })).event).toMatchObject({
      groupState: 'FORMING', seatsToConfirm: 1,
    });
  });

  it('presents a USER-hosted EVENT room with the host public profile only', () => {
    const view = toInboxRoomView(row({
      event_id: 'event-walk', event_title: 'Old City food walk', event_host_type: 'USER',
      event_status: 'FULL', event_starts_at: new Date('2090-02-01T17:00:00Z'),
      event_capacity_min: null, event_capacity_max: 4, event_reserved_seat_count: 4,
      event_host_user_id: 'host-noa', event_host_display_name: 'Noa', event_host_avatar_url: 'https://cdn.example/noa.png',
    }));
    expect(view).toMatchObject({
      title: 'Old City food walk', subtitle: 'Noa', avatarUrl: 'https://cdn.example/noa.png', eventId: 'event-walk',
      event: {
        groupState: 'FULL', seatsToConfirm: null,
        host: { type: 'USER', userId: 'host-noa', displayName: 'Noa', avatarUrl: 'https://cdn.example/noa.png' },
      },
    });
  });

  it('presents a MATCH room as the OTHER traveller only', () => {
    const view = toInboxRoomView(row({
      type: 'MATCH', counterpart_user_id: 'user-y', counterpart_display_name: 'Yael', counterpart_avatar_url: null,
    }));
    expect(view).toMatchObject({
      type: 'MATCH', title: 'Yael', subtitle: null, eventId: null, event: null,
      counterpart: { userId: 'user-y', displayName: 'Yael', avatarUrl: null },
    });
    expect(toInboxRoomView(row({ type: 'MATCH', counterpart_user_id: 'user-y' })).title).toBe('TripWith traveller');
  });

  it('presents a PROVIDER_INQUIRY room by provider name, without new product behaviour', () => {
    expect(toInboxRoomView(row({
      type: 'PROVIDER_INQUIRY', room_provider_id: 'provider-andes', room_provider_name: 'Andes Adventures',
    }))).toMatchObject({ title: 'Andes Adventures', provider: { providerId: 'provider-andes', name: 'Andes Adventures' } });
  });

  it('returns the latest message and uses its time as lastActivityAt', () => {
    const sent = new Date('2090-01-02T10:00:00Z');
    expect(toInboxRoomView(providerEventRow({
      lm_id: 'message-9', lm_seq: '9', lm_sender_user_id: 'user-a', lm_type: 'TEXT', lm_body: 'See you at 5!',
      lm_created_at: sent, unread_count: '3',
    }))).toMatchObject({
      lastMessage: {
        messageId: 'message-9', seq: 9, senderUserId: 'user-a', type: 'TEXT', body: 'See you at 5!',
        createdAt: sent.toISOString(),
      },
      lastActivityAt: sent.toISOString(),
      unreadCount: 3,
    });
  });

  it('never reports a negative unread count', () => {
    expect(toInboxRoomView(row({ unread_count: '-2' })).unreadCount).toBe(0);
  });
});

describe('INBOX_SQL authorization and privacy boundary', () => {
  const sql = INBOX_SQL.replace(/\s+/g, ' ');

  it('starts from the caller\'s own ACTIVE membership only', () => {
    expect(sql).toMatch(/FROM chat_members cm JOIN chat_rooms cr ON cr\.id = cm\.room_id/);
    expect(sql).toContain('WHERE cm.user_id = $1 AND cm.left_at IS NULL');
    // Never enumerates other members, participants or join requests.
    expect(sql).not.toMatch(/event_participants|event_join_requests|chat_members (?!cm\b)/);
  });

  it('never selects private or internal columns', () => {
    for (const column of [
      'owner_user_id', 'email', 'firebase_uid', 'date_of_birth', 'shared_location', 'media_storage_key',
      'trust_score', 'payment', 'contact_', 'client_message_id', 'last_location',
    ]) {
      expect(sql).not.toContain(column);
    }
  });

  it('hides soft-deleted messages and orders by activity with a deterministic tie-break', () => {
    expect(sql).toContain('m.deleted_at IS NULL');
    expect(sql).toMatch(/ORDER BY COALESCE\(lm\.created_at, cm\.joined_at\) DESC, cr\.id ASC$/);
  });
});

describe('ChatInboxService', () => {
  it('lists only what the repository returns for the authenticated user', async () => {
    const repository = { listInboxRows: jest.fn().mockResolvedValue([providerEventRow()]), findInboxRow: jest.fn() };
    const service = new ChatInboxService(repository as unknown as ChatInboxRepository);

    await expect(service.listRooms('user-c')).resolves.toHaveLength(1);
    expect(repository.listInboxRows).toHaveBeenCalledWith('user-c');
  });

  it('answers a non-member exactly like a missing room', async () => {
    const repository = { listInboxRows: jest.fn(), findInboxRow: jest.fn().mockResolvedValue(null) };
    const service = new ChatInboxService(repository as unknown as ChatInboxRepository);

    await expect(service.getRoom('stranger', 'room-1')).rejects.toBeInstanceOf(ChatRoomNotFoundError);
    expect(repository.findInboxRow).toHaveBeenCalledWith('stranger', 'room-1');
  });
});

describe('ChatInboxController', () => {
  const viewer = { id: 'viewer-id', firebaseUid: 'fb', accountStatus: UserAccountStatus.Active } as AuthenticatedUser;

  it('serves GET /v1/chat/rooms and GET /v1/chat/rooms/:roomId behind the auth guard, for the caller only', async () => {
    expect(Reflect.getMetadata(PATH_METADATA, ChatInboxController)).toBe('chat/rooms');
    expect(Reflect.getMetadata(VERSION_METADATA, ChatInboxController)).toBe('1');
    expect(Reflect.getMetadata(GUARDS_METADATA, ChatInboxController)).toEqual([TripWithAuthGuard]);
    expect(Reflect.getMetadata(PATH_METADATA, ChatInboxController.prototype.listRooms)).toBe('/');
    expect(Reflect.getMetadata(METHOD_METADATA, ChatInboxController.prototype.listRooms)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, ChatInboxController.prototype.getRoom)).toBe(':roomId');
    expect(Reflect.getMetadata(METHOD_METADATA, ChatInboxController.prototype.getRoom)).toBe(RequestMethod.GET);

    const service = { listRooms: jest.fn().mockResolvedValue([]), getRoom: jest.fn().mockResolvedValue({}) };
    const controller = new ChatInboxController(service as unknown as ChatInboxService);
    await controller.listRooms(viewer);
    await controller.getRoom(viewer, 'room-1');
    expect(service.listRooms).toHaveBeenCalledWith('viewer-id');
    expect(service.getRoom).toHaveBeenCalledWith('viewer-id', 'room-1');
  });
});
