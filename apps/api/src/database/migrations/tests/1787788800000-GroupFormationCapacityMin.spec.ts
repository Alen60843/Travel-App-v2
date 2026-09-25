import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static checks on the Group Formation Step 1 migration SQL text. Runtime
 * enforcement is proven separately against real PostgreSQL
 * (events.int-spec.ts and database/scripts/verify-invariants.sql).
 */
describe('1787788800000-GroupFormationCapacityMin migration', () => {
  function read(file: string): string {
    return readFileSync(join(__dirname, '..', 'sql', file), 'utf8');
  }

  // Executable SQL only: the files' explanatory `--` comments legitimately
  // mention FORMING/CONFIRMED and must not trip these assertions.
  const stripComments = (sql: string) => sql.replace(/--.*$/gm, '');
  const upSql = stripComments(read('1787788800000-GroupFormationCapacityMin.up.sql'));
  const downSql = stripComments(read('1787788800000-GroupFormationCapacityMin.down.sql'));

  it('adds capacity_min as a nullable column with no default and no backfill', () => {
    expect(upSql).toMatch(/ADD COLUMN capacity_min INT;/);
    expect(upSql).not.toMatch(/capacity_min INT[^;]*NOT NULL/i);
    expect(upSql).not.toMatch(/capacity_min INT[^;]*DEFAULT/i);
    expect(upSql).not.toMatch(/UPDATE\s+events/i);
  });

  it('bounds capacity_min to [1, capacity_max] while allowing NULL', () => {
    expect(upSql).toMatch(
      /CONSTRAINT events_capacity_min_chk\s+CHECK \(capacity_min IS NULL OR \(capacity_min >= 1 AND capacity_min <= capacity_max\)\)/,
    );
  });

  it('adds no persisted group-formation status', () => {
    expect(upSql).not.toMatch(/FORMING|CONFIRMED|ALTER TYPE event_status/i);
  });

  it('refuses to downgrade while any Event carries a minimum, before dropping anything', () => {
    const guardIndex = downSql.search(/WHERE capacity_min IS NOT NULL/);
    const dropIndex = downSql.search(/DROP COLUMN IF EXISTS capacity_min/);

    expect(guardIndex).toBeGreaterThan(-1);
    expect(downSql).toMatch(/RAISE EXCEPTION/);
    expect(dropIndex).toBeGreaterThan(guardIndex);
    expect(downSql).not.toMatch(/UPDATE\s+events/i);
  });
});
