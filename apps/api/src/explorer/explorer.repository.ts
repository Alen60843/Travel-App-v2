import { EventHostType, EventStatus } from '@tripwith/shared';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { GeoService, type LatLng, type SqlFragment } from '../database/geo';
import type { PublicEventHostSummary } from '../events/event-detail.types';
import { deriveEventGroupFormation } from '../events/event-group-state';
import { ExplorerQueryTooBroadError } from './explorer.errors';
import type {
  ExplorerClusterCategorySummary,
  ExplorerClusterMarker,
  ExplorerDiscoveryResult,
  ExplorerEventCard,
  ExplorerEventCardPage,
  ExplorerEventPin,
  ExplorerMarker,
  NormalizedExplorerQuery,
} from './explorer.types';

interface ExplorerRawMarker {
  readonly resultEventCount: string | number;
  readonly kind: 'event' | 'cluster' | null;
  readonly markerId: string | null;
  readonly title: string | null;
  readonly status: EventStatus | null;
  readonly latitude: string | number | null;
  readonly longitude: string | number | null;
  readonly categoryCode: string | null;
  readonly categoryLabel: string | null;
  readonly categoryIcon: string | null;
  readonly startsAt: Date | string | null;
  readonly endsAt: Date | string | null;
  readonly meetingPointLabel: string | null;
  readonly clusterEventCount: string | number | null;
  readonly categories: unknown;
}

/**
 * The SQL aggregation path safely handles the benchmark's 5,500-event dense
 * viewport. This higher ceiling is only a final denial-of-service guard: the
 * materialized discoverable CTE stops after one extra row and the repository
 * fails closed instead of returning partial cluster counts.
 */
export const EXPLORER_AGGREGATION_LIMIT = 100_000;
export const EXPLORER_CLUSTER_THROUGH_ZOOM = 14;
// Deliberately below every WGS84 curvature radius. This slightly enlarges the
// spherical radius envelope so it conservatively contains ST_DWithin's default
// spheroidal geography result, including near-pole and dateline cases.
const CONSERVATIVE_EARTH_RADIUS_METERS = 6_300_000;

/**
 * The ONE discoverable-Event rule, shared verbatim by the map CTE and the
 * card list so the two populations can never diverge:
 *
 *   - PUBLIC, and ACTIVE or FULL (the original Explorer boundary);
 *   - OPERATIONAL (Group Formation Step 2): USER-hosted, or a PROVIDER session
 *     whose Provider is claimed (owner_user_id set) and not deleted — the
 *     same "has a manager" fact as event-management.ts's
 *     findEventManagerUserId; nobody can join or manage an unclaimed session;
 *   - NOT YET STARTED (Step 5 joinable-time closure): starts_at strictly after
 *     the normalized discovery instant (:discoveryNow), matching the join
 *     flow, which refuses once starts_at <= now. A started-but-still-ACTIVE
 *     or FULL Event is no longer something a stranger can request to join.
 *
 * Applied inside the map's MATERIALIZED privacy CTE, so an excluded Event
 * never reaches a pin, cluster, category summary or eventCount. The time
 * window filter (time_range overlap) is separate and unchanged.
 */
export const EXPLORER_DISCOVERABLE_EVENT_SQL = `event.visibility = 'PUBLIC'
     AND event.status IN ('ACTIVE', 'FULL')
     AND (event.host_type = 'USER'
          OR EXISTS (
               SELECT 1
                 FROM providers operational_provider
                WHERE operational_provider.id = event.host_provider_id
                  AND operational_provider.owner_user_id IS NOT NULL
                  AND operational_provider.deleted_at IS NULL))
     AND event.starts_at > :discoveryNow`;

