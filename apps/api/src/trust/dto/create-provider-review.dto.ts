import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class ProviderReviewSignalsDto {
  @IsOptional()
  @IsBoolean()
  wouldRecommendProvider?: boolean;

  @IsOptional()
  @IsBoolean()
  wouldUseAgain?: boolean;
}

/** Traveller -> Provider. The provider is derived server-side from the event's host — never a client-supplied id. */
export class CreateProviderReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProviderReviewSignalsDto)
  signals?: ProviderReviewSignalsDto;
}
