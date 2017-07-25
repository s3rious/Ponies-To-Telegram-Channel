const GRABBING_CRON_INTERVAL = process.env.GRABBING_CRON_INTERVAL;
const GRABBING_PAGES = process.env.GRABBING_PAGES ? parseInt(process.env.GRABBING_PAGES, 10) : null;
const GRABBING_URLS = process.env.GRABBING_URLS;
const POSTING_CRON_INTERVAL = process.env.POSTING_CRON_INTERVAL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHANNEL_NAME = process.env.TELEGRAM_CHANNEL_NAME;
const MONGO_DATABASE = process.env.MONGO_DATABASE;
const MONGO_USER = process.env.MONGO_USER;
const MONGO_PASSWORD = process.env.MONGO_PASSWORD;

function validateExistance(constants) {
  return Object.keys(constants).forEach((name) => {
    if (!constants[name]) {
      throw new Error(`process.env.${name} variable is empty`);
    }
  });
}

validateExistance({
  GRABBING_CRON_INTERVAL,
  GRABBING_PAGES,
  GRABBING_URLS,
  POSTING_CRON_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_NAME,
  MONGO_DATABASE,
  MONGO_USER,
  MONGO_PASSWORD
});

const STATUSES = {
  UNPUBLISHED: 'unpublished',
  PROCESSING: 'processing',
  POSTED: 'posted',
  ERROR: 'error'
};

export default {
  GRABBING_CRON_INTERVAL,
  GRABBING_PAGES,
  GRABBING_URLS,
  POSTING_CRON_INTERVAL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHANNEL_NAME,
  MONGO_DATABASE,
  MONGO_USER,
  MONGO_PASSWORD,
  STATUSES
};
