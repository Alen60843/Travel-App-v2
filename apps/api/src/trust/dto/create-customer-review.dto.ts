import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export class CustomerReviewSignalsDto {
  @IsOptional()
  @IsBoolean()
  wouldAcceptAgain?: boolean;

  @IsOptional()
  @IsBoolean()
  respectedBooking?: boolean;
}

/** Provider -> Traveller. Never accepted from an ordinary traveller endpoint — only reachable via the provider-owned route. */
export class CreateCustomerReviewDto {
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
  @Type(() => CustomerReviewSignalsDto)
  signals?: CustomerReviewSignalsDto;
}