const ADAPTIVE_CLUSTER_SQL = `
WITH discoverable AS MATERIALIZED (
  SELECT event.id AS event_id,
         event.title,
         event.status,
         ST_Y(event.meeting_point::geometry) AS latitude,
         ST_X(event.meeting_point::geometry) AS longitude,
         category.code AS category_code,
         category.label AS category_label,
         category.icon AS category_icon,
         event.starts_at,
         event.ends_at,
         event.meeting_point_label
    FROM events event
    JOIN event_categories category ON category.id = event.category_id
   WHERE ${EXPLORER_DISCOVERABLE_EVENT_SQL}
     AND event.time_range && tstzrange(:windowStart, :windowEnd, '[)')
     AND :spatialPredicate
     :categoryPredicate
   LIMIT :candidateLimitPlusOne
), discovery_stats AS (
  SELECT count(*)::INT AS event_count,
         count(*) <= :markerLimit AND :zoom > :clusterThroughZoom AS return_pins,
         count(*) <= :candidateLimit AS within_candidate_limit
    FROM discoverable
), bucketed AS MATERIALIZED (
  SELECT
         LEAST(
           ceil(360.0 / :clusterCellDegrees)::INT - 1,
           GREATEST(
             0,
             floor((discoverable.longitude + 180.0) /
                   :clusterCellDegrees)::INT
           )
         ) AS bucket_x,
         LEAST(
           GREATEST(
             0,
             ceil(180.0 / :clusterCellDegrees)::INT - 1
           ),
           GREATEST(
             0,
             floor((discoverable.latitude + 90.0) /
                   :clusterCellDegrees)::INT
           )
         ) AS bucket_y,
         discoverable.*
    FROM discoverable
    CROSS JOIN discovery_stats
   WHERE NOT discovery_stats.return_pins
     AND discovery_stats.within_candidate_limit
), category_counts AS (
  SELECT bucket_x,
         bucket_y,
         category_code,
         count(*)::INT AS event_count
    FROM bucketed
   GROUP BY bucket_x, bucket_y, category_code
), category_summaries AS (
  SELECT bucket_x,
         bucket_y,
         jsonb_agg(
           jsonb_build_object('code', category_code, 'eventCount', event_count)
           ORDER BY event_count DESC, category_code ASC
         ) AS categories
    FROM category_counts
   GROUP BY bucket_x, bucket_y
), clustered AS (
  SELECT bucketed.bucket_x,
         bucketed.bucket_y,
         round(avg(bucketed.latitude)::NUMERIC, 6)::DOUBLE PRECISION AS latitude,
         round(
           degrees(
             atan2(
               avg(sin(radians(bucketed.longitude))),
               avg(cos(radians(bucketed.longitude)))
             )
           )::NUMERIC,
           6
         )::DOUBLE PRECISION AS longitude,
         count(*)::INT AS event_count,
         min(bucketed.starts_at) AS first_starts_at
    FROM bucketed
   GROUP BY bucketed.bucket_x,
            bucketed.bucket_y
), marker_rows AS (
  SELECT discoverable.starts_at AS sort_starts_at,
         discoverable.event_id::TEXT AS sort_id,
         'event'::TEXT AS kind,
         discoverable.event_id::TEXT AS marker_id,
         discoverable.title,
         discoverable.status::TEXT AS status,
         discoverable.latitude,
         discoverable.longitude,
         discoverable.category_code,
         discoverable.category_label,
         discoverable.category_icon,
         discoverable.starts_at,
         discoverable.ends_at,
         discoverable.meeting_point_label,
         NULL::INT AS cluster_event_count,
         NULL::JSONB AS categories
    FROM discoverable
    CROSS JOIN discovery_stats
   WHERE discovery_stats.return_pins

  UNION ALL

  SELECT clustered.first_starts_at AS sort_starts_at,
         'cluster:z' || :zoom || ':s' || :clusterScale ||
           ':x' || clustered.bucket_x || ':y' || clustered.bucket_y AS sort_id,
         'cluster'::TEXT AS kind,
         'cluster:z' || :zoom || ':s' || :clusterScale ||
           ':x' || clustered.bucket_x || ':y' || clustered.bucket_y AS marker_id,
         NULL::TEXT AS title,
         NULL::TEXT AS status,
         clustered.latitude,
         clustered.longitude,
         NULL::TEXT AS category_code,
         NULL::TEXT AS category_label,
         NULL::TEXT AS category_icon,
         NULL::TIMESTAMPTZ AS starts_at,
         NULL::TIMESTAMPTZ AS ends_at,
         NULL::TEXT AS meeting_point_label,
         clustered.event_count AS cluster_event_count,
         category_summaries.categories
    FROM clustered
    JOIN category_summaries USING (bucket_x, bucket_y)
)
SELECT discovery_stats.event_count AS "resultEventCount",
       marker_rows.kind AS kind,
       marker_rows.marker_id AS "markerId",
       marker_rows.title AS title,
       marker_rows.status AS status,
       marker_rows.latitude AS latitude,
       marker_rows.longitude AS longitude,
       marker_rows.category_code AS "categoryCode",
       marker_rows.category_label AS "categoryLabel",
       marker_rows.category_icon AS "categoryIcon",
       marker_rows.starts_at AS "startsAt",
       marker_rows.ends_at AS "endsAt",
       marker_rows.meeting_point_label AS "meetingPointLabel",
       marker_rows.cluster_event_count AS "clusterEventCount",
       marker_rows.categories AS categories
  FROM discovery_stats
  LEFT JOIN marker_rows ON TRUE
 ORDER BY marker_rows.sort_starts_at ASC, marker_rows.sort_id ASC
 LIMIT :markerLimit
`;

