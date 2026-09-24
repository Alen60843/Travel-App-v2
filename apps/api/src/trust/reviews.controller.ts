import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import { CreateCustomerReviewDto, CreateProviderReviewDto } from './dto';
import { ReviewsService } from './reviews.service';
import type { ReviewView } from './reviews.types';

/**
 * Direction-specific routes rather than one generic POST /v1/reviews (§16):
 * each URL shape encodes exactly who may be reviewed and in what capacity,
 * so a client can never assert its own reviewer role, target type, or
 * verification state — those are all derived server-side from the
 * authenticated user, the path, and the event/attendance/ownership rows.
 *
 * Traveller -> Traveller is deliberately NOT a route here (WS8.3): it is no
 * longer a star review. See ../trust/traveller-feedback for its replacement
 * (positive-interaction-confirmation + wouldTravelAgain, not a rating).
 */
@UseGuards(TripWithAuthGuard)
@Controller({ version: '1' })
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('events/:eventId/provider-review')
  @HttpCode(201)
  createProviderReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Body() dto: CreateProviderReviewDto,
  ): Promise<ReviewView> {
    return this.reviews.createProviderReview(user.id, eventId, dto);
  }

  @Post('providers/:providerId/events/:eventId/travellers/:targetUserId/reviews')
  @HttpCode(201)
  createCustomerReview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('providerId', new ParseUUIDPipe({ version: '4' })) providerId: string,
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @Param('targetUserId', new ParseUUIDPipe({ version: '4' })) targetUserId: string,
    @Body() dto: CreateCustomerReviewDto,
  ): Promise<ReviewView> {
    return this.reviews.createCustomerReview(user.id, providerId, eventId, targetUserId, dto);
  }
}
