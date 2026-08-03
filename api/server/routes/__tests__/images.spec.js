const http = require('http');
const sharp = require('sharp');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { fileSchema, createMethods } = require('@librechat/data-schemas');

// --- @librechat/api: keep the REAL image service/exports, but make
//     submitGeneration / resolveResult configurable jest.fns that default
//     to the real implementation (so real-path tests exercise actual logic). ---
const actualApi = jest.requireActual('@librechat/api');
const mockSubmitGeneration = jest.fn((...args) => actualApi.submitGeneration(...args));
const mockResolveResult = jest.fn((...args) => actualApi.resolveResult(...args));
const mockRefreshS3Url = jest.fn((...args) => actualApi.refreshS3Url(...args));

jest.mock('@librechat/api', () => {
  const real = jest.requireActual('@librechat/api');
  return {
    ...real,
    submitGeneration: (...args) => mockSubmitGeneration(...args),
    resolveResult: (...args) => mockResolveResult(...args),
    refreshS3Url: (...args) => mockRefreshS3Url(...args),
  };
});

// --- mock auth middleware (bypass JWT) ---
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => next(),
}));

// --- mock file strategies: saveBuffer writes nothing, returns a stable path ---
const mockSaveBuffer = jest.fn(async ({ fileName }) => `/images/user-1/${fileName}`);
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({ saveBuffer: mockSaveBuffer })),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn(() => 'local'),
}));

// --- mock app config ---
const TEST_IMAGE_GENERATION_CONFIG = {
  providers: [
    {
      name: 'GPTsAPI',
      protocol: 'gptsapi-predictions',
      apiKey: 'test-gptsapi-key',
      baseURL: 'https://api.gptsapi.net',
      aspectRatios: ['auto', '1:1', '9:16', '16:9', '4:3', '3:4'],
      models: [
        {
          id: 'gemini-3-pro-image-preview',
          label: 'Nano Banana Pro',
          isDefault: true,
          vendor: 'google',
          supportsEdit: true,
          editImagesKey: 'images',
          paramKey: 'output_format',
          paramValues: ['png', 'jpeg'],
          defaultParam: 'png',
        },
      ],
    },
  ],
};

const mockGetAppConfig = jest.fn(async () => ({
  fileStrategy: 'local',
  imageGeneration: TEST_IMAGE_GENERATION_CONFIG,
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

// --- ~/models: delegate to REAL mongoose-backed methods (in-memory Mongo) ---
jest.mock('~/models', () => {
  const m = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  return createMethods(m, { removeAllPermissions: jest.fn() });
});

// --- mock cache ---
const mockCacheSet = jest.fn(async () => true);
const mockCacheGet = jest.fn(async () => null);
const mockCacheDelete = jest.fn(async () => true);
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    set: mockCacheSet,
    get: mockCacheGet,
    delete: mockCacheDelete,
  })),
}));

const imagesRouter = require('../images');

function createApp(user = { id: new mongoose.Types.ObjectId().toString(), role: 'USER' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/api/images', imagesRouter);
  return { app, user };
}

let mongoServer;
let File;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  File = mongoose.models.File || mongoose.model('File', fileSchema);
  createMethods(mongoose, { removeAllPermissions: jest.fn() });
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockSubmitGeneration.mockImplementation((...args) => actualApi.submitGeneration(...args));
  mockResolveResult.mockImplementation((...args) => actualApi.resolveResult(...args));
  mockRefreshS3Url.mockImplementation((...args) => actualApi.refreshS3Url(...args));
  mockGetAppConfig.mockImplementation(async () => ({
    fileStrategy: 'local',
    imageGeneration: TEST_IMAGE_GENERATION_CONFIG,
  }));
  await File.deleteMany({});
});

describe('GET /api/images/models', () => {
  it('returns model list (tagged with provider), default, and aspect ratios', async () => {
    const { app } = createApp();
    const res = await request(app).get('/api/images/models');

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      expect.objectContaining({ id: 'gemini-3-pro-image-preview', provider: 'GPTsAPI' }),
    ]);
    expect(res.body.default).toBe('gemini-3-pro-image-preview');
    expect(res.body.aspectRatios).toEqual(
      expect.arrayContaining(['auto', '1:1', '9:16', '16:9', '4:3', '3:4']),
    );
  });
});