/**
 * Prototype Step 5 list of discoverable Event / Session cards. Exactly the
 * map's EXPLORER_DISCOVERABLE_EVENT_SQL boundary plus the same time-overlap,
 * spatial and category predicates, so a card can only exist for an Event
 * that could also be a pin. Host joins are narrow and
 * display-only: profile display name/avatar of a non-deleted USER host, the
 * Provider's id and name — never owner_user_id or contact data — and no
 * participant, request, chat or payment table is read at all.
 *
 * Deterministic, explainable order: startsAt ASC, then id ASC. One extra row
 * is fetched only to report hasMore.
 */
const EVENT_CARDS_SQL = `
SELECT event.id AS "eventId",
       event.title AS title,
       event.description AS description,
       event.host_type AS "hostType",
       event.status AS status,
       category.code AS "categoryCode",
       category.label AS "categoryLabel",
       category.icon AS "categoryIcon",
       event.starts_at AS "startsAt",
       event.ends_at AS "endsAt",
       ST_Y(event.meeting_point::geometry) AS latitude,
       ST_X(event.meeting_point::geometry) AS longitude,
       event.meeting_point_label AS "meetingPointLabel",
       event.capacity_min AS "capacityMin",
       event.capacity_max AS "capacityMax",
       event.reserved_seat_count AS "reservedSeatCount",
       event.participant_count AS "participantCount",
       event.price_minor AS "priceMinor",
       event.currency AS currency,
       event.join_approval_required AS "joinApprovalRequired",
       event.host_user_id AS "hostUserId",
       host_profile.display_name AS "hostDisplayName",
       host_profile.avatar_url AS "hostAvatarUrl",
       host_provider.id AS "hostProviderId",
       host_provider.name AS "hostProviderName"
  FROM events event
  JOIN event_categories category ON category.id = event.category_id
  LEFT JOIN users host_user
         ON host_user.id = event.host_user_id AND host_user.deleted_at IS NULL
  LEFT JOIN user_profiles host_profile ON host_profile.user_id = host_user.id
  LEFT JOIN providers host_provider ON host_provider.id = event.host_provider_id
 WHERE ${EXPLORER_DISCOVERABLE_EVENT_SQL}
   AND event.time_range && tstzrange(:windowStart, :windowEnd, '[)')
   AND :spatialPredicate
   :categoryPredicate
 ORDER BY event.starts_at ASC, event.id ASC
 LIMIT :limitPlusOne
`;

