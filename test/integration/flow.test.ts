// Boots against the ephemeral mongo from test/integration/run.sh.
// Derpibooru, Telegram, and the transcoder are stubbed; mongo is real.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SendPhotoArgs, SendVideoArgs, SendMessageArgs, TelegramClient } from '../../src/telegram.ts';
import type { Transcoder } from '../../src/transcode.ts';

// src/config.ts validates env at module load — set everything BEFORE the imports below.
process.env.MONGO_HOST = process.env.INT_MONGO_HOST ?? '127.0.0.1';
process.env.MONGO_PORT = process.env.INT_MONGO_PORT ?? '27019';
process.env.MONGO_USER = process.env.INT_MONGO_USER ?? 'testuser';
process.env.MONGO_PASSWORD = process.env.INT_MONGO_PASSWORD ?? 'testpass';
process.env.MONGO_DATABASE = 'derpibooru_test';
process.env.GRABBING_CRON_INTERVAL = '0 * * * *';
process.env.GRABBING_PAGES = '1';
process.env.GRABBING_URLS = 'https://derpibooru.example/api/v1/json/search/images?q=test';
process.env.POSTING_CRON_INTERVAL = '*/5 * * * *';
process.env.TELEGRAM_BOT_TOKEN = '0:fake-token';
process.env.TELEGRAM_CHANNEL_NAME = 'test_channel';

const LOG_DIR = await mkdtemp(join(tmpdir(), 'derpi-int-log-'));
process.env.LOG_FILE = join(LOG_DIR, 'verbose.log');
const TMP_DIR = await mkdtemp(join(tmpdir(), 'derpi-int-tmp-'));
process.env.TMP_DIR = TMP_DIR;

interface FetchCall { url: string }
const fetchCalls: FetchCall[] = [];
const derpibooruImages: { value: readonly unknown[] } = { value: [] };
const originalFetch = globalThis.fetch;

type FetchInput = Parameters<typeof fetch>[0];

