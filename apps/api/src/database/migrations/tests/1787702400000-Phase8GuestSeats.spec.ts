import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WS8.5D: static, non-PostgreSQL coverage for the DOWN-migration safety
 * guards (WS8.6A audit findings #1/#2). These read the actual SQL text
 * rather than executing it — no PostgreSQL instance is available in this
 * environment (see the WS8.5D report) — so this only proves the guarding
 * SQL is present in the file, never that Postgres actually enforces it.
 */
describe('1787702400000-Phase8GuestSeats DOWN migration safety guards', () => {
  function read(file: string): string {
    return readFileSync(join(__dirname, '..', 'sql', file), 'utf8');
  }

  const downSql = read('1787702400000-Phase8GuestSeats.down.sql');
  const upSql = read('1787702400000-Phase8GuestSeats.up.sql');

  // 10. USER-hosted Event capacity-semantics downgrade refusal.
  it('refuses downgrade when any USER-hosted Event row exists', () => {
    expect(downSql).toMatch(/SELECT\s+count\(\*\)\s+INTO\s+user_hosted_events\s+FROM\s+events\s+WHERE\s+host_type\s*=\s*'USER'/i);
    expect(downSql).toMatch(/IF\s+user_hosted_events\s*>\s*0\s+THEN/i);
    expect(downSql).toMatch(/RAISE EXCEPTION/i);
    // Never a numeric adjustment/guess of capacity_max as a way past the guard.
    expect(downSql).not.toMatch(/capacity_max\s*=\s*capacity_max\s*[+-]\s*1/i);
  });

  // 11. Pre-existing WS8.5C guest-history / capacity-override guard remains
  // present and unweakened alongside the new stronger guard.
  it('still refuses downgrade when meaningful Guest Seats / capacity-override history exists', () => {
    expect(downSql).toMatch(/FROM event_join_requests WHERE guest_count <> 0/);
    expect(downSql).toMatch(/FROM event_participants WHERE guest_count <> 0/);
    expect(downSql).toMatch(/FROM events WHERE host_type = 'USER' AND host_guest_count <> 0/);
    expect(downSql).toMatch(/FROM event_join_requests WHERE capacity_override_approved_at IS NOT NULL/);
  });

  // Both DO $$ guard blocks must run before any destructive DROP statement.
  it('places both preflight guards before the destructive DROP statements', () => {
    const userHostedGuardIndex = downSql.indexOf('user_hosted_events');
    const guestHistoryGuardIndex = downSql.indexOf('join_request_guests');
    const firstDropIndex = downSql.search(/DROP (COLUMN|CONSTRAINT|TRIGGER|FUNCTION)/i);
    expect(userHostedGuardIndex).toBeGreaterThan(-1);
    expect(guestHistoryGuardIndex).toBeGreaterThan(-1);
    expect(firstDropIndex).toBeGreaterThan(-1);
    expect(userHostedGuardIndex).toBeLessThan(firstDropIndex);
    expect(guestHistoryGuardIndex).toBeLessThan(firstDropIndex);
  });

  // WS8.5D: no backfill from current Event state, and the snapshot columns
  // stay nullable with a both-or-neither invariant.
  it('does not backfill the legacy capacity snapshot from current Event values', () => {
    expect(upSql).not.toMatch(/UPDATE event_join_requests[\s\S]*SET capacity_max_at_request = e\.capacity_max/i);
    expect(upSql).not.toMatch(/ALTER COLUMN capacity_max_at_request SET NOT NULL/i);
    expect(upSql).not.toMatch(/ALTER COLUMN reserved_seat_count_at_request SET NOT NULL/i);
  });

  it('enforces the snapshot both-null-or-both-non-null invariant', () => {
    expect(upSql).toMatch(
      /CHECK\s*\(\s*\(capacity_max_at_request IS NULL\)\s*=\s*\(reserved_seat_count_at_request IS NULL\)/i,
    );
  });

  // guest_count trigger (WS8.6A confirmed correct — must not be redesigned).
  it('keeps the reserved-seat trigger scoped to INSERT, UPDATE OF cancelled_at/guest_count, and DELETE', () => {
    expect(upSql).toMatch(
      /AFTER INSERT OR UPDATE OF cancelled_at, guest_count OR DELETE ON event_participants/,
    );
  });
});
