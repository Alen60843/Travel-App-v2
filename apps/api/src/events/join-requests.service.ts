import { Injectable } from '@nestjs/common';
import {
  AttendanceStatus, canTransition, EventHostType, EventParticipantCancellationReason,
  EventStatus, JoinRequestStatus, RestrictionType, UserAccountStatus,
} from '@tripwith/shared';
import { In, IsNull, LessThanOrEqual, MoreThan, type EntityManager } from 'typeorm';

import { ChatRepository } from '../chat/chat.repository';
import { AppError, ValidationError } from '../common/errors/app-error';
import {
  AccountRestrictionEntity, EventEntity, EventJoinRequestEntity,
  EventParticipantEntity, UserEntity,
} from '../database/entities';
import type { CreateJoinRequestDto } from './dto/create-join-request.dto';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';
import { joinError, translateJoinConflict } from './join-requests.errors';

export interface JoinRequestView {
  readonly id: string;
  readonly eventId: string;
  readonly userId: string;
  readonly status: JoinRequestStatus;
  readonly message: string | null;
  /** WS8.5B: immutable historical record — the party size AS REQUESTED, never rewritten after decision. */
  readonly guestCount: number;
  readonly requestedSeats: number;

  // WS8.5C: immutable snapshot of capacity AT REQUEST TIME — never
  // rewritten, independent of whatever capacityMax/reservedSeatCount are
  // now. "Your request was submitted for 3 seats when only 2 were
  // available" is exactly capacityMaxAtRequest/reservedSeatCountAtRequest/
  // requestedSeats.
  readonly capacityMaxAtRequest: number;
  readonly reservedSeatCountAtRequest: number;
  readonly availableSeatsAtRequest: number;
  readonly exceededCapacityAtRequest: boolean;
  readonly exceededByAtRequest: number;

  // WS8.5C: dynamic, computed from the Event's CURRENT capacity — distinct
  // from the snapshot above (a request that exceeded capacity when
  // submitted may fit again later if someone leaves). `null` when the
  // caller did not have the current Event loaded (see
  // JoinRequestsService.view) — never fabricated as false/0.
  readonly currentCapacityMax: number | null;
  readonly currentReservedSeatCount: number | null;
  readonly currentAvailableSeats: number | null;
  readonly currentlyFits: boolean | null;
  readonly currentOverrideRequired: boolean | null;
  readonly currentExceedsBy: number | null;

  // WS8.5C: capacity-override audit evidence. All null unless an actual
  // override was used to approve THIS request (see
  // JoinRequestsService.approveWithCapacityOverride) — never set merely
  // because the request originally exceeded capacity.
  readonly capacityOverrideApprovedAt: string | null;
  readonly capacityOverrideApprovedByUserId: string | null;
  readonly capacityBeforeOverride: number | null;
  readonly capacityAfterOverride: number | null;

  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
  readonly cancelledAt: string | null;
  readonly expiredAt: string | null;
}

/**
 * WS8.4B: the compact result of a leave/remove command. Deliberately not
 * the full EventParticipantEntity — no payment_id, no join_request_id,
 * nothing beyond what a client needs to confirm the outcome.
 */
export interface MembershipView {
  readonly eventId: string;
  readonly userId: string;
  readonly cancelledAt: string;
  readonly cancelledByUserId: string;
  readonly cancellationReason: EventParticipantCancellationReason;
}

@Injectable()
export class JoinRequestsService {
  constructor(
    private readonly events: EventsRepository,
    private readonly chat: ChatRepository,
  ) {}

