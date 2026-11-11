import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import router from '../src/routes/translate.js';
import mongoose from 'mongoose';
import { AiModel } from '../src/models/AiModel.js';
import { Translation } from '../src/models/Translation.js';

test('manga preserves duplicate items and supplies context without Mongo translation cache', async () => {
  const previousKey = process.env.APP_KEY;
  const previousState = mongoose.connection.readyState;
  const findOne = AiModel.findOne;
  const find = Translation.find;
  const originalFetch = globalThis.fetch;
  process.env.APP_KEY = 'test-key';
  mongoose.connection.readyState = 1;
  AiModel.findOne = () => ({ lean: async () => ({ code: 'test', baseUrl: 'https://model.test', apiKey: 'secret' }) });
  Translation.find = () => { throw new Error('Manga must not read translation cache'); };
  let modelRequest;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://model.test')) {
      modelRequest = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '["Anh","Em"]' } }] }));
    }
    return originalFetch(url, options);
  };
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/translate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-app-key': 'test-key' },
      body: JSON.stringify({ texts: ['You', 'You'], targetLang: 'vi', model: 'test', mode: 'manga', context: [[{ source: 'Brother', translation: 'Anh trai' }]] }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).translations, ['Anh', 'Em']);
    assert.match(JSON.stringify(modelRequest.messages), /Brother/);
  } finally {
    globalThis.fetch = originalFetch;
    AiModel.findOne = findOne;
    Translation.find = find;
    mongoose.connection.readyState = previousState;
    if (previousKey === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = previousKey;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('rejects invalid modes and context before model calls', async () => {
  const previous = process.env.APP_KEY;
  process.env.APP_KEY = 'test-key';
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const invalid = [
      { mode: 'unknown' },
      { mode: 'manga', context: 'bad' },
      { mode: 'manga', context: [[{ source: 42, translation: 'a' }]] },
      { mode: 'manga', context: Array(4).fill([{ source: 'a', translation: 'b' }]) },
      { mode: 'manga', context: [[{ source: 'a'.repeat(6000), translation: 'b' }]] },
      { mode: 'game', context: [[{ source: 'a', translation: 'b' }]] },
    ];
    for (const options of invalid) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-app-key': 'test-key' },
        body: JSON.stringify({ texts: ['Hi'], targetLang: 'vi', model: 'test', ...options }),
      });
      assert.equal(response.status, 400, JSON.stringify(options));
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.APP_KEY; else process.env.APP_KEY = previous;
  }
});
