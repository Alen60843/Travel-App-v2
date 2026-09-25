import { EventStatus } from '@tripwith/shared';

import type { EventEntity } from '../database/entities';

/**
 * Group Formation presentation state. Derived at read time, NEVER persisted:
 * the Event lifecycle (events.status) stays the only state machine, and the
 * seat counter it reads (reserved_seat_count) stays DB-owned. Lives in
 * apps/api rather than @tripwith/shared because it has no Postgres enum
 * counterpart (scripts/check-enum-parity.mjs pairs shared enums with SQL ones).
 */
export const EventGroupState = {
  Open: 'OPEN',
  Forming: 'FORMING',
  Confirmed: 'CONFIRMED',
  Full: 'FULL',
  Cancelled: 'CANCELLED',
} as const;
export type EventGroupState = (typeof EventGroupState)[keyof typeof EventGroupState];

export interface EventGroupFormation {
  /** null while group formation does not apply: DRAFT, IN_PROGRESS, COMPLETED. */
  readonly groupState: EventGroupState | null;
  /** Physical seats still needed to reach capacityMin; null when there is no minimum. */
  readonly seatsToConfirm: number | null;
}

/** The ONE place FORMING/CONFIRMED are decided — callers must not re-derive them. */
export function deriveEventGroupFormation(
  event: Pick<EventEntity, 'status' | 'capacityMin' | 'reservedSeatCount'>,
): EventGroupFormation {
  const { status, capacityMin, reservedSeatCount } = event;
  const seatsToConfirm =
    capacityMin === null ? null : Math.max(capacityMin - reservedSeatCount, 0);

  return { groupState: groupStateFor(status, capacityMin, reservedSeatCount), seatsToConfirm };
}

function groupStateFor(
  status: EventStatus,
  capacityMin: number | null,
  reservedSeatCount: number,
): EventGroupState | null {
  switch (status) {
    case EventStatus.Cancelled:
      return EventGroupState.Cancelled;
    case EventStatus.Full:
      return EventGroupState.Full;
    case EventStatus.Active:
      if (capacityMin === null) return EventGroupState.Open;
      return reservedSeatCount >= capacityMin ? EventGroupState.Confirmed : EventGroupState.Forming;
    default:
      return null;
  }
}
