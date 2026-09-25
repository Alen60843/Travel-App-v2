import { Injectable } from '@nestjs/common';
import {
  EventHostType,
  EventStatus,
  EventVisibility,
  JoinRequestStatus,
} from '@tripwith/shared';
import { IsNull, type EntityManager } from 'typeorm';

import { ChatRepository } from '../chat/chat.repository';
import {
  EventEntity,
  EventJoinRequestEntity,
  EventParticipantEntity,
  UserEntity,
} from '../database/entities';
import {
  EventViewerPrimaryAction,
  type EventJoinUnavailableReason,
  type EventViewerRelationship,
  type PublicEventDetail,
  type PublicEventDetailView,
  type PublicEventHostSummary,
} from './event-detail.types';
import { deriveEventGroupFormation } from './event-group-state';
import { findEventManagerUserId } from './event-management';
import { EventNotFoundError } from './events.errors';
import { EventsRepository } from './events.repository';

const JOINABLE_STATUSES: ReadonlySet<EventStatus> = new Set([EventStatus.Active, EventStatus.Full]);

export interface EventDetailAccessFacts {
  readonly status: EventStatus;
  readonly visibility: EventVisibility;
  /** A resolvable manager exists (USER host, or a claimed, non-deleted Provider). */
  readonly hasManager: boolean;
  readonly isManager: boolean;
  readonly isParticipant: boolean;
  /** A PENDING JoinRequest that has not yet passed its expiry. */
  readonly hasLivePendingRequest: boolean;
}

/**
 * Who may open GET /v1/events/:eventId. Anything else is indistinguishable
 * from a missing Event (EventNotFoundError), so existence never leaks.
 *
 *   1. The Event's manager: always (including their own DRAFT).
 *   2. DRAFT: nobody else, ever.
 *   3. An active participant or a live pending requester: in any later
 *      lifecycle state (FULL, IN_PROGRESS, COMPLETED, CANCELLED) and at any
 *      visibility — it is their Event.
 *   4. Everyone else: exactly Explorer's discoverable set — visibility PUBLIC
 *      and status ACTIVE/FULL — and only when the Event has a manager (a
 *      session of an unclaimed Provider is not operational, per Step 2).
 *      UNLISTED and PRIVATE never reach unrelated users through this route.
 */
export function canViewEventDetail(facts: EventDetailAccessFacts): boolean {
  if (facts.isManager) return true;
  if (facts.status === EventStatus.Draft) return false;
  if (facts.isParticipant || facts.hasLivePendingRequest) return true;
  return facts.visibility === EventVisibility.Public
    && JOINABLE_STATUSES.has(facts.status)
    && facts.hasManager;
}

export interface EventViewerFacts {
  readonly isManager: boolean;
  /** guest_count of the viewer's ACTIVE participation, or null when not a current member. */
  readonly activeParticipantGuestCount: number | null;
  readonly latestJoinRequest: Pick<
    EventJoinRequestEntity,
    'id' | 'status' | 'guestCount' | 'expiresAt'
  > | null;
  readonly event: Pick<EventEntity, 'status' | 'startsAt' | 'depositMinor' | 'minTrustScore'>;
  readonly hasManager: boolean;
  readonly viewerTrustScore: number | null;
  readonly chatRoomId: string | null;
  readonly now: Date;
}

/** A PENDING row past its deadline is expired in fact, even before a command persists it. */
export function effectiveJoinRequestStatus(
  request: Pick<EventJoinRequestEntity, 'status' | 'expiresAt'>,
  now: Date,
): JoinRequestStatus {
  return request.status === JoinRequestStatus.Pending && request.expiresAt.getTime() <= now.getTime()
    ? JoinRequestStatus.Expired
    : request.status;
}

/**
 * Mirrors JoinRequestsService.create()'s gates in the same order (trust,
 * then status/time, then deposit), so the button the client shows matches
 * what the join endpoint would actually do. Capacity is deliberately not a
 * gate: a request to a FULL or too-small Event is still created and simply
 * stays PENDING (WS8.5C).
 */
function joinUnavailableReason(facts: EventViewerFacts): EventJoinUnavailableReason | null {
  if (facts.viewerTrustScore === null || facts.viewerTrustScore < facts.event.minTrustScore) {
    return 'EVENT_TRUST_REQUIRED';
  }
  if (
    !facts.hasManager
    || !JOINABLE_STATUSES.has(facts.event.status)
    || facts.event.startsAt.getTime() <= facts.now.getTime()
  ) {
    return 'EVENT_NOT_JOINABLE';
  }
  if (facts.event.depositMinor > 0) return 'PAID_JOIN_NOT_AVAILABLE';
  return null;
}

/**
 * JoinRequest = historical decision record; EventParticipant = current
 * membership (Phase 8). isParticipant/partySize come ONLY from the active
 * participant row; a historical APPROVED request or a cancelled
 * participation never makes the viewer a member.
 */
