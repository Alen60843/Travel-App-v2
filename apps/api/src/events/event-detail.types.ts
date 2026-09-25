import type {
  EventHostType,
  EventStatus,
  EventVisibility,
  JoinRequestStatus,
} from '@tripwith/shared';

import type { EventGroupState } from './event-group-state';
import type { EventCategoryView } from './events.types';

/**
 * Touchable Prototype Step 3: traveller-facing read model for
 * GET /v1/events/:eventId. Deliberately separate from the owner-only
 * EventView: no management fields (hostGuestCount, depositMinor,
 * cancelledAt/completedAt, created/updated timestamps) and never a raw entity.
 */
export interface PublicEventDetail {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly hostType: EventHostType;
  readonly category: EventCategoryView;
  readonly status: EventStatus;
  readonly visibility: EventVisibility;
  readonly startsAt: string;
  readonly endsAt: string;
  /** The host-chosen public meeting point — the same coordinate Explorer serves. */
  readonly meetingPoint: {
    readonly latitude: number;
    readonly longitude: number;
    readonly label: string | null;
  };
  readonly capacityMin: number | null;
  readonly capacityMax: number;
  /** Physical travellers (leaders + their guests, plus a USER host's own party). */
  readonly reservedSeatCount: number;
  readonly remainingSeats: number;
  /** Registered EventParticipant rows (party leaders only, never guests). */
  readonly participantCount: number;
  readonly groupState: EventGroupState | null;
  readonly seatsToConfirm: number | null;
  readonly priceMinor: number;
  readonly currency: string;
  readonly joinApprovalRequired: boolean;
  readonly minTrustScore: number;
  readonly cancellationPolicy: string | null;
}

/** Only fields already public on the profile; no email, DOB, Firebase UID or location. */
export interface PublicUserHostSummary {
  readonly type: 'USER';
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
}

/** Never exposes providers.owner_user_id: who manages a session is not traveller data. */
export interface PublicProviderHostSummary {
  readonly type: 'PROVIDER';
  readonly providerId: string;
  readonly name: string;
}

export type PublicEventHostSummary = PublicUserHostSummary | PublicProviderHostSummary;

/**
 * The single button Mobile renders, decided server-side from the facts below:
 *   MANAGE             -> "Manage session"
 *   OPEN_CHAT          -> "Open group chat" (active participant)
 *   AWAITING_APPROVAL  -> "Waiting for approval"
 *   REQUEST_TO_JOIN    -> "Join with N" (also on FULL: the request may stay PENDING)
 *   NONE               -> no action; see joinUnavailableReason
 */
export const EventViewerPrimaryAction = {
  Manage: 'MANAGE',
  OpenChat: 'OPEN_CHAT',
  AwaitingApproval: 'AWAITING_APPROVAL',
  RequestToJoin: 'REQUEST_TO_JOIN',
  None: 'NONE',
} as const;
export type EventViewerPrimaryAction =
  (typeof EventViewerPrimaryAction)[keyof typeof EventViewerPrimaryAction];

/** Same codes the join endpoint itself would return, so the client never re-derives them. */
export type EventJoinUnavailableReason =
  | 'EVENT_NOT_JOINABLE'
  | 'PAID_JOIN_NOT_AVAILABLE'
  | 'EVENT_TRUST_REQUIRED';

export interface EventViewerRelationship {
  readonly isManager: boolean;
  /** Current membership — an active EventParticipant row, never a JoinRequest status. */
  readonly isParticipant: boolean;
  /** 1 + guest_count of the viewer's ACTIVE participation; null otherwise. */
  readonly partySize: number | null;
  /**
   * The viewer's most recent JoinRequest, as a historical decision record.
   * A PENDING row past its expiry is reported as EXPIRED (read-only: this
   * endpoint never writes). APPROVED alone never implies isParticipant.
   */
  readonly joinRequest: {
    readonly id: string;
    readonly status: JoinRequestStatus;
    readonly requestedSeats: number;
  } | null;
  readonly canRequestToJoin: boolean;
  readonly joinUnavailableReason: EventJoinUnavailableReason | null;
  readonly primaryAction: EventViewerPrimaryAction;
  /** Only for the manager or an active participant, and only once the room exists. */
  readonly chatRoomId: string | null;
}

export interface PublicEventDetailView {
  readonly event: PublicEventDetail;
  readonly host: PublicEventHostSummary;
  readonly viewer: EventViewerRelationship;
}
