const requestNode = require('request').defaults({ encoding: null });
import { writeFile, unlink } from 'fs-promise';
import { take } from 'lodash';
import Telegram from 'telegram-bot-api';

import { STATUSES, TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_NAME } from './config.js';
import { Image } from './mongo.js';
import { logger } from './logger';
const { UNPUBLISHED, PROCESSING, POSTED, ERROR } = STATUSES;

const telegramApi = new Telegram({ token: TELEGRAM_BOT_TOKEN });

async function changeImageStatus(image, status, failedStatus = UNPUBLISHED) {
  let processingImage = image;

  try {
    logger.info(`... setting processing status for image ${processingImage.id}...`);
    processingImage.status = status;
    await processingImage.save();
    logger.info('... status changed...');
  } catch (e) {
    processingImage = null;
    logger.info(`... something went wrong, ${processingImage.id} status isn't changed, trying to revert it...`);
    logger.error(e);
    processingImage.status = failedStatus;
    await processingImage.save();
  }

  return processingImage;
}

async function downloadImage(image) {
  let path = null;

  try {
    logger.info(`... downloading image ${image.id}...`);
    path = await new Promise((resolve, reject) => {
      // TODO: Promisify the shit outta here
      requestNode.get(image.src, async (error, response, imageBody) => {
        if (!error && response.statusCode === 200) {
          path = `./.tmp/${image.id}.${image.format}`;
          await writeFile(path, new Buffer(imageBody));
          logger.info(`... image ${image.id} downloaded...`);
          resolve(path);
        } else {
          reject(error);
          throw new Error(error);
        }
      });
    });
  } catch (e) {
    logger.info(`... something went wrong, ${image.id} isn't downloaded...`);
    changeImageStatus(image, ERROR);
    logger.error(e);
  }

  return path;
}

async function sendImageToChannel(image, path) {
  const isGif = image.format === 'gif';
  const action = isGif ? 'sendDocument' : 'sendPhoto';
  const key = isGif ? 'document' : 'photo';
  let sendedImage = null;

  let data = {
    chat_id: `@${TELEGRAM_CHANNEL_NAME}`,
    [key]: path
  };

  if (!isGif) {
    data = { ...data, caption: image.original_source };
  }

  try {
    logger.info(`... posting ${image.id} ${key} to a @${TELEGRAM_CHANNEL_NAME} channel...`);
    const response = await telegramApi[action](data);
    if (isGif) {
      const { message_id } = response;
      await telegramApi.sendMessage({
        chat_id: `@${TELEGRAM_CHANNEL_NAME}`,
        text: image.original_source,
        reply_to_message_id: message_id,
        disable_web_page_preview: 'true'
      });
    }
    logger.info(`... ${image.id} posted into a @${TELEGRAM_CHANNEL_NAME}...`);
    sendedImage = image;
  } catch (e) {
    logger.info(`... something went wrong, ${image.id} isn't posted...`);
    changeImageStatus(image, ERROR);
    logger.error(e);
  }

  return sendedImage;
}

async function deleteTemp(path) {
  let deletedTemp = null;

  try {
    logger.info(`... deleting temporary file at ${path}...`);
    deletedTemp = await unlink(path);
    logger.info(`... ${path} deleted...`);
  } catch (e) {
    logger.info(`... something went wrong, ${path} isn't deleted...`);
    logger.error(e);
  }

  return deletedTemp;
}

async function postImage(image) {
  logger.info(`... posting image ${image.id}...`);
  const processingImage = await changeImageStatus(image, PROCESSING);
  const path = await downloadImage(processingImage);
  const sendedImage = await sendImageToChannel(processingImage, path);
  const postedImage = await changeImageStatus(sendedImage, POSTED);
  logger.info(`... ${image.id} posted...`);
  await deleteTemp(path);
  return postedImage;
}

function postOneAfterAnother(images) {
  return images.reduce(
    (p, image) => p.then(() => postImage(image)),
    new Promise(resolve => resolve())
  );
}

export async function postImages() {
  logger.info('New posting job started...');
  const unpostedImages = await Image.find({ status: UNPUBLISHED }).sort({ id: -1 });
  logger.info(`... we've got ${unpostedImages.length} unposted images...`);
  let postNow = Math.ceil(unpostedImages.length / 10);
  postNow = postNow < 5 && postNow > 0 ? postNow = 5 : postNow;
  const imagesToPost = take(unpostedImages, postNow);
  if (imagesToPost.length > 0) {
    logger.info(`... posting ${imagesToPost.length} right now...`);
    await postOneAfterAnother(imagesToPost);
  } else {
    logger.info('... nothing to post...');
  }
  logger.info(`${imagesToPost.length} images posted!`);
}
