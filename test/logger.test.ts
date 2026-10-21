import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '../src/logger.ts';

async function waitForFile(path: string, timeoutMs = 500): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const content = await readFile(path, 'utf8');
      if (content.length > 0) return content;
    } catch {
      // file may not exist yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${path}`);
    await new Promise<void>((r) => { setTimeout(r, 20); });
  }
}

test('logger writes ISO timestamp + level + message to file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logger-'));
  const file = join(dir, 'verbose.log');
  try {
    const logger = createLogger(file);
    logger.info('hello world');
    const content = await waitForFile(file);
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO: hello world\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('logger error writes ERROR level and stack', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'logger-'));
  const file = join(dir, 'verbose.log');
  try {
    const logger = createLogger(file);
    logger.error('boom:', new Error('kapow'));
    const content = await waitForFile(file);
    assert.match(content, /ERROR: boom: Error: kapow/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('logger survives unwritable file path (does not throw)', () => {
  const logger = createLogger('/proc/this-cannot-be-written/log');
  assert.doesNotThrow(() => {
    logger.info('still alive');
  });
});