describe('POST /api/images/generate', () => {
  it('calls submitGeneration and caches ctx, returns predictionId', async () => {
    mockSubmitGeneration.mockResolvedValue({ status: 'pending', predictionId: 'pred-abc' });

    const { app, user } = createApp();
    const res = await request(app).post('/api/images/generate').send({
      prompt: 'a sunset',
      model: 'gemini-3-pro-image-preview',
      provider: 'GPTsAPI',
      aspectRatio: '16:9',
    });

    expect(res.status).toBe(200);
    expect(res.body.predictionId).toBe('pred-abc');

    expect(mockSubmitGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: 'GPTsAPI', prompt: 'a sunset', aspectRatio: '16:9' }),
      expect.any(Array),
      expect.objectContaining({ fetchImage: expect.any(Function) }),
      user.id,
    );

    expect(mockCacheSet).toHaveBeenCalledWith(
      'pred-abc',
      expect.objectContaining({ userId: user.id, provider: 'GPTsAPI', prompt: 'a sunset' }),
      expect.any(Number),
    );
  });

  it('uses default model/provider and 1:1 when not provided', async () => {
    mockSubmitGeneration.mockResolvedValue({ status: 'pending', predictionId: 'pred-def' });

    const { app } = createApp();
    const res = await request(app).post('/api/images/generate').send({ prompt: 'mountains' });

    expect(res.status).toBe(200);
    expect(mockSubmitGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-3-pro-image-preview',
        providerName: 'GPTsAPI',
        aspectRatio: '1:1',
      }),
      expect.any(Array),
      expect.anything(),
      expect.any(String),
    );
  });

  it('does not write to cache when submitGeneration resolves synchronously (completed)', async () => {
    mockSubmitGeneration.mockResolvedValue({
      status: 'completed',
      predictionId: 'pred-sync-1',
      file: { _id: 'file-1', context: 'image_generation' },
    });

    const { app } = createApp();
    const res = await request(app).post('/api/images/generate').send({ prompt: 'a robot' });

    expect(res.status).toBe(200);
    expect(res.body.predictionId).toBe('pred-sync-1');
    expect(mockCacheSet).not.toHaveBeenCalled();
  });

  it('returns 400 when submitGeneration throws', async () => {
    mockSubmitGeneration.mockRejectedValue(new Error('prompt is required'));

    const { app } = createApp();
    const res = await request(app)
      .post('/api/images/generate')
      .send({ model: 'gemini-3-pro-image-preview' });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('prompt is required');
  });
});

