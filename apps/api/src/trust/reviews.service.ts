import { Injectable } from '@nestjs/common';

import type { CreateCustomerReviewDto } from './dto/create-customer-review.dto';
import type { CreateProviderReviewDto } from './dto/create-provider-review.dto';
import { ReviewsRepository } from './reviews.repository';
import type { ReviewView } from './reviews.types';
import { SelfReviewError } from './trust.errors';

/**
 * Generic over the DTO's own shape rather than requiring
 * Record<string, boolean | undefined> — the direction-specific signal DTOs
 * (only known boolean keys, no index signature, deliberately, so
 * class-validator keeps rejecting unknown keys) are never assignable to an
 * indexed Record type, with or without a generic constraint that names
 * Record explicitly (indexed-signature assignability is checked, not
 * bypassed, when the constraint itself is a Record type). Constraining only
 * to `object` sidesteps that check entirely: `keyof T` and `T[keyof T]`
 * indexing work for any object type without requiring an index signature,
 * and the `typeof value === 'boolean'` guard below narrows the resulting
 * opaque `T[keyof T]` down to `boolean` for the assignment — so this stays
 * exactly as narrow as the DTOs themselves, with no cast and no `any`.
 */
function toSignals<T extends object>(signals: T | undefined): Record<string, boolean> {
  if (!signals) return {};
  const result: Record<string, boolean> = {};
  for (const key of Object.keys(signals) as (keyof T)[]) {
    const value = signals[key];
    if (typeof value === 'boolean') result[key as string] = value;
  }
  return result;
}

@Injectable()
export class ReviewsService {
  constructor(private readonly reviews: ReviewsRepository) {}

  /** Traveller -> Provider. The provider is derived server-side from the event's host, never from client input. */
  createProviderReview(
    reviewerUserId: string,
    eventId: string,
    dto: CreateProviderReviewDto,
  ): Promise<ReviewView> {
    return this.reviews.createProviderReview(
      reviewerUserId,
      eventId,
      dto.rating,
      dto.body ?? null,
      toSignals(dto.signals),
    );
  }

  /** Provider -> Traveller. reviewerUserId must own providerId; that authorization is enforced in the repository. */
  createCustomerReview(
    reviewerUserId: string,
    providerId: string,
    eventId: string,
    targetUserId: string,
    dto: CreateCustomerReviewDto,
  ): Promise<ReviewView> {
    if (reviewerUserId === targetUserId) throw new SelfReviewError();
    return this.reviews.createCustomerReview(
      reviewerUserId,
      providerId,
      eventId,
      targetUserId,
      dto.rating,
      dto.body ?? null,
      toSignals(dto.signals),
    );
  }
}
