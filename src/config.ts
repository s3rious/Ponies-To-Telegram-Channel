function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`process.env.${name} is empty`);
  return v;
}

function requiredInt(name: string): number {
  const raw = required(name);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`process.env.${name} must be an integer, got "${raw}"`);
  return n;
}

const config = Object.freeze({
  grabbingCronInterval: required('GRABBING_CRON_INTERVAL'),
  grabbingPages: requiredInt('GRABBING_PAGES'),
  grabbingUrls: required('GRABBING_URLS').split(',').map((s) => s.trim()).filter(Boolean),
  postingCronInterval: required('POSTING_CRON_INTERVAL'),
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChannelName: required('TELEGRAM_CHANNEL_NAME'),
  mongo: {
    database: required('MONGO_DATABASE'),
    user: required('MONGO_USER'),
    password: required('MONGO_PASSWORD'),
    host: process.env.MONGO_HOST ?? 'mongo',
    port: parseInt(process.env.MONGO_PORT ?? '27017', 10),
  },
});

const STATUS_UNPUBLISHED = 'unpublished';
const STATUS_PROCESSING = 'processing';
const STATUS_POSTED = 'posted';
const STATUS_ERROR = 'error';

const MAX_POSTING_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 30_000;
const FFMPEG_TIMEOUT_MS = 5 * 60_000;
const FFPROBE_TIMEOUT_MS = 30_000;

type Status =
  | typeof STATUS_UNPUBLISHED
  | typeof STATUS_PROCESSING
  | typeof STATUS_POSTED
  | typeof STATUS_ERROR;

const ALL_STATUSES: readonly Status[] = [
  STATUS_UNPUBLISHED,
  STATUS_PROCESSING,
  STATUS_POSTED,
  STATUS_ERROR,
];

export {
  config,
  STATUS_UNPUBLISHED,
  STATUS_PROCESSING,
  STATUS_POSTED,
  STATUS_ERROR,
  ALL_STATUSES,
  MAX_POSTING_ATTEMPTS,
  FETCH_TIMEOUT_MS,
  FFMPEG_TIMEOUT_MS,
  FFPROBE_TIMEOUT_MS,
  type Status,
};
