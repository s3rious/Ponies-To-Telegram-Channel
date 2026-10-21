import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { FFMPEG_TIMEOUT_MS, FFPROBE_TIMEOUT_MS } from './config.ts';
import { logger } from './logger.ts';

const RESIZE_ATTEMPTS: readonly { width: number; quality: number }[] = [
  { width: 2560, quality: 4 },
  { width: 1920, quality: 8 },
];

const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const VIDEO_ATTEMPTS: readonly { scale: number; crf: number }[] = [
  { scale: 1080, crf: 23 },
  { scale: 720, crf: 28 },
];

interface ResizeOptions {
  maxBytes: number;
}

interface Transcoder {
  toMp4: (input: string, output: string) => Promise<void>;
  toResizedJpeg: (input: string, output: string, opts: ResizeOptions) => Promise<void>;
}

function buildMp4Args(input: string, output: string, attempt: number, hasAudio: boolean): readonly string[] {
  const idx = Math.min(attempt, VIDEO_ATTEMPTS.length - 1);
  const step = VIDEO_ATTEMPTS[idx];
  if (!step) throw new Error(`buildMp4Args: no video step for attempt ${attempt}`);
  const audioArgs = hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an'];
  return [
    '-i', input,
    '-vf', `scale=trunc(iw*sar/2)*2:ih,setsar=1,scale='min(${step.scale},iw)':-2`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', `${step.crf}`,
    '-movflags', '+faststart',
    ...audioArgs,
    '-y', output,
  ];
}

function buildResizeArgs(input: string, output: string, attempt: number): readonly string[] {
  const idx = Math.min(attempt, RESIZE_ATTEMPTS.length - 1);
  const step = RESIZE_ATTEMPTS[idx];
  if (!step) throw new Error(`buildResizeArgs: no resize step for attempt ${attempt}`);
  return [
    '-i', input,
    '-vf', `scale='min(${step.width},iw)':-2`,
    '-q:v', `${step.quality}`,
    '-y', output,
  ];
}

async function runProcess(bin: string, args: readonly string[], timeoutMs: number = FFMPEG_TIMEOUT_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args);
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = Buffer.concat(stderrChunks).toString('utf-8').split('\n').slice(-10).join('\n');
      const reason = code === null ? 'killed (signal)' : `exited with code ${code}`;
      reject(new Error(`${bin} ${reason}: ${tail}`));
    });
  });
}

async function captureStdout(bin: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(bin, args);
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(killTimer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString('utf-8'));
        return;
      }
      const tail = Buffer.concat(stderrChunks).toString('utf-8').split('\n').slice(-10).join('\n');
      const reason = code === null ? 'killed (signal)' : `exited with code ${code}`;
      reject(new Error(`${bin} ${reason}: ${tail}`));
    });
  });
}

async function probeHasAudio(input: string): Promise<boolean> {
  const stdout = await captureStdout('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=codec_type',
    '-of', 'default=nw=1:nk=1',
    input,
  ], FFPROBE_TIMEOUT_MS);
  return stdout.trim().length > 0;
}

async function realToMp4(input: string, output: string): Promise<void> {
  const hasAudio = await probeHasAudio(input);
  for (let attempt = 0; attempt < VIDEO_ATTEMPTS.length; attempt += 1) {
    logger.info(`... transcoding ${input} -> ${output} (mp4, attempt ${attempt + 1}, audio=${hasAudio})`);
    await runProcess('ffmpeg', buildMp4Args(input, output, attempt, hasAudio));
    const { size } = await stat(output);
    if (size <= MAX_VIDEO_BYTES) return;
    logger.warn(`... ${output} still ${size}b > ${MAX_VIDEO_BYTES}b after attempt ${attempt + 1}`);
  }
  throw new Error(`could not encode ${input} below ${MAX_VIDEO_BYTES} bytes`);
}

async function realToResizedJpeg(input: string, output: string, opts: ResizeOptions): Promise<void> {
  for (let attempt = 0; attempt < RESIZE_ATTEMPTS.length; attempt += 1) {
    logger.info(`... resizing ${input} -> ${output} (jpeg, attempt ${attempt + 1})`);
    await runProcess('ffmpeg', buildResizeArgs(input, output, attempt));
    const { size } = await stat(output);
    if (size <= opts.maxBytes) return;
    logger.warn(`... ${output} still ${size}b > ${opts.maxBytes}b after attempt ${attempt + 1}`);
  }
  throw new Error(`could not resize ${input} below ${opts.maxBytes} bytes`);
}

let active: Transcoder = {
  toMp4: realToMp4,
  toResizedJpeg: realToResizedJpeg,
};

function setTranscoder(next: Transcoder): Transcoder {
  const prev = active;
  active = next;
  return prev;
}

async function toMp4(input: string, output: string): Promise<void> {
  return active.toMp4(input, output);
}

async function toResizedJpeg(input: string, output: string, opts: ResizeOptions): Promise<void> {
  return active.toResizedJpeg(input, output, opts);
}

export {
  toMp4,
  toResizedJpeg,
  setTranscoder,
  buildMp4Args,
  buildResizeArgs,
  runProcess,
  RESIZE_ATTEMPTS,
  VIDEO_ATTEMPTS,
  MAX_VIDEO_BYTES,
  type ResizeOptions,
  type Transcoder,
};
