import { CronJob } from 'cron';
import { config } from './config.ts';
import { grabImages } from './grabber.ts';
import { postImages } from './poster.ts';
import { cleanupOldImages } from './mongo.ts';
import { logger } from './logger.ts';

const CLEANUP_AGE_MS = 365 * 24 * 60 * 60 * 1000;
const CLEANUP_CRON = '30 3 * * 0';

const grabbing = CronJob.from({
  cronTime: config.grabbingCronInterval,
  onTick: () => {
    grabImages(config.grabbingPages).catch((error: unknown) => {
      logger.error('grabbing cron tick failed:', error);
    });
  },
  start: true,
  runOnInit: true,
});

const posting = CronJob.from({
  cronTime: config.postingCronInterval,
  onTick: () => {
    postImages().catch((error: unknown) => {
      logger.error('posting cron tick failed:', error);
    });
  },
  start: true,
  runOnInit: true,
});

const cleanup = CronJob.from({
  cronTime: CLEANUP_CRON,
  onTick: () => {
    cleanupOldImages(CLEANUP_AGE_MS).catch((error: unknown) => {
      logger.error('cleanup cron tick failed:', error);
    });
  },
  start: true,
  runOnInit: false,
});

function stopJobs(): void {
  grabbing.stop();
  posting.stop();
  cleanup.stop();
}

export { grabbing, posting, cleanup, stopJobs };
