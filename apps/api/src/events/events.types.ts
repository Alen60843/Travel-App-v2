import type {
  EventHostType,
  EventStatus,
  EventVisibility,
} from '@tripwith/shared';

export interface EventCategoryView {
  readonly id: number;
  readonly code: string;
  readonly label: string;
  readonly icon: string | null;
  readonly isActive: boolean;
}

export interface EventMeetingPointView {
  readonly latitude: number;
  readonly longitude: number;
  readonly label: string | null;
}

/** Owner management representation. Explorer remains the public discovery representation. */
export interface EventView {
  readonly id: string;
  readonly hostType: EventHostType;
  readonly category: EventCategoryView;
  readonly title: string;
  readonly description: string | null;
  readonly status: EventStatus;
  readonly visibility: EventVisibility;
  readonly capacityMax: number;
  readonly participantCount: number;
  /** WS8.5B: the USER host's own party size (irrelevant/0 for provider-hosted events). */
  readonly hostGuestCount: number;
  /** WS8.5B: total physical seats currently occupied (host + host's guests + participants + their guests). Server/DB-owned — never derived client-side. */
  readonly reservedSeatCount: number;
  /** WS8.5B: capacityMax - reservedSeatCount, never negative. */
  readonly remainingSeats: number;
  readonly priceMinor: number;
  readonly depositMinor: number;
  readonly currency: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly meetingPoint: EventMeetingPointView;
  readonly minTrustScore: number;
  readonly joinApprovalRequired: boolean;
  readonly cancellationPolicy: string | null;
  readonly cancelledAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
