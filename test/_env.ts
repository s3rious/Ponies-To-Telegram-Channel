// Required-by-config env stubs. Each test file imports this BEFORE any src/* module
// so that `src/config.ts` validation does not throw.
process.env.GRABBING_CRON_INTERVAL ??= '0 * * * *';
process.env.GRABBING_PAGES ??= '5';
process.env.GRABBING_URLS ??= 'https://example.com/api?q=test, https://example.com/api?q=test2';
process.env.POSTING_CRON_INTERVAL ??= '*/5 * * * *';
process.env.TELEGRAM_BOT_TOKEN ??= '0:test-token';
process.env.TELEGRAM_CHANNEL_NAME ??= 'test_channel';
process.env.MONGO_DATABASE ??= 'testdb';
process.env.MONGO_USER ??= 'testuser';
process.env.MONGO_PASSWORD ??= 'testpass';
process.env.MONGO_HOST ??= '127.0.0.1';
process.env.MONGO_PORT ??= '27017';
