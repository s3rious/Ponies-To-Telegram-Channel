import { config, FETCH_TIMEOUT_MS, STATUS_UNPUBLISHED, type Status } from './config.ts';
import { Image } from './mongo.ts';
import { logger } from './logger.ts';
import { retry, sleep } from './retry.ts';

const GRABBING_PAGE_DELAY_MS = 500;

interface DerpibooruImageRaw {
  id: number | string;
  duplicate_of?: number | null;
  representations: { full: string };
  source_url?: string | null;
  format: string;
  mime_type: string;
}

interface DerpibooruResponse {
  images: DerpibooruImageRaw[];
}

interface ImageInsert {
  id: number;
  src: string;
  original_source: string;
  format: string;
  mime_type: string;
  status: Status;
}

class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs: number | undefined) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

class TransientHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Derpibooru responded ${status}`);
    this.name = 'TransientHttpError';
    this.status = status;
  }
}

function isStringRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseImageRaw(raw: unknown): DerpibooruImageRaw | null {
  if (!isStringRecord(raw)) return null;
  if (typeof raw.id !== 'number' && typeof raw.id !== 'string') return null;
  if (!isStringRecord(raw.representations)) return null;
  if (typeof raw.representations.full !== 'string') return null;
  if (typeof raw.format !== 'string') return null;
  if (typeof raw.mime_type !== 'string') return null;

  const source_url = typeof raw.source_url === 'string' ? raw.source_url : null;
  const duplicate_of = typeof raw.duplicate_of === 'number' ? raw.duplicate_of : null;

  return {
    id: raw.id,
    duplicate_of,
    representations: { full: raw.representations.full },
    source_url,
    format: raw.format,
    mime_type: raw.mime_type,
  };
}

function parseResponse(body: unknown): DerpibooruResponse {
  if (!isStringRecord(body) || !Array.isArray(body.images)) {
    return { images: [] };
  }
  const images: DerpibooruImageRaw[] = [];
  for (const item of body.images) {
    const parsed = parseImageRaw(item);
    if (parsed) images.push(parsed);
  }
  return { images };
}

function urlForPage(url: string, page: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set('page', `${page}`);
  return parsed.toString();
}

function httpsiseUrl(url: string): string {
  return /^http/.test(url) ? url : `https:${url}`;
}

function filterDuplicates(images: readonly DerpibooruImageRaw[]): DerpibooruImageRaw[] {
  return images.filter((image) => {
    if (image.duplicate_of) {
      logger.info(`... image ${image.id} filtered due to duplicate report...`);
      return false;
    }
    return true;
  });
}

function processResponseData(data: DerpibooruResponse, page: number): ImageInsert[] {
  const withoutDuplicates = filterDuplicates(data.images);
  logger.info(`... duplicates for page ${page} cleared...`);

  return withoutDuplicates.map((image) => ({
    id: typeof image.id === 'string' ? parseInt(image.id, 10) : image.id,
    src: httpsiseUrl(image.representations.full),
    original_source: image.source_url ? image.source_url : `https://derpibooru.org/${image.id}`,
    format: image.format,
    mime_type: image.mime_type,
    status: STATUS_UNPUBLISHED,
  }));
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = parseInt(header, 10);
  if (Number.isFinite(secs) && secs >= 0 && `${secs}` === header.trim()) return secs * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function shouldRetryGrab(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (error instanceof TransientHttpError && error.status >= 500) return true;
  return false;
}

async function grabPage(url: string, page: number): Promise<ImageInsert[]> {
  logger.info(`... grabbing page ${page}...`);
  let pendingRetryAfter: number | undefined;
  try {
    const data = await retry<DerpibooruResponse>(
      async () => {
        if (pendingRetryAfter !== undefined && pendingRetryAfter > 0) {
          const ms = pendingRetryAfter;
          pendingRetryAfter = undefined;
          logger.warn(`... honoring Retry-After: sleeping ${ms}ms before page ${page}`);
          await sleep(ms);
        }
        const res = await fetch(urlForPage(url, page), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (res.status === 429) {
          pendingRetryAfter = parseRetryAfter(res.headers.get('retry-after'));
          throw new RateLimitError(`Derpibooru rate-limited page ${page}`, pendingRetryAfter);
        }
        if (!res.ok) {
          if (res.status >= 500) throw new TransientHttpError(res.status);
          throw new Error(`Derpibooru responded ${res.status}`);
        }
        const body: unknown = await res.json();
        return parseResponse(body);
      },
      {
        attempts: 8,
        initialDelayMs: 500,
        maxDelayMs: 60_000,
        shouldRetry: shouldRetryGrab,
      },
    );
    logger.info(`... got response for page ${page}...`);
    return processResponseData(data, page);
  } catch (error) {
    logger.error(`... page ${page} abandoned after rate-limit retries:`, error);
    return [];
  }
}

async function getInfoFromPages(url: string, pagesCount: number): Promise<ImageInsert[]> {
  logger.info(`... grabbing ${pagesCount} pages from ${url}...`);
  const collected: ImageInsert[] = [];
  for (let page = 1; page <= pagesCount; page++) {
    if (page > 1) await sleep(GRABBING_PAGE_DELAY_MS);
    const result = await grabPage(url, page);
    collected.push(...result);
  }
  logger.info(`... ${pagesCount} pages from ${url} grabbed, we’ve got ${collected.length} images...`);
  return collected;
}

async function getInfo(urls: readonly string[], pagesCount: number): Promise<ImageInsert[]> {
  const all: ImageInsert[] = [];
  for (const url of urls) {
    all.push(...(await getInfoFromPages(url, pagesCount)));
  }
  return all;
}

async function saveImageIfNotExist(image: ImageInsert): Promise<boolean> {
  logger.info(`... saving ${image.id} to mongo...`);
  const existing = await Image.findOne({ id: image.id });
  if (existing) {
    logger.info(`... image ${image.id} already exists in mongo...`);
    return false;
  }
  await new Image(image).save();
  logger.info(`... image ${image.id} saved to mongo...`);
  return true;
}

async function storeImages(images: readonly ImageInsert[]): Promise<number> {
  logger.info(`... saving ${images.length} images to mongo...`);
  const results = await Promise.all(
    images.map((image) =>
      saveImageIfNotExist(image).catch((error: unknown) => {
        logger.error(`... save failed for ${image.id}:`, error);
        return false;
      }),
    ),
  );
  return results.filter(Boolean).length;
}

async function grabImages(pagesCount: number): Promise<void> {
  logger.info('New grabbing job started...');
  const images = await getInfo(config.grabbingUrls, pagesCount);
  const stored = await storeImages(images);
  logger.info(`... ${stored} new images stored!`);
}

export {
  grabImages,
  grabPage,
  getInfoFromPages,
  urlForPage,
  httpsiseUrl,
  filterDuplicates,
  processResponseData,
  parseResponse,
  parseRetryAfter,
  shouldRetryGrab,
  RateLimitError,
  TransientHttpError,
  GRABBING_PAGE_DELAY_MS,
  type DerpibooruImageRaw,
  type DerpibooruResponse,
  type ImageInsert,
};
