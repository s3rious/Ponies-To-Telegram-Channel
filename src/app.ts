import { logger, flush } from './logger.ts';
import { connect, disconnect, resetStaleProcessing } from './mongo.ts';

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down...`);
  try {
    const { stopJobs } = await import('./jobs.ts');
    const { drainInFlight } = await import('./poster.ts');
    stopJobs();
    await drainInFlight(30_000);
    await disconnect();
  } catch (error) {
    logger.error('shutdown error:', error);
  }
  await flush();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

process.on('unhandledRejection', (error: unknown) => {
  logger.error('unhandledRejection:', error);
  process.exit(1);
});

process.on('uncaughtException', (error: unknown) => {
  logger.error('uncaughtException:', error);
  process.exit(1);
});

await connect();
await resetStaleProcessing();

// Only import jobs after Mongo is ready so cron ticks never fire into a dead DB.
await import('./jobs.ts');

logger.info('app: jobs scheduled');
