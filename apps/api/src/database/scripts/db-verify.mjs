#!/usr/bin/env node
/**
 * Portable launcher for `pnpm run db:verify`.
 *
 * Runs, in order, failing fast and propagating the failing step's exit code:
 *   1. verify-invariants.sql   (SQL invariant harness)
 *   2. verify-concurrency.sh   (real parallel-connection capacity race)
 *
 * Uses a host `psql` client when one is on PATH (optionally honouring
 * $DATABASE_URL, exactly as the old inline npm script did). Otherwise falls
 * back to running `psql` INSIDE the already-running Docker Postgres
 * container (default `infra-postgres-1`, see infra/docker-compose.yml) —
 * no host PostgreSQL client needs to be installed. verify-concurrency.sh
 * already carries the same host-psql-or-Docker fallback internally, so it
 * is simply invoked with the same connection environment.
 *
 * Node builtins only, no dependencies — same convention as
 * scripts/check-enum-parity.mjs.
 *
 *   node src/database/scripts/db-verify.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const INVARIANTS_SQL = join(scriptsDir, 'verify-invariants.sql');
const CONCURRENCY_SH = join(scriptsDir, 'verify-concurrency.sh');

// Same defaults as verify-concurrency.sh and infra/docker-compose.yml.
const env = {
  ...process.env,
  PGHOST: process.env.PGHOST ?? 'localhost',
  PGPORT: process.env.PGPORT ?? '5432',
  PGUSER: process.env.PGUSER ?? 'tripwith',
  PGPASSWORD: process.env.PGPASSWORD ?? 'tripwith_local_dev',
  PGDATABASE: process.env.PGDATABASE ?? 'tripwith',
  PG_CONTAINER: process.env.PG_CONTAINER ?? 'infra-postgres-1',
};

function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function fail(message, code = 1) {
  console.error(`db:verify: ${message}`);
  process.exit(code);
}

function exitCodeOf(result, stepName) {
  if (result.error) fail(`${stepName} could not be started: ${result.error.message}`);
  // A null status means the child was terminated by a signal — never a pass.
  return result.status ?? 1;
}

function runInvariants() {
  console.log('=== db:verify [1/2] verify-invariants.sql ===');
  if (commandExists('psql')) {
    const args = ['-v', 'ON_ERROR_STOP=1', '-f', INVARIANTS_SQL];
    if (process.env.DATABASE_URL) args.unshift(process.env.DATABASE_URL);
    return exitCodeOf(spawnSync('psql', args, { stdio: 'inherit', env }), 'host psql');
  }

  if (!commandExists('docker')) {
    fail('no host `psql` client and no `docker` CLI found on PATH — cannot reach PostgreSQL.');
  }
  console.log(`(no host psql found — using psql inside Docker container "${env.PG_CONTAINER}")`);
  // Feed the SQL file over stdin (`-f -`) rather than `docker cp`-ing it into
  // the container, so no temp file is left behind inside the container.
  return exitCodeOf(
    spawnSync(
      'docker',
      [
        'exec', '-i', '-e', `PGPASSWORD=${env.PGPASSWORD}`, env.PG_CONTAINER,
        'psql', '-U', env.PGUSER, '-d', env.PGDATABASE, '-v', 'ON_ERROR_STOP=1', '-f', '-',
      ],
      { input: readFileSync(INVARIANTS_SQL), stdio: ['pipe', 'inherit', 'inherit'], env },
    ),
    'docker exec psql',
  );
}

function runConcurrency() {
  console.log('=== db:verify [2/2] verify-concurrency.sh ===');
  if (!commandExists('bash')) {
    fail('`bash` not found on PATH — verify-concurrency.sh requires it (on Windows, Git Bash provides it).');
  }
  return exitCodeOf(spawnSync('bash', [CONCURRENCY_SH], { stdio: 'inherit', env }), 'bash');
}

const invariantsStatus = runInvariants();
if (invariantsStatus !== 0) fail(`verify-invariants.sql failed (exit ${invariantsStatus}).`, invariantsStatus);

const concurrencyStatus = runConcurrency();
if (concurrencyStatus !== 0) fail(`verify-concurrency.sh failed (exit ${concurrencyStatus}).`, concurrencyStatus);

console.log('=== db:verify PASS: invariants and concurrency verification both succeeded ===');
