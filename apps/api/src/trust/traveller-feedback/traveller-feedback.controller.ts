import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../../auth';
import { SubmitTravellerFeedbackDto } from './dto';
import { TravellerFeedbackService } from './traveller-feedback.service';
import type { TravellerFeedbackCandidateView, TravellerFeedbackView } from './traveller-feedback.types';

/**
 * List-first, event-level batch (WS8.3, WS8.3A) — one request per event,
 * not one per traveller, matching the two-step UX ("who did you spend time
 * with?" then "would you travel with them again?"). The reviewer is always
 * the authenticated user; there is intentionally no route or field anywhere
 * in this controller/DTO for a client to assert reviewerUserId, rating,
 * interacted, isVerified, attendanceStatus, noShow, trustScore,
 * moderationState, or any reputation weight/score.
 *
 * No update/delete route exists: submitted feedback is immutable in V1
 * (an identical retry is a safe no-op, not an edit — see
 * TravellerFeedbackRepository).
 */
@UseGuards(TripWithAuthGuard)
@Controller({ version: '1' })
export class TravellerFeedbackController {
  constructor(private readonly travellerFeedback: TravellerFeedbackService) {}

  @Get('events/:eventId/traveller-feedback/candidates')
  listCandidates(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
  ): Promise<readonly TravellerFeedbackCandidateView[]> {
    return this.travellerFeedback.listCandidates(user.id, eventId);
  }

  @Post('events/:eventId/traveller-feedback')
  @HttpCode(201)
  submitTravellerFeedback(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() dto: SubmitTravellerFeedbackDto,
  ): Promise<readonly TravellerFeedbackView[]> {
    return this.travellerFeedback.submitFeedback(user.id, eventId, dto);
  }
}
