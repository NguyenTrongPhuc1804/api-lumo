import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startTestServer } from './helpers/test-app.js';
import { createQuotaPolicyRouter } from '../src/routes/quotaPolicy.js';
import { GuestTrial, signGuestToken, readGuestToken } from '../src/services/guestTrial.js';
import { QuotaPolicy } from '../src/services/quotaPolicy.js';
import { AiUsage } from '../src/services/aiUsage.js';
import { verifyModel } from '../src/services/gemini.js';
import { AiModel } from '../src/models/AiModel.js';
import { Translation } from '../src/models/Translation.js';
import mongoose from 'mongoose';
import translateRouter from '../src/routes/translate.js';
import { verifyToken } from '../src/services/tokens.js';

process.env.JWT_SECRET = 'test-guest-key';
process.env.QUOTA_HMAC_SECRET = 'test-quota-key';

test('guest: tính cả cache, không vượt lượt khi gọi song song và hoàn khi model lỗi', async (t) => {
  let used = 0, cached = false, limit = 1, usageCalls = 0;
  t.mock.method(AiUsage, 'updateOne', async ({ _id }) => {
    assert.match(_id, /:guest$/);
    usageCalls++;
  });
  t.mock.method(QuotaPolicy, 'findById', async () => ({ guestLimit: limit, freeLimit: 29 }));
  t.mock.method(GuestTrial, 'findById', async () => ({ used }));
  t.mock.method(GuestTrial, 'updateOne', async (_filter, update) => { used += update.$inc?.used ?? 0; });
  t.mock.method(GuestTrial, 'findOneAndUpdate', async (filter) => used < filter.used.$lt ? { used: ++used } : null);
  t.mock.method(AiModel, 'findOne', (filter) => {
    assert.equal(filter.enabled, true);
    if (filter.code) assert.equal(filter.code, 'default');
    const query = { sort: () => query, lean: async () => ({ code: 'default', baseUrl: 'https://model.test', apiKey: 'test-key' }) };
    return query;
  });
  t.mock.method(Translation, 'find', async () => cached ? [{ text: 'Hi', translated: 'Chào' }] : []);
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => String(url).startsWith('https://model.test') ? Promise.reject(new Error('model down')) : realFetch(url, options));
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  const server = await startTestServer(translateRouter);
  try {
    const post = (path, body, token) => fetch(`${server.baseUrl}/api/${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    });
    const installId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const session = await (await post('guest/session', { installId })).json();
    assert.equal(session.remaining, 1);
    const translate = () => post('guest/translate', { texts: ['Hi'], targetLang: 'vi', model: 'not-allowed' }, session.token);
    assert.equal((await translate()).status, 502);
    assert.equal(used, 0);
    cached = true;
    const results = await Promise.all([translate(), translate()]);
    const ok = results.find((r) => r.status === 200);
    const exhausted = results.find((r) => r.status === 429);
    assert.equal((await ok.json()).remaining, 0);
    assert.equal((await exhausted.json()).code, 'TRIAL_EXHAUSTED');
    const renewed = await (await post('guest/session', { installId })).json();
    assert.equal(renewed.remaining, 0);
    limit = 2;
    assert.equal((await translate()).status, 200);
    assert.equal(used, 2);
    assert.equal(usageCalls, 1);
    await assert.rejects(verifyModel('default', 'https://model.test', 'test-key', true));
    assert.equal(usageCalls, 1);
  } finally {
    mongoose.connection.readyState = previous;
    await server.close();
  }
});

test('token khách không dùng làm token tài khoản', () => {
  const token = signGuestToken('installation');
  assert.equal(readGuestToken(token), 'installation');
  assert.throws(() => verifyToken(token));
});

test('quota policy: admin đọc, owner ghi, viewer bị chặn', async () => {
  let policy = { guestLimit: 3, freeLimit: 100 };
  const app = express();
  app.use(express.json());
  app.use(createQuotaPolicyRouter({
    authorize(req, res, next) { req.adminWeb = { role: req.get('role'), username: 'tester' }; next(); },
    read: async () => policy,
    save: async (next) => (policy = next),
  }));
  const server = await startTestServer(app, '/');
  try {
    const call = (role, body) => fetch(`${server.baseUrl}/quota-policy`, {
      headers: { role, 'content-type': 'application/json' },
      ...(body && { method: 'PUT', body: JSON.stringify(body) }),
    });
    assert.equal((await call('viewer')).status, 403);
    assert.equal((await call('admin')).status, 200);
    assert.equal((await call('admin', policy)).status, 403);
    assert.equal((await call('owner', { guestLimit: -1, freeLimit: 9 })).status, 400);
    const saved = await call('owner', { guestLimit: 0, freeLimit: 9, revision: 0 });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).updatedBy, 'tester');
    assert.equal(policy.freeLimit, 9);
  } finally { await server.close(); }
});
