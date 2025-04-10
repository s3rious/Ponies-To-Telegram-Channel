import request from 'request-promise';
import cheerio from 'cheerio';
import { range, flattenDeep } from 'lodash';

import { logger } from './logger';
import { Image } from './mongo.js';

import { GRABBING_URLS, STATUSES } from './config.js';

function getUrlsForGrabbing() {
  return GRABBING_URLS.split(',');
}

function getUrlForPage(url, page) {
  return `${url}&page=${page}`;
}

async function getLastEpisode() {
  try {
    logger.info('... getting last episode...');
    const html = await request({ url: 'http://mlp-episodes.tk/', json: false });
    const $ = cheerio.load(html);
    const data = $('.mlpepisode_new').data();
    const lastEp = { s: data.episodeSeason, e: data.episodeNumber };
    logger.info('... last episode is:', lastEp);
    return lastEp;
  } catch (e) {
    const lastEp = { s: 0, e: 0 };
    logger.info('... something went wrong, let’s consider last episode is:', lastEp);
    logger.error(e);
    return lastEp;
  }
}

function httpsiseUrl(url) {
  return /^http/.test(url) ? url : `https:${url}`;
}

function filterDupes(images) {
  return images.filter((image) => {
    const haveDupes = image.duplicate_reports.length > 0;
    if (haveDupes) {
      logger.info(`... image ${image.id} filtered due to duplicate report...`);
    }
    return !haveDupes;
  });
}

async function filterSpoilers(images, lastEp) {
  const spoilerEpRegexp = /spoiler:s(\d{2})e(\d{2})/;

  return images.filter((image) => {
    let allowed = true;
    const tags = image.tags;
    if (spoilerEpRegexp.test(tags)) {
      const match = tags.match(spoilerEpRegexp, '$1,$2');
      const spoilerEp = { s: parseInt(match[1], 10), e: parseInt(match[2], 10) };
      allowed = Number(`${lastEp.s}${lastEp.e}`) > Number(`${spoilerEp.s}${spoilerEp.e}`);
      if (!allowed) {
        logger.info(`... image ${image.id} filtered due to spoiler alert for s${spoilerEp.s}e${spoilerEp.e}...`);
      }
    }
    return allowed;
  });
}

async function processResponseData(data, page, lastEp) {
  const images = data.search;
  const woDupes = filterDupes(images);
  logger.info(`... dupes for page ${page} cleared...`);
  const woSpoilers = await filterSpoilers(woDupes, lastEp);
  logger.info(`... spoilers for page ${page} cleared...`);
  const result = woSpoilers.map(i => ({
    id: parseInt(i.id, 10),
    src: httpsiseUrl(i.representations.large),
    original_source: i.source_url ? i.source_url : `https://derpibooru.org/${i.id}`,
    format: i.original_format,
    mime_type: i.mime_type,
    status: STATUSES.UNPUBLISHED
  }));
  return result;
}

async function grapPage(url, page, lastEp) {
  logger.info(`... grabbing page ${page}...`);
  try {
    const data = await request({ url: getUrlForPage(url, page), json: true });
    logger.info(`... got response for page ${page}...`);
    const clearData = await processResponseData(data, page, lastEp);
    return clearData;
  } catch (e) {
    logger.info(`... something went wrong ${page} didn't grabbed...`);
    logger.error(e);
    return [];
  }
}

async function grabOnePageAfterAnother(url, pages, lastEp) {
  let images = [];
  await pages.reduce(
    (p, page) => p.then(async () => {
      const result = await grapPage(url, page, lastEp);
      images = [...images, ...result];
    }),
    new Promise(resolve => resolve())
  );
  return images;
}

async function getInfoFromPages(url, pagesCount, lastEp) {
  logger.info(`... grabbing ${pagesCount} pages from ${url}...`);
  const pages = range(1, pagesCount + 1, 1);
  const arrayedData = await grabOnePageAfterAnother(url, pages, lastEp);
  const flattenData = flattenDeep(arrayedData);
  logger.info(`... ${pagesCount} pages from ${url} grabbed, we’ve got ${flattenData.length} images...`);
  return flattenData;
}

async function getInfo(urls, pagesCount, lastEp) {
  let images = [];
  await urls.reduce(
    (p, url) => p.then(async () => {
      const result = await getInfoFromPages(url, pagesCount, lastEp);
      images = [...images, ...result];
    }),
    new Promise(resolve => resolve())
  );
  return images;
}

async function saveImageIfNotExist(image) {
  let saved = null;
  logger.info(`... saving ${image.id} to mongo...`);
  let savedImage = await Image.findOne({ id: image.id });
  if (!savedImage) {
    savedImage = new Image({ ...image });
    saved = savedImage.save();
    logger.info(`... image ${image.id} saved to mongo...`);
  } else {
    logger.info(`... image ${image.id} is already exist in mongo database...`);
  }
  return saved;
}

async function storeImages(images) {
  logger.info(`... saving ${images.length} images to mongo...`);
  const savedArray = await Promise.all(images.map(i => saveImageIfNotExist(i)));
  const savedCount = savedArray.map((s) => Number(Boolean(s))).reduce((m = 0, b) => m + b);
  return savedCount;
}

export async function grabImages(pagesCount) {
  logger.info('New grabbing job started...');
  const lastEp = await getLastEpisode();
  const urls = getUrlsForGrabbing();
  const images = await getInfo(urls, pagesCount, lastEp);
  const storedImages = await storeImages(images);
  logger.info(`... ${storedImages} new images stored!`);
}
