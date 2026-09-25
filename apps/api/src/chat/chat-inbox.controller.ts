import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import { ChatInboxService } from './chat-inbox.service';
import type { InboxRoomView } from './chat-inbox.types';

/**
 * Touchable Prototype Step 4: the authenticated user's Inbox and a room
 * header. Read-only; shares the chat/rooms prefix with ChatController,
 * whose send/history/sync/presence/read routes are unchanged. There is no
 * userId parameter anywhere — the Inbox is always the caller's own.
 */
@Controller({ path: 'chat/rooms', version: '1' })
@UseGuards(TripWithAuthGuard)
export class ChatInboxController {
  constructor(private readonly inbox: ChatInboxService) {}

  @Get()
  listRooms(@CurrentUser() user: AuthenticatedUser): Promise<readonly InboxRoomView[]> {
    return this.inbox.listRooms(user.id);
  }

  @Get(':roomId')
  getRoom(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUUIDPipe) roomId: string,
  ): Promise<InboxRoomView> {
    return this.inbox.getRoom(user.id, roomId);
  }
}
