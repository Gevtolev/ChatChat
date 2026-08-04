const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { CacheKeys } = require('librechat-data-provider');
const {
  submitGeneration,
  resolveResult,
  resolveImageProviders,
  getImageModels,
  getDefaultImageModel,
  getAspectRatios,
  getStorageMetadata,
  refreshS3Url,
} = require('@librechat/api');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { getFileStrategy } = require('~/server/utils/getFileStrategy');
const { getAppConfig } = require('~/server/services/Config');
const { getLogStores } = require('~/cache');
const { requireJwtAuth } = require('~/server/middleware');
const db = require('~/models');

const router = express.Router();
router.use(requireJwtAuth);

const PENDING_TTL = 30 * 60 * 1000;

/** @returns {import('@librechat/api').ImageDeps} */
const buildDeps = (appConfig, req) => ({
  fetchImage: async (url) => {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
    const buffer = Buffer.from(r.data);
    const meta = await sharp(buffer).metadata();
    return {
      buffer,
      contentType: r.headers['content-type'] || 'image/png',
      width: meta.width,
      height: meta.height,
    };
  },
  fetchImageFromB64: async (b64, mediaType) => {
    const buffer = Buffer.from(b64, 'base64');
    const meta = await sharp(buffer).metadata();
    return {
      buffer,
      contentType: mediaType || 'image/png',
      width: meta.width,
      height: meta.height,
    };
  },
  saveImageFile: async ({ userId, buffer, contentType }) => {
    const source = getFileStrategy(appConfig, { isImage: true });
    const { saveBuffer } = getStrategyFunctions(source);
    const ext = contentType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `${uuidv4()}.${ext}`;
    const filepath = await saveBuffer({
      userId,
      buffer,
      fileName: filename,
      tenantId: req.user.tenantId,
    });
    return {
      filepath,
      source,
      bytes: buffer.length,
      filename,
      storageMetadata: getStorageMetadata({ filepath, source }),
    };
  },
  createFileRecord: (doc) => db.createFile({ ...doc, tenantId: req.user.tenantId }, true),
  findFileByPrediction: async (userId, pid) => {
    const files = await db.getFiles(
      { user: userId, 'metadata.imageGen.predictionId': pid },
      null,
      null,
    );
    return files && files[0] ? files[0] : null;
  },
});

router.get('/models', async (req, res) => {
  const appConfig = await getAppConfig({ role: req.user.role });
  const providers = resolveImageProviders(appConfig.imageGeneration);
  const defaultModel = getDefaultImageModel(providers);
  res.json({
    models: getImageModels(providers),
    default: defaultModel?.id,
    aspectRatios: getAspectRatios(providers),
  });
});

router.post('/generate', async (req, res) => {
  try {
    const appConfig = await getAppConfig({ role: req.user.role });
    const providers = resolveImageProviders(appConfig.imageGeneration);
    const deps = buildDeps(appConfig, req);
    const defaultModel = getDefaultImageModel(providers);
    const { prompt, model, provider, aspectRatio, param, imageUrls } = req.body;
    const providerName = provider || defaultModel?.provider;
    const modelId = model || defaultModel?.id;
    const result = await submitGeneration(
      {
        providerName,
        model: modelId,
        prompt,
        aspectRatio: aspectRatio || '1:1',
        param,
        imageUrls,
      },
      providers,
      deps,
      req.user.id,
    );
    if (result.status === 'pending') {
      await getLogStores(CacheKeys.IMAGE_GENERATION).set(
        result.predictionId,
        { userId: req.user.id, provider: providerName, model: modelId, prompt },
        PENDING_TTL,
      );
    }
    res.json({ predictionId: result.predictionId });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

router.get('/result/:predictionId', async (req, res) => {
  try {
    const { predictionId } = req.params;
    const cache = getLogStores(CacheKeys.IMAGE_GENERATION);
    const ctx = (await cache.get(predictionId)) || {};
    if (ctx.userId && ctx.userId !== req.user.id) {
      return res.status(403).json({ message: 'forbidden' });
    }
    const appConfig = await getAppConfig({ role: req.user.role });
    const providers = resolveImageProviders(appConfig.imageGeneration);
    const deps = buildDeps(appConfig, req);
    const out = await resolveResult(
      {
        predictionId,
        userId: req.user.id,
        providerName: ctx.provider || 'unknown',
        model: ctx.model || 'unknown',
        prompt: ctx.prompt || '',
      },
      deps,
      providers,
    );
    if (out.status === 'completed' || out.status === 'failed') {
      await cache.delete(predictionId);
    }
    res.json(out);
  } catch (err) {
    res.status(502).json({ status: 'failed', message: err.message });
  }
});

router.get('/', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const filter = { user: req.user.id, context: 'image_generation' };
  if (req.query.cursor) {
    filter._id = { $lt: req.query.cursor };
  }
  const File = mongoose.models.File;
  const results = await File.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  let nextCursor = null;
  if (results.length > limit) {
    results.pop();
    nextCursor = results[results.length - 1]._id;
  }
  const images = await Promise.all(
    results.map(async (file) => ({ ...file, filepath: await refreshS3Url(file) })),
  );
  res.json({ images, nextCursor });
});

router.buildDeps = buildDeps;
module.exports = router;
