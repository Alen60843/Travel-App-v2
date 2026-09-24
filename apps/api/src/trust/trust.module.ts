import { Module } from '@nestjs/common';

import { AuthModule } from '../auth';
import { DatabaseModule } from '../database/database.module';
import { ReviewsController } from './reviews.controller';
import { ReviewsRepository } from './reviews.repository';
import { ReviewsService } from './reviews.service';
import { TravellerFeedbackController } from './traveller-feedback/traveller-feedback.controller';
import { TravellerFeedbackRepository } from './traveller-feedback/traveller-feedback.repository';
import { TravellerFeedbackService } from './traveller-feedback/traveller-feedback.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [ReviewsController, TravellerFeedbackController],
  providers: [ReviewsRepository, ReviewsService, TravellerFeedbackRepository, TravellerFeedbackService],
  exports: [ReviewsService, TravellerFeedbackService],
})
export class TrustModule {}
