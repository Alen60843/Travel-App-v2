import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { MigrationInterface, QueryRunner } from 'typeorm';

/** Group Formation Step 1: nullable events.capacity_min (minimum physical group size) with events_capacity_min_chk. */
export class GroupFormationCapacityMin1787788800000 implements MigrationInterface {
  public readonly name = 'GroupFormationCapacityMin1787788800000';

  private read(file: string): string {
    return readFileSync(join(__dirname, 'sql', file), 'utf8');
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787788800000-GroupFormationCapacityMin.up.sql'));
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(this.read('1787788800000-GroupFormationCapacityMin.down.sql'));
  }
}
