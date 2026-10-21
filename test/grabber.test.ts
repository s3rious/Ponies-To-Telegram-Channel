import './_env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  urlForPage,
  httpsiseUrl,
  filterDuplicates,
  processResponseData,
  parseResponse,
  parseRetryAfter,
  shouldRetryGrab,
  RateLimitError,
  TransientHttpError,
  grabPage,
  getInfoFromPages,
  GRABBING_PAGE_DELAY_MS,
  type DerpibooruImageRaw,
  type DerpibooruResponse,
} from '../src/grabber.ts';
import { STATUS_UNPUBLISHED } from '../src/config.ts';

function rawImage(overrides: Partial<DerpibooruImageRaw> & Pick<DerpibooruImageRaw, 'id'>): DerpibooruImageRaw {
  return {
    representations: { full: '//cdn/x.png' },
    format: 'png',
    mime_type: 'image/png',
    ...overrides,
  };
}

test('urlForPage appends page param when query string exists', () => {
  assert.equal(urlForPage('https://x.test/?q=a', 3), 'https://x.test/?q=a&page=3');
});

test('urlForPage adds the query string when the URL has none', () => {
  assert.equal(urlForPage('https://x.test/', 3), 'https://x.test/?page=3');
});

test('urlForPage overwrites existing page param instead of duplicating', () => {
  assert.equal(urlForPage('https://x.test/?q=a&page=1', 7), 'https://x.test/?q=a&page=7');
});

test('httpsiseUrl prepends https: to protocol-relative URLs', () => {
  assert.equal(httpsiseUrl('//images.test/x.png'), 'https://images.test/x.png');
});

test('httpsiseUrl leaves http/https URLs alone', () => {
  assert.equal(httpsiseUrl('https://x.test/y'), 'https://x.test/y');
  assert.equal(httpsiseUrl('http://x.test/y'), 'http://x.test/y');
});

test('filterDuplicates drops images with a duplicate_of pointer', () => {
  const input: DerpibooruImageRaw[] = [
    rawImage({ id: 1 }),
    rawImage({ id: 2, duplicate_of: 1 }),
    rawImage({ id: 3 }),
  ];
  const out = filterDuplicates(input);
  assert.deepEqual(out.map((i) => i.id), [1, 3]);
});

test('processResponseData maps Derpibooru shape into ImageInsert', () => {
  const response: DerpibooruResponse = {
    images: [
      rawImage({
        id: '42',
        representations: { full: '//cdn/x.png' },
        source_url: 'https://artist.test/work',
      }),
      rawImage({
        id: 43,
        representations: { full: '//cdn/y.gif' },
        source_url: null,
        format: 'gif',
        mime_type: 'image/gif',
      }),
    ],
  };
  const out = processResponseData(response, 1);
  assert.equal(out.length, 2);
  const first = out[0];
  const second = out[1];
  if (!first || !second) throw new Error('expected two results');
  assert.equal(first.id, 42);
  assert.equal(first.src, 'https://cdn/x.png');
  assert.equal(first.original_source, 'https://artist.test/work');
  assert.equal(first.status, STATUS_UNPUBLISHED);
  assert.equal(second.original_source, 'https://derpibooru.org/43');
});

test('parseResponse rejects malformed payloads gracefully', () => {
  assert.deepEqual(parseResponse(null), { images: [] });
  assert.deepEqual(parseResponse({ images: 'not an array' }), { images: [] });
  assert.deepEqual(
    parseResponse({ images: [{ id: 1, representations: { full: '//x' }, format: 'png', mime_type: 'image/png' }] }).images.length,
    1,
  );
});

test('config parses GRABBING_URLS as comma-separated trimmed list', async () => {
  const { config } = await import('../src/config.ts');
  assert.deepEqual(config.grabbingUrls, [
    'https://example.com/api?q=test',
    'https://example.com/api?q=test2',
  ]);
});

test('parseRetryAfter handles seconds, http-date, and missing values', () => {
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter('garbage'), undefined);
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter('0'), 0);
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfter(future);
  assert.ok(ms !== undefined && ms > 5_000 && ms <= 10_000, `expected ~10s, got ${ms}`);
  const past = new Date(Date.now() - 10_000).toUTCString();
  assert.equal(parseRetryAfter(past), 0);
});

