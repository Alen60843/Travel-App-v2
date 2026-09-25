import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { EventDetailService } from './event-detail.service';
import type { PublicEventDetailView } from './event-detail.types';

/**
 * Touchable Prototype Step 3: traveller-facing Event / Session detail.
 * Distinct from the owner-only GET /v1/me/events/:eventId, which is unchanged.
 * Access policy: EventDetailService / canViewEventDetail.
 */
@Controller({ path: 'events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class EventDetailController {
  constructor(private readonly eventDetail: EventDetailService) {}

  @Get(':eventId')
  getEventDetail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ): Promise<PublicEventDetailView> {
    return this.eventDetail.getEventDetail(user.id, eventId);
  }
}
