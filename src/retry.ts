import { logger } from './logger.ts';

interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
  onAttempt?: (attempt: number, error: unknown, nextDelayMs: number) => void;
}

interface RetryForeverOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  onAttempt?: (attempt: number, error: unknown, nextDelayMs: number) => void;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((r) => {
  setTimeout(r, ms);
});

async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const factor = opts.factor ?? 2;
  const initial = opts.initialDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const shouldRetry = opts.shouldRetry ?? ((): boolean => true);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !shouldRetry(error)) break;
      const delay = Math.min(max, initial * Math.pow(factor, attempt - 1));
      opts.onAttempt?.(attempt, error, delay);
      logger.warn(`retry: attempt ${attempt}/${attempts} failed, sleeping ${delay}ms:`, error);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Loops forever with exponential backoff. Used for Mongo connect — we never want to give up.
 */
async function retryForever<T>(fn: () => Promise<T>, opts: RetryForeverOptions = {}): Promise<T> {
  const factor = opts.factor ?? 2;
  const initial = opts.initialDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const delay = Math.min(max, initial * Math.pow(factor, attempt - 1));
      opts.onAttempt?.(attempt, error, delay);
      logger.warn(`retryForever: attempt ${attempt} failed, sleeping ${delay}ms:`, error);
      await sleep(delay);
    }
  }
}

export { retry, retryForever, sleep, type RetryOptions, type RetryForeverOptions };