interface ExplorerRawEventCard {
  readonly eventId: string;
  readonly title: string;
  readonly description: string | null;
  readonly hostType: EventHostType;
  readonly status: EventStatus;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly categoryIcon: string | null;
  readonly startsAt: Date | string;
  readonly endsAt: Date | string;
  readonly latitude: string | number;
  readonly longitude: string | number;
  readonly meetingPointLabel: string | null;
  readonly capacityMin: number | null;
  readonly capacityMax: string | number;
  readonly reservedSeatCount: string | number;
  readonly participantCount: string | number;
  readonly priceMinor: string | number;
  readonly currency: string;
  readonly joinApprovalRequired: boolean;
  readonly hostUserId: string | null;
  readonly hostDisplayName: string | null;
  readonly hostAvatarUrl: string | null;
  readonly hostProviderId: string | null;
  readonly hostProviderName: string | null;
}

interface ExplorerDatabase {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
}

/**
 * Explorer owns the event-specific SQL. GeoService supplies the shared,
 * index-aware spatial predicates, and this repository composes them with the
 * exact partial-index visibility/status predicate and generated time_range.
 *
 * Privacy filtering is a MATERIALIZED CTE boundary before any bucket, count,
 * centroid, cluster ID, or category summary is computed. A single adaptive
 * query returns individual pins only above zoom 14 when the complete result
 * fits the requested marker limit; every other result is grouped in SQL at
 * the finest power-of-two grid scale producing at most that limit. Thus dense
 * views transfer bounded aggregates instead of thousands of full event rows.
 */