describe('GET /api/images/result/:predictionId (handler wiring)', () => {
  it('returns resolveResult output and deletes cache on completed', async () => {
    const fileRecord = { _id: 'file-1', filepath: '/images/test.png', context: 'image_generation' };
    const { app, user } = createApp();
    mockCacheGet.mockResolvedValue({
      userId: user.id,
      provider: 'GPTsAPI',
      model: 'm',
      prompt: 'a sunset',
    });
    mockResolveResult.mockResolvedValue({ status: 'completed', file: fileRecord });

    const res = await request(app).get('/api/images/result/pred-abc');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.file).toBeDefined();
    expect(mockResolveResult).toHaveBeenCalledWith(
      expect.objectContaining({ predictionId: 'pred-abc', providerName: 'GPTsAPI' }),
      expect.objectContaining({
        fetchImage: expect.any(Function),
        fetchImageFromB64: expect.any(Function),
        saveImageFile: expect.any(Function),
      }),
      expect.any(Array),
    );
    expect(mockCacheDelete).toHaveBeenCalledWith('pred-abc');
  });

  it('does NOT delete cache when status is still processing', async () => {
    const { app, user } = createApp();
    mockCacheGet.mockResolvedValue({ userId: user.id, model: 'm', prompt: 'test' });
    mockResolveResult.mockResolvedValue({ status: 'processing' });

    const res = await request(app).get('/api/images/result/pred-xyz');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('processing');
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it('returns 200 {status:"failed"} and deletes cache when resolveResult returns failed', async () => {
    const { app, user } = createApp();
    mockCacheGet.mockResolvedValue({ userId: user.id, model: 'm', prompt: 'test' });
    mockResolveResult.mockResolvedValue({ status: 'failed', error: 'out of memory' });

    const res = await request(app).get('/api/images/result/pred-gptsapi-fail');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(mockCacheDelete).toHaveBeenCalledWith('pred-gptsapi-fail');
  });

  it('returns 502 when resolveResult throws (unexpected/storage error)', async () => {
    mockCacheGet.mockResolvedValue({});
    mockResolveResult.mockRejectedValue(new Error('image generation failed'));

    const { app } = createApp();
    const res = await request(app).get('/api/images/result/pred-bad');

    expect(res.status).toBe(502);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toBe('image generation failed');
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it('uses fallback provider/model/prompt when ctx is missing from cache', async () => {
    mockCacheGet.mockResolvedValue(null);
    mockResolveResult.mockResolvedValue({ status: 'processing' });

    const { app } = createApp();
    await request(app).get('/api/images/result/pred-nocache');

    expect(mockResolveResult).toHaveBeenCalledWith(
      expect.objectContaining({ providerName: 'unknown', model: 'unknown', prompt: '' }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns 403 and does NOT delete cache when ctx.userId differs from req.user.id', async () => {
    const otherId = new mongoose.Types.ObjectId().toString();
    mockCacheGet.mockResolvedValue({ userId: otherId, model: 'm', prompt: 'p' });

    const { app } = createApp({ id: new mongoose.Types.ObjectId().toString(), role: 'USER' });
    const res = await request(app).get('/api/images/result/pred-forbidden');

    expect(res.status).toBe(403);
    expect(mockResolveResult).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });
});

describe('GET /api/images/result/:predictionId — real completed path (M-1)', () => {
  // Spin up a local HTTP server that doubles as both the gptsapi poll endpoint
  // and the generated-image host, so the REAL resolveResult (un-mocked) drives
  // the actual download -> sharp -> saveBuffer -> getStorageMetadata ->
  // createFileRecord closures end to end.
  let server;
  let baseUrl;
  let pngBuffer;

  beforeAll(async () => {
    pngBuffer = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();

    server = http.createServer((req, res) => {
      if (req.url.endsWith('/result')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            data: { status: 'completed', outputs: [`${baseUrl}/output.png`], error: null },
          }),
        );
        return;
      }
      if (req.url === '/output.png') {
        res.setHeader('Content-Type', 'image/png');
        res.end(pngBuffer);
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('downloads, stores, and persists a File with context image_generation', async () => {
    mockGetAppConfig.mockResolvedValueOnce({
      fileStrategy: 'local',
      imageGeneration: {
        providers: [
          {
            name: 'GPTsAPI',
            protocol: 'gptsapi-predictions',
            apiKey: 'test-key',
            baseURL: baseUrl,
            aspectRatios: ['1:1'],
            models: [
              {
                id: 'flux-1.1-ultra',
                label: 'Flux 1.1 Ultra',
                vendor: 'google',
                supportsEdit: false,
                editImagesKey: 'images',
                paramKey: 'output_format',
                paramValues: ['png'],
                defaultParam: 'png',
              },
            ],
          },
        ],
      },
    });

    const { app, user } = createApp();
    mockCacheGet.mockResolvedValue({
      userId: user.id,
      provider: 'GPTsAPI',
      model: 'flux-1.1-ultra',
      prompt: 'a real sunset',
    });

    const res = await request(app).get('/api/images/result/pred-real-123');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.file).toBeDefined();

    // The stored filepath must be the local storage path, NOT the gptsapi temp URL.
    expect(res.body.file.filepath).toMatch(/^\/images\/user-1\//);
    expect(res.body.file.filepath).not.toContain('output.png');

    expect(mockSaveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ buffer: expect.any(Buffer), fileName: expect.any(String) }),
    );

    const stored = await File.findOne({ user: user.id, context: 'image_generation' }).lean();
    expect(stored).not.toBeNull();
    expect(stored.context).toBe('image_generation');
    expect(stored.filepath).toBe(res.body.file.filepath);
    expect(stored.metadata.imageGen.predictionId).toBe('pred-real-123');
    expect(stored.width).toBe(3);
    expect(stored.height).toBe(2);

    expect(mockCacheDelete).toHaveBeenCalledWith('pred-real-123');
  });
});

describe('GET /api/images/ — DB-level pagination with _id cursor (I-1/I-2)', () => {
  const seed = async (userId, n) => {
    const docs = [];
    for (let i = 0; i < n; i++) {
      docs.push({
        file_id: `img-${i}`,
        user: userId,
        context: 'image_generation',
        filename: `img-${i}.png`,
        filepath: `/images/${userId}/img-${i}.png`,
        object: 'file',
        type: 'image/png',
        bytes: 1,
        source: 'local',
      });
    }
    return File.insertMany(docs);
  };

  it('returns only the requested page and a monotonic _id nextCursor', async () => {
    const { app, user } = createApp();
    await seed(user.id, 5);

    const res = await request(app).get('/api/images/?limit=3');

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(3);
    expect(res.body.nextCursor).toBe(res.body.images[res.body.images.length - 1]._id);
  });

  it('returns null nextCursor when fewer than limit remain', async () => {
    const { app, user } = createApp();
    await seed(user.id, 2);

    const res = await request(app).get('/api/images/?limit=30');

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(2);
    expect(res.body.nextCursor).toBeNull();
  });

  it('advances past the cursor on the next page with no overlap', async () => {
    const { app, user } = createApp();
    await seed(user.id, 5);

    const first = await request(app).get('/api/images/?limit=3');
    expect(first.body.images).toHaveLength(3);
    const cursor = first.body.nextCursor;

    const second = await request(app).get(`/api/images/?limit=3&cursor=${cursor}`);
    expect(second.status).toBe(200);
    expect(second.body.images).toHaveLength(2);
    expect(second.body.nextCursor).toBeNull();

    const firstIds = new Set(first.body.images.map((f) => f._id));
    for (const f of second.body.images) {
      expect(firstIds.has(f._id)).toBe(false);
    }
  });

  it("only returns the requesting user's image_generation files", async () => {
    const { app, user } = createApp();
    await seed(user.id, 2);
    await seed(new mongoose.Types.ObjectId().toString(), 3);
    await File.create({
      file_id: 'other-context',
      user: user.id,
      context: 'message_attachment',
      filename: 'doc.png',
      filepath: '/images/doc.png',
      object: 'file',
      type: 'image/png',
      bytes: 1,
      source: 'local',
    });

    const res = await request(app).get('/api/images/');

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(2);
    for (const f of res.body.images) {
      expect(f.context).toBe('image_generation');
    }
  });
});

describe('GET /api/images/ — refreshes S3 signed URLs on read', () => {
  it('replaces each returned filepath with a freshly signed URL', async () => {
    const { app, user } = createApp();
    await File.insertMany([
      {
        file_id: 's3-1',
        user: user.id,
        context: 'image_generation',
        filename: 's3-1.png',
        filepath: 'https://r2.example.com/images/s3-1.png?X-Amz-Expires=120',
        object: 'file',
        type: 'image/png',
        bytes: 1,
        source: 's3',
        storageKey: 'images/user/s3-1.png',
      },
      {
        file_id: 's3-2',
        user: user.id,
        context: 'image_generation',
        filename: 's3-2.png',
        filepath: 'https://r2.example.com/images/s3-2.png?X-Amz-Expires=120',
        object: 'file',
        type: 'image/png',
        bytes: 1,
        source: 's3',
        storageKey: 'images/user/s3-2.png',
      },
    ]);
    mockRefreshS3Url.mockImplementation(async (file) => `${file.filepath}&signed=fresh`);

    const res = await request(app).get('/api/images/');

    expect(res.status).toBe(200);
    expect(res.body.images).toHaveLength(2);
    expect(mockRefreshS3Url).toHaveBeenCalledTimes(2);
    for (const f of res.body.images) {
      expect(f.filepath).toMatch(/&signed=fresh$/);
    }
  });

  it('leaves non-s3 (local) filepaths unchanged', async () => {
    const { app, user } = createApp();
    await File.create({
      file_id: 'local-1',
      user: user.id,
      context: 'image_generation',
      filename: 'local-1.png',
      filepath: '/images/user/local-1.png',
      object: 'file',
      type: 'image/png',
      bytes: 1,
      source: 'local',
    });

    const res = await request(app).get('/api/images/');

    expect(res.status).toBe(200);
    expect(res.body.images[0].filepath).toBe('/images/user/local-1.png');
  });
});
