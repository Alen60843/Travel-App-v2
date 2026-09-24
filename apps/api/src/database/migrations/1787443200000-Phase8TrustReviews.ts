import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Adds reviewer capacity (TRAVELLER/PROVIDER) so Provider -> Traveller reviews stay distinct from peer reviews. */
export class Phase8TrustReviews1787443200000 implements MigrationInterface {
  public readonly name = 'Phase8TrustReviews1787443200000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787443200000-Phase8TrustReviews.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787443200000-Phase8TrustReviews.down.sql'));
  }
}
