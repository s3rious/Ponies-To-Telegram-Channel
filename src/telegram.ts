import { Bot, GrammyError, HttpError, InputFile } from 'grammy';
import { config } from './config.ts';
import { logger } from './logger.ts';
import { retry } from './retry.ts';

type PhotoInput = string | Buffer | { source: string };
type VideoInput = PhotoInput;

interface SendPhotoArgs {
  chatId: string | number;
  photo: PhotoInput;
  caption?: string;
}

interface SendVideoArgs {
  chatId: string | number;
  video: VideoInput;
  caption?: string;
}

interface SendMessageArgs {
  chatId: string | number;
  text: string;
  replyToMessageId?: number;
  disableWebPagePreview?: boolean;
}

interface SendResult {
  message_id: number;
}

interface TelegramClient {
  sendPhoto: (args: SendPhotoArgs) => Promise<SendResult>;
  sendVideo: (args: SendVideoArgs) => Promise<SendResult>;
  sendMessage: (args: SendMessageArgs) => Promise<SendResult>;
}

function isTransient(error: unknown): boolean {
  if (error instanceof GrammyError) {
    if (error.error_code === 429) return true;
    if (error.error_code >= 500) return true;
    return false;
  }
  if (error instanceof HttpError) return true;
  return false;
}

function withRetry<T>(op: string, fn: () => Promise<T>): Promise<T> {
  return retry(fn, {
    attempts: 5,
    initialDelayMs: 1000,
    maxDelayMs: 30_000,
    shouldRetry: isTransient,
    onAttempt: (attempt, error) => {
      logger.warn(`telegram ${op}: attempt ${attempt} failed:`, error);
    },
  });
}

function toInput(value: PhotoInput): string | InputFile {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return new InputFile(value);
  return new InputFile(value.source);
}

function createGrammyClient(token: string): TelegramClient {
  const bot = new Bot(token);
  return {
    sendPhoto: ({ chatId, photo, caption }) =>
      withRetry('sendPhoto', () => bot.api.sendPhoto(chatId, toInput(photo), caption ? { caption } : {})),
    sendVideo: ({ chatId, video, caption }) =>
      withRetry('sendVideo', () => bot.api.sendVideo(chatId, toInput(video), caption ? { caption } : {})),
    sendMessage: ({ chatId, text, replyToMessageId, disableWebPagePreview }) =>
      withRetry('sendMessage', () =>
        bot.api.sendMessage(chatId, text, {
          reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
          link_preview_options: disableWebPagePreview ? { is_disabled: true } : undefined,
        }),
      ),
  };
}

let client: TelegramClient = createGrammyClient(config.telegramBotToken);

function setClient(next: TelegramClient): TelegramClient {
  const prev = client;
  client = next;
  return prev;
}

async function sendPhoto(args: SendPhotoArgs): Promise<SendResult> {
  return client.sendPhoto(args);
}

async function sendVideo(args: SendVideoArgs): Promise<SendResult> {
  return client.sendVideo(args);
}

async function sendMessage(args: SendMessageArgs): Promise<SendResult> {
  return client.sendMessage(args);
}

export {
  sendPhoto,
  sendVideo,
  sendMessage,
  setClient,
  createGrammyClient,
  isTransient,
  type SendPhotoArgs,
  type SendVideoArgs,
  type SendMessageArgs,
  type SendResult,
  type TelegramClient,
  type PhotoInput,
  type VideoInput,
};