@Injectable()
export class ExplorerRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: ExplorerDatabase,
    private readonly geo: GeoService,
  ) {}

  async findKnownCategoryCodes(codes: readonly string[]): Promise<readonly string[]> {
    if (codes.length === 0) return [];
    const rows = await this.dataSource.query<{ code: string }[]>(
      `SELECT code
         FROM event_categories
        WHERE code = ANY($1::text[])
        ORDER BY code ASC
        LIMIT 20`,
      [[...codes]],
    );
    return rows.map(({ code }) => code);
  }

  async findDiscoverableMarkers(query: NormalizedExplorerQuery): Promise<ExplorerDiscoveryResult> {
    const spatial = this.spatialPredicate(query);
    const clusterScale = explorerClusterScale(query);
    const categoryPredicate = query.categoryCodes.length > 0
      ? 'AND category.code = ANY(:categoryCodes::text[])'
      : '';
    const namedSql = ADAPTIVE_CLUSTER_SQL
      .replace(':spatialPredicate', spatial.sql)
      .replace(':categoryPredicate', categoryPredicate);
    const { sql, values } = bindNamedParameters(namedSql, {
      ...spatial.parameters,
      windowStart: query.windowStart,
      windowEnd: query.windowEnd,
      categoryCodes: [...query.categoryCodes],
      markerLimit: query.limit,
      zoom: query.zoom,
      clusterThroughZoom: EXPLORER_CLUSTER_THROUGH_ZOOM,
      clusterScale,
      clusterCellDegrees: 90 / 2 ** query.zoom * clusterScale,
      candidateLimit: EXPLORER_AGGREGATION_LIMIT,
      candidateLimitPlusOne: EXPLORER_AGGREGATION_LIMIT + 1,
      discoveryNow: query.now,
    });
    const rows = await this.dataSource.query<ExplorerRawMarker[]>(sql, values);
    if (rows.length === 0) throw new TypeError('Explorer query returned no discovery_stats row');

    const eventCount = finiteInteger(rows[0]!.resultEventCount, 'result event count');
    if (eventCount > EXPLORER_AGGREGATION_LIMIT) throw new ExplorerQueryTooBroadError();
    const markers = rows
      .filter((row): row is ExplorerRawMarker & { kind: 'event' | 'cluster' } => row.kind !== null)
      .map(toMarker);
    if (markers.length > query.limit) {
      throw new TypeError('Explorer query returned more markers than requested');
    }
    return { eventCount, markers };
  }

  /** Card list for the same discoverable population (see EVENT_CARDS_SQL); zoom is not used. */
  async findDiscoverableEventCards(query: NormalizedExplorerQuery): Promise<ExplorerEventCardPage> {
    const spatial = this.spatialPredicate(query);
    const categoryPredicate = query.categoryCodes.length > 0
      ? 'AND category.code = ANY(:categoryCodes::text[])'
      : '';
    const namedSql = EVENT_CARDS_SQL
      .replace(':spatialPredicate', spatial.sql)
      .replace(':categoryPredicate', categoryPredicate);
    const { sql, values } = bindNamedParameters(namedSql, {
      ...spatial.parameters,
      windowStart: query.windowStart,
      windowEnd: query.windowEnd,
      categoryCodes: [...query.categoryCodes],
      limitPlusOne: query.limit + 1,
      discoveryNow: query.now,
    });
    const rows = await this.dataSource.query<ExplorerRawEventCard[]>(sql, values);
    return {
      cards: rows.slice(0, query.limit).map(toEventCard),
      hasMore: rows.length > query.limit,
    };
  }

  private spatialPredicate(query: NormalizedExplorerQuery): SqlFragment {
    if (query.spatial.kind === 'radius') {
      return this.geo.withinRadius(
        'event.meeting_point',
        query.spatial.center,
        query.spatial.radiusMeters,
        'explorerRadius',
      );
    }

    const { south, west, north, east, crossesAntimeridian } = query.spatial;
    if (!crossesAntimeridian) {
      return this.viewportPredicate(
        { latitude: south, longitude: west },
        { latitude: north, longitude: east },
        'explorerViewport',
      );
    }

    // GeoService deliberately rejects crossing boxes. Compose its two safe
    // halves into one OR predicate. A WHERE clause never duplicates a table
    // row regardless of how many OR branches it satisfies, so a point
    // matching both halves (only possible exactly at +/-180, see
    // viewportPredicate below) still cannot produce a duplicate row here.
    const westHalf = this.viewportPredicate(
      { latitude: south, longitude: west },
      { latitude: north, longitude: 180 },
      'explorerViewportWest',
    );
    const eastHalf = this.viewportPredicate(
      { latitude: south, longitude: -180 },
      { latitude: north, longitude: east },
      'explorerViewportEast',
    );
    return {
      sql: `(${westHalf.sql} OR ${eastHalf.sql})`,
      parameters: { ...westHalf.parameters, ...eastHalf.parameters },
    };
  }

  /**
   * Rectangular SCREEN VIEWPORT membership: south <= latitude <= north AND
   * west <= longitude <= east — a planar rectangle, deliberately NOT "inside
   * a spherical polygon with geodesic edges" (what GeoService.withinBoundingBox
   * alone, cast straight to ::geography, actually means). Two independent,
   * evidence-backed reasons this repository adds an exact geometry check on
   * top of it rather than using it alone:
   *
   * 1) Semantic mismatch: a mobile map viewport is a planar screen rectangle,
   *    not a geodesic shape. Confirmed by minimal reproduction: for a point
   *    resting exactly at the antimeridian, geography's ST_Intersects
   *    correctly (if surprisingly) reports membership in BOTH the west and
   *    east half — because longitude 180 and -180 are literally the same
   *    point on a sphere — whereas the product's own rectangle definition
   *    (§4) has no such ambiguity.
   * 2) A real, reproduced PostGIS/GEOS anomaly: with more than one row
   *    present, plain geography ST_Intersects for these exact antimeridian-
   *    adjacent envelopes returned true for a point at longitude 0 (nowhere
   *    near either half) — reproduced independently of this repository's SQL
   *    (a minimal 9-row temp table, no CTE, no clustering, both as a bare
   *    per-row boolean column and as a WHERE filter) and reproduced only for
   *    ::geography, never for the equivalent ::geometry or coordinate-based
   *    predicate on the identical rows. A single-row-filtered query does not
   *    reproduce it either, so it cannot be dismissed as ordinary semantics.
   *
   * GeoService.withinBoundingBox itself is untouched: it is shared
   * infrastructure with a documented geography contract, and Explorer is its
   * only caller (confirmed by inspection) — so the fix stays local to
   * Explorer rather than redefining shared behavior other callers might rely
   * on. The existing geography predicate is kept as the GIST-indexed coarse
   * filter (false positives are fine there); the exact planar rectangle is
   * the authoritative, correctness-final AND'd condition. Verified by
   * EXPLAIN (ANALYZE, BUFFERS) against a real indexed dataset: the added
   * condition changes only the Filter/Recheck Cond, never the chosen index
   * scan — events_discoverable_geo_time_gix is used identically before and
   * after.
   */
  private viewportPredicate(
    southWest: LatLng,
    northEast: LatLng,
    paramPrefix: string,
  ): SqlFragment {
    const coarse = this.geo.withinBoundingBox('event.meeting_point', southWest, northEast, paramPrefix);
    const minLng = `${paramPrefix}ExactMinLng`;
    const minLat = `${paramPrefix}ExactMinLat`;
    const maxLng = `${paramPrefix}ExactMaxLng`;
    const maxLat = `${paramPrefix}ExactMaxLat`;
    return {
      sql: `(${coarse.sql} AND ST_Intersects((event.meeting_point)::geometry, ST_MakeEnvelope(:${minLng}, :${minLat}, :${maxLng}, :${maxLat}, 4326)))`,
      parameters: {
        ...coarse.parameters,
        [minLng]: southWest.longitude,
        [minLat]: southWest.latitude,
        [maxLng]: northEast.longitude,
        [maxLat]: northEast.latitude,
      },
    };
  }
}

