import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retry, retryForever } from '../src/retry.ts';

test('retry: resolves on first success', async () => {
  let calls = 0;
  const out = await retry(async () => {
    await Promise.resolve();
    calls += 1;
    return 'ok';
  }, { attempts: 3, initialDelayMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(calls, 1);
});

test('retry: retries on transient errors and resolves', async () => {
  let calls = 0;
  const out = await retry(async () => {
    await Promise.resolve();
    calls += 1;
    if (calls < 3) throw new Error('transient');
    return 'ok';
  }, { attempts: 5, initialDelayMs: 1 });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('retry: throws after exhausting attempts', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      await Promise.resolve();
      calls += 1;
      throw new Error('always');
    }, { attempts: 3, initialDelayMs: 1 }),
    /always/,
  );
  assert.equal(calls, 3);
});

test('retry: shouldRetry=false stops immediately', async () => {
  let calls = 0;
  await assert.rejects(
    retry(async () => {
      await Promise.resolve();
      calls += 1;
      throw new Error('hard');
    }, { attempts: 5, initialDelayMs: 1, shouldRetry: () => false }),
    /hard/,
  );
  assert.equal(calls, 1);
});

test('retryForever: keeps retrying until success', async () => {
  let calls = 0;
  const out = await retryForever(async () => {
    await Promise.resolve();
    calls += 1;
    if (calls < 4) throw new Error('not yet');
    return 'finally';
  }, { initialDelayMs: 1, maxDelayMs: 5 });
  assert.equal(out, 'finally');
  assert.equal(calls, 4);
});
