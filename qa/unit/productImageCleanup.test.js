const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';
process.env.CLOUDINARY_CLOUD_NAME = 'demo';

const httpPath = require.resolve('../../utils/cloudinaryHttp');
const calls = [];
let response = {};
require.cache[httpPath] = {
  id: httpPath,
  filename: httpPath,
  loaded: true,
  exports: {
    cloudinaryRequest: async (method, path) => {
      calls.push({ method, path });
      return response;
    },
  },
};

const { destroyCloudinaryImage } = require('../../utils/cloudinaryDestroy');

test('destroyCloudinaryImage usa DELETE sobre resources/image/upload', async () => {
  calls.length = 0;
  response = { deleted: { 'carpeta/foto': 'deleted' } };
  await destroyCloudinaryImage('carpeta/foto');
  assert.equal(calls[0].method, 'DELETE');
  assert.equal(calls[0].path, '/v1_1/demo/resources/image/upload?public_ids%5B%5D=carpeta%2Ffoto');
});

test('destroyCloudinaryImage rechaza si el asset no existía (not_found)', async () => {
  response = { deleted: { x: 'not_found' } };
  await assert.rejects(destroyCloudinaryImage('x'), /no confirmó/);
});

test('destroyCloudinaryImage rechaza si Cloudinary responde con error', async () => {
  response = { error: { message: 'Invalid credentials' } };
  await assert.rejects(destroyCloudinaryImage('x'), /no confirmó/);
});
