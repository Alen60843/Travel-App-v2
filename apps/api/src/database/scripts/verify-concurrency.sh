#!/usr/bin/env bash
# ============================================================================
# TripWith — concurrent capacity race verification
#
# Proves the §36 question "can it handle concurrent users taking the final
# event slot?" against a real server with real parallel connections.
#
# WS8.5E-A: capacity_max now bounds TOTAL PHYSICAL OCCUPANCY
# (reserved_seat_count), not just registered EventParticipant rows. The
# fixture here is a USER-hosted Event with host_guest_count = 0, so the host
# ALONE already reserves 1 of the TOTAL_CAPACITY physical seats before any
# worker races — only TOTAL_CAPACITY - 1 seats remain for participants. N
# workers race for those AVAILABLE_PARTICIPANT_SEATS. All N block on a shared
# advisory barrier, then fire simultaneously. Exactly
# AVAILABLE_PARTICIPANT_SEATS must win — not TOTAL_CAPACITY, which was the
# pre-Phase-8 (host-excluded) expectation this script used to encode.
#
# Usage: ./verify-concurrency.sh
# (or PGPORT=5432 ./verify-concurrency.sh to point at a different local port)
# ============================================================================
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
# infra/docker-compose.yml exposes Postgres on 5432 (not the old 55432
# default this script used to assume before that compose file existed in
# its current form).
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-tripwith}"
PGPASSWORD="${PGPASSWORD:-tripwith_local_dev}"
PGDATABASE="${PGDATABASE:-tripwith}"
export PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE

# No host psql client is installed (this repo's Windows dev environment has
# none, and none should need to be installed just to run this script). The
# database itself runs healthily in Docker (infra-postgres-1). Minimum
# portability fix: run psql INSIDE that container via `docker exec` when no
# host psql is found; use a real host psql directly and unchanged when one
# IS present (e.g. CI, a Linux dev machine) — no verification logic below
# this point changes either way.
PG_CONTAINER="${PG_CONTAINER:-infra-postgres-1}"
if command -v psql >/dev/null 2>&1; then
  psql_bin() { psql "$@"; }
else
  psql_bin() { docker exec -i -e PGPASSWORD="${PGPASSWORD}" "${PG_CONTAINER}" psql -U "${PGUSER}" -d "${PGDATABASE}" "$@"; }
fi

WORKERS="${WORKERS:-24}"
# TOTAL_CAPACITY = events.capacity_max for the race fixture (total physical
# seats, host included). Renamed from the old, now-ambiguous CAPACITY.
TOTAL_CAPACITY="${TOTAL_CAPACITY:-${CAPACITY:-5}}"
# The race fixture's USER host always has host_guest_count = 0 here, so the
# host's own physical occupancy at seed time is fixed at 1 seat. If a future
# revision of this script parameterizes host_guest_count, this must become
# 1 + that value.
INITIAL_RESERVED_SEATS=1
AVAILABLE_PARTICIPANT_SEATS=$((TOTAL_CAPACITY - INITIAL_RESERVED_SEATS))
if [ "$AVAILABLE_PARTICIPANT_SEATS" -lt 0 ]; then
  echo "FATAL: TOTAL_CAPACITY (${TOTAL_CAPACITY}) is below the host's own physical occupancy (${INITIAL_RESERVED_SEATS})" >&2
  exit 1
fi
BARRIER_ID=424242

psql_q() { psql_bin -qAt -v ON_ERROR_STOP=1 "$@"; }

