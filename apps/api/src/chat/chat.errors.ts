import { NotFoundError } from '../common/errors/app-error';

/**
 * Covers both "this room does not exist" and "you are not an active member
 * of it". Deliberately a single, indistinguishable shape — a caller who
 * isn't a member must not be able to tell those two cases apart, the same
 * way SwipeTargetInvalidError avoids confirming a swipe target's state.
 */
export class ChatRoomNotFoundError extends NotFoundError {
  constructor() {
    super('chat room');
  }
}
