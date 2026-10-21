import './_env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAnimated,
  isStill,
  isTelegramNativeStill,
  MAX_PHOTO_BYTES,
} from '../src/poster.ts';

test('isAnimated covers gif and every video/*', () => {
  assert.equal(isAnimated('image/gif'), true);
  assert.equal(isAnimated('video/webm'), true);
  assert.equal(isAnimated('video/mp4'), true);
  assert.equal(isAnimated('video/quicktime'), true);
  assert.equal(isAnimated('image/png'), false);
  assert.equal(isAnimated('image/jpeg'), false);
  assert.equal(isAnimated('image/svg+xml'), false);
  assert.equal(isAnimated('application/octet-stream'), false);
});

test('isStill matches any image/* mime_type', () => {
  assert.equal(isStill('image/png'), true);
  assert.equal(isStill('image/jpeg'), true);
  assert.equal(isStill('image/gif'), true);
  assert.equal(isStill('image/svg+xml'), true);
  assert.equal(isStill('image/webp'), true);
  assert.equal(isStill('image/heif'), true);
  assert.equal(isStill('image/avif'), true);
  assert.equal(isStill('image/tiff'), true);
  assert.equal(isStill('video/webm'), false);
  assert.equal(isStill('application/octet-stream'), false);
});

test('isTelegramNativeStill is the narrow allowlist (jpeg/jpg/png only)', () => {
  assert.equal(isTelegramNativeStill('image/jpeg'), true);
  assert.equal(isTelegramNativeStill('image/jpg'), true);
  assert.equal(isTelegramNativeStill('image/png'), true);
  assert.equal(isTelegramNativeStill('image/webp'), false);
  assert.equal(isTelegramNativeStill('image/avif'), false);
  assert.equal(isTelegramNativeStill('image/heif'), false);
  assert.equal(isTelegramNativeStill('image/tiff'), false);
  assert.equal(isTelegramNativeStill('image/svg+xml'), false);
  assert.equal(isTelegramNativeStill('image/gif'), false);
});

test('MAX_PHOTO_BYTES matches Telegram photo upload limit (10 MB)', () => {
  assert.equal(MAX_PHOTO_BYTES, 10 * 1024 * 1024);
});
