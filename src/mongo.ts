import mongoose, { Schema, model, type HydratedDocument } from 'mongoose';
import {
  config,
  ALL_STATUSES,
  STATUS_PROCESSING,
  STATUS_UNPUBLISHED,
  type Status,
} from './config.ts';
import { logger } from './logger.ts';
import { retryForever } from './retry.ts';

interface ImageDoc {
  id: number;
  src: string;
  original_source: string;
  format: string;
  mime_type: string;
  status: Status;
  error_count: number;
  posted_message_id: number | null;
  posted_at: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

type ImageHydrated = HydratedDocument<ImageDoc>;

const imageSchema = new Schema<ImageDoc>(
  {
    id: { type: Number, index: true },
    src: String,
    original_source: String,
    format: String,
    mime_type: String,
    status: { type: String, index: true, enum: ALL_STATUSES },
    error_count: { type: Number, default: 0 },
    posted_message_id: { type: Number, default: null },
    posted_at: { type: Date, default: null },
  },
  { timestamps: true },
);

const Image = model<ImageDoc>('Image', imageSchema);

mongoose.connection.on('connected', () => {
  logger.info('mongo: connected');
});
mongoose.connection.on('disconnected', () => {
  logger.warn('mongo: disconnected');
});
mongoose.connection.on('reconnected', () => {
  logger.info('mongo: reconnected');
});
mongoose.connection.on('error', (error: unknown) => {
  logger.error('mongo: error', error);
});

let connected = false;

async function connect(): Promise<void> {
  if (connected) return;
  const { host, port, database, user, password } = config.mongo;
  const uri = `mongodb://${host}:${port}/${database}`;
  logger.info(`mongo: connecting to ${host}:${port} db=${database}`);

  await retryForever(
    async () => {
      await mongoose.connect(uri, {
        user,
        pass: password,
        authSource: 'admin',
        serverSelectionTimeoutMS: 30_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 10,
        minPoolSize: 1,
        retryWrites: true,
      });
    },
    {
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      onAttempt: (attempt) => {
        logger.warn(`mongo: connect attempt ${attempt} failed`);
      },
    },
  );

  connected = true;
}

async function disconnect(): Promise<void> {
  await mongoose.disconnect();
  connected = false;
}

interface StaleProcessingQuery {
  filter: { status: typeof STATUS_PROCESSING; updatedAt: { $lt: Date } };
  update: { $set: { status: typeof STATUS_UNPUBLISHED } };
}

function buildStaleProcessingQuery(olderThanMs: number, now: number = Date.now()): StaleProcessingQuery {
  return {
    filter: { status: STATUS_PROCESSING, updatedAt: { $lt: new Date(now - olderThanMs) } },
    update: { $set: { status: STATUS_UNPUBLISHED } },
  };
}

async function resetStaleProcessing(olderThanMs = 60 * 60 * 1000): Promise<number> {
  const { filter, update } = buildStaleProcessingQuery(olderThanMs);
  const result = await Image.updateMany(filter, update);
  if (result.modifiedCount > 0) {
    logger.info(`mongo: reset ${result.modifiedCount} stale "processing" images to "unpublished"`);
  }
  return result.modifiedCount;
}

interface CleanupQuery {
  filter: { createdAt: { $lt: Date } };
}

function buildCleanupQuery(olderThanMs: number, now: number = Date.now()): CleanupQuery {
  return { filter: { createdAt: { $lt: new Date(now - olderThanMs) } } };
}

async function cleanupOldImages(olderThanMs: number): Promise<number> {
  const { filter } = buildCleanupQuery(olderThanMs);
  const result = await Image.deleteMany(filter);
  if (result.deletedCount > 0) {
    const days = Math.round(olderThanMs / (24 * 60 * 60 * 1000));
    logger.info(`mongo: deleted ${result.deletedCount} images older than ${days} days`);
  }
  return result.deletedCount;
}

export {
  Image,
  connect,
  disconnect,
  resetStaleProcessing,
  buildStaleProcessingQuery,
  cleanupOldImages,
  buildCleanupQuery,
  type ImageDoc,
  type ImageHydrated,
  type StaleProcessingQuery,
  type CleanupQuery,
};