  async create(userId: string, eventId: string, body: CreateJoinRequestDto): Promise<JoinRequestView> {
    // Fresh alias, read via a binding assertBody's assertion never narrows
    // (the assertion narrows only the `body` identifier it is called with,
    // to Record<string, unknown> — fine for `message` (only ever used with
    // typeof/!==) but would make guestCount's numeric comparisons below
    // untypeable if read through `body` itself after the call).
    const dto = body;
    this.assertBody(body, ['message', 'guestCount']);
    const message = dto.message ?? null;
    const guestCount = dto.guestCount ?? 0;
    if (message !== null && (typeof message !== 'string' || Array.from(message).length > 500 || message.includes('\0'))) {
      throw new ValidationError('message must be text of at most 500 characters without NUL.');
    }
    if (!Number.isInteger(guestCount) || guestCount < 0 || guestCount > 9999) {
      throw new ValidationError('guestCount must be an integer between 0 and 9999.');
    }
    return this.command(async (manager) => {
      const event = await this.lockEvent(manager, eventId);
      const requests = manager.getRepository(EventJoinRequestEntity);
      const live = await requests.findOne({
        where: { eventId, userId, status: In([JoinRequestStatus.Pending, JoinRequestStatus.Approved]) },
        lock: { mode: 'pessimistic_write' },
      });
      if (live && !(await this.expire(manager, live))) return joinError('JOIN_REQUEST_ALREADY_EXISTS');

      // Validation failures are returned so any expiry above commits. No new
      // request/participant has been written at this point.
      try {
        await this.requireEligibleUser(manager, userId, event);
        this.assertJoinable(event);
        // WS8.5C: deliberately NO capacity/party-fit check here — a Join
        // Request may now be created even when it exceeds current remaining
        // capacity (capacityMax is a configured/planned limit, not always a
        // hard wall; the USER host may explicitly override it later). Only
        // status/time/deposit eligibility gate creation.
      } catch (error) {
        if (error instanceof AppError) return error;
        throw error;
      }
      if (await manager.getRepository(EventParticipantEntity).exists({
        where: { eventId, userId, cancelledAt: IsNull() },
      })) return joinError('EVENT_ALREADY_JOINED');

      // WS8.5C: server-derived snapshot, read under the same Event-row lock
      // already held above — never client-suppliable, never rewritten
      // after this INSERT.
      const capacityMaxAtRequest = event.capacityMax;
      const reservedSeatCountAtRequest = event.reservedSeatCount;
      const requestedSeats = 1 + guestCount;
      const fitsNow = requestedSeats <= capacityMaxAtRequest - reservedSeatCountAtRequest;

      const requestedAt = new Date();
      const request = await requests.save(requests.create({
        eventId, userId, message, guestCount, status: JoinRequestStatus.Pending,
        capacityMaxAtRequest, reservedSeatCountAtRequest,
        requestedAt, expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000),
        paymentId: null, approvedAt: null, rejectedAt: null, cancelledAt: null,
        expiredAt: null, decidedByUserId: null,
        capacityOverrideApprovedAt: null, capacityOverrideApprovedByUserId: null,
        capacityBeforeOverride: null, capacityAfterOverride: null,
      }));
      // WS8.5C: auto-approval is a convenience for the ordinary case only —
      // it must NEVER silently expand capacityMax. If the party doesn't fit
      // right now, it stays PENDING regardless of joinApprovalRequired;
      // only an explicit host override (or capacity freeing up naturally,
      // followed by ordinary approval) can move it forward.
      let currentEvent = event;
      if (!event.joinApprovalRequired && fitsNow) {
        // Always UPDATE from PENDING: the existing payment guard is an UPDATE
        // trigger. Auto-approval records approval time, but no host decision.
        await this.approveAndParticipate(manager, event, request, null, userId);
        // Re-read: auto-approval just changed reservedSeatCount (and
        // possibly status) via triggers that the in-memory `event` object
        // does not reflect.
        currentEvent = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
      }
      return this.view(request, currentEvent);
    });
  }

  async listMine(userId: string): Promise<JoinRequestView[]> {
    return this.events.transaction(async (manager) => {
      const requests = await manager.getRepository(EventJoinRequestEntity).find({
        where: { userId }, order: { requestedAt: 'DESC', id: 'ASC' },
      });
      // WS8.5C: a requester's own requests span multiple Events, so bulk-
      // load the current capacity state of exactly the ones referenced —
      // one extra query, not N — so the requester can still see whether
      // each request currently fits, not just its immutable snapshot.
      const eventIds = [...new Set(requests.map((request) => request.eventId))];
      const events = eventIds.length === 0 ? [] : await manager.getRepository(EventEntity).find({
        where: { id: In(eventIds) },
      });
      const eventsById = new Map(events.map((event) => [event.id, event]));
      return requests.map((request) => this.view(request, eventsById.get(request.eventId)));
    });
  }

  async listForHost(userId: string, eventId: string): Promise<JoinRequestView[]> {
    return this.events.transaction(async (manager) => {
      const event = await this.requireOwnedEvent(manager, userId, eventId);
      const requests = await manager.getRepository(EventJoinRequestEntity).find({
        where: { eventId }, order: { requestedAt: 'DESC', id: 'ASC' },
      });
      return requests.map((request) => this.view(request, event));
    });
  }

  async cancel(userId: string, requestId: string, body: unknown = {}): Promise<JoinRequestView> {
    this.assertBody(body, []);
    return this.command(async (manager) => {
      const requests = manager.getRepository(EventJoinRequestEntity);
      // This read only locates the event. All mutable state is re-read after
      // locking in the same event -> request order as approval and lifecycle.
      const located = await requests.findOneBy({ id: requestId, userId });
      if (!located) throw joinError('JOIN_REQUEST_NOT_FOUND');
      const event = await this.lockEvent(manager, located.eventId);
      const request = await requests.findOne({
        where: { id: requestId, userId, eventId: located.eventId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw joinError('JOIN_REQUEST_NOT_FOUND');
      const failure = await this.pendingFailure(manager, request);
      if (failure) return failure;
      request.status = JoinRequestStatus.Cancelled;
      request.cancelledAt = new Date();
      await requests.save(request);
      return this.view(request, event);
    });
  }

  async approve(userId: string, eventId: string, requestId: string, body: unknown = {}): Promise<JoinRequestView> {
    return this.decide(userId, eventId, requestId, true, body);
  }

  async reject(userId: string, eventId: string, requestId: string, body: unknown = {}): Promise<JoinRequestView> {
    return this.decide(userId, eventId, requestId, false, body);
  }

  /**
   * Self-leave. The authenticated user is always the participant leaving —
   * never taken from a body. The USER host has no EventParticipant row at
   * all (see approveAndParticipate) and must not be able to "leave" their
   * own Event through this participant-shaped action; they have Event
   * cancellation/management semantics instead (HOST_CANNOT_LEAVE_...).
   */
  async leave(userId: string, eventId: string): Promise<MembershipView> {
    return this.command(async (manager) => {
      const event = await this.lockEvent(manager, eventId);
      if (event.hostUserId === userId) return joinError('HOST_CANNOT_LEAVE_VIA_PARTICIPANT_ENDPOINT');
      const window = this.assertLeavable(event);
      if (window) return window;
      return this.cancelParticipation(
        manager, event, userId, userId, EventParticipantCancellationReason.VoluntaryLeave,
      );
    });
  }

  /**
   * Organizer remove. Only the exact USER host who owns eventId may call
   * this (requireOwnedEvent both authorizes AND locks in one query, same
   * as decide()); the host cannot target themselves — hosts are never
   * EventParticipant rows to begin with, so "removing" the host is not a
   * meaningful participant action.
   */
  async remove(hostUserId: string, eventId: string, participantUserId: string): Promise<MembershipView> {
    return this.command(async (manager) => {
      const event = await this.requireOwnedEvent(manager, hostUserId, eventId);
      if (participantUserId === hostUserId) return joinError('HOST_CANNOT_REMOVE_SELF');
      const window = this.assertLeavable(event);
      if (window) return window;
      return this.cancelParticipation(
        manager, event, participantUserId, hostUserId, EventParticipantCancellationReason.HostRemoval,
      );
    });
  }

  /**
   * WS8.4B pre-start boundary: normal leave/remove is only available while
   * the Event is ACTIVE or FULL and strictly before starts_at. CANCELLED is
   * rejected outright; DRAFT never has participants to begin with (joining
   * requires ACTIVE — see assertJoinable); IN_PROGRESS/COMPLETED are
   * already excluded by the time check alone, since starts_at is frozen
   * once an Event leaves DRAFT (updateEvent requires DRAFT). One
   * undifferentiated error, same reasoning as EVENT_NOT_JOINABLE — a client
   * should not be able to probe which specific fact failed.
   */
  private assertLeavable(event: EventEntity): AppError | null {
    const leavableStatus = event.status === EventStatus.Active || event.status === EventStatus.Full;
    if (!leavableStatus || event.startsAt.getTime() <= Date.now()) return joinError('EVENT_MEMBERSHIP_LOCKED');
    return null;
  }

  /**
   * Shared leave/remove write path.
   *
   * Idempotency (WS8.4B mobile-safe requirement): the participant row is
   * locked first; if it is ALREADY cancelled, this returns the existing
   * audit metadata as-is and performs no further writes at all — no
   * re-insert, no chat call, no status transition attempt. First successful
   * cancellation wins and its audit metadata (cancelled_at,
   * cancelled_by_user_id, cancellation_reason) is never overwritten by a
   * retry. A participant row that never existed for this (event, user) is a
   * distinct, honest EVENT_NOT_A_MEMBER — not silently treated as success.
   *
   * Payment guard: paid joining is blocked upstream today (assertJoinable),
   * so payment_id is always NULL in current practice — this check is
   * deliberately defensive so a future payment feature can never have its
   * cancellation silently mishandled by this free-path code.
   */
  private async cancelParticipation(
    manager: EntityManager,
    event: EventEntity,
    participantUserId: string,
    actorUserId: string,
    reason: EventParticipantCancellationReason,
  ): Promise<MembershipView | AppError> {
    const participants = manager.getRepository(EventParticipantEntity);
    const participant = await participants.findOne({
      where: { eventId: event.id, userId: participantUserId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!participant) return joinError('EVENT_NOT_A_MEMBER');

    if (participant.cancelledAt) return this.membershipView(participant);

    if (participant.paymentId) return joinError('PAID_PARTICIPATION_CANCELLATION_NOT_SUPPORTED');

    const cancelledAt = new Date();
    await participants.update(
      { id: participant.id, cancelledAt: IsNull() },
      {
        cancelledAt,
        attendanceStatus: AttendanceStatus.Cancelled,
        cancelledByUserId: actorUserId,
        cancellationReason: reason,
      },
    );

    // Same transaction, never a separate one — see ChatRepository's own WS5
    // integration-contract comment for why (a chat-only failure must not
    // leave a stranger-free but still-listed participant, or vice versa).
    // A missing room (an Event that never had chat provisioned) is a safe
    // no-op, not an error — nothing to deactivate.
    const roomId = await this.chat.findEventRoomId(manager, event.id);
    if (roomId) await this.chat.deactivateEventMember(manager, roomId, participantUserId);

    // Re-read the trigger-maintained counters; never calculate or write
    // them here (tw_sync_participant_count / tw_sync_reserved_seat_count
    // are authoritative). WS8.5B: the seat-release check uses
    // reservedSeatCount (physical seats), so leaving/removing a
    // multi-guest party correctly frees ALL of its seats atomically, not
    // just one.
    const refreshed = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
    if (
      event.status === EventStatus.Full
      && refreshed.reservedSeatCount < refreshed.capacityMax
      && canTransition(refreshed.status, EventStatus.Active)
    ) {
      await this.events.setTransitionContext(manager, actorUserId, 'seat_freed');
      await manager.getRepository(EventEntity).update(event.id, { status: EventStatus.Active });
    }

    return {
      eventId: event.id,
      userId: participantUserId,
      cancelledAt: cancelledAt.toISOString(),
      cancelledByUserId: actorUserId,
      cancellationReason: reason,
    };
  }

  private membershipView(participant: EventParticipantEntity): MembershipView {
    if (!participant.cancelledAt || !participant.cancelledByUserId || !participant.cancellationReason) {
      throw new Error('membershipView called on a non-cancelled EventParticipant.');
    }
    return {
      eventId: participant.eventId,
      userId: participant.userId,
      cancelledAt: participant.cancelledAt.toISOString(),
      cancelledByUserId: participant.cancelledByUserId,
      cancellationReason: participant.cancellationReason,
    };
  }

  private async decide(userId: string, eventId: string, requestId: string, approve: boolean, body: unknown): Promise<JoinRequestView> {
    this.assertBody(body, []);
    return this.command(async (manager) => {
      const event = await this.requireOwnedEvent(manager, userId, eventId);
      const request = await manager.getRepository(EventJoinRequestEntity).findOne({
        where: { id: requestId, eventId }, lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw joinError('JOIN_REQUEST_NOT_FOUND');
      const failure = await this.pendingFailure(manager, request);
      if (failure) return failure;
      let currentEvent = event;
      if (approve) {
        let eligibilityFailure: AppError | null = null;
        try {
          await this.requireEligibleUser(manager, request.userId, event);
        } catch (error) {
          if (!(error instanceof AppError)) throw error;
          eligibilityFailure = error;
        }
        // Recheck expiry after the user lock too, including when current user
        // eligibility failed: waiting may have crossed the deadline.
        const overdue = await this.pendingFailure(manager, request);
        if (overdue) return overdue;
        if (eligibilityFailure) return eligibilityFailure;
        this.assertJoinable(event);
        // Authoritative recheck (WS8.5C): ordinary approval is capacity-safe
        // and NEVER silently expands capacityMax — if the party does not
        // currently fit, it fails outright (EVENT_CAPACITY_OVERRIDE_REQUIRED)
        // and the host must use the explicit override action instead.
        // `event` was read fresh under requireOwnedEvent's pessimistic lock
        // at the top of this transaction, so reservedSeatCount is current.
        this.assertPartyFits(event, request.guestCount);
        await this.approveAndParticipate(manager, event, request, userId, userId);
        currentEvent = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
      } else {
        request.status = JoinRequestStatus.Rejected;
        request.rejectedAt = new Date();
        request.decidedByUserId = userId;
        await manager.getRepository(EventJoinRequestEntity).save(request);
      }
      return this.view(request, currentEvent);
    });
  }

  /**
   * WS8.5C: explicit, organizer-only approval of a party that does NOT fit
   * current remaining capacity — visibly distinct from ordinary approve().
   * Only this action may ever raise capacityMax; ordinary approve() never
   * does. Same authorization (requireOwnedEvent — exact USER host, same
   * lock) and lifecycle protections (pendingFailure, requireEligibleUser,
   * assertJoinable) as ordinary approval; the only behavioral difference is
   * what happens when the party does not fit.
   */
  async approveWithCapacityOverride(
    hostUserId: string,
    eventId: string,
    requestId: string,
    body: unknown = {},
  ): Promise<JoinRequestView> {
    // Empty allowlist: the client can never supply newCapacityMax,
    // capacityIncrease, overrideSeats, reservedSeatCount, or anything else —
    // the server derives the exact required value, always.
    this.assertBody(body, []);
    return this.command(async (manager) => {
      const event = await this.requireOwnedEvent(manager, hostUserId, eventId);
      const request = await manager.getRepository(EventJoinRequestEntity).findOne({
        where: { id: requestId, eventId }, lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw joinError('JOIN_REQUEST_NOT_FOUND');
      const failure = await this.pendingFailure(manager, request);
      if (failure) return failure;

      let eligibilityFailure: AppError | null = null;
      try {
        await this.requireEligibleUser(manager, request.userId, event);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        eligibilityFailure = error;
      }
      const overdue = await this.pendingFailure(manager, request);
      if (overdue) return overdue;
      if (eligibilityFailure) return eligibilityFailure;
      this.assertJoinable(event);

      const requestedSeats = 1 + request.guestCount;
      const remainingSeats = event.capacityMax - event.reservedSeatCount;
      if (requestedSeats <= remainingSeats) {
        // WS8.5C: the party already fits by decision time (e.g. someone
        // left since this request was created) — approve normally. No
        // override happened, so no override audit evidence is written;
        // capacityMax is never touched. Never fabricate override evidence
        // merely because the request originally exceeded capacity.
        await this.approveAndParticipate(manager, event, request, hostUserId, hostUserId);
        const currentEvent = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
        return this.view(request, currentEvent);
      }

      // WS8.5C: minimum required capacity only — never a client-supplied
      // number, never more than exactly what this party needs.
      const capacityBeforeOverride = event.capacityMax;
      const requiredCapacity = event.reservedSeatCount + requestedSeats;
      if (requiredCapacity > 10_000) return joinError('EVENT_CAPACITY_OVERRIDE_LIMIT_EXCEEDED');

      // Bump capacityMax FIRST, in the same transaction/lock, before the
      // participant is inserted — the participant INSERT's trigger raises
      // reserved_seat_count next, and events_reserved_seat_count_capacity_chk
      // must never observe reserved_seat_count > capacity_max even
      // transiently within the transaction.
      await manager.getRepository(EventEntity).update(event.id, { capacityMax: requiredCapacity });
      event.capacityMax = requiredCapacity;

      request.capacityOverrideApprovedAt = new Date();
      request.capacityOverrideApprovedByUserId = hostUserId;
      request.capacityBeforeOverride = capacityBeforeOverride;
      request.capacityAfterOverride = requiredCapacity;

      // approveAndParticipate's own request.save() persists the override
      // fields set above together with status=APPROVED in one write — see
      // its own body.
      await this.approveAndParticipate(manager, event, request, hostUserId, hostUserId);
      const currentEvent = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
      return this.view(request, currentEvent);
    });
  }

  private async approveAndParticipate(manager: EntityManager, event: EventEntity, request: EventJoinRequestEntity, decidedBy: string | null, actor: string): Promise<void> {
    request.status = JoinRequestStatus.Approved;
    request.approvedAt = new Date();
    request.decidedByUserId = decidedBy;
    await manager.getRepository(EventJoinRequestEntity).save(request);
    await manager.getRepository(EventParticipantEntity).insert({
      eventId: event.id, userId: request.userId, joinRequestId: request.id,
      paymentId: null, isHost: false, attendanceStatus: AttendanceStatus.Unknown,
      // WS8.5B: copied once, from the approving (now-immutable-history)
      // request, into the CURRENT membership row. Never written again after
      // this INSERT — see EventParticipantEntity.guestCount.
      guestCount: request.guestCount,
    });
    // WS5: EVENT chat provisioning, inside this same transaction/manager —
    // never a separate one. Both manual and auto approval reach this single
    // method, so both always end up with identical chat state. The host has
    // no EventParticipant row in Phase 6 (see events.service.ts), so their
    // chat membership can only be established here; event.hostUserId is the
    // server-authoritative host identity, never taken from a request body.
    // Any failure below throws and rolls back the whole approval.
    // lockEvent/requireOwnedEvent only ever select USER-hosted events
    // (hostType: User, hostProviderId: IsNull()), so hostUserId is always
    // set here; the entity's wider `string | null` type just doesn't carry
    // that narrowing across the query boundary.
    if (!event.hostUserId) throw new Error('USER-hosted event unexpectedly has no hostUserId');
    const roomId = await this.chat.ensureEventRoom(manager, event.id);
    await this.chat.activateEventMember(manager, roomId, event.hostUserId);
    await this.chat.activateEventMember(manager, roomId, request.userId);
    // Re-read the trigger-maintained counters; never calculate or write them
    // here. WS8.5B: FULL now follows physical seat occupancy
    // (reservedSeatCount), not registered-participant count.
    const current = await manager.getRepository(EventEntity).findOneByOrFail({ id: event.id });
    if (current.reservedSeatCount === current.capacityMax && canTransition(current.status, EventStatus.Full)) {
      await this.events.setTransitionContext(manager, actor, 'capacity_reached');
      await manager.getRepository(EventEntity).update(event.id, { status: EventStatus.Full });
    }
  }

  private async requireEligibleUser(manager: EntityManager, userId: string, event: EventEntity): Promise<void> {
    if (event.hostUserId === userId) throw joinError('EVENT_SELF_JOIN');
    const user = await manager.getRepository(UserEntity).findOne({
      where: { id: userId }, lock: { mode: 'pessimistic_read' },
    });
    if (!user || user.deletedAt || user.accountStatus !== UserAccountStatus.Active) {
      throw joinError('JOIN_ACCOUNT_UNAVAILABLE');
    }
    const now = new Date();
    const restriction = { userId, type: RestrictionType.FullSuspension, startsAt: LessThanOrEqual(now), liftedAt: IsNull() };
    if (await manager.getRepository(AccountRestrictionEntity).exists({
      where: [{ ...restriction, endsAt: IsNull() }, { ...restriction, endsAt: MoreThan(now) }],
    })) throw joinError('JOIN_ACCOUNT_UNAVAILABLE');
    if (user.trustScore === null || user.trustScore < event.minTrustScore) throw joinError('EVENT_TRUST_REQUIRED');
  }

  /**
   * WS8.5C: FULL Events may still receive/decide Join Requests — FULL only
   * describes current physical occupancy (reservedSeatCount >=
   * capacityMax), it no longer means "closed to new requests." Capacity
   * itself is deliberately NOT checked here at all — see assertPartyFits,
   * which is the ONLY capacity gate, and only for ordinary (non-override)
   * approval, never for request creation.
   */
  private assertJoinable(event: EventEntity): void {
    const joinableStatus = event.status === EventStatus.Active || event.status === EventStatus.Full;
    if (!joinableStatus || event.startsAt.getTime() <= Date.now()) throw joinError('EVENT_NOT_JOINABLE');
    if (event.depositMinor > 0) throw joinError('PAID_JOIN_NOT_AVAILABLE');
  }

  /**
   * WS8.5C: the ONLY capacity gate left, and it applies exclusively to
   * ORDINARY approval — "does THIS SPECIFIC party fit current remaining
   * capacity, under the authoritative lock, right now." Never used at
   * request creation (a request may exist over-capacity; see create()).
   * A party may be rejected here even when the Event has SOME remaining
   * seats, if not enough for the whole party — never a partial approval;
   * the whole party fits or the host must use the explicit override action.
   */
  private assertPartyFits(event: EventEntity, guestCount: number): void {
    const requestedSeats = 1 + guestCount;
    const remainingSeats = event.capacityMax - event.reservedSeatCount;
    if (requestedSeats > remainingSeats) throw joinError('EVENT_CAPACITY_OVERRIDE_REQUIRED');
  }

  private async lockEvent(manager: EntityManager, eventId: string): Promise<EventEntity> {
    const event = await manager.getRepository(EventEntity).findOne({
      where: { id: eventId, hostType: EventHostType.User, hostProviderId: IsNull() },
      lock: { mode: 'pessimistic_write' },
    });
    if (!event) throw new EventNotFoundError();
    return event;
  }

  private async requireOwnedEvent(manager: EntityManager, userId: string, eventId: string): Promise<EventEntity> {
    const event = await this.events.findOwnedEvent(manager, userId, eventId, true);
    if (!event) throw new EventNotFoundError();
    return event;
  }

  private async expire(manager: EntityManager, request: EventJoinRequestEntity): Promise<boolean> {
    const now = new Date();
    if (request.status !== JoinRequestStatus.Pending || request.expiresAt.getTime() > now.getTime()) return false;
    request.status = JoinRequestStatus.Expired;
    request.expiredAt = now;
    await manager.getRepository(EventJoinRequestEntity).save(request);
    return true;
  }

  private async pendingFailure(manager: EntityManager, request: EventJoinRequestEntity): Promise<AppError | null> {
    if (await this.expire(manager, request) || request.status === JoinRequestStatus.Expired) return joinError('JOIN_REQUEST_EXPIRED');
    return request.status === JoinRequestStatus.Pending ? null : joinError('JOIN_REQUEST_NOT_PENDING');
  }

  private async command<T>(work: (manager: EntityManager) => Promise<T | AppError>): Promise<T> {
    try {
      const result = await this.events.transaction(work);
      // Throw only after commit when a command has durably expired a row.
      if (result instanceof AppError) throw result;
      return result;
    } catch (error) {
      throw translateJoinConflict(error);
    }
  }


  private assertBody(body: unknown, fields: readonly string[]): asserts body is Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) {
      throw new ValidationError('Request contains unsupported fields.');
    }
  }

  /**
   * WS8.5C: `currentEvent` is optional because not every caller has the
   * Event loaded (e.g. a hypothetical future bulk path) — when omitted,
   * the `current*` fields are `null`, never fabricated. Every caller in
   * this service DOES pass it today (create/decide/
   * approveWithCapacityOverride/cancel/listForHost/listMine all load or
   * bulk-load the Event(s) involved), so `null` is not currently reachable
   * from any route, but the type honestly reflects that this is a
   * best-effort enrichment, not a guarantee.
   */
  private view(request: EventJoinRequestEntity, currentEvent?: Pick<EventEntity, 'capacityMax' | 'reservedSeatCount'>): JoinRequestView {
    const requestedSeats = 1 + request.guestCount;
    const availableSeatsAtRequest = Math.max(0, request.capacityMaxAtRequest - request.reservedSeatCountAtRequest);
    const exceededByAtRequest = Math.max(0, requestedSeats - availableSeatsAtRequest);

    const currentAvailableSeats = currentEvent
      ? Math.max(0, currentEvent.capacityMax - currentEvent.reservedSeatCount)
      : null;

    return {
      id: request.id, eventId: request.eventId, userId: request.userId,
      status: request.status, message: request.message,
      guestCount: request.guestCount, requestedSeats,

      capacityMaxAtRequest: request.capacityMaxAtRequest,
      reservedSeatCountAtRequest: request.reservedSeatCountAtRequest,
      availableSeatsAtRequest,
      exceededCapacityAtRequest: exceededByAtRequest > 0,
      exceededByAtRequest,

      currentCapacityMax: currentEvent?.capacityMax ?? null,
      currentReservedSeatCount: currentEvent?.reservedSeatCount ?? null,
      currentAvailableSeats,
      currentlyFits: currentAvailableSeats === null ? null : requestedSeats <= currentAvailableSeats,
      currentOverrideRequired: currentAvailableSeats === null ? null : requestedSeats > currentAvailableSeats,
      currentExceedsBy: currentAvailableSeats === null ? null : Math.max(0, requestedSeats - currentAvailableSeats),

      capacityOverrideApprovedAt: request.capacityOverrideApprovedAt?.toISOString() ?? null,
      capacityOverrideApprovedByUserId: request.capacityOverrideApprovedByUserId,
      capacityBeforeOverride: request.capacityBeforeOverride,
      capacityAfterOverride: request.capacityAfterOverride,

      requestedAt: request.requestedAt.toISOString(), expiresAt: request.expiresAt.toISOString(),
      approvedAt: request.approvedAt?.toISOString() ?? null,
      rejectedAt: request.rejectedAt?.toISOString() ?? null,
      cancelledAt: request.cancelledAt?.toISOString() ?? null,
      expiredAt: request.expiredAt?.toISOString() ?? null,
    };
  }
}
