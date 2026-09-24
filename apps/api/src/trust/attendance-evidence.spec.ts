import { AttendanceStatus } from '@tripwith/shared';

import { attendanceEvidenceFor, isEligibleForVerification, isEligibleToSubmitReview } from './attendance-evidence';

describe('attendance evidence (H4)', () => {
  it('only ATTENDED resolves to CONFIRMED evidence today', () => {
    expect(attendanceEvidenceFor(AttendanceStatus.Attended)).toBe('CONFIRMED');
    expect(attendanceEvidenceFor(AttendanceStatus.Unknown)).toBe('NONE');
    expect(attendanceEvidenceFor(AttendanceStatus.NoShow)).toBe('NONE');
    expect(attendanceEvidenceFor(AttendanceStatus.Cancelled)).toBe('NONE');
  });

  it('review eligibility and verification eligibility are independently callable decisions', () => {
    // Structural requirement (H4): these must be two distinct exported
    // functions, not one shared boolean, even though they agree today.
    expect(isEligibleToSubmitReview).not.toBe(isEligibleForVerification);
  });

  it.each([
    ['NONE', false],
    ['CONFIRMED', true],
  ] as const)('evidence %s -> eligible=%s for every current decision point', (evidence, expected) => {
    expect(isEligibleToSubmitReview(evidence)).toBe(expected);
    expect(isEligibleForVerification(evidence)).toBe(expected);
  });
});
