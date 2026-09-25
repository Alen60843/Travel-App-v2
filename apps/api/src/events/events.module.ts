import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from '../auth';
import { ChatModule } from '../chat';
import { EventCategoryEntity, EventEntity } from '../database/entities';
import { GeoService } from '../database/geo';
import { EventDetailController } from './event-detail.controller';
import { EventDetailService } from './event-detail.service';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';
import { EventsService } from './events.service';
import { EventJoinRequestsController, HostJoinRequestsController, MyJoinRequestsController } from './join-requests.controller';
import { JoinRequestsService } from './join-requests.service';

@Module({
  // ChatModule is imported for its exported ChatRepository only — WS5 EVENT
  // chat provisioning inside JoinRequestsService.approveAndParticipate.
  // ChatModule does not import EventsModule, so this is a one-way dependency
  // (EventsModule -> ChatModule), not a cycle. EventDetailService reuses the
  // same ChatRepository export for its read-only EVENT room lookup.
  imports: [AuthModule, ChatModule, TypeOrmModule.forFeature([EventEntity, EventCategoryEntity])],
  controllers: [
    EventsController, EventDetailController,
    EventJoinRequestsController, HostJoinRequestsController, MyJoinRequestsController,
  ],
  providers: [GeoService, EventsRepository, EventsService, JoinRequestsService, EventDetailService],
  exports: [EventsService],
})
export class EventsModule {}
