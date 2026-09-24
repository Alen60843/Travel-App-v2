import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsUUID, ValidateNested } from 'class-validator';

/**
 * One Step-2 answer for one Step-1-selected traveller. No rating, no text,
 * no attendance/verification field — the reviewer's own authenticated
 * identity is never part of this DTO (see controller: it is always taken
 * from the session, never the body).
 */
export class TravellerFeedbackItemDto {
  @IsUUID('4')
  targetUserId!: string;

  @IsBoolean()
  wouldTravelAgain!: boolean;
}

/**
 * List-first, event-level batch (WS8.3): one request covers every traveller
 * the reviewer positively selected in Step 1, each with its Step 2 answer.
 * A traveller the reviewer did NOT select in Step 1 is simply absent from
 * `feedback` — the server never infers anything about an omitted id, and an
 * empty array is a legitimate "I'm giving feedback about nobody" no-op, not
 * an error (see TravellerFeedbackService.submitFeedback).
 */
export class SubmitTravellerFeedbackDto {
  @IsArray()
  // Defensive upper bound only (mirrors capacity-style bounds used
  // elsewhere in this codebase) — not a product-meaningful limit, just a
  // guard against an unbounded payload.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TravellerFeedbackItemDto)
  feedback!: TravellerFeedbackItemDto[];
}
