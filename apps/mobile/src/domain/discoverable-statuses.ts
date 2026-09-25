import { EventStatus } from '@tripwith/shared';

/**
 * @tripwith/shared integration proof: the canonical lifecycle enum comes
 * from the shared package (never re-declared here). Explorer only ever
 * serves ACTIVE and FULL Events; the placeholder copy reads these values so
 * a rename in the shared enum breaks the mobile typecheck, not the UI.
 */
export const DISCOVERABLE_EVENT_STATUSES = [EventStatus.Active, EventStatus.Full] as const;