/**
 * Selects a deterministic power-of-two grid scale from request geometry, not
 * event density. The conservative bounding extent is guaranteed to intersect
 * at most markerLimit cells, so SQL can aggregate each candidate once and the
 * requested limit is a real output bound without sampling or partial counts.
 */
export function explorerClusterScale(query: NormalizedExplorerQuery): number {
  const baseCellDegrees = 90 / 2 ** query.zoom;
  const extent = clusterExtent(query);
  let scale = 1;
  while (extentCellCount(extent, baseCellDegrees * scale) > query.limit) scale *= 2;
  return scale;
}

interface ClusterExtent {
  readonly south: number;
  readonly north: number;
  readonly longitudeRanges: readonly (readonly [number, number])[];
}

function clusterExtent(query: NormalizedExplorerQuery): ClusterExtent {
  if (query.spatial.kind === 'viewport') {
    const { south, north, west, east, crossesAntimeridian } = query.spatial;
    return {
      south,
      north,
      longitudeRanges: crossesAntimeridian
        ? [[west, 180], [-180, east]]
        : [[west, east]],
    };
  }

  const angularRadius = query.spatial.radiusMeters / CONSERVATIVE_EARTH_RADIUS_METERS;
  const latitudeRadians = query.spatial.center.latitude * Math.PI / 180;
  const latitudeDelta = angularRadius * 180 / Math.PI;
  const south = Math.max(-90, query.spatial.center.latitude - latitudeDelta);
  const north = Math.min(90, query.spatial.center.latitude + latitudeDelta);
  if (angularRadius >= Math.PI / 2 - Math.abs(latitudeRadians)) {
    return { south, north, longitudeRanges: [[-180, 180]] };
  }

  const longitudeDelta = Math.asin(Math.sin(angularRadius) / Math.cos(latitudeRadians))
    * 180 / Math.PI;
  const west = query.spatial.center.longitude - longitudeDelta;
  const east = query.spatial.center.longitude + longitudeDelta;
  if (west < -180) {
    return { south, north, longitudeRanges: [[west + 360, 180], [-180, east]] };
  }
  if (east > 180) {
    return { south, north, longitudeRanges: [[west, 180], [-180, east - 360]] };
  }
  return { south, north, longitudeRanges: [[west, east]] };
}

