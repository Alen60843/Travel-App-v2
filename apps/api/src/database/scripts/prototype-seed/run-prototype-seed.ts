import {
  assertPrototypeSeedAllowed,
  formatPrototypeSeedSummary,
  PrototypeSeedRefusedError,
  runPrototypeSeed,
} from './prototype-seed';

/**
 * CLI entry for `pnpm --filter @tripwith/api db:seed:prototype`.
 * The safety guard runs before the data source module is even loaded, so a
 * refused run never opens a database connection.
 */
async function main(): Promise<void> {
  assertPrototypeSeedAllowed(process.env);
  const { AppDataSource } = await import('../../data-source');
  await AppDataSource.initialize();
  try {
    const result = await runPrototypeSeed(AppDataSource);
    console.log(formatPrototypeSeedSummary(result));
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  if (error instanceof PrototypeSeedRefusedError) {
    console.error(error.message);
  } else {
    console.error('Prototype seed failed:', error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
