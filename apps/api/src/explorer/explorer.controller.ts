import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import { ExplorerAreaQueryDto, GetExplorerEventsQueryDto } from './dto/get-explorer-events-query.dto';
import { ExplorerService } from './explorer.service';
import type { ExplorerEventCardsView, ExplorerEventsView } from './explorer.types';

@Controller({ path: 'explorer', version: '1' })
@UseGuards(TripWithAuthGuard)
export class ExplorerController {
  constructor(private readonly explorer: ExplorerService) {}

  @Get('events')
  getEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: GetExplorerEventsQueryDto,
  ): Promise<ExplorerEventsView> {
    return this.explorer.discoverEvents(user.id, query);
  }

  /** Prototype Step 5: "groups forming near you" cards for the same area/window/category query (no zoom). */
  @Get('event-cards')
  getEventCards(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExplorerAreaQueryDto,
  ): Promise<ExplorerEventCardsView> {
    return this.explorer.discoverEventCards(user.id, query);
  }
}