test('shouldRetryGrab retries RateLimitError and TransientHttpError 5xx only', () => {
  assert.equal(shouldRetryGrab(new RateLimitError('x', 1000)), true);
  assert.equal(shouldRetryGrab(new TransientHttpError(503)), true);
  assert.equal(shouldRetryGrab(new TransientHttpError(500)), true);
  assert.equal(shouldRetryGrab(new TransientHttpError(499)), false);
  assert.equal(shouldRetryGrab(new Error('Derpibooru responded 503')), false, 'plain Error no longer retried — must be TransientHttpError');
  assert.equal(shouldRetryGrab(new Error('Derpibooru responded 404')), false);
  assert.equal(shouldRetryGrab(new Error('some other error')), false);
  assert.equal(shouldRetryGrab('not even an error'), false);
});

test('TransientHttpError carries status and a stable name', () => {
  const error = new TransientHttpError(502);
  assert.equal(error.name, 'TransientHttpError');
  assert.equal(error.status, 502);
  assert.ok(error instanceof Error);
});

test('RateLimitError carries retryAfterMs and a stable name', () => {
  const error = new RateLimitError('rate limited', 4000);
  assert.equal(error.name, 'RateLimitError');
  assert.equal(error.retryAfterMs, 4000);
  assert.ok(error instanceof Error);
});

interface FetchPlanEntry {
  status: number;
  retryAfter?: string;
  body?: unknown;
}

function installFetchPlan(plan: FetchPlanEntry[]): { calls: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  let i = 0;
  const mock: typeof fetch = async (input) => {
    await Promise.resolve();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const entry = plan[Math.min(i, plan.length - 1)];
    i += 1;
    if (!entry) throw new Error('fetch plan exhausted');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (entry.retryAfter !== undefined) headers['retry-after'] = entry.retryAfter;
    return new Response(JSON.stringify(entry.body ?? { images: [] }), { status: entry.status, headers });
  };
  globalThis.fetch = mock;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('grabPage retries 429 with Retry-After and returns parsed images on success', async () => {
  const { calls, restore } = installFetchPlan([
    { status: 429, retryAfter: '0' },
    { status: 429, retryAfter: '0' },
    {
      status: 200,
      body: {
        images: [
          { id: 7001, representations: { full: '//cdn/7001.png' }, source_url: 'https://artist/7001', format: 'png', mime_type: 'image/png' },
        ],
      },
    },
  ]);
  try {
    const out = await grabPage('https://derpi.example/api?q=x', 1);
    assert.equal(calls.length, 3, '429, 429, 200 — three fetches');
    assert.equal(out.length, 1);
    const [first] = out;
    if (!first) throw new Error('expected one image');
    assert.equal(first.id, 7001);
  } finally {
    restore();
  }
});

test('grabPage returns [] on 404 (non-retryable) without retries', async () => {
  const { calls, restore } = installFetchPlan([{ status: 404 }]);
  try {
    const out = await grabPage('https://derpi.example/api?q=x', 1);
    assert.equal(calls.length, 1, '404 is not retryable');
    assert.deepEqual(out, []);
  } finally {
    restore();
  }
});

test('getInfoFromPages waits between pages (timing >= delay * (pages - 1))', async () => {
  const { restore } = installFetchPlan([
    { status: 200, body: { images: [] } },
    { status: 200, body: { images: [] } },
    { status: 200, body: { images: [] } },
  ]);
  try {
    const start = Date.now();
    await getInfoFromPages('https://derpi.example/api?q=x', 3);
    const elapsed = Date.now() - start;
    assert.ok(
      elapsed >= GRABBING_PAGE_DELAY_MS * 2,
      `expected >= ${GRABBING_PAGE_DELAY_MS * 2}ms between 3 pages, got ${elapsed}ms`,
    );
  } finally {
    restore();
  }
});

test('grabPage retries 5xx via TransientHttpError and resolves on eventual success', async () => {
  const { calls, restore } = installFetchPlan([
    { status: 503 },
    { status: 502 },
    {
      status: 200,
      body: {
        images: [
          { id: 7100, representations: { full: '//cdn/7100.png' }, source_url: null, format: 'png', mime_type: 'image/png' },
        ],
      },
    },
  ]);
  try {
    const out = await grabPage('https://derpi.example/api?q=x', 1);
    assert.equal(calls.length, 3, '503, 502, 200 — three fetches');
    assert.equal(out.length, 1);
    const [first] = out;
    if (!first) throw new Error('expected one image');
    assert.equal(first.id, 7100);
  } finally {
    restore();
  }
});

test('grabPage retries 429 without Retry-After header (falls back to retry backoff)', async () => {
  const { calls, restore } = installFetchPlan([
    { status: 429 },
    { status: 200, body: { images: [] } },
  ]);
  try {
    const out = await grabPage('https://derpi.example/api?q=x', 1);
    assert.equal(calls.length, 2, '429 with no Retry-After still retries');
    assert.deepEqual(out, []);
  } finally {
    restore();
  }
});