function extentCellCount(extent: ClusterExtent, cellDegrees: number): number {
  const latitudeCells = intervalCellRange(extent.south, extent.north, -90, 180, cellDegrees);
  const longitudeRanges = extent.longitudeRanges
    .map(([west, east]) => intervalCellRange(west, east, -180, 360, cellDegrees))
    .sort((left, right) => left[0] - right[0]);
  let longitudeCells = 0;
  let rangeStart = longitudeRanges[0]![0];
  let rangeEnd = longitudeRanges[0]![1];
  for (const [start, end] of longitudeRanges.slice(1)) {
    if (start <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, end);
    } else {
      longitudeCells += rangeEnd - rangeStart + 1;
      rangeStart = start;
      rangeEnd = end;
    }
  }
  longitudeCells += rangeEnd - rangeStart + 1;
  return (latitudeCells[1] - latitudeCells[0] + 1) * longitudeCells;
}

function intervalCellRange(
  start: number,
  end: number,
  origin: number,
  span: number,
  cellDegrees: number,
): readonly [number, number] {
  const cellCount = Math.max(1, Math.ceil(span / cellDegrees));
  const index = (coordinate: number) => Math.min(
    cellCount - 1,
    Math.max(0, Math.floor((coordinate - origin) / cellDegrees)),
  );
  return [index(start), index(end)];
}

function bindNamedParameters(
  namedSql: string,
  parameters: Readonly<Record<string, unknown>>,
): { readonly sql: string; readonly values: unknown[] } {
  const positions = new Map<string, number>();
  const values: unknown[] = [];
  const sql = namedSql.replace(
    /(?<![:A-Za-z0-9_']):([A-Za-z][A-Za-z0-9_]*)/g,
    (_match, name: string) => {
      if (!Object.prototype.hasOwnProperty.call(parameters, name)) {
        throw new TypeError(`Explorer SQL parameter ${name} is missing`);
      }
      let position = positions.get(name);
      if (position === undefined) {
        values.push(parameters[name]);
        position = values.length;
        positions.set(name, position);
      }
      return `$${position}`;
    },
  );
  return { sql, values };
}

function finiteCoordinate(value: string | number | null, name: string): number {
  const result = Number(value);
  if (value === null || !Number.isFinite(result)) {
    throw new TypeError(`Explorer query returned invalid ${name}`);
  }
  return result;
}

function finiteInteger(value: string | number | null, name: string): number {
  const result = finiteCoordinate(value, name);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`Explorer query returned invalid ${name}`);
  }
  return result;
}

function requiredString(value: string | null, name: string): string {
  if (value === null || value.length === 0) {
    throw new TypeError(`Explorer query returned invalid ${name}`);
  }
  return value;
}

function isoInstant(value: Date | string | null, name: string): string {
  if (value === null) throw new TypeError(`Explorer query returned invalid ${name}`);
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`Explorer query returned invalid ${name}`);
  return parsed.toISOString();
}

