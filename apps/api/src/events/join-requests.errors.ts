import { AppError } from '../common/errors/app-error';

const errors = {
  JOIN_REQUEST_NOT_FOUND: [404, 'Join request not found.'],
  JOIN_REQUEST_NOT_PENDING: [409, 'Only a pending request can be changed.'],
  JOIN_REQUEST_EXPIRED: [409, 'The join request has expired.'],
  JOIN_REQUEST_ALREADY_EXISTS: [409, 'A live join request already exists.'],
  EVENT_ALREADY_JOINED: [409, 'An active participation already exists.'],
  EVENT_CAPACITY_REACHED: [409, 'The Event has no available seats.'],
  EVENT_NOT_JOINABLE: [409, 'The Event is not available for joining.'],
  EVENT_SELF_JOIN: [422, 'The host cannot request to join their own Event.'],
  EVENT_TRUST_REQUIRED: [403, 'The Event trust requirement is not met.'],
  JOIN_ACCOUNT_UNAVAILABLE: [403, 'This account cannot join Events.'],
  PAID_JOIN_NOT_AVAILABLE: [409, 'Joining Events with a deposit is not available yet.'],
  // WS8.4B — participant leave / organizer remove.
  EVENT_NOT_A_MEMBER: [404, 'You are not an active participant of this event.'],
  HOST_CANNOT_LEAVE_VIA_PARTICIPANT_ENDPOINT: [
    422,
    'The host cannot leave their own Event through the participant endpoint; use Event cancellation instead.',
  ],
  HOST_CANNOT_REMOVE_SELF: [422, 'The host cannot remove themselves as a participant.'],
  // Deliberately undifferentiated (same reasoning as EVENT_NOT_JOINABLE):
  // covers "already started", "CANCELLED", and any other non-leavable
  // status alike, so a client cannot probe which specific fact failed.
  EVENT_MEMBERSHIP_LOCKED: [409, 'Normal leave/remove is not available for this Event right now.'],
  PAID_PARTICIPATION_CANCELLATION_NOT_SUPPORTED: [
    409,
    'Cancelling a participation with a financial commitment is not supported yet.',
  ],
  // WS8.5C — flexible capacity overrides. Request CREATION no longer
  // rejects on capacity at all (see JoinRequestsService.create) — this is
  // now raised ONLY by NORMAL approval, meaning exactly "this party does
  // not fit current remaining capacity; the USER host may instead use the
  // explicit approve-with-capacity-override action."
  EVENT_CAPACITY_OVERRIDE_REQUIRED: [
    409,
    'This party does not fit the Event’s current remaining capacity. Explicit capacity override approval is required.',
  ],
  // The override action's own derived requiredCapacity would exceed the
  // technical capacityMax ceiling (10,000) — never a client-supplied number.
  EVENT_CAPACITY_OVERRIDE_LIMIT_EXCEEDED: [
    409,
    'Approving this party would require raising capacityMax beyond the maximum supported value.',
  ],
} as const;

export function joinError(code: keyof typeof errors): AppError {
  const [status, message] = errors[code];
  return new AppError(code, message, status);
}

/** Only known database invariants become client-visible conflicts. */
export function translateJoinConflict(error: unknown): unknown {
  const driver = (error as { driverError?: { code?: string; constraint?: string } })?.driverError;
  if (driver?.code === '23505') {
    if (driver.constraint === 'event_join_requests_pending_uk') {
      return joinError('JOIN_REQUEST_ALREADY_EXISTS');
    }
    if (driver.constraint === 'event_participants_active_uk' ||
        driver.constraint === 'event_participants_join_request_uk') {
      return joinError('EVENT_ALREADY_JOINED');
    }
  }
  if (driver?.code === '23514' && driver.constraint === 'events_capacity_not_exceeded_chk') {
    return joinError('EVENT_CAPACITY_REACHED');
  }
  // WS8.5B/C: the physical-seat backstop. Reached only if the application's
  // own pre-checks (assertJoinable / assertPartyFits / the override's own
  // requiredCapacity arithmetic) were ever bypassed or raced past — same
  // defense-in-depth role as events_capacity_not_exceeded_chk.
  if (driver?.code === '23514' && driver.constraint === 'events_reserved_seat_count_capacity_chk') {
    return joinError('EVENT_CAPACITY_OVERRIDE_REQUIRED');
  }
  return error;
}
