import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { JoinRequestsService } from './join-requests.service';

@Controller({ path: 'events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class EventJoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  @Post(':eventId/join-requests')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() body: CreateJoinRequestDto,
  ) {
    return this.requests.create(user.id, eventId, body);
  }

  /**
   * WS8.4B self-leave. "The authenticated user leaves this event" — the
   * authenticated user is always the one leaving, never a body-supplied id.
   * The USER host cannot use this route (JoinRequestsService.leave rejects
   * it) — hosts have Event cancellation/management semantics, not
   * participant-leave semantics.
   */
  @Delete(':eventId/membership')
  @HttpCode(200)
  leave(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ) {
    return this.requests.leave(user.id, eventId);
  }
}

@Controller({ path: 'me/join-requests', version: '1' })
@UseGuards(TripWithAuthGuard)
export class MyJoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.requests.listMine(user.id);
  }

  @Post(':requestId/cancel')
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.cancel(user.id, requestId, body);
  }
}

@Controller({ path: 'me/events', version: '1' })
@UseGuards(TripWithAuthGuard)
export class HostJoinRequestsController {
  constructor(private readonly requests: JoinRequestsService) {}

  @Get(':eventId/join-requests')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ) {
    return this.requests.listForHost(user.id, eventId);
  }

  @Post(':eventId/join-requests/:requestId/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.approve(user.id, eventId, requestId, body);
  }

  @Post(':eventId/join-requests/:requestId/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.reject(user.id, eventId, requestId, body);
  }

  /**
   * WS8.5C: explicit, visibly-distinct capacity-exception approval. Only
   * the exact USER host who owns :eventId may call this (same
   * requireOwnedEvent authorization as approve/reject); the empty request
   * body means the client can never submit newCapacityMax/
   * capacityIncrease/overrideSeats/reservedSeatCount — the server derives
   * the exact minimum required capacity itself. Ordinary approve() above
   * never raises capacityMax; only this action may.
   */
  @Post(':eventId/join-requests/:requestId/approve-with-capacity-override')
  @HttpCode(200)
  approveWithCapacityOverride(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('requestId', new ParseUUIDPipe({ version: '4' })) requestId: string,
    @Body() body: unknown,
  ) {
    return this.requests.approveWithCapacityOverride(user.id, eventId, requestId, body);
  }

  /**
   * WS8.4B organizer remove. Only the exact USER host who owns :eventId may
   * call this (JoinRequestsService.remove authorizes via the same
   * requireOwnedEvent used by approve/reject); the host cannot target
   * themselves (HOST_CANNOT_REMOVE_SELF) — hosts are never EventParticipant
   * rows. Provider-hosted organizer management is out of scope (WS8.4A).
   */
  @Delete(':eventId/participants/:participantUserId')
  @HttpCode(200)
  removeParticipant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('participantUserId', new ParseUUIDPipe({ version: '4' })) participantUserId: string,
  ) {
    return this.requests.remove(user.id, eventId, participantUserId);
  }
}
