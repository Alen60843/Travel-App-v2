import { ModerationState } from '@tripwith/shared';

import { decideInitialModerationState } from './moderation-policy';

describe('decideInitialModerationState (H1 / Product Decision A)', () => {
  it('is callable independently of any attendance/verification input', () => {
    // The whole point of H1: this function takes no "is_verified" input at
    // all. Moderation state must never be derivable from interaction
    // authenticity.
    expect(decideInitialModerationState.length).toBe(0);
  });

  it('starts every new review PENDING — attendance verification alone is not a publication decision', () => {
    expect(decideInitialModerationState()).toBe(ModerationState.Pending);
    expect(decideInitialModerationState()).not.toBe(ModerationState.Approved);
  });
});
