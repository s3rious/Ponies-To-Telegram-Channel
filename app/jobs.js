import { CronJob } from 'cron';

import { GRABBING_CRON_INTERVAL, GRABBING_PAGES, POSTING_CRON_INTERVAL } from './config.js';
import { grabImages } from './grabber.js';
import { postImages } from './poster.js';

const grabbing = new CronJob({
  cronTime: GRABBING_CRON_INTERVAL,
  onTick: () => grabImages(GRABBING_PAGES),
  start: true,
  runOnInit: true
});

const posting = new CronJob({
  cronTime: POSTING_CRON_INTERVAL,
  onTick: () => postImages(posting),
  start: true,
  runOnInit: true
});

export default {
  grabbing,
  posting
};