function toEventCard(row: ExplorerRawEventCard): ExplorerEventCard {
  const capacityMax = finiteInteger(row.capacityMax, 'capacity max');
  const reservedSeatCount = finiteInteger(row.reservedSeatCount, 'reserved seat count');
  const status = requiredString(row.status, 'status') as EventStatus;
  let host: PublicEventHostSummary;
  if (row.hostType === EventHostType.Provider) {
    host = {
      type: 'PROVIDER',
      providerId: requiredString(row.hostProviderId, 'host provider id'),
      name: requiredString(row.hostProviderName, 'host provider name'),
    };
  } else {
    host = {
      type: 'USER',
      userId: requiredString(row.hostUserId, 'host user id'),
      displayName: row.hostDisplayName,
      avatarUrl: row.hostAvatarUrl,
    };
  }
  return {
    eventId: requiredString(row.eventId, 'event ID'),
    title: requiredString(row.title, 'title'),
    description: row.description,
    category: {
      code: requiredString(row.categoryCode, 'category code'),
      label: requiredString(row.categoryLabel, 'category label'),
      icon: row.categoryIcon,
    },
    hostType: row.hostType,
    host,
    status,
    startsAt: isoInstant(row.startsAt, 'startsAt'),
    endsAt: isoInstant(row.endsAt, 'endsAt'),
    coordinate: {
      latitude: finiteCoordinate(row.latitude, 'latitude'),
      longitude: finiteCoordinate(row.longitude, 'longitude'),
    },
    meetingPointLabel: row.meetingPointLabel,
    capacityMin: row.capacityMin,
    capacityMax,
    reservedSeatCount,
    remainingSeats: Math.max(0, capacityMax - reservedSeatCount),
    participantCount: finiteInteger(row.participantCount, 'participant count'),
    // The single Step 1 derivation — never a second copy in SQL or the client.
    ...deriveEventGroupFormation({ status, capacityMin: row.capacityMin, reservedSeatCount }),
    priceMinor: finiteInteger(row.priceMinor, 'price'),
    currency: requiredString(row.currency, 'currency'),
    joinApprovalRequired: row.joinApprovalRequired,
  };
}

function toMarker(row: ExplorerRawMarker & { kind: 'event' | 'cluster' }): ExplorerMarker {
  return row.kind === 'event' ? toEventPin(row) : toClusterMarker(row);
}

function toEventPin(row: ExplorerRawMarker): ExplorerEventPin {
  return {
    kind: 'event',
    id: requiredString(row.markerId, 'event ID'),
    title: requiredString(row.title, 'title'),
    status: requiredString(row.status, 'status') as EventStatus,
    coordinate: {
      latitude: finiteCoordinate(row.latitude, 'latitude'),
      longitude: finiteCoordinate(row.longitude, 'longitude'),
    },
    category: {
      code: requiredString(row.categoryCode, 'category code'),
      label: requiredString(row.categoryLabel, 'category label'),
      icon: row.categoryIcon,
    },
    startsAt: isoInstant(row.startsAt, 'startsAt'),
    endsAt: isoInstant(row.endsAt, 'endsAt'),
    meetingPointLabel: row.meetingPointLabel,
  };
}

function toClusterMarker(row: ExplorerRawMarker): ExplorerClusterMarker {
  return {
    kind: 'cluster',
    id: requiredString(row.markerId, 'cluster ID'),
    coordinate: {
      latitude: finiteCoordinate(row.latitude, 'cluster latitude'),
      longitude: finiteCoordinate(row.longitude, 'cluster longitude'),
    },
    eventCount: finiteInteger(row.clusterEventCount, 'cluster event count'),
    categories: categorySummary(row.categories),
  };
}

function categorySummary(value: unknown): readonly ExplorerClusterCategorySummary[] {
  if (!Array.isArray(value)) throw new TypeError('Explorer query returned invalid cluster categories');
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('Explorer query returned invalid cluster category');
    }
    const code = 'code' in entry ? entry.code : null;
    const eventCount = 'eventCount' in entry ? entry.eventCount : null;
    return {
      code: requiredString(typeof code === 'string' ? code : null, 'cluster category code'),
      eventCount: finiteInteger(
        typeof eventCount === 'string' || typeof eventCount === 'number' ? eventCount : null,
        'cluster category event count',
      ),
    };
  });
}
