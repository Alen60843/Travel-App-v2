import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateJoinRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string | null;

  /**
   * WS8.5B: additional non-TripWith people accompanying the requester —
   * partySeats = 1 + guestCount. Bounded by the same technical ceiling as
   * capacityMax (0-9999), not an arbitrary business "max N guests" policy;
   * the Event's own remaining capacity is the authoritative per-request
   * limit, enforced server-side in JoinRequestsService, not here.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  guestCount?: number;
}
