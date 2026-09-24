import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** WS8.3: adds `traveller_feedback` — positive-interaction-confirmation + wouldTravelAgain, not a star review (Option T2, additive to Phase8TrustReviews). */
export class Phase8TravellerFeedback1787529600000 implements MigrationInterface {
  public readonly name = 'Phase8TravellerFeedback1787529600000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787529600000-Phase8TravellerFeedback.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787529600000-Phase8TravellerFeedback.down.sql'));
  }
}
