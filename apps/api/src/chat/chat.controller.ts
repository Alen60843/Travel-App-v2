import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import type { PresenceUpdate } from '../realtime';
import { ChatService } from './chat.service';
import type { MessagePageView, MessageView, ReadStateView } from './chat.types';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SyncMessagesQueryDto } from './dto/sync-messages-query.dto';
import { UpdateReadStateDto } from './dto/update-read-state.dto';

@Controller({ path: 'chat/rooms', version: '1' })
@UseGuards(TripWithAuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Post(':roomId/messages')
  @HttpCode(200)
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body() dto: SendMessageDto,
  ): Promise<MessageView> {
    return this.chat.sendTextMessage(roomId, user.id, dto);
  }

  @Get(':roomId/messages')
  listHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessagePageView> {
    return this.chat.listHistory(roomId, user.id, query);
  }

  @Get(':roomId/sync')
  syncMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Query() query: SyncMessagesQueryDto,
  ): Promise<MessagePageView> {
    return this.chat.syncMessages(roomId, user.id, query);
  }

  @Get(':roomId/presence')
  getPresenceSnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUUIDPipe) roomId: string,
  ): Promise<readonly PresenceUpdate[]> {
    return this.chat.getPresenceSnapshot(roomId, user.id);
  }

  @Patch(':roomId/read')
  advanceReadState(
    @CurrentUser() user: AuthenticatedUser,
    @Param('roomId', ParseUUIDPipe) roomId: string,
    @Body() dto: UpdateReadStateDto,
  ): Promise<ReadStateView> {
    return this.chat.advanceReadState(roomId, user.id, dto);
  }
}
