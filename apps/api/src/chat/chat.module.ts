import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { DatabaseModule } from '../database/database.module';
import { realtimeModule } from '../realtime-wiring';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatController } from './chat.controller';
import { ChatRepository } from './chat.repository';
import { ChatService } from './chat.service';

@Module({
  // realtimeModule is the single shared RealtimeModule.forRoot(...) instance
  // (see ../realtime-wiring.ts) — importing it here does not instantiate a
  // second RealtimeGateway/ConnectionTracker/authenticator; it reuses the
  // exact object AppModule also imports.
  imports: [AuthModule, DatabaseModule, realtimeModule],
  controllers: [ChatController],
  providers: [ChatRepository, ChatBroadcastService, ChatService],
  // ChatRepository is exported alongside ChatService for the WS5 EVENT
  // integration: JoinRequestsService (EventsModule) needs the raw
  // ensureEventRoom/activateEventMember primitives directly, inside its own
  // participant-approval transaction — ChatService is not usable there since
  // it owns broadcast/presence concerns unrelated to that transaction.
  exports: [ChatService, ChatRepository],
})
export class ChatModule {}
