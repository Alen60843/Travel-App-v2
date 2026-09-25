import { EventStatus } from '@tripwith/shared';

import { deriveEventGroupFormation, EventGroupState } from './event-group-state';

const derive = (status: EventStatus, capacityMin: number | null, reservedSeatCount: number) =>
  deriveEventGroupFormation({ status, capacityMin, reservedSeatCount });

describe('deriveEventGroupFormation', () => {
  it('reports OPEN with no seatsToConfirm when an ACTIVE Event has no minimum', () => {
    expect(derive(EventStatus.Active, null, 5)).toEqual({
      groupState: EventGroupState.Open,
      seatsToConfirm: null,
    });
  });

  it('reports FORMING with the full minimum outstanding when no seat is reserved yet', () => {
    expect(derive(EventStatus.Active, 8, 0)).toEqual({
      groupState: EventGroupState.Forming,
      seatsToConfirm: 8,
    });
  });

  it('reports FORMING with the remaining gap while below the minimum', () => {
    expect(derive(EventStatus.Active, 8, 6)).toEqual({
      groupState: EventGroupState.Forming,
      seatsToConfirm: 2,
    });
  });

  it('reports CONFIRMED exactly at the minimum', () => {
    expect(derive(EventStatus.Active, 8, 8)).toEqual({
      groupState: EventGroupState.Confirmed,
      seatsToConfirm: 0,
    });
  });

  it('reports CONFIRMED above the minimum, never a negative seatsToConfirm', () => {
    expect(derive(EventStatus.Active, 8, 9)).toEqual({
      groupState: EventGroupState.Confirmed,
      seatsToConfirm: 0,
    });
  });

  it('lets the persisted FULL status override the derived CONFIRMED state', () => {
    expect(derive(EventStatus.Full, 8, 12).groupState).toBe(EventGroupState.Full);
    expect(derive(EventStatus.Full, null, 12).groupState).toBe(EventGroupState.Full);
  });

  it('lets CANCELLED override every group-formation state, with or without a minimum', () => {
    for (const [capacityMin, reserved] of [[8, 0], [8, 9], [null, 3]] as const) {
      expect(derive(EventStatus.Cancelled, capacityMin, reserved).groupState).toBe(
        EventGroupState.Cancelled,
      );
    }
  });

  it('reports no groupState where group formation does not apply, but still the arithmetic gap', () => {
    for (const status of [EventStatus.Draft, EventStatus.InProgress, EventStatus.Completed]) {
      expect(derive(status, 8, 3)).toEqual({ groupState: null, seatsToConfirm: 5 });
      expect(derive(status, null, 3)).toEqual({ groupState: null, seatsToConfirm: null });
    }
  });
});
