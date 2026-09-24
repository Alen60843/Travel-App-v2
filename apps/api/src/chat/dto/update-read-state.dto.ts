import { IsInt, Min } from 'class-validator';

export class UpdateReadStateDto {
  @IsInt()
  @Min(0)
  seq!: number;
}
