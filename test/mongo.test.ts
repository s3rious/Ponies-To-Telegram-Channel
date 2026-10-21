import './_env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Image, buildStaleProcessingQuery, buildCleanupQuery } from '../src/mongo.ts';
import { ALL_STATUSES, STATUS_PROCESSING, STATUS_UNPUBLISHED } from '../src/config.ts';

test('Image schema enforces known status enum', () => {
  const path = Image.schema.path('status');
  const enums: unknown = path.options.enum;
  if (!Array.isArray(enums)) throw new Error('expected status enum to be an array on the schema');
  const got: string[] = enums.filter((v): v is string => typeof v === 'string').sort();
  const want = [...ALL_STATUSES].sort();
  assert.deepEqual(got, want);
});

test('buildStaleProcessingQuery selects PROCESSING items older than cutoff', () => {
  const now = Date.UTC(2026, 4, 27, 12, 0, 0);
  const oneHour = 60 * 60 * 1000;
  const q = buildStaleProcessingQuery(oneHour, now);
  assert.equal(q.filter.status, STATUS_PROCESSING);
  assert.equal(q.filter.updatedAt.$lt.getTime(), now - oneHour);
  assert.equal(q.update.$set.status, STATUS_UNPUBLISHED);
});

test('buildCleanupQuery selects images with createdAt older than cutoff', () => {
  const now = Date.UTC(2026, 4, 27, 12, 0, 0);
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const q = buildCleanupQuery(oneYear, now);
  assert.equal(q.filter.createdAt.$lt.getTime(), now - oneYear);
});
