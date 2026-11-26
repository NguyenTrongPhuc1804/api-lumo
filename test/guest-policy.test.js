import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startTestServer } from './helpers/test-app.js';
import { createQuotaPolicyRouter } from '../src/routes/quotaPolicy.js';
import { GuestTrial, signGuestToken, readGuestToken } from '../src/services/guestTrial.js';
import { QuotaPolicy } from '../src/services/quotaPolicy.js';
import { AiUsage } from '../src/services/aiUsage.js';
import { verifyModel } from '../src/services/aiTranslation.js';
import { AiModel } from '../src/models/AiModel.js';
import { Translation } from '../src/models/Translation.js';
import mongoose from 'mongoose';
import translateRouter from '../src/routes/translate.js';
import { verifyToken } from '../src/services/tokens.js';

process.env.AI_PROVIDER_ALLOWED_ORIGINS = 'https://model.test';
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

test('Guest dùng đúng model chỉ định, chung lượt ML Kit và không mất lượt khi AI lỗi', async (t) => {
  let used = 0;
  let calls = 0;
  let fail = true;
  const requests = new Set();
  t.mock.method(QuotaPolicy, 'findById', async () => ({ guestLimit: 2, sharedAiModelId: 'selected' }));
  t.mock.method(GuestTrial, 'findById', async () => ({ used, basicRequests: [...requests] }));
  t.mock.method(GuestTrial, 'updateOne', async (filter, update) => {
    if (update.$pull && requests.delete(filter.basicRequests)) used--;
  });
  t.mock.method(GuestTrial, 'findOneAndUpdate', async (filter, update) => {
    const id = update.$push?.basicRequests;
    if (used >= filter.used.$lt || requests.has(id)) return null;
    requests.add(id);
    return { used: ++used };
  });
  t.mock.method(AiModel, 'findOne', ({ code }) => ({ lean: async () => ({ _id: code, code, baseUrl: 'https://model.test', apiKey: 'test-key' }) }));
  let cached = [];
  t.mock.method(Translation, 'find', async () => cached);
  t.mock.method(Translation, 'bulkWrite', async (ops) => { cached = ops.map(({ updateOne }) => updateOne.update.$set); });
  t.mock.method(AiUsage, 'updateOne', async () => {});
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (!String(url).startsWith('https://model.test')) return realFetch(url, options);
    calls++;
    if (fail) throw new Error('AI down');
    return new Response(JSON.stringify({ choices: [{ message: { content: '["Chào"]' } }] }));
  });
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  const server = await startTestServer(translateRouter);
  const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const body = { requestId, texts: ['Hi'], targetLang: 'vi', model: 'selected' };
  const post = (path, body) => fetch(`${server.baseUrl}/api/guest/${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${signGuestToken('installation')}` },
  });
  try {
    assert.equal((await post('ai-translation', { ...body, model: 'other' })).status, 403);
    assert.equal((await post('ai-translation', { ...body, mode: 'manga' })).status, 403);
    assert.equal((await post('basic-translation', { requestId })).status, 200);
    assert.equal((await post('ai-translation', body)).status, 502);
    assert.equal(used, 1);
    fail = false;
    assert.equal((await post('ai-translation', body)).status, 200);
    assert.equal((await post('ai-translation', body)).status, 200);
    assert.equal((await post('ai-translation', { ...body, requestId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' })).status, 429);
    assert.equal(used, 2);
    assert.equal(calls, 2);
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
