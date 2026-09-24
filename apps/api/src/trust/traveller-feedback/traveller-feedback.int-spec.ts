import { randomUUID } from 'node:crypto';

import { AppDataSource } from '../../database/data-source';
import { EventNotEligibleForFeedbackError, ParticipantNotEligibleError, TravellerFeedbackAnswerConflictError } from './traveller-feedback.errors';
import { TravellerFeedbackRepository } from './traveller-feedback.repository';

/**
 * PostgreSQL-dependent invariants for Traveller Feedback (WS8.3, WS8.3A).
 * Mirrors reviews.int-spec.ts's convention (a live AppDataSource
 * connection, no mocks, cleanup keyed off a run-scoped firebase_uid
 * prefix). NOT RUN as part of this pass — node_modules and Postgres are
 * both unavailable in this environment; see WS8.3A report for the honest
 * verification-gap statement.
 *
 * Eligibility here is deliberately NOT attendance_status = ATTENDED: both
 * reviewer and every selected target need only be an "Event Feedback
 * Member" — the event's USER host, OR an ACTIVE (cancelled_at IS NULL)
 * EventParticipant. This file never sets attendance_status, and never
 * inserts the host into event_participants.
 */

const RUN_ID = randomUUID().replace(/-/g, '');
const UID_PREFIX = `travfb-int-${RUN_ID}`;

interface TestUser {
  readonly id: string;
  readonly firebaseUid: string;
}

async function createUser(suffix: string): Promise<TestUser> {
  const firebaseUid = `${UID_PREFIX}-${suffix}`;
  const [row] = await AppDataSource.query(
    `INSERT INTO users (firebase_uid, email, date_of_birth)
     VALUES ($1, $2, DATE '1995-01-01')
     RETURNING id`,
    [firebaseUid, `${firebaseUid}@example.test`],
  );
  // The candidate list JOINs user_profiles (the existing safe public
  // profile shape reused for Step-1 — see traveller-feedback.types.ts), so
  // every test user needs one, same as production provisioning would create.
  await AppDataSource.query(
    `INSERT INTO user_profiles (user_id, display_name, avatar_url) VALUES ($1, $2, NULL)`,
    [row.id, `Traveller ${suffix}`.slice(0, 50)],
  );
  return { id: row.id, firebaseUid };
}

async function anyEventCategoryId(): Promise<number> {
  const [row] = await AppDataSource.query(`SELECT id FROM event_categories LIMIT 1`);
  return row.id;
}

interface CreateEventOptions {
  readonly hostUserId: string;
  /** Defaults to an event that has already ended (ends_at in the past). */
  readonly ended?: boolean;
  readonly cancelled?: boolean;
}

async function createEvent(options: CreateEventOptions): Promise<string> {
  const categoryId = await anyEventCategoryId();
  const ended = options.ended ?? true;
  const status = options.cancelled ? 'CANCELLED' : ended ? 'IN_PROGRESS' : 'ACTIVE';
  const startsAt = ended ? `now() - interval '3 days'` : `now() + interval '1 day'`;
  const endsAt = ended ? `now() - interval '2 days'` : `now() + interval '2 days'`;
  const [row] = await AppDataSource.query(
    `INSERT INTO events (
       host_type, host_user_id, category_id, title,
       capacity_max, starts_at, ends_at, meeting_point, status,
       cancelled_at
     ) VALUES ('USER',$1,$2,$3,10,${startsAt},${endsAt},
               ST_SetSRID(ST_MakePoint(139.6917, 35.6895), 4326)::geography,$4,
               CASE WHEN $4 = 'CANCELLED' THEN now() ELSE NULL END)
     RETURNING id`,
    [options.hostUserId, categoryId, `Traveller feedback int event ${RUN_ID}`, status],
  );
  return row.id;
}

interface AddParticipantOptions {
  readonly cancelled?: boolean;
}

async function addParticipant(eventId: string, userId: string, options: AddParticipantOptions = {}): Promise<void> {
  await AppDataSource.query(
    `INSERT INTO event_participants (event_id, user_id, cancelled_at, attendance_status)
     VALUES ($1, $2, CASE WHEN $3 THEN now() ELSE NULL END, CASE WHEN $3 THEN 'CANCELLED' ELSE 'UNKNOWN' END)`,
    [eventId, userId, options.cancelled ?? false],
  );
}