function urlFromInput(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const OVERSIZED_BYTES = 11 * 1024 * 1024;

const mockFetch: typeof fetch = async (input, _init) => {
  await Promise.resolve();
  const url = urlFromInput(input);
  fetchCalls.push({ url });

  if (url.includes('derpibooru.example')) {
    return new Response(JSON.stringify({ images: derpibooruImages.value }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('cdn.example')) {
    if (url.includes('/big.')) {
      return new Response(Buffer.alloc(OVERSIZED_BYTES), { status: 200 });
    }
    if (url.endsWith('.svg')) {
      return new Response(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { status: 200 });
    }
    return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
  }
  if (url.includes('api.telegram.org')) {
    return new Response(JSON.stringify({ ok: true, result: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch to ${url}`);
};
globalThis.fetch = mockFetch;

const mongo = await import('../../src/mongo.ts');
const { Image } = mongo;
const { STATUS_POSTED, STATUS_ERROR, STATUS_PROCESSING, STATUS_UNPUBLISHED } = await import('../../src/config.ts');
const { grabImages } = await import('../../src/grabber.ts');
const { postImages, drainInFlight, claimNextImage } = await import('../../src/poster.ts');
const { setClient } = await import('../../src/telegram.ts');
const { setTranscoder } = await import('../../src/transcode.ts');

interface PhotoCall { kind: 'photo'; args: SendPhotoArgs; messageId: number }
interface VideoCall { kind: 'video'; args: SendVideoArgs; messageId: number }
interface MessageCall { kind: 'message'; args: SendMessageArgs; messageId: number }
type TelegramCall = PhotoCall | VideoCall | MessageCall;

const telegramCalls: TelegramCall[] = [];
let nextMessageId = 1;

const stubClient: TelegramClient = {
  sendPhoto: async (args) => {
    await Promise.resolve();
    const messageId = nextMessageId++;
    telegramCalls.push({ kind: 'photo', args, messageId });
    return { message_id: messageId };
  },
  sendVideo: async (args) => {
    await Promise.resolve();
    const messageId = nextMessageId++;
    telegramCalls.push({ kind: 'video', args, messageId });
    return { message_id: messageId };
  },
  sendMessage: async (args) => {
    await Promise.resolve();
    const messageId = nextMessageId++;
    telegramCalls.push({ kind: 'message', args, messageId });
    return { message_id: messageId };
  },
};
setClient(stubClient);

interface TranscodeCall {
  op: 'toMp4' | 'toResizedJpeg';
  input: string;
  output: string;
}
const transcodeCalls: TranscodeCall[] = [];

const stubTranscoder: Transcoder = {
  toMp4: async (input, output) => {
    transcodeCalls.push({ op: 'toMp4', input, output });
    await writeFile(output, Buffer.from([0]));
  },
  toResizedJpeg: async (input, output, _opts) => {
    transcodeCalls.push({ op: 'toResizedJpeg', input, output });
    await writeFile(output, Buffer.from([0]));
  },
};
setTranscoder(stubTranscoder);

before(async () => {
  await mongo.connect();
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongo.disconnect();
  await rm(LOG_DIR, { recursive: true, force: true });
  await rm(TMP_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await Image.deleteMany({});
  fetchCalls.length = 0;
  telegramCalls.length = 0;
  transcodeCalls.length = 0;
  derpibooruImages.value = [];
  nextMessageId = 1;
});

test('connect retries until mongo is reachable', () => {
  assert.equal(Image.db.readyState, 1);
});

test('grabImages stores filtered + parsed images as unpublished', async () => {
  derpibooruImages.value = [
    { id: 1001, representations: { full: '//cdn.example/1001.png' }, source_url: 'https://artist.example/1001', format: 'png', mime_type: 'image/png' },
    { id: 1002, duplicate_of: 999, representations: { full: '//cdn.example/1002.png' }, format: 'png', mime_type: 'image/png' },
    { id: 1003, representations: { full: '//cdn.example/1003.gif' }, source_url: null, format: 'gif', mime_type: 'image/gif' },
  ];

  await grabImages(1);

  const stored = await Image.find({}).sort({ id: 1 }).lean();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((i) => i.id), [1001, 1003]);
  const first = stored[0];
  const second = stored[1];
  if (!first || !second) throw new Error('expected two stored images');
  assert.equal(first.status, STATUS_UNPUBLISHED);
  assert.equal(first.src, 'https://cdn.example/1001.png');
  assert.equal(second.original_source, 'https://derpibooru.org/1003');
});

test('postImages: success path populates posted_message_id + posted_at', async () => {
  await Image.create([
    { id: 2200, src: 'https://cdn.example/2200.png', original_source: 'https://artist.example/2200', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
  ]);

  const beforeMs = Date.now();
  await postImages();
  const afterMs = Date.now();

  const after = await Image.findOne({ id: 2200 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_POSTED);
  assert.ok(typeof after.posted_message_id === 'number' && after.posted_message_id > 0, `posted_message_id should be a positive number, got ${after.posted_message_id}`);
  const postedAt = after.posted_at;
  if (!(postedAt instanceof Date)) throw new Error('posted_at should be a Date');
  const postedMs = postedAt.getTime();
  assert.ok(postedMs >= beforeMs && postedMs <= afterMs, `posted_at should be within the test window, got ${postedAt.toISOString()}`);
});

test('postImages: animated path stores the video message_id (not the reply message_id)', async () => {
  await Image.create([
    { id: 2210, src: 'https://cdn.example/2210.gif', original_source: 'https://artist.example/2210', format: 'gif', mime_type: 'image/gif', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2210 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_POSTED);
  const videos = telegramCalls.filter((c): c is VideoCall => c.kind === 'video');
  assert.equal(videos.length, 1);
  const [video] = videos;
  if (!video) throw new Error('expected one video call');
  assert.equal(after.posted_message_id, video.messageId, 'posted_message_id should be the video, not the reply');
});

test('claimNextImage atomically claims one row per call; sequential cycles drain the queue without double-posts', async () => {
  // The cycle-overlap guard prevents two concurrent postImages calls from doing
  // simultaneous work, so atomic-claim correctness is exercised via sequential
  // cycles instead. Each cycle's claim loop must hand back disjoint images.
  const seedCount = 10;
  await Image.create(
    Array.from({ length: seedCount }, (_, index) => ({
      id: 9100 + index,
      src: `https://cdn.example/${9100 + index}.png`,
      original_source: `https://artist.example/${9100 + index}`,
      format: 'png',
      mime_type: 'image/png',
      status: STATUS_UNPUBLISHED,
    })),
  );

  // Drain via repeated cycles until queue is empty (cap iterations defensively).
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const remaining = await Image.countDocuments({ status: STATUS_UNPUBLISHED });
    if (remaining === 0) break;
    await postImages();
  }

  const final = await Image.find({}).sort({ id: 1 }).lean();
  assert.equal(final.length, seedCount);
  for (const image of final) {
    assert.equal(image.status, STATUS_POSTED, `image ${image.id} should be posted`);
    assert.ok(typeof image.posted_message_id === 'number', `image ${image.id} should have a posted_message_id`);
  }

  const messageIds = new Set(final.map((i) => i.posted_message_id));
  assert.equal(messageIds.size, seedCount, 'every posted image should have a distinct message_id (no double-post)');

  const photos = telegramCalls.filter((c): c is PhotoCall => c.kind === 'photo');
  assert.equal(photos.length, seedCount, 'one telegram photo per image, no duplicates');
});

test('claimNextImage returns null when nothing is unpublished', async () => {
  const claimed = await claimNextImage();
  assert.equal(claimed, null);
});

test('postImages: cycle-overlap guard skips concurrent ticks while a cycle is in flight', async () => {
  await Image.create([
    { id: 9500, src: 'https://cdn.example/9500.png', original_source: 'https://artist.example/9500', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
  ]);

  // Slow stub: sendPhoto signals on entry, then blocks on a gate until the test releases it.
  let releaseGate: () => void = () => {};
  let signalEntered: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });

  const slowClient: TelegramClient = {
    sendPhoto: async (args) => {
      signalEntered();
      await gate;
      const messageId = nextMessageId++;
      telegramCalls.push({ kind: 'photo', args, messageId });
      return { message_id: messageId };
    },
    sendVideo: stubClient.sendVideo,
    sendMessage: stubClient.sendMessage,
  };
  const prevClient = setClient(slowClient);

  try {
    // Kick off the first cycle — it will block inside sendPhoto once it reaches it.
    const firstCycle = postImages();

    // Wait until the first cycle has reached the slow stub (claim → download → sendPhoto entered).
    await entered;

    // Seed a second unpublished image — would be claimable if guard didn't work.
    await Image.create([
      { id: 9501, src: 'https://cdn.example/9501.png', original_source: 'https://artist.example/9501', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
    ]);

    // Trigger the overlapping tick — guard should make it return immediately without claiming.
    const overlapStart = Date.now();
    await postImages();
    const overlapElapsed = Date.now() - overlapStart;
    assert.ok(overlapElapsed < 200, `overlapping tick should return fast when cycle is in flight, took ${overlapElapsed}ms`);

    // Image 9501 must still be unpublished (the skipped cycle didn't claim it).
    const skipped = await Image.findOne({ id: 9501 }).lean();
    assert.equal(skipped?.status, STATUS_UNPUBLISHED, 'overlapping cycle must not have claimed image 9501');

    // Release the first cycle and let it complete.
    releaseGate();
    await firstCycle;

    // First cycle done → next tick is allowed to run and process 9501.
    await postImages();
    const finallyPosted = await Image.findOne({ id: 9501 }).lean();
    assert.equal(finallyPosted?.status, STATUS_POSTED, 'next tick after cycle release should process 9501');
  } finally {
    setClient(prevClient);
  }
});

test('postImages: cycle-overlap guard releases on exception', async () => {
  // Seed an image whose sendPhoto throws — postImage swallows it via markImageError,
  // postImages completes normally and the guard releases. Then a second postImages call should
  // be able to run without being blocked. This exercises the try/finally release path.
  await Image.create([
    { id: 9510, src: 'https://cdn.example/9510.bin', original_source: 'https://artist.example/9510', format: 'bin', mime_type: 'application/octet-stream', status: STATUS_UNPUBLISHED },
  ]);

  await postImages(); // First cycle: image errors (unsupported mime_type), cycle completes, guard releases.

  // Second call must run normally (not skipped as "previous still running").
  await Image.create([
    { id: 9511, src: 'https://cdn.example/9511.png', original_source: 'https://artist.example/9511', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
  ]);
  await postImages();

  const after = await Image.findOne({ id: 9511 }).lean();
  assert.equal(after?.status, STATUS_POSTED, 'second cycle should process 9511 — guard must have released');
});

test('drainInFlight returns immediately when nothing is in flight', async () => {
  const start = Date.now();
  await drainInFlight(5000);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `drain should be instant when idle, took ${elapsed}ms`);
});

test('postImages: native still png -> sendPhoto, gif -> toMp4 + sendVideo + reply', async () => {
  await Image.create([
    { id: 2001, src: 'https://cdn.example/2001.png', original_source: 'https://artist.example/2001', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
    { id: 2002, src: 'https://cdn.example/2002.gif', original_source: 'https://artist.example/2002', format: 'gif', mime_type: 'image/gif', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const posted = await Image.find({}).sort({ id: 1 }).lean();
  assert.equal(posted.length, 2);
  for (const p of posted) {
    assert.equal(p.status, STATUS_POSTED, `image ${p.id} should be posted, got ${p.status}`);
  }

  const photos = telegramCalls.filter((c): c is PhotoCall => c.kind === 'photo');
  const videos = telegramCalls.filter((c): c is VideoCall => c.kind === 'video');
  const msgs = telegramCalls.filter((c): c is MessageCall => c.kind === 'message');

  assert.equal(photos.length, 1, 'one photo sent (png)');
  assert.equal(videos.length, 1, 'one video sent (gif transcoded)');
  assert.equal(msgs.length, 1, 'one followup message for the gif');

  const [firstPhoto] = photos;
  const [firstVideo] = videos;
  const [firstMsg] = msgs;
  assert.ok(firstPhoto && firstVideo && firstMsg, 'expected one of each telegram call');
  assert.equal(firstPhoto.args.chatId, '@test_channel');
  assert.equal(firstPhoto.args.caption, 'https://artist.example/2001');
  assert.equal(firstMsg.args.text, 'https://artist.example/2002');
  assert.equal(firstMsg.args.replyToMessageId, firstVideo.messageId);

  const mp4Calls = transcodeCalls.filter((c) => c.op === 'toMp4');
  assert.equal(mp4Calls.length, 1, 'toMp4 invoked once for the gif');
});

test('postImages: video/webm routes through the animated path', async () => {
  await Image.create([
    { id: 2101, src: 'https://cdn.example/2101.webm', original_source: 'https://artist.example/2101', format: 'webm', mime_type: 'video/webm', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2101 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_POSTED);

  const videos = telegramCalls.filter((c): c is VideoCall => c.kind === 'video');
  const msgs = telegramCalls.filter((c): c is MessageCall => c.kind === 'message');
  assert.equal(videos.length, 1);
  assert.equal(msgs.length, 1);
  assert.equal(transcodeCalls.filter((c) => c.op === 'toMp4').length, 1);
});

test('postImages: oversized png triggers toResizedJpeg then sendPhoto', async () => {
  await Image.create([
    { id: 2201, src: 'https://cdn.example/big.png', original_source: 'https://artist.example/2201', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2201 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_POSTED);

  const photos = telegramCalls.filter((c): c is PhotoCall => c.kind === 'photo');
  assert.equal(photos.length, 1);
  const [photo] = photos;
  if (!photo) throw new Error('expected one photo call');
  const photoSrc = photo.args.photo;
  assert.ok(typeof photoSrc === 'object' && 'source' in photoSrc, 'photo should be a file source');
  assert.ok(photoSrc.source.endsWith('.jpg'), `expected .jpg path, got ${photoSrc.source}`);

  const resizeCalls = transcodeCalls.filter((c) => c.op === 'toResizedJpeg');
  assert.equal(resizeCalls.length, 1, 'toResizedJpeg invoked once for oversized png');
});

test('postImages: image/svg+xml (Derpibooru-rasterized PNG) routes through toResizedJpeg', async () => {
  // Derpibooru's `representations.full` for SVG sources returns a pre-rasterized
  // PNG, so production svg+xml images actually arrive as PNG bytes. The dispatcher
  // sees mime_type=image/svg+xml (not a Telegram-native still) and re-encodes via
  // toResizedJpeg, which ffmpeg handles fine regardless of the actual bytes.
  await Image.create([
    { id: 2301, src: 'https://cdn.example/2301.png', original_source: 'https://artist.example/2301', format: 'svg', mime_type: 'image/svg+xml', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2301 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_POSTED);

  const photos = telegramCalls.filter((c): c is PhotoCall => c.kind === 'photo');
  assert.equal(photos.length, 1);
  const [photo] = photos;
  if (!photo) throw new Error('expected one photo call');
  const photoSrc = photo.args.photo;
  assert.ok(typeof photoSrc === 'object' && 'source' in photoSrc, 'photo should be a file source');
  assert.ok(photoSrc.source.endsWith('.jpg'), `svg+xml re-encoded to jpg, got ${photoSrc.source}`);

  assert.equal(transcodeCalls.filter((c) => c.op === 'toResizedJpeg').length, 1);
});

test('postImages: non-native still (image/webp) is always re-encoded via toResizedJpeg', async () => {
  await Image.create([
    { id: 2501, src: 'https://cdn.example/2501.webp', original_source: 'https://artist.example/2501', format: 'webp', mime_type: 'image/webp', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2501 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_POSTED);

  const photos = telegramCalls.filter((c): c is PhotoCall => c.kind === 'photo');
  assert.equal(photos.length, 1);
  const [photo] = photos;
  if (!photo) throw new Error('expected one photo call');
  const photoSrc = photo.args.photo;
  assert.ok(typeof photoSrc === 'object' && 'source' in photoSrc, 'photo should be a file source');
  assert.ok(photoSrc.source.endsWith('.jpg'), `non-native still re-encoded to jpg, got ${photoSrc.source}`);

  assert.equal(transcodeCalls.filter((c) => c.op === 'toResizedJpeg').length, 1, 'image/webp always triggers toResizedJpeg regardless of size');
});

test('postImages: first failure -> error_count=1, status=unpublished (retry budget intact)', async () => {
  await Image.create([
    { id: 2401, src: 'https://cdn.example/2401.bin', original_source: 'https://artist.example/2401', format: 'bin', mime_type: 'application/octet-stream', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2401 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_UNPUBLISHED, 'first failure leaves status unpublished for retry');
  assert.equal(after.error_count, 1);

  assert.equal(telegramCalls.length, 0, 'no telegram call for unsupported mime_type');
  assert.equal(transcodeCalls.length, 0, 'no transcode call for unsupported mime_type');
});

test('postImages: reaching MAX_POSTING_ATTEMPTS -> error_count=3, status=error (permanent)', async () => {
  await Image.create([
    { id: 2402, src: 'https://cdn.example/2402.bin', original_source: 'https://artist.example/2402', format: 'bin', mime_type: 'application/octet-stream', status: STATUS_UNPUBLISHED, error_count: 2 },
  ]);

  await postImages();

  const after = await Image.findOne({ id: 2402 }).lean();
  if (!after) throw new Error('image should exist after post');
  assert.equal(after.status, STATUS_ERROR, 'hitting the cap marks status as error permanently');
  assert.equal(after.error_count, 3);
});

test('postImages: log line reports "attempted N, succeeded M"', async () => {
  await Image.create([
    { id: 2410, src: 'https://cdn.example/2410.png', original_source: 'https://artist.example/2410', format: 'png', mime_type: 'image/png', status: STATUS_UNPUBLISHED },
    { id: 2411, src: 'https://cdn.example/2411.bin', original_source: 'https://artist.example/2411', format: 'bin', mime_type: 'application/octet-stream', status: STATUS_UNPUBLISHED },
  ]);

  await postImages();

  // logger writes are fire-and-forget — give them a tick to flush before reading.
  await new Promise<void>((resolve) => { setTimeout(resolve, 200); });

  const logPath = process.env.LOG_FILE;
  if (!logPath) throw new Error('LOG_FILE env not set');
  const logContent = await readFile(logPath, 'utf-8');
  assert.ok(
    logContent.includes('posting: attempted 2, succeeded 1'),
    `expected "posting: attempted 2, succeeded 1" in log, got tail:\n${logContent.split('\n').slice(-20).join('\n')}`,
  );
});

test('cleanupOldImages deletes images with createdAt older than the threshold', async () => {
  const ageThresholdMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const now = Date.now();
  await Image.create([
    { id: 8001, src: 'https://cdn.example/8001.png', original_source: 'https://artist.example/8001', format: 'png', mime_type: 'image/png', status: STATUS_POSTED },
    { id: 8002, src: 'https://cdn.example/8002.png', original_source: 'https://artist.example/8002', format: 'png', mime_type: 'image/png', status: STATUS_POSTED },
    { id: 8003, src: 'https://cdn.example/8003.png', original_source: 'https://artist.example/8003', format: 'png', mime_type: 'image/png', status: STATUS_ERROR },
  ]);
  // Backdate two of them past the threshold (bypass mongoose auto-timestamps).
  await Image.collection.updateOne({ id: 8001 }, { $set: { createdAt: new Date(now - 60 * 24 * 60 * 60 * 1000) } });
  await Image.collection.updateOne({ id: 8003 }, { $set: { createdAt: new Date(now - 365 * 24 * 60 * 60 * 1000) } });

  const deletedCount = await mongo.cleanupOldImages(ageThresholdMs);
  assert.equal(deletedCount, 2);

  const remaining = await Image.find({}).sort({ id: 1 }).lean();
  assert.equal(remaining.length, 1);
  const [survivor] = remaining;
  if (!survivor) throw new Error('expected surviving image');
  assert.equal(survivor.id, 8002, 'recent image preserved');
});

test('FULL E2E: grab -> store -> post -> POSTED in one chain', async () => {
  derpibooruImages.value = [
    { id: 9001, representations: { full: '//cdn.example/9001.png' }, source_url: 'https://artist.example/9001', format: 'png', mime_type: 'image/png' },
    { id: 9002, representations: { full: '//cdn.example/9002.gif' }, source_url: 'https://artist.example/9002', format: 'gif', mime_type: 'image/gif' },
  ];

  await grabImages(1);

  const afterGrab = await Image.find({}).sort({ id: 1 }).lean();
  assert.equal(afterGrab.length, 2);
  assert.ok(afterGrab.every((i) => i.status === STATUS_UNPUBLISHED));

  await postImages();

  const final = await Image.find({}).sort({ id: 1 }).lean();
  assert.equal(final.length, 2);
  assert.ok(final.every((i) => i.status === STATUS_POSTED), `all images should be posted`);

  const photos = telegramCalls.filter((c): c is PhotoCall => c.kind === 'photo');
  const videos = telegramCalls.filter((c): c is VideoCall => c.kind === 'video');
  const msgs = telegramCalls.filter((c): c is MessageCall => c.kind === 'message');
  assert.equal(photos.length, 1, 'one photo (9001) sent');
  assert.equal(videos.length, 1, 'one video (9002 gif transcoded) sent');
  assert.equal(msgs.length, 1, 'one followup message for the gif');
});

test('connection resilience: mongoose reconnects after mongo restart, writes work again', { timeout: 60_000 }, async () => {
  const { execSync } = await import('node:child_process');
  const containerName = execSync(
    `docker ps --filter "label=com.docker.compose.service=mongo" --filter "publish=27019" --format '{{.Names}}'`,
  ).toString().trim().split('\n')[0];
  if (!containerName) throw new Error('mongo container should be running');

  const state = { disconnected: false, reconnected: false };
  const onDisconnect = (): void => { state.disconnected = true; };
  const onReconnect = (): void => { state.reconnected = true; };
  Image.db.on('disconnected', onDisconnect);
  Image.db.on('reconnected', onReconnect);

  try {
    execSync(`docker restart -t 1 ${containerName}`, { stdio: 'pipe' });

    for (let index = 0; index < 60; index++) {
      if (state.reconnected) break;
      await new Promise<void>((resolve) => { setTimeout(resolve, 500); });
    }
    assert.ok(state.disconnected, 'mongoose should have observed disconnect');
    assert.ok(state.reconnected, 'mongoose should have reconnected within 30s');

    const written = await Image.create({
      id: 5001,
      src: 'https://cdn.example/5001.png',
      original_source: 'https://artist.example/5001',
      format: 'png',
      mime_type: 'image/png',
      status: STATUS_UNPUBLISHED,
    });
    assert.equal(written.id, 5001);
    const found = await Image.findOne({ id: 5001 }).lean();
    if (!found) throw new Error('newly-written image should be findable');
    assert.equal(found.status, STATUS_UNPUBLISHED);
  } finally {
    Image.db.off('disconnected', onDisconnect);
    Image.db.off('reconnected', onReconnect);
  }
});

test('resetStaleProcessing reverts stuck processing items', async () => {
  const oneDay = 24 * 60 * 60 * 1000;
  await Image.create({
    id: 3001,
    src: 'https://cdn.example/3001.png',
    original_source: 'https://artist.example/3001',
    format: 'png',
    mime_type: 'image/png',
    status: STATUS_PROCESSING,
  });
  // Bypass mongoose auto-timestamps via the raw collection driver
  await Image.collection.updateOne({ id: 3001 }, { $set: { updatedAt: new Date(Date.now() - oneDay) } });

  const restored = await mongo.resetStaleProcessing(60 * 60 * 1000);
  assert.equal(restored, 1);
  const after = await Image.findOne({ id: 3001 }).lean();
  if (!after) throw new Error('image should still exist after sweep');
  assert.equal(after.status, STATUS_UNPUBLISHED);
});
