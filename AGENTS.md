# derpibooru-poster — Shared poster code

Copy of `derpibooru-poster/` from the digital-ocean repo, which also keeps its own copy. The Hoofbeat and Hoofington wrappers there build from `../derpibooru-poster` in their compose files.

`legacy/` holds the original JavaScript app and is not linted, type-checked or tested.

## Stack

- Node 22, TypeScript via `--experimental-strip-types` (no build step)
- mongoose, cron, grammy
- Internal logger (~30 lines, file + stdout)

## Commands

```
npm install
npm run start              # production-style run (requires env + reachable Mongo)
npm run dev                # node --watch
npm run typecheck
npm test                   # node:test unit suites
npm run test:integration   # boots ephemeral mongo, runs full-flow test, tears down
npm run lint               # ESLint (strict)
```

## Layout

```
src/
  app.ts        entry — awaits Mongo, then schedules cron jobs
  config.ts     env-var loader + validation
  mongo.ts      mongoose connect with exponential-backoff retry
  grabber.ts    Derpibooru fetcher (native fetch + retry helper)
  poster.ts     Telegram poster (via telegram.ts)
  telegram.ts   grammy wrapper, injectable for tests
  jobs.ts       cron scheduling
  logger.ts     stdout + file logger
  retry.ts      retry + retryForever helpers

test/*.test.ts          unit tests
test/integration/       full-flow test against a real Mongo container
```

## Env vars

Required: `GRABBING_CRON_INTERVAL`, `GRABBING_PAGES`, `GRABBING_URLS`, `POSTING_CRON_INTERVAL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_NAME`, `MONGO_DATABASE`, `MONGO_USER`, `MONGO_PASSWORD`.

Optional: `MONGO_HOST` (default `mongo`), `MONGO_PORT` (default `27017`), `LOG_FILE` (default `/app/logs/verbose.log`), `TMP_DIR` (default `/app/tmp`).

## Code style

Enforced by ESLint (see `eslint.config.js`):
- Imports at top, exports collected at the bottom (no inline `export`)
- No `else` — prefer early return
- No `any`, no type assertions; use `unknown` + type guards

## Naming

Not lint-enforced — apply by convention:

- Reuse schema terms verbatim. `mime_type`, `original_source`, `duplicate_of`, `source_url` stay snake_case everywhere (params, locals, logs, error messages). No shorthand like `mt`, `mime`, `orig`.
- camelCase for everything else JS-side (`retryAfterMs`, `chatId`, `extraTempPaths`).
- Spell out domain words: `duplicates` not `dupes`, `tempPath` not `t`, `error` not `e`/`err` in catch blocks.
- No single-letter loop indices — `index`, not `i`.
- Path variables name their role: `inputPath`/`outputPath` in send-helpers, `downloadedPath` for the post-download local. Match this shape in new helpers.
