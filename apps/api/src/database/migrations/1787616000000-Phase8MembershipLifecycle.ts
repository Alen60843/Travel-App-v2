import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** WS8.4B: EventParticipant cancellation audit metadata + fixes event_join_requests uniqueness so a historical APPROVED request no longer blocks rejoin after leave/remove. */
export class Phase8MembershipLifecycle1787616000000 implements MigrationInterface {
  public readonly name = 'Phase8MembershipLifecycle1787616000000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787616000000-Phase8MembershipLifecycle.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787616000000-Phase8MembershipLifecycle.down.sql'));
  }
}
