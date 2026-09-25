import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

function queryStringArray(value: unknown): unknown[] {
  return (Array.isArray(value) ? value : [value]).map((entry) =>
    typeof entry === 'string' ? entry.trim() : entry,
  );
}

/**
 * The shared area/time/category query for Explorer. Cross-field rules such as
 * "exactly one complete spatial shape" and ordered time bounds are applied
 * by the query normalizer after this DTO validates each primitive. Step 5
 * (event cards) reuses it unchanged; only the map endpoint adds zoom.
 */
export class ExplorerAreaQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  south?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  west?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  north?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  east?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  centerLatitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  centerLongitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(500_000)
  radiusMeters?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/)
  windowStart?: string;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/)
  windowEnd?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => queryStringArray(value))
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z0-9_]{2,40}$/, { each: true })
  categoryCodes?: string[];
}

/**
 * One map endpoint supports both interaction shapes (viewport or radius); zoom
 * drives only its adaptive marker clustering.
 */
export class GetExplorerEventsQueryDto extends ExplorerAreaQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(22)
  zoom!: number;
}
