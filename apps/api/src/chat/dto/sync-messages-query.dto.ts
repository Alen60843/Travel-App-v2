import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const SYNC_DEFAULT_LIMIT = 50;
export const SYNC_MAX_LIMIT = 100;

export class SyncMessagesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterSeq!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SYNC_MAX_LIMIT)
  limit?: number;
}