describe('traveller feedback (real PostgreSQL)', () => {
  let repository: TravellerFeedbackRepository;

  beforeAll(async () => {
    await AppDataSource.initialize();
    repository = new TravellerFeedbackRepository(AppDataSource);
  });

  afterAll(async () => {
    try {
      await AppDataSource.transaction(async (manager) => {
        await manager.query(
          `DELETE FROM events WHERE host_user_id IN (SELECT id FROM users WHERE firebase_uid LIKE $1)`,
          [`${UID_PREFIX}%`],
        );
        await manager.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${UID_PREFIX}%`]);
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('creates one row per selected target, backed only by active EventParticipant rows — no attendance_status ATTENDED involved', async () => {
    const reviewer = await createUser('happy-reviewer');
    const daniel = await createUser('happy-daniel');
    const sarah = await createUser('happy-sarah');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);
    await addParticipant(eventId, sarah.id);

    const rows = await repository.submitFeedback(reviewer.id, eventId, [
      { targetUserId: daniel.id, wouldTravelAgain: true },
      { targetUserId: sarah.id, wouldTravelAgain: false },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.targetUserId === daniel.id)?.wouldTravelAgain).toBe(true);
    expect(rows.find((r) => r.targetUserId === sarah.id)?.wouldTravelAgain).toBe(false);
  });

  it('an omitted participant (John) never gets a row, and no evidence about him exists anywhere', async () => {
    const reviewer = await createUser('omit-reviewer');
    const daniel = await createUser('omit-daniel');
    const john = await createUser('omit-john');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);
    await addParticipant(eventId, john.id);

    await repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]);

    const johnRows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM traveller_feedback WHERE event_id = $1 AND target_user_id = $2`,
      [eventId, john.id],
    );
    expect(johnRows[0].n).toBe(0);
  });

  it('rejects a reviewer with no active EventParticipant row for the event', async () => {
    const nonParticipant = await createUser('nonpart-reviewer');
    const daniel = await createUser('nonpart-daniel');
    const eventId = await createEvent({ hostUserId: daniel.id });
    await addParticipant(eventId, daniel.id);

    await expect(
      repository.submitFeedback(nonParticipant.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
    ).rejects.toBeInstanceOf(ParticipantNotEligibleError);
  });

  it('rejects a selected target with no active EventParticipant row for the event', async () => {
    const reviewer = await createUser('nontarget-reviewer');
    const stranger = await createUser('nontarget-stranger');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    // stranger never joined this event at all.

    await expect(
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: stranger.id, wouldTravelAgain: true }]),
    ).rejects.toBeInstanceOf(ParticipantNotEligibleError);
  });

  it('rejects a reviewer whose participation was cancelled', async () => {
    const reviewer = await createUser('cancelled-reviewer');
    const daniel = await createUser('cancelled-reviewer-daniel');
    const eventId = await createEvent({ hostUserId: daniel.id });
    await addParticipant(eventId, reviewer.id, { cancelled: true });
    await addParticipant(eventId, daniel.id);

    await expect(
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
    ).rejects.toBeInstanceOf(ParticipantNotEligibleError);
  });

  it('rejects a selected target whose participation was cancelled', async () => {
    const reviewer = await createUser('cancelled-target-reviewer');
    const daniel = await createUser('cancelled-target-daniel');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id, { cancelled: true });

    await expect(
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
    ).rejects.toBeInstanceOf(ParticipantNotEligibleError);
  });

  it('rejects feedback submitted before the event has ended', async () => {
    const reviewer = await createUser('notended-reviewer');
    const daniel = await createUser('notended-daniel');
    const eventId = await createEvent({ hostUserId: reviewer.id, ended: false });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);

    await expect(
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
    ).rejects.toBeInstanceOf(EventNotEligibleForFeedbackError);
  });

  it('rejects feedback for a CANCELLED event even if its ends_at has passed', async () => {
    const reviewer = await createUser('cancelledevent-reviewer');
    const daniel = await createUser('cancelledevent-daniel');
    const eventId = await createEvent({ hostUserId: reviewer.id, cancelled: true });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);

    await expect(
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
    ).rejects.toBeInstanceOf(EventNotEligibleForFeedbackError);
  });

  it('rejects the DB-level self-feedback CHECK if ever reached directly', async () => {
    const reviewer = await createUser('selfcheck-reviewer');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);

    await expect(
      AppDataSource.query(
        `INSERT INTO traveller_feedback (reviewer_user_id, target_user_id, event_id, would_travel_again)
         VALUES ($1, $1, $2, TRUE)`,
        [reviewer.id, eventId],
      ),
    ).rejects.toThrow();
  });

  it('blocks a concurrent duplicate submission for the same reviewer+target+event', async () => {
    const reviewer = await createUser('dup-reviewer');
    const daniel = await createUser('dup-daniel');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);

    const [first, second] = await Promise.allSettled([
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
      repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: false }]),
    ]);
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TravellerFeedbackAnswerConflictError);

    const rows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM traveller_feedback WHERE reviewer_user_id = $1 AND event_id = $2 AND target_user_id = $3`,
      [reviewer.id, eventId, daniel.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('rolls back the ENTIRE batch when one target in it already has feedback (all-or-nothing)', async () => {
    const reviewer = await createUser('rollback-reviewer');
    const daniel = await createUser('rollback-daniel');
    const sarah = await createUser('rollback-sarah');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);
    await addParticipant(eventId, sarah.id);

    await repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]);

    await expect(
      repository.submitFeedback(reviewer.id, eventId, [
        { targetUserId: sarah.id, wouldTravelAgain: true },
        { targetUserId: daniel.id, wouldTravelAgain: false }, // already exists
      ]),
    ).rejects.toBeInstanceOf(TravellerFeedbackAnswerConflictError);

    // Sarah must NOT have been left behind by the failed batch — the retry
    // rolled back completely, not partially.
    const sarahRows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM traveller_feedback WHERE event_id = $1 AND target_user_id = $2`,
      [eventId, sarah.id],
    );
    expect(sarahRows[0].n).toBe(0);
  });

  it('rejects an UPDATE and a DELETE — submitted feedback is fully immutable', async () => {
    const reviewer = await createUser('immut-reviewer');
    const daniel = await createUser('immut-daniel');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);
    const [row] = await repository.submitFeedback(reviewer.id, eventId, [
      { targetUserId: daniel.id, wouldTravelAgain: true },
    ]);
    if (!row) throw new Error('submitFeedback did not return the inserted row.');

    await expect(
      AppDataSource.query(`UPDATE traveller_feedback SET would_travel_again = FALSE WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/immutable|append-only|forbid/i);
    await expect(
      AppDataSource.query(`DELETE FROM traveller_feedback WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/immutable|append-only|forbid/i);
  });

  it('never writes a trust_score_events row for any submitted feedback', async () => {
    const reviewer = await createUser('notrust-reviewer');
    const daniel = await createUser('notrust-daniel');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);
    await addParticipant(eventId, daniel.id);

    await repository.submitFeedback(reviewer.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]);

    const ledgerRows = await AppDataSource.query(
      `SELECT count(*)::int AS n FROM trust_score_events WHERE source_user_id = $1`,
      [reviewer.id],
    );
    expect(ledgerRows[0].n).toBe(0);
    const [reviewerRow] = await AppDataSource.query(`SELECT trust_score_raw FROM users WHERE id = $1`, [
      reviewer.id,
    ]);
    expect(Number(reviewerRow.trust_score_raw)).toBe(5); // untouched default
  });

  it('an empty submission writes nothing and errors on nobody', async () => {
    const reviewer = await createUser('empty-reviewer');
    const eventId = await createEvent({ hostUserId: reviewer.id });
    await addParticipant(eventId, reviewer.id);

    await expect(repository.submitFeedback(reviewer.id, eventId, [])).resolves.toEqual([]);
  });

  // ==========================================================================
  // WS8.3A — host membership, self-exclusion, candidate list, safe retry
  // ==========================================================================

  describe('Event Feedback Member = USER host OR active EventParticipant', () => {
    it('lets a participant submit feedback about the USER host, without the host ever having an EventParticipant row', async () => {
      const host = await createUser('host-target-host');
      const participant = await createUser('host-target-participant');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, participant.id);
      // The host deliberately has NO event_participants row at all.

      const rows = await repository.submitFeedback(participant.id, eventId, [
        { targetUserId: host.id, wouldTravelAgain: true },
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.targetUserId).toBe(host.id);
      const hostParticipantRows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM event_participants WHERE event_id = $1 AND user_id = $2`,
        [eventId, host.id],
      );
      expect(hostParticipantRows[0].n).toBe(0);
    });

    it('lets the USER host submit feedback about a participant', async () => {
      const host = await createUser('host-reviewer-host');
      const participant = await createUser('host-reviewer-participant');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, participant.id);

      const rows = await repository.submitFeedback(host.id, eventId, [
        { targetUserId: participant.id, wouldTravelAgain: false },
      ]);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.wouldTravelAgain).toBe(false);
    });

    it('still lets a participant submit feedback about another participant (unchanged from WS8.3)', async () => {
      const host = await createUser('p2p-host');
      const daniel = await createUser('p2p-daniel');
      const sarah = await createUser('p2p-sarah');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);
      await addParticipant(eventId, sarah.id);

      const rows = await repository.submitFeedback(daniel.id, eventId, [
        { targetUserId: sarah.id, wouldTravelAgain: true },
      ]);
      expect(rows).toHaveLength(1);
    });

    it('an outsider (neither host nor participant) cannot submit feedback about a member', async () => {
      const host = await createUser('outsider-sub-host');
      const participant = await createUser('outsider-sub-participant');
      const outsider = await createUser('outsider-sub-outsider');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, participant.id);

      await expect(
        repository.submitFeedback(outsider.id, eventId, [{ targetUserId: participant.id, wouldTravelAgain: true }]),
      ).rejects.toBeInstanceOf(ParticipantNotEligibleError);
    });
  });

  describe('candidate list (WS8.3A Step 1)', () => {
    it('includes the USER host for a requesting participant', async () => {
      const host = await createUser('cand-host-host');
      const participant = await createUser('cand-host-participant');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, participant.id);

      const candidates = await repository.listCandidates(participant.id, eventId);

      expect(candidates.some((c) => c.userId === host.id && c.role === 'HOST')).toBe(true);
    });

    it('includes other active participants for a requesting participant', async () => {
      const host = await createUser('cand-peers-host');
      const daniel = await createUser('cand-peers-daniel');
      const sarah = await createUser('cand-peers-sarah');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);
      await addParticipant(eventId, sarah.id);

      const candidates = await repository.listCandidates(daniel.id, eventId);

      expect(candidates.some((c) => c.userId === sarah.id && c.role === 'PARTICIPANT')).toBe(true);
    });

    it('excludes the requesting participant from their own candidate list', async () => {
      const host = await createUser('cand-self-p-host');
      const daniel = await createUser('cand-self-p-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);

      const candidates = await repository.listCandidates(daniel.id, eventId);

      expect(candidates.some((c) => c.userId === daniel.id)).toBe(false);
    });

    it('includes active participants for the requesting USER host', async () => {
      const host = await createUser('cand-host-req-host');
      const daniel = await createUser('cand-host-req-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);

      const candidates = await repository.listCandidates(host.id, eventId);

      expect(candidates.some((c) => c.userId === daniel.id && c.role === 'PARTICIPANT')).toBe(true);
    });

    it('excludes the requesting USER host from their own candidate list', async () => {
      const host = await createUser('cand-self-h-host');
      const daniel = await createUser('cand-self-h-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);

      const candidates = await repository.listCandidates(host.id, eventId);

      expect(candidates.some((c) => c.userId === host.id)).toBe(false);
    });

    it('excludes a cancelled participant from the candidate list', async () => {
      const host = await createUser('cand-cancelled-host');
      const active = await createUser('cand-cancelled-active');
      const cancelled = await createUser('cand-cancelled-cancelled');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, active.id);
      await addParticipant(eventId, cancelled.id, { cancelled: true });

      const candidates = await repository.listCandidates(active.id, eventId);

      expect(candidates.some((c) => c.userId === cancelled.id)).toBe(false);
    });

    it('rejects an outsider fetching the candidate list', async () => {
      const host = await createUser('cand-outsider-host');
      const participant = await createUser('cand-outsider-participant');
      const outsider = await createUser('cand-outsider-outsider');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, participant.id);

      await expect(repository.listCandidates(outsider.id, eventId)).rejects.toBeInstanceOf(
        ParticipantNotEligibleError,
      );
    });

    it('rejects a cancelled participant fetching the candidate list, unless they are independently the USER host', async () => {
      const host = await createUser('cand-cancelledreq-host');
      const cancelledParticipant = await createUser('cand-cancelledreq-cancelled');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, cancelledParticipant.id, { cancelled: true });

      await expect(repository.listCandidates(cancelledParticipant.id, eventId)).rejects.toBeInstanceOf(
        ParticipantNotEligibleError,
      );
      // The host themselves, by contrast, always succeeds — host membership
      // never depends on any event_participants row at all.
      await expect(repository.listCandidates(host.id, eventId)).resolves.toBeDefined();
    });

    it('is unavailable before the event has ended', async () => {
      const host = await createUser('cand-notended-host');
      const participant = await createUser('cand-notended-participant');
      const eventId = await createEvent({ hostUserId: host.id, ended: false });
      await addParticipant(eventId, participant.id);

      await expect(repository.listCandidates(participant.id, eventId)).rejects.toBeInstanceOf(
        EventNotEligibleForFeedbackError,
      );
    });

    it('is unavailable for a CANCELLED event', async () => {
      const host = await createUser('cand-cancelledevent-host');
      const participant = await createUser('cand-cancelledevent-participant');
      const eventId = await createEvent({ hostUserId: host.id, cancelled: true });
      await addParticipant(eventId, participant.id);

      await expect(repository.listCandidates(participant.id, eventId)).rejects.toBeInstanceOf(
        EventNotEligibleForFeedbackError,
      );
    });
  });

  describe('safe retry semantics (WS8.3A)', () => {
    it('an identical TRUE retry is a safe idempotent success — no duplicate row', async () => {
      const host = await createUser('retry-true-host');
      const daniel = await createUser('retry-true-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);

      const first = await repository.submitFeedback(host.id, eventId, [
        { targetUserId: daniel.id, wouldTravelAgain: true },
      ]);
      const second = await repository.submitFeedback(host.id, eventId, [
        { targetUserId: daniel.id, wouldTravelAgain: true },
      ]);

      expect(second[0]?.id).toBe(first[0]?.id);
      const rows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM traveller_feedback WHERE reviewer_user_id = $1 AND event_id = $2 AND target_user_id = $3`,
        [host.id, eventId, daniel.id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('an identical FALSE retry is a safe idempotent success — no duplicate row', async () => {
      const host = await createUser('retry-false-host');
      const daniel = await createUser('retry-false-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);

      const first = await repository.submitFeedback(host.id, eventId, [
        { targetUserId: daniel.id, wouldTravelAgain: false },
      ]);
      const second = await repository.submitFeedback(host.id, eventId, [
        { targetUserId: daniel.id, wouldTravelAgain: false },
      ]);

      expect(second[0]?.id).toBe(first[0]?.id);
      const rows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM traveller_feedback WHERE reviewer_user_id = $1 AND event_id = $2 AND target_user_id = $3`,
        [host.id, eventId, daniel.id],
      );
      expect(rows[0].n).toBe(1);
    });

    it('TRUE -> FALSE is a conflict, not an edit', async () => {
      const host = await createUser('retry-t2f-host');
      const daniel = await createUser('retry-t2f-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);
      await repository.submitFeedback(host.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]);

      await expect(
        repository.submitFeedback(host.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: false }]),
      ).rejects.toBeInstanceOf(TravellerFeedbackAnswerConflictError);

      const [row] = await AppDataSource.query(
        `SELECT would_travel_again FROM traveller_feedback WHERE reviewer_user_id = $1 AND event_id = $2 AND target_user_id = $3`,
        [host.id, eventId, daniel.id],
      );
      expect(row.would_travel_again).toBe(true); // unchanged
    });

    it('FALSE -> TRUE is a conflict, not an edit', async () => {
      const host = await createUser('retry-f2t-host');
      const daniel = await createUser('retry-f2t-daniel');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);
      await repository.submitFeedback(host.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: false }]);

      await expect(
        repository.submitFeedback(host.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]),
      ).rejects.toBeInstanceOf(TravellerFeedbackAnswerConflictError);

      const [row] = await AppDataSource.query(
        `SELECT would_travel_again FROM traveller_feedback WHERE reviewer_user_id = $1 AND event_id = $2 AND target_user_id = $3`,
        [host.id, eventId, daniel.id],
      );
      expect(row.would_travel_again).toBe(false); // unchanged
    });

    it('a mixed batch with one identical-existing target and two new targets succeeds atomically', async () => {
      const host = await createUser('retry-mixed-host');
      const daniel = await createUser('retry-mixed-daniel');
      const sarah = await createUser('retry-mixed-sarah');
      const emma = await createUser('retry-mixed-emma');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);
      await addParticipant(eventId, sarah.id);
      await addParticipant(eventId, emma.id);
      await repository.submitFeedback(host.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]);

      const result = await repository.submitFeedback(host.id, eventId, [
        { targetUserId: daniel.id, wouldTravelAgain: true }, // identical existing
        { targetUserId: sarah.id, wouldTravelAgain: false }, // new
        { targetUserId: emma.id, wouldTravelAgain: true }, // new
      ]);

      expect(result).toHaveLength(3);
      const rows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM traveller_feedback WHERE reviewer_user_id = $1 AND event_id = $2`,
        [host.id, eventId],
      );
      expect(rows[0].n).toBe(3); // Daniel not duplicated
    });

    it('a mixed batch with one CONFLICTING existing target rolls back the new targets too', async () => {
      const host = await createUser('retry-mixedconflict-host');
      const daniel = await createUser('retry-mixedconflict-daniel');
      const sarah = await createUser('retry-mixedconflict-sarah');
      const eventId = await createEvent({ hostUserId: host.id });
      await addParticipant(eventId, daniel.id);
      await addParticipant(eventId, sarah.id);
      await repository.submitFeedback(host.id, eventId, [{ targetUserId: daniel.id, wouldTravelAgain: true }]);

      await expect(
        repository.submitFeedback(host.id, eventId, [
          { targetUserId: daniel.id, wouldTravelAgain: false }, // conflicting existing
          { targetUserId: sarah.id, wouldTravelAgain: true }, // would otherwise be new
        ]),
      ).rejects.toBeInstanceOf(TravellerFeedbackAnswerConflictError);

      const sarahRows = await AppDataSource.query(
        `SELECT count(*)::int AS n FROM traveller_feedback WHERE event_id = $1 AND target_user_id = $2`,
        [eventId, sarah.id],
      );
      expect(sarahRows[0].n).toBe(0); // Sarah was NOT inserted despite being a "new" target
    });
  });

  it('DB-level uniqueness is still enforced even bypassing the repository entirely', async () => {
    const host = await createUser('uniq-host');
    const daniel = await createUser('uniq-daniel');
    const eventId = await createEvent({ hostUserId: host.id });
    await addParticipant(eventId, daniel.id);
    await AppDataSource.query(
      `INSERT INTO traveller_feedback (reviewer_user_id, target_user_id, event_id, would_travel_again) VALUES ($1,$2,$3,TRUE)`,
      [host.id, daniel.id, eventId],
    );

    await expect(
      AppDataSource.query(
        `INSERT INTO traveller_feedback (reviewer_user_id, target_user_id, event_id, would_travel_again) VALUES ($1,$2,$3,TRUE)`,
        [host.id, daniel.id, eventId],
      ),
    ).rejects.toThrow();
  });
});
