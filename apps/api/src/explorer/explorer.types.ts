import type { EventHostType, EventStatus } from '@tripwith/shared';

import type { PublicEventHostSummary } from '../events/event-detail.types';
import type { EventGroupState } from '../events/event-group-state';

export interface ExplorerCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export interface ExplorerCategoryView {
  readonly code: string;
  readonly label: string;
  readonly icon: string | null;
}

/** Minimal, map-safe event projection. This is never a serialized EventEntity. */
export interface ExplorerEventPin {
  readonly kind: 'event';
  readonly id: string;
  readonly title: string;
  readonly status: EventStatus;
  readonly coordinate: ExplorerCoordinate;
  readonly category: ExplorerCategoryView;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly meetingPointLabel: string | null;
}

export interface ExplorerClusterCategorySummary {
  readonly code: string;
  readonly eventCount: number;
}

export interface ExplorerClusterMarker {
  readonly kind: 'cluster';
  /** Stable for the normalized grid cell, zoom, and adaptive scale. */
  readonly id: string;
  readonly coordinate: ExplorerCoordinate;
  readonly eventCount: number;
  readonly categories: readonly ExplorerClusterCategorySummary[];
}

export type ExplorerMarker = ExplorerEventPin | ExplorerClusterMarker;

export interface ExplorerDiscoveryResult {
  readonly eventCount: number;
  readonly markers: readonly ExplorerMarker[];
}

export interface ExplorerEventsView {
  readonly spatialMode: 'viewport' | 'radius';
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Exact number considered for this response, before output clustering. */
  readonly eventCount: number;
  readonly markers: readonly ExplorerMarker[];
}

/**
 * Prototype Step 5 "groups forming near you" card: enough to render a
 * discovery card without opening Event Detail. Event-level facts only — no
 * participant or request identities, no chat room, no viewer relationship
 * (that is GET /v1/events/:eventId's job), never a serialized entity.
 * Mobile renders copy such as "Needs 1 more" from groupState/seatsToConfirm.
 */
export interface ExplorerEventCard {
  readonly eventId: string;
  readonly title: string;
  readonly description: string | null;
  readonly category: ExplorerCategoryView;
  readonly hostType: EventHostType;
  /** Same public host summary as Event Detail; never providers.owner_user_id. */
  readonly host: PublicEventHostSummary;
  readonly status: EventStatus;
  readonly startsAt: string;
  readonly endsAt: string;
  /** The host-chosen public meeting point, exactly as the map pins use it. */
  readonly coordinate: ExplorerCoordinate;
  readonly meetingPointLabel: string | null;
  readonly capacityMin: number | null;
  readonly capacityMax: number;
  /** Physical travellers (party leaders + guests, plus a USER host's own party). */
  readonly reservedSeatCount: number;
  readonly remainingSeats: number;
  /** Registered party leaders only; guests are never counted here. */
  readonly participantCount: number;
  readonly groupState: EventGroupState | null;
  readonly seatsToConfirm: number | null;
  readonly priceMinor: number;
  readonly currency: string;
  readonly joinApprovalRequired: boolean;
}

export interface ExplorerEventCardPage {
  readonly cards: readonly ExplorerEventCard[];
  readonly hasMore: boolean;
}

export interface ExplorerEventCardsView extends ExplorerEventCardPage {
  readonly spatialMode: 'viewport' | 'radius';
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface ExplorerViewport {
  readonly kind: 'viewport';
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
  readonly crossesAntimeridian: boolean;
}

export interface ExplorerRadius {
  readonly kind: 'radius';
  readonly center: ExplorerCoordinate;
  readonly radiusMeters: number;
}

export type ExplorerSpatialQuery = ExplorerViewport | ExplorerRadius;

export interface NormalizedExplorerQuery {
  readonly spatial: ExplorerSpatialQuery;
  /**
   * The single discovery instant the normalizer was given. Only Events with
   * starts_at strictly after it are discoverable (they can still be joined);
   * windowStart is clamped to it but may be later when a future window is asked for.
   */
  readonly now: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly categoryCodes: readonly string[];
  readonly zoom: number;
  readonly limit: number;
}