# event_status_history is correctly append-only for application code. This
# test owns its RACE TEST fixtures, so cleanup temporarily disables only that
# table's mutation guard inside a transaction and restores it before commit.
# With `set -e`, any cleanup/setup error now fails the gate instead of silently
# continuing against stale rows and printing a false PASS.
cleanup() {
  psql_q <<SQL >/dev/null
BEGIN;
ALTER TABLE event_status_history DISABLE TRIGGER event_status_history_append_only;
DELETE FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE title = 'RACE TEST');
DELETE FROM event_status_history WHERE event_id IN (SELECT id FROM events WHERE title = 'RACE TEST');
DELETE FROM events WHERE title = 'RACE TEST';
ALTER TABLE event_status_history ENABLE TRIGGER event_status_history_append_only;
DELETE FROM user_settings WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'race_%');
DELETE FROM user_profiles WHERE user_id IN (SELECT id FROM users WHERE firebase_uid LIKE 'race_%');
DELETE FROM users WHERE firebase_uid LIKE 'race_%';
COMMIT;
SQL
}

cleanup
TMPDIR_RUN=''
cleanup_all() {
  if [ -n "$TMPDIR_RUN" ] && [ -d "$TMPDIR_RUN" ]; then
    rm -rf "$TMPDIR_RUN"
  fi
  cleanup
}
trap cleanup_all EXIT

echo "=== setting up: total_capacity=${TOTAL_CAPACITY} (host reserves ${INITIAL_RESERVED_SEATS}, ${AVAILABLE_PARTICIPANT_SEATS} available), racing workers=${WORKERS} ==="

psql_q <<SQL >/dev/null
INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
SELECT 'race_host', 'race_host@example.com', CURRENT_DATE - INTERVAL '35 years', 'ACTIVE';

INSERT INTO users (firebase_uid, email, date_of_birth, account_status)
SELECT 'race_' || g, 'race' || g || '@example.com',
       CURRENT_DATE - INTERVAL '30 years', 'ACTIVE'
  FROM generate_series(1, ${WORKERS}) g;

INSERT INTO events (host_type, host_user_id, category_id, title, capacity_max, host_guest_count,
                    starts_at, ends_at, meeting_point, status)
SELECT 'USER',
       (SELECT id FROM users WHERE firebase_uid = 'race_host'),
       (SELECT id FROM event_categories WHERE code = 'trek'),
       'RACE TEST', ${TOTAL_CAPACITY}, 0,
       now() + INTERVAL '5 days', now() + INTERVAL '5 days 4 hours',
       ST_MakePoint(100.5, 13.75)::GEOGRAPHY, 'ACTIVE';
SQL

EVENT_ID=$(psql_q -c "SELECT id FROM events WHERE title = 'RACE TEST'")

# Hold the barrier exclusively so every worker blocks before its INSERT.
psql_bin -qAt -c "SELECT pg_advisory_lock(${BARRIER_ID}); SELECT pg_sleep(4);" >/dev/null 2>&1 &
BARRIER_PID=$!
sleep 1

TMPDIR_RUN=$(mktemp -d)
for i in $(seq 1 "$WORKERS"); do
  (
    if psql_bin -qAt -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>"${TMPDIR_RUN}/err_${i}"
BEGIN;
SELECT pg_advisory_xact_lock_shared(${BARRIER_ID});
INSERT INTO event_participants (event_id, user_id)
VALUES ('${EVENT_ID}', (SELECT id FROM users WHERE firebase_uid = 'race_${i}'));
COMMIT;
SQL
    then
      echo 0 > "${TMPDIR_RUN}/rc_${i}"
    else
      echo $? > "${TMPDIR_RUN}/rc_${i}"
    fi
  ) &
done

wait "$BARRIER_PID" 2>/dev/null
wait

