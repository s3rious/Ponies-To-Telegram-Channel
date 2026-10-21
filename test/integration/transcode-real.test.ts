// Real-ffmpeg integration coverage for src/transcode.ts.
// Generates input fixtures with ffmpeg, then exercises the project's helpers
// against the real binary. Skipped when ffmpeg is not on PATH.

import '../_env.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { stat, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toMp4, toResizedJpeg, runProcess } from '../../src/transcode.ts';

const FIXTURE_DIR = await mkdtemp(join(tmpdir(), 'derpi-transcode-real-'));

function commandExists(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('which', [bin]);
    child.on('close', (code) => { resolve(code === 0); });
    child.on('error', () => { resolve(false); });
  });
}

async function runFfmpeg(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = Buffer.concat(stderrChunks).toString('utf-8').split('\n').slice(-5).join('\n');
      reject(new Error(`ffmpeg ${args.join(' ')} failed (${code}): ${tail}`));
    });
    child.on('error', reject);
  });
}

async function runFfprobe(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('ffprobe', args);
    const stdoutChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk); });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
        return;
      }
      reject(new Error(`ffprobe ${args.join(' ')} failed (${code})`));
    });
    child.on('error', reject);
  });
}

function probeAudioCodecType(file: string): Promise<string> {
  return runFfprobe([
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_type',
    '-of', 'default=nw=1:nk=1',
    file,
  ]).then((stdout) => stdout.trim());
}

function probeSar(file: string): Promise<string> {
  return runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=sample_aspect_ratio',
    '-of', 'default=nw=1:nk=1',
    file,
  ]).then((stdout) => stdout.trim());
}

const ffmpegAvailable = await commandExists('ffmpeg') && await commandExists('ffprobe');
const skipReason = ffmpegAvailable ? undefined : 'ffmpeg/ffprobe not on PATH';

before(async () => {
  if (!ffmpegAvailable) return;
  // 1-second, 24-frame red GIF — stands in for any animated source.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1:r=24',
    '-frames:v', '24',
    '-y', join(FIXTURE_DIR, 'in.gif'),
  ]);
  // Single 256x256 blue PNG — stands in for a still source.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=256x256:d=1',
    '-frames:v', '1',
    '-y', join(FIXTURE_DIR, 'in.png'),
  ]);
  // 1-second clip carrying a 1 kHz tone — stands in for a video with sound.
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=1:r=24',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-y', join(FIXTURE_DIR, 'in-audio.mp4'),
  ]);
  // Anamorphic source: 64x32 storage with sample aspect ratio 2:1 (non-square pixels).
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=orange:s=64x32:d=1:r=24',
    '-frames:v', '24',
    '-vf', 'setsar=2/1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-y', join(FIXTURE_DIR, 'in-anamorphic.mp4'),
  ]);
});

after(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

test('real toMp4: gif input produces a valid mp4 (ftyp box, libx264/yuv420p)', { skip: skipReason }, async () => {
  const input = join(FIXTURE_DIR, 'in.gif');
  const output = join(FIXTURE_DIR, 'out.mp4');
  await toMp4(input, output);
  const { size } = await stat(output);
  assert.ok(size > 0, 'output mp4 should be non-empty');
  // ISO base media: bytes 4..8 = 'ftyp'
  const header = await readFile(output);
  assert.equal(header.subarray(4, 8).toString('latin1'), 'ftyp', 'output should be an ISO base media (mp4) file');
});

test('real toMp4: silent source produces an mp4 with no audio stream', { skip: skipReason }, async () => {
  const input = join(FIXTURE_DIR, 'in.gif');
  const output = join(FIXTURE_DIR, 'out-silent.mp4');
  await toMp4(input, output);
  const codecType = await probeAudioCodecType(output);
  assert.equal(codecType, '', 'silent source must not gain an audio stream');
});

test('real toMp4: source with sound keeps an aac audio stream', { skip: skipReason }, async () => {
  const input = join(FIXTURE_DIR, 'in-audio.mp4');
  const output = join(FIXTURE_DIR, 'out-audio.mp4');
  await toMp4(input, output);
  const codecType = await probeAudioCodecType(output);
  assert.equal(codecType, 'audio', 'source with sound must keep its audio stream');
});

test('real toMp4: anamorphic source is normalized to square pixels (SAR 1:1)', { skip: skipReason }, async () => {
  const input = join(FIXTURE_DIR, 'in-anamorphic.mp4');
  const output = join(FIXTURE_DIR, 'out-anamorphic.mp4');
  await toMp4(input, output);
  const sampleAspectRatio = await probeSar(output);
  assert.equal(sampleAspectRatio, '1:1', 'output should have square pixels so Telegram renders it undistorted');
});

test('real toResizedJpeg: png input produces a JPEG under the byte cap', { skip: skipReason }, async () => {
  const input = join(FIXTURE_DIR, 'in.png');
  const output = join(FIXTURE_DIR, 'out.jpg');
  const maxBytes = 64 * 1024;
  await toResizedJpeg(input, output, { maxBytes });
  const { size } = await stat(output);
  assert.ok(size > 0 && size <= maxBytes, `output jpeg should be <= ${maxBytes}b, got ${size}b`);
  // JPEG magic: FF D8 FF
  const header = await readFile(output);
  assert.equal(header[0], 0xFF);
  assert.equal(header[1], 0xD8);
  assert.equal(header[2], 0xFF);
});

test('runProcess: kills the child after the configured timeout', async () => {
  const haveSleep = await commandExists('sleep');
  if (!haveSleep) {
    return; // skip silently — `sleep` is universal on alpine/macOS but defensive
  }
  const start = Date.now();
  await assert.rejects(
    () => runProcess('sleep', ['10'], 250),
    /timed out/,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `timeout should fire fast, took ${elapsed}ms`);
});

test('real toResizedJpeg: throws when target byte cap is impossible', { skip: skipReason }, async () => {
  const input = join(FIXTURE_DIR, 'in.png');
  const output = join(FIXTURE_DIR, 'out-tiny.jpg');
  // A 4-byte cap is unreachable — even the JPEG header is bigger.
  await assert.rejects(
    () => toResizedJpeg(input, output, { maxBytes: 4 }),
    /could not resize/,
  );
});
