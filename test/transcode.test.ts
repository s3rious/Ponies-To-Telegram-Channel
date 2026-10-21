import './_env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMp4Args,
  buildResizeArgs,
  RESIZE_ATTEMPTS,
  VIDEO_ATTEMPTS,
  MAX_VIDEO_BYTES,
} from '../src/transcode.ts';

test('buildMp4Args attempt 0 without audio strips audio and normalizes SAR', () => {
  const args = buildMp4Args('/in.webm', '/out.mp4', 0, false);
  const first = VIDEO_ATTEMPTS[0];
  if (!first) throw new Error('VIDEO_ATTEMPTS should have at least one entry');
  assert.deepEqual(args, [
    '-i', '/in.webm',
    '-vf', `scale=trunc(iw*sar/2)*2:ih,setsar=1,scale='min(${first.scale},iw)':-2`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', `${first.crf}`,
    '-movflags', '+faststart',
    '-an',
    '-y', '/out.mp4',
  ]);
});

test('buildMp4Args re-encodes audio to AAC when the source has sound', () => {
  const args = buildMp4Args('/in.webm', '/out.mp4', 0, true);
  assert.ok(args.includes('-c:a'), 'should map an audio codec');
  const codecIndex = args.indexOf('-c:a');
  assert.equal(args[codecIndex + 1], 'aac');
  assert.ok(args.includes('-b:a'), 'should set an audio bitrate');
  assert.equal(args[args.indexOf('-b:a') + 1], '128k');
  assert.ok(!args.includes('-an'), 'should not strip audio when sound is present');
});

test('buildMp4Args steps down on subsequent attempts (lower scale, higher CRF)', () => {
  const a0 = buildMp4Args('/in.webm', '/out.mp4', 0, false);
  const a1 = buildMp4Args('/in.webm', '/out.mp4', 1, false);
  assert.notDeepEqual(a0, a1, 'attempt 1 should differ from attempt 0');
  const last = VIDEO_ATTEMPTS[VIDEO_ATTEMPTS.length - 1];
  if (!last) throw new Error('VIDEO_ATTEMPTS should have entries');
  const overflow = buildMp4Args('/in.webm', '/out.mp4', VIDEO_ATTEMPTS.length + 99, false);
  assert.deepEqual(overflow, a1, 'attempt beyond list clamps to last step');
});

test('MAX_VIDEO_BYTES matches Telegram cloud Bot API sendVideo limit (50 MB)', () => {
  assert.equal(MAX_VIDEO_BYTES, 50 * 1024 * 1024);
});

test('buildResizeArgs picks the widest step on attempt 0', () => {
  const args = buildResizeArgs('/in.png', '/out.jpg', 0);
  const first = RESIZE_ATTEMPTS[0];
  if (!first) throw new Error('RESIZE_ATTEMPTS should have at least one entry');
  assert.deepEqual(args, [
    '-i', '/in.png',
    '-vf', `scale='min(${first.width},iw)':-2`,
    '-q:v', `${first.quality}`,
    '-y', '/out.jpg',
  ]);
});

test('buildResizeArgs steps down on subsequent attempts', () => {
  const a0 = buildResizeArgs('/in.png', '/out.jpg', 0);
  const a1 = buildResizeArgs('/in.png', '/out.jpg', 1);
  assert.notDeepEqual(a0, a1, 'attempt 1 should differ from attempt 0');
});

test('buildResizeArgs clamps to the last step when attempt exceeds list length', () => {
  const last = buildResizeArgs('/in.png', '/out.jpg', RESIZE_ATTEMPTS.length - 1);
  const overflow = buildResizeArgs('/in.png', '/out.jpg', RESIZE_ATTEMPTS.length + 99);
  assert.deepEqual(overflow, last);
});

