/**
 * Ephemeral presence, aggregated across every active session (device/tab) a
 * user currently has connected. Redis-backed, never PostgreSQL — see
 * presence.service.ts's header comment for why.
 */
export const PresenceState = {
  Online: 'ONLINE',
  Afk: 'AFK',
  Offline: 'OFFLINE',
} as const;
export type PresenceState = (typeof PresenceState)[keyof typeof PresenceState];

export interface PresenceTransition {
  readonly state: PresenceState;
  readonly changed: boolean;
}

/** Public-safe payload — no session id, socket id, device info, or IP. */
export interface PresenceUpdate {
  readonly userId: string;
  readonly state: PresenceState;
}
