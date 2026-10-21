import './_env.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GrammyError, HttpError } from 'grammy';
import {
  sendPhoto,
  sendVideo,
  sendMessage,
  setClient,
  isTransient,
  type TelegramClient,
  type SendPhotoArgs,
  type SendVideoArgs,
  type SendMessageArgs,
} from '../src/telegram.ts';

function makeGrammyError(code: number): GrammyError {
  return new GrammyError(
    `mock ${code}`,
    { ok: false, error_code: code, description: `mock ${code}` },
    'mockMethod',
    {},
  );
}

test('isTransient: GrammyError 429 -> retry', () => {
  assert.equal(isTransient(makeGrammyError(429)), true);
});

test('isTransient: GrammyError 500 -> retry', () => {
  assert.equal(isTransient(makeGrammyError(500)), true);
});

test('isTransient: GrammyError 502 -> retry', () => {
  assert.equal(isTransient(makeGrammyError(502)), true);
});

test('isTransient: GrammyError 400 -> no retry (client error)', () => {
  assert.equal(isTransient(makeGrammyError(400)), false);
});

test('isTransient: HttpError -> retry (transport-level)', () => {
  assert.equal(isTransient(new HttpError('mock', new Error('underlying'))), true);
});

test('isTransient: plain Error -> NO retry (was true before; programmer errors should fail fast)', () => {
  assert.equal(isTransient(new Error('boom')), false);
});

test('isTransient: TypeError -> NO retry', () => {
  assert.equal(isTransient(new TypeError('bad call')), false);
});

test('isTransient: non-Error value -> NO retry', () => {
  assert.equal(isTransient('not an error'), false);
  assert.equal(isTransient(null), false);
  assert.equal(isTransient(undefined), false);
});

interface Capture {
  photos: SendPhotoArgs[];
  videos: SendVideoArgs[];
  messages: SendMessageArgs[];
}

function makeRecordingClient(capture: Capture): TelegramClient {
  return {
    sendPhoto: async (args) => {
      await Promise.resolve();
      capture.photos.push(args);
      return { message_id: 1 };
    },
    sendVideo: async (args) => {
      await Promise.resolve();
      capture.videos.push(args);
      return { message_id: 2 };
    },
    sendMessage: async (args) => {
      await Promise.resolve();
      capture.messages.push(args);
      return { message_id: 3 };
    },
  };
}

test('sendPhoto delegates to the active client and returns the message_id', async () => {
  const capture: Capture = { photos: [], videos: [], messages: [] };
  const prev = setClient(makeRecordingClient(capture));
  try {
    const out = await sendPhoto({ chatId: '@chan', photo: 'https://x/y.png', caption: 'cap' });
    assert.equal(out.message_id, 1);
    assert.equal(capture.photos.length, 1);
    const [first] = capture.photos;
    assert.ok(first, 'expected a captured photo');
    assert.equal(first.chatId, '@chan');
    assert.equal(first.caption, 'cap');
  } finally {
    setClient(prev);
  }
});

test('sendVideo delegates to the active client', async () => {
  const capture: Capture = { photos: [], videos: [], messages: [] };
  const prev = setClient(makeRecordingClient(capture));
  try {
    const out = await sendVideo({ chatId: 1, video: { source: '/tmp/x.mp4' } });
    assert.equal(out.message_id, 2);
    assert.equal(capture.videos.length, 1);
    const [first] = capture.videos;
    assert.ok(first, 'expected a captured video');
    assert.equal(first.chatId, 1);
  } finally {
    setClient(prev);
  }
});

test('sendMessage delegates to the active client', async () => {
  const capture: Capture = { photos: [], videos: [], messages: [] };
  const prev = setClient(makeRecordingClient(capture));
  try {
    const out = await sendMessage({ chatId: '@chan', text: 'hi', replyToMessageId: 9 });
    assert.equal(out.message_id, 3);
    const [first] = capture.messages;
    assert.ok(first, 'expected a captured message');
    assert.equal(first.text, 'hi');
    assert.equal(first.replyToMessageId, 9);
  } finally {
    setClient(prev);
  }
});