export function deriveViewerRelationship(facts: EventViewerFacts): EventViewerRelationship {
  const isParticipant = !facts.isManager && facts.activeParticipantGuestCount !== null;
  const joinRequest = facts.latestJoinRequest
    ? {
      id: facts.latestJoinRequest.id,
      status: effectiveJoinRequestStatus(facts.latestJoinRequest, facts.now),
      requestedSeats: 1 + facts.latestJoinRequest.guestCount,
    }
    : null;
  const awaitingApproval = !facts.isManager && !isParticipant
    && joinRequest?.status === JoinRequestStatus.Pending;
  const reason = facts.isManager || isParticipant || awaitingApproval ? null : joinUnavailableReason(facts);
  const canRequestToJoin = !facts.isManager && !isParticipant && !awaitingApproval && reason === null;

  let primaryAction: EventViewerPrimaryAction = EventViewerPrimaryAction.None;
  if (facts.isManager) primaryAction = EventViewerPrimaryAction.Manage;
  else if (isParticipant) primaryAction = EventViewerPrimaryAction.OpenChat;
  else if (awaitingApproval) primaryAction = EventViewerPrimaryAction.AwaitingApproval;
  else if (canRequestToJoin) primaryAction = EventViewerPrimaryAction.RequestToJoin;

  return {
    isManager: facts.isManager,
    isParticipant,
    partySize: isParticipant ? 1 + facts.activeParticipantGuestCount! : null,
    joinRequest,
    canRequestToJoin,
    joinUnavailableReason: reason,
    primaryAction,
    // Chat entitlement = current manager or current member, nothing else.
    chatRoomId: facts.isManager || isParticipant ? facts.chatRoomId : null,
  };
}

@Injectable()
export class EventDetailService {
  constructor(
    private readonly events: EventsRepository,
    private readonly chat: ChatRepository,
  ) {}

  async getEventDetail(viewerId: string, eventId: string, now = new Date()): Promise<PublicEventDetailView> {
    return this.events.transaction(async (manager) => {
      const event = await manager
        .getRepository(EventEntity)
        .createQueryBuilder('event')
        .innerJoinAndSelect('event.category', 'category')
        .where('event.id = :eventId', { eventId })
        .getOne();
      if (!event) throw new EventNotFoundError();

      const managerUserId = await findEventManagerUserId(manager, event);
      const isManager = managerUserId !== null && managerUserId === viewerId;
      const participant = await manager.getRepository(EventParticipantEntity).findOne({
        where: { eventId, userId: viewerId, cancelledAt: IsNull() },
      });
      const latestJoinRequest = await manager.getRepository(EventJoinRequestEntity).findOne({
        where: { eventId, userId: viewerId },
        order: { requestedAt: 'DESC', id: 'DESC' },
      });
      const hasLivePendingRequest = latestJoinRequest !== null
        && effectiveJoinRequestStatus(latestJoinRequest, now) === JoinRequestStatus.Pending;

      if (!canViewEventDetail({
        status: event.status,
        visibility: event.visibility,
        hasManager: managerUserId !== null,
        isManager,
        isParticipant: participant !== null,
        hasLivePendingRequest,
      })) {
        throw new EventNotFoundError();
      }

      const viewer = await manager.getRepository(UserEntity).findOne({ where: { id: viewerId } });
      const entitledToChat = isManager || participant !== null;
      const chatRoomId = entitledToChat ? await this.chat.findEventRoomId(manager, eventId) : null;

      return {
        event: toPublicEventDetail(event),
        host: await this.hostSummary(manager, event),
        viewer: deriveViewerRelationship({
          isManager,
          activeParticipantGuestCount: participant?.guestCount ?? null,
          latestJoinRequest,
          event,
          hasManager: managerUserId !== null,
          viewerTrustScore: viewer?.trustScore ?? null,
          chatRoomId,
          now,
        }),
      };
    });
  }

  private async hostSummary(manager: EntityManager, event: EventEntity): Promise<PublicEventHostSummary> {
    if (event.hostType === EventHostType.Provider && event.hostProviderId) {
      // Only the public name: never owner_user_id, contact details or
      // unreviewed imported data.
      const [provider] = (await manager.query(
        `SELECT id, name FROM providers WHERE id = $1`,
        [event.hostProviderId],
      )) as Array<{ id: string; name: string }>;
      if (!provider) throw new Error('Provider-hosted Event references a missing Provider.');
      return { type: 'PROVIDER', providerId: provider.id, name: provider.name };
    }
    if (!event.hostUserId) throw new Error('USER-hosted Event has no host user.');
    // Profile display fields only; a deleted account keeps its id but shows no identity.
    const [host] = (await manager.query(
      `SELECT u.id, p.display_name, p.avatar_url
         FROM users u
         LEFT JOIN user_profiles p ON p.user_id = u.id AND u.deleted_at IS NULL
        WHERE u.id = $1`,
      [event.hostUserId],
    )) as Array<{ id: string; display_name: string | null; avatar_url: string | null }>;
    return {
      type: 'USER',
      userId: event.hostUserId,
      displayName: host?.display_name ?? null,
      avatarUrl: host?.avatar_url ?? null,
    };
  }
}

export function toPublicEventDetail(event: EventEntity): PublicEventDetail {
  const category = event.category;
  if (!category) throw new Error('Cannot serialize an Event without its category.');
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    hostType: event.hostType,
    category: {
      id: category.id,
      code: category.code,
      label: category.label,
      icon: category.icon,
      isActive: category.isActive,
    },
    status: event.status,
    visibility: event.visibility,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    meetingPoint: {
      latitude: event.meetingPoint.coordinates[1],
      longitude: event.meetingPoint.coordinates[0],
      label: event.meetingPointLabel,
    },
    capacityMin: event.capacityMin,
    capacityMax: event.capacityMax,
    reservedSeatCount: event.reservedSeatCount,
    remainingSeats: Math.max(0, event.capacityMax - event.reservedSeatCount),
    participantCount: event.participantCount,
    ...deriveEventGroupFormation(event),
    priceMinor: event.priceMinor,
    currency: event.currency,
    joinApprovalRequired: event.joinApprovalRequired,
    minTrustScore: event.minTrustScore,
    cancellationPolicy: event.cancellationPolicy,
  };
}
