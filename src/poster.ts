import { writeFile, unlink, mkdir, stat } from 'node:fs/promises';
import { config, FETCH_TIMEOUT_MS, MAX_POSTING_ATTEMPTS, STATUS_POSTED, STATUS_PROCESSING, STATUS_UNPUBLISHED, STATUS_ERROR } from './config.ts';
import { Image, type ImageHydrated } from './mongo.ts';
import { logger } from './logger.ts';
import { retry } from './retry.ts';
import { sendMessage, sendPhoto, sendVideo } from './telegram.ts';
import { toMp4, toResizedJpeg } from './transcode.ts';

const TMP_DIR = process.env.TMP_DIR ?? '/app/tmp';
const CHANNEL = `@${config.telegramChannelName}`;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

let inFlight = 0;
const drainWaiters: (() => void)[] = [];
let cycleRunning = false;

function isAnimated(mime_type: string): boolean {
  return mime_type === 'image/gif' || mime_type.startsWith('video/');
}

function isStill(mime_type: string): boolean {
  return mime_type.startsWith('image/');
}

function isTelegramNativeStill(mime_type: string): boolean {
  return mime_type === 'image/jpeg' || mime_type === 'image/jpg' || mime_type === 'image/png';
}

async function markImageError(image: ImageHydrated): Promise<void> {
  const nextCount = image.error_count + 1;
  image.error_count = nextCount;
  image.status = nextCount >= MAX_POSTING_ATTEMPTS ? STATUS_ERROR : STATUS_UNPUBLISHED;
  await image.save();
  logger.info(`... image ${image.id}: error #${nextCount} (status=${image.status})`);
}

