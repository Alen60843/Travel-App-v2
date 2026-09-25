import { Injectable } from '@nestjs/common';

import type {
  ExplorerAreaQueryDto,
  GetExplorerEventsQueryDto,
} from './dto/get-explorer-events-query.dto';
import { ExplorerQueryInvalidError } from './explorer.errors';
import { normalizeExplorerQuery } from './explorer-query';
import { ExplorerRepository } from './explorer.repository';
import type {
  ExplorerEventCardsView,
  ExplorerEventsView,
  NormalizedExplorerQuery,
} from './explorer.types';

/**
 * The card list shares the map's normalizer (spatial, time window, category,
 * limit rules) verbatim. Zoom only drives map clustering and is never read by
 * the card query, so a fixed in-range placeholder satisfies the normalizer
 * without inventing a card-specific validation path.
 */
const CARD_LIST_PLACEHOLDER_ZOOM = 22;

@Injectable()
export class ExplorerService {
  constructor(private readonly repository: ExplorerRepository) {}

  async discoverEvents(
    authenticatedUserId: string,
    query: GetExplorerEventsQueryDto,
    now = new Date(),
  ): Promise<ExplorerEventsView> {
    // The current endpoint has no per-user ranking, but deliberately takes the
    // guard-derived internal UUID so future personalization cannot grow a
    // parallel client-selected identity seam.
    if (authenticatedUserId.length === 0) throw new TypeError('authenticatedUserId is required');
    const normalized = normalizeExplorerQuery(query, now);
    await this.assertKnownCategories(normalized);

    const discovery = await this.repository.findDiscoverableMarkers(normalized);
    return {
      spatialMode: normalized.spatial.kind,
      windowStart: normalized.windowStart.toISOString(),
      windowEnd: normalized.windowEnd.toISOString(),
      eventCount: discovery.eventCount,
      markers: discovery.markers,
    };
  }

  /**
   * Prototype Step 5: the same discoverable population as discoverEvents,
   * as a deterministic (startsAt, id) list of group-formation cards. No
   * ranking, personalization or viewer state.
   */
  async discoverEventCards(
    authenticatedUserId: string,
    query: ExplorerAreaQueryDto,
    now = new Date(),
  ): Promise<ExplorerEventCardsView> {
    if (authenticatedUserId.length === 0) throw new TypeError('authenticatedUserId is required');
    const normalized = normalizeExplorerQuery({ ...query, zoom: CARD_LIST_PLACEHOLDER_ZOOM }, now);
    await this.assertKnownCategories(normalized);

    const page = await this.repository.findDiscoverableEventCards(normalized);
    return {
      spatialMode: normalized.spatial.kind,
      windowStart: normalized.windowStart.toISOString(),
      windowEnd: normalized.windowEnd.toISOString(),
      cards: page.cards,
      hasMore: page.hasMore,
    };
  }

  private async assertKnownCategories(normalized: NormalizedExplorerQuery): Promise<void> {
    if (normalized.categoryCodes.length === 0) return;
    const knownCodes = await this.repository.findKnownCategoryCodes(normalized.categoryCodes);
    if (knownCodes.length !== normalized.categoryCodes.length) {
      throw new ExplorerQueryInvalidError(
        'Every categoryCodes value must identify an existing event category.',
        'categoryCodes',
      );
    }
  }
}