RESULT_COUNT=$(find "$TMPDIR_RUN" -type f -name 'rc_*' | wc -l | tr -d ' ')
SUCCEEDED=$(awk '$1 == 0 { count++ } END { print count + 0 }' "${TMPDIR_RUN}"/rc_*)
FAILED=$((RESULT_COUNT - SUCCEEDED))
ROWS=$(psql_q -c "SELECT count(*) FROM event_participants WHERE event_id = '${EVENT_ID}' AND cancelled_at IS NULL")
PARTICIPANT_COUNTER=$(psql_q -c "SELECT participant_count FROM events WHERE id = '${EVENT_ID}'")
RESERVED_SEAT_COUNTER=$(psql_q -c "SELECT reserved_seat_count FROM events WHERE id = '${EVENT_ID}'")
# WS8.5E-A: workers are rejected by the physical-occupancy CHECK
# (events_reserved_seat_count_capacity_chk), not the old, now-redundant
# events_capacity_not_exceeded_chk (participant_count <= capacity_max) —
# for a USER-hosted Event the new CHECK is always at least as strict, so it
# is the one that actually fires. See the WS8.5E-A report for why the old
# constraint was left in place rather than modified in this pass (schema
# change, out of this harness-only workstream's scope).
CAPCHECK=$(awk '/events_reserved_seat_count_capacity_chk/ { count++ } END { print count + 0 }' "${TMPDIR_RUN}"/err_*)

echo
echo "workers that committed        : ${SUCCEEDED}"
echo "workers rejected              : ${FAILED}"
echo "  ...by physical-seat CHECK   : ${CAPCHECK}"
echo "participant rows (active)     : ${ROWS}"
echo "events.participant_count      : ${PARTICIPANT_COUNTER}"
echo "events.reserved_seat_count    : ${RESERVED_SEAT_COUNTER}"
echo

STATUS=0
[ "$RESULT_COUNT" -eq "$WORKERS" ] || { echo "FAIL: expected ${WORKERS} worker results, got ${RESULT_COUNT}"; STATUS=1; }
[ "$SUCCEEDED" -eq "$AVAILABLE_PARTICIPANT_SEATS" ] || { echo "FAIL: expected exactly ${AVAILABLE_PARTICIPANT_SEATS} winners (total_capacity ${TOTAL_CAPACITY} - host occupancy ${INITIAL_RESERVED_SEATS}), got ${SUCCEEDED}"; STATUS=1; }
[ "$FAILED" -eq $((WORKERS - AVAILABLE_PARTICIPANT_SEATS)) ] || { echo "FAIL: expected $((WORKERS - AVAILABLE_PARTICIPANT_SEATS)) rejected workers"; STATUS=1; }
[ "$CAPCHECK" -eq "$FAILED" ] || { echo "FAIL: not every rejected worker hit the physical-seat CHECK"; STATUS=1; }
[ "$ROWS" -eq "$AVAILABLE_PARTICIPANT_SEATS" ]      || { echo "FAIL: expected ${AVAILABLE_PARTICIPANT_SEATS} participant rows"; STATUS=1; }
[ "$PARTICIPANT_COUNTER" -eq "$AVAILABLE_PARTICIPANT_SEATS" ]   || { echo "FAIL: participant_count drifted from reality"; STATUS=1; }
# reserved_seat_count must include the host's occupancy on top of the
# winning participants, and must never exceed total_capacity (the CHECK
# already guarantees this transactionally; this re-derives it independently
# from the two counters so a trigger/counter drift bug cannot hide behind a
# CHECK that happened to hold for an unrelated reason).
[ "$RESERVED_SEAT_COUNTER" -le "$TOTAL_CAPACITY" ] || { echo "FAIL: reserved_seat_count (${RESERVED_SEAT_COUNTER}) exceeds total_capacity (${TOTAL_CAPACITY}) — overbooked"; STATUS=1; }
[ "$RESERVED_SEAT_COUNTER" -eq "$((PARTICIPANT_COUNTER + INITIAL_RESERVED_SEATS))" ] || { echo "FAIL: reserved_seat_count (${RESERVED_SEAT_COUNTER}) does not equal participant_count (${PARTICIPANT_COUNTER}) + host occupancy (${INITIAL_RESERVED_SEATS}) — counter drift"; STATUS=1; }

if [ "$STATUS" -eq 0 ]; then
  echo "PASS: ${WORKERS} concurrent joiners, exactly ${AVAILABLE_PARTICIPANT_SEATS} participant seats filled (host already reserved ${INITIAL_RESERVED_SEATS} of ${TOTAL_CAPACITY}), no overbooking, counters consistent"
fi

exit "$STATUS"
