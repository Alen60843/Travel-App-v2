import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** WS8.5B: guest_count (JoinRequest + EventParticipant), events.host_guest_count, and the server-owned events.reserved_seat_count physical-capacity counter. Additive to Phase8MembershipLifecycle. */
export class Phase8GuestSeats1787702400000 implements MigrationInterface {
  public readonly name = 'Phase8GuestSeats1787702400000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787702400000-Phase8GuestSeats.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787702400000-Phase8GuestSeats.down.sql'));
  }
}
