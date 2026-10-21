import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

type Level = 'INFO' | 'WARN' | 'ERROR';

interface Logger {
  info: (...parts: readonly unknown[]) => void;
  warn: (...parts: readonly unknown[]) => void;
  error: (...parts: readonly unknown[]) => void;
}

function formatPart(p: unknown): string {
  if (typeof p === 'string') return p;
  if (typeof p === 'number' || typeof p === 'boolean') return String(p);
  if (p instanceof Error) return p.stack ?? p.message;
  if (p === null || p === undefined) return String(p);
  try {
    return JSON.stringify(p);
  } catch {
    return Object.prototype.toString.call(p);
  }
}

function format(level: Level, parts: readonly unknown[]): string {
  const msg = parts.map(formatPart).join(' ');
  return `[${new Date().toISOString()}] ${level}: ${msg}`;
}

const pending = new Set<Promise<unknown>>();

function createLogger(logFile: string): Logger {
  let dirEnsured = false;

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    try {
      await mkdir(dirname(logFile), { recursive: true });
      dirEnsured = true;
    } catch {
      // Disk/permission failures must never crash the app — keep streaming to stdout only.
    }
  }

  function write(level: Level, parts: readonly unknown[]): void {
    const line = format(level, parts);
    const stream = level === 'ERROR' ? process.stderr : process.stdout;
    stream.write(line + '\n');
    const queued = ensureDir()
      .then(() => appendFile(logFile, line + '\n'))
      .catch(() => {})
      .finally(() => {
        pending.delete(queued);
      });
    pending.add(queued);
  }

  return {
    info: (...parts) => { write('INFO', parts); },
    warn: (...parts) => { write('WARN', parts); },
    error: (...parts) => { write('ERROR', parts); },
  };
}

async function flush(): Promise<void> {
  await Promise.all(pending);
}

const logger = createLogger(process.env.LOG_FILE ?? '/app/logs/verbose.log');

export { logger, createLogger, flush, type Logger };