async function downloadImage(image: ImageHydrated): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  const path = `${TMP_DIR}/${image.id}.${image.format}`;
  logger.info(`... downloading image ${image.id}...`);

  const buf = await retry(
    async () => {
      const res = await fetch(image.src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`download ${image.src} responded ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    { attempts: 3, initialDelayMs: 1000 },
  );
  await writeFile(path, buf);
  logger.info(`... image ${image.id} downloaded...`);
  return path;
}

async function sendStill(image: ImageHydrated, inputPath: string, mime_type: string, extraTempPaths: string[]): Promise<number> {
  const { size } = await stat(inputPath);
  if (isTelegramNativeStill(mime_type) && size <= MAX_PHOTO_BYTES) {
    const sent = await sendPhoto({ chatId: CHANNEL, photo: { source: inputPath }, caption: image.original_source });
    return sent.message_id;
  }
  const outputPath = `${TMP_DIR}/${image.id}.jpg`;
  extraTempPaths.push(outputPath);
  await toResizedJpeg(inputPath, outputPath, { maxBytes: MAX_PHOTO_BYTES });
  const sent = await sendPhoto({ chatId: CHANNEL, photo: { source: outputPath }, caption: image.original_source });
  return sent.message_id;
}

async function sendAnimated(image: ImageHydrated, inputPath: string, extraTempPaths: string[]): Promise<number> {
  const outputPath = `${TMP_DIR}/${image.id}.mp4`;
  extraTempPaths.push(outputPath);
  await toMp4(inputPath, outputPath);
  const sent = await sendVideo({ chatId: CHANNEL, video: { source: outputPath } });
  await sendMessage({
    chatId: CHANNEL,
    text: image.original_source,
    replyToMessageId: sent.message_id,
    disableWebPagePreview: true,
  });
  return sent.message_id;
}

async function sendImageToChannel(image: ImageHydrated, inputPath: string, extraTempPaths: string[]): Promise<number> {
  const { mime_type } = image;
  logger.info(`... posting ${image.id} (mime_type=${mime_type}) to ${CHANNEL}...`);
  if (isAnimated(mime_type)) {
    const messageId = await sendAnimated(image, inputPath, extraTempPaths);
    logger.info(`... ${image.id} posted to ${CHANNEL}`);
    return messageId;
  }
  // image/svg+xml falls through here too: Derpibooru's `representations.full`
  // returns a rasterized PNG for SVG sources, and isTelegramNativeStill rejects
  // image/svg+xml so sendStill routes it through toResizedJpeg.
  if (isStill(mime_type)) {
    const messageId = await sendStill(image, inputPath, mime_type, extraTempPaths);
    logger.info(`... ${image.id} posted to ${CHANNEL}`);
    return messageId;
  }
  throw new Error(`unsupported mime_type: ${mime_type}`);
}

async function deleteTempFile(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
    logger.info(`... ${tempPath} deleted`);
  } catch (error) {
    logger.warn(`... could not delete ${tempPath}:`, error);
  }
}

async function claimNextImage(excludeIds: readonly number[] = []): Promise<ImageHydrated | null> {
  const filter = excludeIds.length > 0
    ? { status: STATUS_UNPUBLISHED, id: { $nin: excludeIds } }
    : { status: STATUS_UNPUBLISHED };
  return Image.findOneAndUpdate(
    filter,
    { $set: { status: STATUS_PROCESSING } },
    { sort: { id: -1 }, new: true },
  );
}

async function postImage(image: ImageHydrated): Promise<boolean> {
  logger.info(`... posting image ${image.id}...`);
  inFlight += 1;
  let downloadedPath: string | null = null;
  const extraTempPaths: string[] = [];
  let succeeded = false;
  try {
    downloadedPath = await downloadImage(image);
    const messageId = await sendImageToChannel(image, downloadedPath, extraTempPaths);
    image.posted_message_id = messageId;
    image.posted_at = new Date();
    image.status = STATUS_POSTED;
    await image.save();
    logger.info(`... ${image.id} posted`);
    succeeded = true;
  } catch (error) {
    logger.error(`... posting ${image.id} failed:`, error);
    try {
      await markImageError(image);
    } catch (saveError) {
      logger.error(`... failed to mark ${image.id} as error:`, saveError);
    }
  } finally {
    if (downloadedPath) await deleteTempFile(downloadedPath);
    for (const tempPath of extraTempPaths) await deleteTempFile(tempPath);
    inFlight -= 1;
    if (inFlight === 0) {
      for (const resolve of drainWaiters.splice(0)) resolve();
    }
  }
  return succeeded;
}

async function postImages(): Promise<void> {
  if (cycleRunning) {
    logger.info('skipping posting tick: previous cycle still running');
    return;
  }
  cycleRunning = true;
  try {
    logger.info('New posting job started...');
    const total = await Image.countDocuments({ status: STATUS_UNPUBLISHED });
    if (total === 0) {
      logger.info('... nothing to post...');
      return;
    }
    const postNow = Math.max(5, Math.ceil(total / 10));
    logger.info(`... will post up to ${postNow} of ${total} unposted...`);

    let attempted = 0;
    let succeeded = 0;
    // Track ids attempted in this cycle. Without per-image backoff, the claim
    // would otherwise re-pick a just-errored image and burn the 3-strike cap in
    // a single tick instead of spreading retries across ticks.
    const attemptedIds: number[] = [];
    while (attempted < postNow) {
      const image = await claimNextImage(attemptedIds);
      if (!image) break;
      attemptedIds.push(Number(image.id));
      attempted += 1;
      if (await postImage(image)) succeeded += 1;
    }
    logger.info(`posting: attempted ${attempted}, succeeded ${succeeded}`);
  } finally {
    cycleRunning = false;
  }
}

async function drainInFlight(timeoutMs: number): Promise<void> {
  if (inFlight === 0) return;
  await new Promise<void>((resolve) => {
    drainWaiters.push(resolve);
    setTimeout(resolve, timeoutMs);
  });
}

export {
  postImages,
  postImage,
  claimNextImage,
  drainInFlight,
  isAnimated,
  isStill,
  isTelegramNativeStill,
  MAX_PHOTO_BYTES,
};
