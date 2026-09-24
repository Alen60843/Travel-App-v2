import { Injectable } from '@nestjs/common';

import type { SubmitTravellerFeedbackDto } from './dto/submit-traveller-feedback.dto';
import { DuplicateFeedbackTargetError, SelfFeedbackError } from './traveller-feedback.errors';
import { TravellerFeedbackRepository } from './traveller-feedback.repository';
import type { TravellerFeedbackCandidateView, TravellerFeedbackView } from './traveller-feedback.types';

@Injectable()
export class TravellerFeedbackService {
  constructor(private readonly feedback: TravellerFeedbackRepository) {}

  /**
   * Step-1 candidate list: every OTHER Event Feedback Member (the event's
   * USER host, plus active participants) — never the requester themselves.
   * Self-exclusion is enforced server-side in the repository query, not by
   * trusting the frontend to hide the current user (WS8.3A hard
   * requirement).
   */
  listCandidates(
    requesterUserId: string,
    eventId: string,
  ): Promise<readonly TravellerFeedbackCandidateView[]> {
    return this.feedback.listCandidates(requesterUserId, eventId);
  }

  /**
   * Traveller -> Traveller. `dto.feedback` is exactly the reviewer's Step-1
   * selection plus each selected traveller's Step-2 answer — a traveller
   * NOT selected in Step 1 is simply absent from this array, and the
   * server never infers anything about an omitted id (WS8.2/WS8.3 product
   * decision: unselected != no-show != negative evidence).
   *
   * An empty array is accepted as a legitimate no-op: "I'm giving feedback
   * about nobody this time" is a real, valid outcome of Step 1, not an
   * error condition, and must not be treated as claiming anything about
   * every other participant.
   */
  submitFeedback(
    reviewerUserId: string,
    eventId: string,
    dto: SubmitTravellerFeedbackDto,
  ): Promise<readonly TravellerFeedbackView[]> {
    const items = dto.feedback;
    if (items.length === 0) return Promise.resolve([]);

    const targetIds = items.map((item) => item.targetUserId);
    if (new Set(targetIds).size !== targetIds.length) throw new DuplicateFeedbackTargetError();
    // Defense in depth (WS8.3A): the candidate list already excludes the
    // requester server-side, but submission itself must independently
    // reject self-feedback rather than trust that exclusion.
    if (targetIds.includes(reviewerUserId)) throw new SelfFeedbackError();

    return this.feedback.submitFeedback(reviewerUserId, eventId, items);
  }
}
