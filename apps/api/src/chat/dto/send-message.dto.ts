import { IsString, IsUUID, Length } from 'class-validator';

/**
 * Workstream 1 supports only client-originated TEXT messages, so `type` is
 * not a field here — the repository always inserts MessageType.Text. Sender
 * identity is likewise never a DTO field: it comes exclusively from the
 * authenticated request principal (see ChatController).
 */
export class SendMessageDto {
  @IsUUID('4')
  clientMessageId!: string;

  @IsString()
  @Length(1, 4000)
  body!: string;
}
