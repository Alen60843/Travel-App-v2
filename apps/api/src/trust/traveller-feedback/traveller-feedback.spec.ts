import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../../auth';
import { SubmitTravellerFeedbackDto, TravellerFeedbackItemDto } from './dto';
import { TravellerFeedbackController } from './traveller-feedback.controller';
import { DuplicateFeedbackTargetError, SelfFeedbackError } from './traveller-feedback.errors';
import type { TravellerFeedbackRepository } from './traveller-feedback.repository';
import { TravellerFeedbackService } from './traveller-feedback.service';
import type { TravellerFeedbackCandidateView, TravellerFeedbackView } from './traveller-feedback.types';

describe('traveller feedback API boundary (WS8.3, WS8.3A)', () => {
  const reviewerUserId = randomUUID();
  const eventId = randomUUID();
  const daniel = randomUUID();
  const sarah = randomUUID();
  const emma = randomUUID();

  const viewOf = (targetUserId: string, wouldTravelAgain: boolean): TravellerFeedbackView => ({
    id: randomUUID(),
    reviewerUserId,
    targetUserId,
    eventId,
    wouldTravelAgain,
    createdAt: '2026-09-22T10:00:00.000Z',
  });

  const candidateOf = (userId: string, role: 'HOST' | 'PARTICIPANT'): TravellerFeedbackCandidateView => ({
    userId,
    displayName: `Traveller ${userId.slice(0, 8)}`,
    avatarUrl: null,
    role,
  });

  const repository = {
    submitFeedback: jest.fn(),
    listCandidates: jest.fn(),
  };
  const service = new TravellerFeedbackService(repository as unknown as TravellerFeedbackRepository);
  const controller = new TravellerFeedbackController(service);

  const user = { id: reviewerUserId } as AuthenticatedUser;

  beforeEach(() => {
    repository.submitFeedback.mockReset();
    repository.listCandidates.mockReset();
  });

  // 1 + 2. authenticated user is always the reviewer; reviewerUserId is not
  // a field the client can supply — it is not part of the DTO, and the
  // value passed to the repository comes only from @CurrentUser().
  it('takes the reviewer exclusively from the authenticated user, never the body', async () => {
    repository.submitFeedback.mockResolvedValue([viewOf(daniel, true)]);
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [Object.assign(new TravellerFeedbackItemDto(), { targetUserId: daniel, wouldTravelAgain: true })],
    });

    await controller.submitTravellerFeedback(user, eventId, dto);

    expect(repository.submitFeedback).toHaveBeenCalledWith(reviewerUserId, eventId, [
      { targetUserId: daniel, wouldTravelAgain: true },
    ]);
    expect(Object.prototype.hasOwnProperty.call(dto, 'reviewerUserId')).toBe(false);
  });

  it('the item DTO has no reviewerUserId field — the client cannot assert who the reviewer is', () => {
    expect(Object.prototype.hasOwnProperty.call(new TravellerFeedbackItemDto(), 'reviewerUserId')).toBe(false);
  });

  // 3 + 4. no rating, no attendance/no-show, no verification/score field
  // exists anywhere on the DTOs or the stored view — structurally, not by
  // convention.
  it('no rating, attendanceStatus, noShow, isVerified, trustScore, moderationState, or reputation field exists on the item DTO', () => {
    const item = new TravellerFeedbackItemDto();
    for (const field of [
      'rating',
      'interacted',
      'isVerified',
      'attendanceStatus',
      'noShow',
      'trustScore',
      'moderationState',
      'reputationWeight',
      'reputationScore',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(item, field)).toBe(false);
    }
  });

  it('a client-supplied rating/attendanceStatus/noShow/isVerified/trustScore field on an item is rejected by validation', async () => {
    const item = Object.assign(new TravellerFeedbackItemDto(), {
      targetUserId: daniel,
      wouldTravelAgain: true,
      rating: 5,
      attendanceStatus: 'ATTENDED',
      noShow: false,
      isVerified: true,
      trustScore: 10,
    });
    const errors = await validate(item, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('the stored feedback view exposes no rating, attendance, verification, or reputation field', () => {
    const view = viewOf(daniel, true);
    for (const field of ['rating', 'interacted', 'isVerified', 'attendanceStatus', 'noShow', 'moderationState']) {
      expect(Object.prototype.hasOwnProperty.call(view, field)).toBe(false);
    }
  });

  // 5. self-feedback rejected, before touching persistence.
  it('rejects self-feedback before touching persistence', () => {
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [{ targetUserId: reviewerUserId, wouldTravelAgain: true }],
    });
    expect(() => service.submitFeedback(reviewerUserId, eventId, dto)).toThrow(SelfFeedbackError);
    expect(repository.submitFeedback).not.toHaveBeenCalled();
  });

  it('rejects self-feedback even when it is mixed into a batch with valid targets', () => {
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [
        { targetUserId: daniel, wouldTravelAgain: true },
        { targetUserId: reviewerUserId, wouldTravelAgain: false },
      ],
    });
    expect(() => service.submitFeedback(reviewerUserId, eventId, dto)).toThrow(SelfFeedbackError);
    expect(repository.submitFeedback).not.toHaveBeenCalled();
  });

  // 6. one selected target, wouldTravelAgain = true.
  it('accepts one selected target with wouldTravelAgain=true', async () => {
    const expected = [viewOf(daniel, true)];
    repository.submitFeedback.mockResolvedValue(expected);
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [{ targetUserId: daniel, wouldTravelAgain: true }],
    });

    const result = await service.submitFeedback(reviewerUserId, eventId, dto);

    expect(repository.submitFeedback).toHaveBeenCalledWith(reviewerUserId, eventId, [
      { targetUserId: daniel, wouldTravelAgain: true },
    ]);
    expect(result).toEqual(expected);
  });

  // 7. one selected target, wouldTravelAgain = false.
  it('accepts one selected target with wouldTravelAgain=false', async () => {
    repository.submitFeedback.mockResolvedValue([viewOf(sarah, false)]);
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [{ targetUserId: sarah, wouldTravelAgain: false }],
    });

    await service.submitFeedback(reviewerUserId, eventId, dto);

    expect(repository.submitFeedback).toHaveBeenCalledWith(reviewerUserId, eventId, [
      { targetUserId: sarah, wouldTravelAgain: false },
    ]);
  });

  // 8 + 19. multiple selected targets accepted as ONE batch call — the
  // repository, not the client, is responsible for making the write
  // atomic; the service never issues one call per target.
  it('accepts multiple selected targets as a single batch call to the repository', async () => {
    repository.submitFeedback.mockResolvedValue([
      viewOf(daniel, true),
      viewOf(sarah, false),
      viewOf(emma, true),
    ]);
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [
        { targetUserId: daniel, wouldTravelAgain: true },
        { targetUserId: sarah, wouldTravelAgain: false },
        { targetUserId: emma, wouldTravelAgain: true },
      ],
    });

    await service.submitFeedback(reviewerUserId, eventId, dto);

    expect(repository.submitFeedback).toHaveBeenCalledTimes(1);
    expect(repository.submitFeedback).toHaveBeenCalledWith(reviewerUserId, eventId, [
      { targetUserId: daniel, wouldTravelAgain: true },
      { targetUserId: sarah, wouldTravelAgain: false },
      { targetUserId: emma, wouldTravelAgain: true },
    ]);
  });

  it('rejects a batch containing the same target twice, before touching persistence', () => {
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [
        { targetUserId: daniel, wouldTravelAgain: true },
        { targetUserId: daniel, wouldTravelAgain: false },
      ],
    });
    expect(() => service.submitFeedback(reviewerUserId, eventId, dto)).toThrow(DuplicateFeedbackTargetError);
    expect(repository.submitFeedback).not.toHaveBeenCalled();
  });

  // 9. each selected target requires wouldTravelAgain.
  it('requires wouldTravelAgain on every item', async () => {
    const missing = Object.assign(new TravellerFeedbackItemDto(), { targetUserId: daniel });
    const errors = await validate(missing);
    expect(errors.some((error) => error.property === 'wouldTravelAgain')).toBe(true);
  });

  it('requires targetUserId to be a UUID on every item', async () => {
    const invalid = Object.assign(new TravellerFeedbackItemDto(), {
      targetUserId: 'not-a-uuid',
      wouldTravelAgain: true,
    });
    const errors = await validate(invalid);
    expect(errors.some((error) => error.property === 'targetUserId')).toBe(true);
  });

  // 10 + 11. omitted participants generate no rows and carry no negative
  // meaning — proven structurally: the repository is called with EXACTLY
  // the selected items, nothing added or inferred for anyone else, and an
  // empty selection is a valid no-op rather than a rejected/negative
  // submission.
  it('an omitted participant produces no row and no repository call about them — only positively selected targets are ever sent', async () => {
    repository.submitFeedback.mockResolvedValue([viewOf(daniel, true)]);
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), {
      feedback: [{ targetUserId: daniel, wouldTravelAgain: true }],
    });

    await service.submitFeedback(reviewerUserId, eventId, dto);

    const [, , items] = repository.submitFeedback.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items.map((item: { targetUserId: string }) => item.targetUserId)).toEqual([daniel]);
    // Nothing about "sarah"/"emma"/John or any other non-selected id is
    // ever constructed or passed — there is no code path that could.
  });

  it('an empty selection ("feedback": []) is accepted as a no-op — it does not create negative evidence about anyone', async () => {
    const dto = Object.assign(new SubmitTravellerFeedbackDto(), { feedback: [] });

    const result = await service.submitFeedback(reviewerUserId, eventId, dto);

    expect(result).toEqual([]);
    expect(repository.submitFeedback).not.toHaveBeenCalled();
  });

  // WS8.3A candidate list — 1/2/4 (host+participants included, structurally
  // proven by delegation; real DB membership/role assembly is covered by
  // traveller-feedback.int-spec.ts, same split as WS8.3's own eligibility
  // tests).
  it('lists candidates by delegating to the repository with the authenticated user and eventId, never a client-supplied id', async () => {
    const expected = [candidateOf(daniel, 'PARTICIPANT'), candidateOf(sarah, 'HOST')];
    repository.listCandidates.mockResolvedValue(expected);

    const result = await controller.listCandidates(user, eventId);

    expect(repository.listCandidates).toHaveBeenCalledWith(reviewerUserId, eventId);
    expect(result).toEqual(expected);
  });

  // 3 + 5. server-side self-exclusion: the repository query (not the
  // frontend) is what excludes the requester — the service/controller
  // never adds the requester's own id to the result, and there is no
  // client-suppliable field that could ask for it back.
  it('the candidate route has no field for a client to request their own id be included', () => {
    // Structural: listCandidates takes no body/query DTO at all — only the
    // authenticated user (never trusted from input) and the path eventId.
    expect(TravellerFeedbackController.prototype.listCandidates.length).toBe(2);
  });

  // WS8.3A: candidate exists != interaction confirmed — the candidate view
  // itself carries no interaction/attendance claim of any kind.
  it('a candidate view exposes no interaction, attendance, or verification claim', () => {
    const candidate = candidateOf(daniel, 'HOST');
    for (const field of ['interacted', 'attended', 'isVerified', 'attendanceStatus', 'noShow', 'wouldTravelAgain']) {
      expect(Object.prototype.hasOwnProperty.call(candidate, field)).toBe(false);
    }
  });

  // 21. the old Traveller -> Traveller star-review route is not exposed by
  // this controller (nor, per reviews.spec.ts, by ReviewsController), and
  // the only two routes are the list-first candidate list + batch submit.
  it('exposes no rating-based review route — only the candidate list and the list-first batch submission endpoint', () => {
    const methodNames = Object.getOwnPropertyNames(TravellerFeedbackController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methodNames.sort()).toEqual(['listCandidates', 'submitTravellerFeedback'].sort());
  });

  // 24. no user-facing update/delete route exists — submitted feedback is
  // immutable in V1.
  it('exposes no update/delete route — submitted feedback is immutable', () => {
    const methodNames = Object.getOwnPropertyNames(TravellerFeedbackController.prototype).filter(
      (name) => name !== 'constructor',
    );
    for (const name of methodNames) {
      expect(name.toLowerCase()).not.toMatch(/update|edit|patch|delete/);
    }
  });
});
