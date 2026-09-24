import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../auth';
import {
  CreateCustomerReviewDto,
  CreateProviderReviewDto,
  CustomerReviewSignalsDto,
} from './dto';
import { ReviewsController } from './reviews.controller';
import type { ReviewsRepository } from './reviews.repository';
import { ReviewsService } from './reviews.service';
import { SelfReviewError } from './trust.errors';
import type { ReviewView } from './reviews.types';

describe('reviews API boundary', () => {
  const reviewerUserId = randomUUID();
  const targetUserId = randomUUID();
  const eventId = randomUUID();
  const providerId = randomUUID();

  const persisted: ReviewView = {
    id: randomUUID(),
    reviewerUserId,
    reviewerType: 'TRAVELLER',
    reviewerProviderId: null,
    targetType: 'USER',
    targetUserId,
    targetProviderId: null,
    eventId,
    rating: 5,
    body: null,
    signals: {},
    // Verification and moderation are independent (H1 / Product Decision
    // A): a review can be verified (real interaction) while still PENDING
    // (content not yet approved for public visibility/aggregation).
    isVerified: true,
    moderationState: 'PENDING',
    createdAt: '2026-08-21T10:00:00.000Z',
  };

  const repository = {
    createProviderReview: jest.fn().mockResolvedValue(persisted),
    createCustomerReview: jest.fn().mockResolvedValue(persisted),
  };
  const service = new ReviewsService(repository as unknown as ReviewsRepository);
  const controller = new ReviewsController(service);

  const user = { id: reviewerUserId } as AuthenticatedUser;

  beforeEach(() => {
    repository.createProviderReview.mockClear();
    repository.createCustomerReview.mockClear();
  });

  it('rejects a provider self-review (owner reviewing themselves as the target traveller)', () => {
    expect(() =>
      service.createCustomerReview(reviewerUserId, providerId, eventId, reviewerUserId, { rating: 3 }),
    ).toThrow(SelfReviewError);
    expect(repository.createCustomerReview).not.toHaveBeenCalled();
  });

  it('the traveller -> provider route never accepts a client-supplied provider id', () => {
    // Structural guarantee: CreateProviderReviewDto has no providerId field,
    // and the controller derives the provider from the event's host inside
    // the repository, not from the request body or a route param.
    expect(Object.prototype.hasOwnProperty.call(new CreateProviderReviewDto(), 'providerId')).toBe(false);
  });

  it('forwards provider-review requests with the provider derived only from the URL, not the DTO', async () => {
    await controller.createCustomerReview(user, providerId, eventId, targetUserId, { rating: 4 });
    expect(repository.createCustomerReview).toHaveBeenCalledWith(
      reviewerUserId,
      providerId,
      eventId,
      targetUserId,
      4,
      null,
      {},
    );
  });

  it('validates rating bounds and body length', async () => {
    const valid = Object.assign(new CreateProviderReviewDto(), { rating: 3 });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = Object.assign(new CreateProviderReviewDto(), {
      rating: 6,
      body: 'x'.repeat(2001),
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property).sort()).toEqual(['body', 'rating']);
  });

  it('validates nested signals on the customer-review DTO', async () => {
    const invalid = Object.assign(new CreateCustomerReviewDto(), {
      rating: 2,
      signals: Object.assign(new CustomerReviewSignalsDto(), { wouldAcceptAgain: 'yes' }),
    });
    const errors = await validate(invalid, { validationError: { target: false } });
    expect(errors.some((error) => error.property === 'signals')).toBe(true);
  });

  it('no DTO exposes isVerified or moderationState — a client can never assert either (H1)', () => {
    for (const dto of [new CreateProviderReviewDto(), new CreateCustomerReviewDto()]) {
      expect(Object.prototype.hasOwnProperty.call(dto, 'isVerified')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(dto, 'moderationState')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(dto, 'verified')).toBe(false);
    }
  });

  it('the controller exposes no update/delete route for a submitted review (H2), and no longer exposes the retired Traveller -> Traveller star-review route (WS8.3)', () => {
    // A normal user must never be able to submit, see the counterparty's
    // review, and edit their own — that requires there be no mutation
    // entry point at all, not just client-side discipline. Traveller ->
    // Traveller is no longer a review at all (see trust/traveller-feedback).
    const methodNames = Object.getOwnPropertyNames(ReviewsController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methodNames).toEqual(['createProviderReview', 'createCustomerReview']);
    expect(methodNames).not.toContain('createTravellerReview');
    for (const name of methodNames) {
      expect(name.toLowerCase()).not.toMatch(/update|edit|patch|delete/);
    }
  });
});
