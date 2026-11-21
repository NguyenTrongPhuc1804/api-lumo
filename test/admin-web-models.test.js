import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import mongoose from 'mongoose';
import * as models from '../src/routes/models.js';
import { createAdminWebAuth } from '../src/routes/adminWebAuth.js';
import { AiModel } from '../src/models/AiModel.js';
import { User } from '../src/models/User.js';
import { startTestServer } from './helpers/test-app.js';

const path = '/admin-web/models';
const origin = 'https://admin.example';
const password = 'fixture-password';
const salt = Buffer.alloc(16, 1);
const config = {
  ADMIN_WEB_ALLOWED_ORIGINS: origin,
  ADMIN_WEB_USERNAME: 'owner',
  ADMIN_WEB_PASSWORD_HASH: `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('hex')}`,
};
const id = '507f1f77bcf86cd799439011';
const baseUrl = 'https://models.example';
const otherUrl = 'https://other-models.example';
const apiKey = 'saved-fixture-key';
const newKey = 'new-fixture-key';

async function setup(t, rows = []) {
  const auth = createAdminWebAuth(config);
  const router = express.Router();
  router.use('/admin-web', auth.cors);
  router.use('/admin-web/auth', auth.router);
  if (models.createAdminModelsRouter) {
    router.use('/admin-web', models.createAdminModelsRouter({ prefix: '', authorize: auth.requireSession, web: true }));
  }
  const server = await startTestServer(router);
  t.after(() => server.close());
  const state = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = state; });

  const httpFetch = globalThis.fetch;
  const upstream = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const key = options.headers.Authorization;
    const model = JSON.parse(options.body).model;
    if (model === 'failing') return new Response(key, { status: 401 });
    if (model === 'redirecting') {
      if (options.redirect === 'error') throw new Error(`Redirect rejected: ${key}`);
      return Response.json({ choices: [{ message: { content: '["redirect followed"]' } }] });
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify([key]) } }] });
  });
  t.mock.method(AiModel, 'find', () => ({ sort: () => ({ lean: async () => rows }) }));
  t.mock.method(AiModel, 'findOne', async ({ code }) => rows.find((row) => row.code === code));
  t.mock.method(AiModel, 'distinct', async (field, { apiKey: key }) => [...new Set(rows.filter((row) => row.apiKey === key).map((row) => row[field]))]);
  t.mock.method(AiModel, 'findById', (value) => {
    const row = rows.find((row) => row._id === value);
    const query = Promise.resolve(row && {
      ...row, toObject() { return this; }, async save() { Object.assign(row, this.toObject()); },
    });
    return Object.assign(query, { select: () => ({ lean: async () => row }) });
  });
  t.mock.method(AiModel, 'create', async (fields) => {
    const row = { _id: id, ...fields };
    rows.push(row);
    return { toObject: () => row };
  });
  t.mock.method(AiModel, 'findByIdAndDelete', async (value) => {
    const index = rows.findIndex((row) => row._id === value);
    return index < 0 ? null : rows.splice(index, 1)[0];
  });

  const call = (endpoint, { method = 'GET', token, body, headers } = {}) => httpFetch(`${server.baseUrl}/api${endpoint}`, {
    method, body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }), ...headers },
  });
  const login = async (username) => {
    const response = await call('/admin-web/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };
  return { call, login, upstream };
}

test('web preflight allowlisted hỗ trợ PUT và DELETE', async (t) => {
  const { call } = await setup(t);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const headers = { 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization,content-type' };
    const res = await call(`${path}/${id}`, { method: 'OPTIONS', headers });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.ok(res.headers.get('access-control-allow-methods').split(/,\s*/).includes(method));
    const denied = await call(`${path}/${id}`, { method: 'OPTIONS', headers: { ...headers, Origin: 'https://outside.example' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  }
});

const fixture = { _id: id, code: 'test', name: 'Test', description: '', baseUrl, apiKey, enabled: false, order: 2 };

test('web chỉ gửi khóa phù hợp với đích và không phản hồi nội dung lỗi upstream', async (t) => {
  const { call, login, upstream } = await setup(t, [{ ...fixture }, { ...fixture, _id: '507f1f77bcf86cd799439012', code: 'legacy', apiKey: '' }]);
  const token = await login('owner');
  const verify = (body) => call(`${path}/verify`, { method: 'POST', token, body });
  const edit = (body) => call(`${path}/${id}`, { method: 'PUT', token, body });
  const create = (body) => call(path, { method: 'POST', token, body: { name: 'New', code: 'new', ...body } });
  for (const res of [
    await verify({ id, model: 'test', baseUrl: otherUrl }),
    await verify({ id, model: 'test', baseUrl: '' }),
    await verify({ id, model: 'test', baseUrl: otherUrl, apiKey }),
    await verify({ model: 'test', baseUrl: otherUrl, apiKey }),
    await create({ baseUrl: otherUrl, apiKey }),
    await verify({ model: 'test', baseUrl: otherUrl, apiKey: ' ' }),
    await verify({ id: '507f1f77bcf86cd799439012', model: 'legacy' }),
    await edit({ baseUrl: otherUrl }), await edit({ baseUrl: '' }), await create({ baseUrl: otherUrl }),
    await call(`${path}/507f1f77bcf86cd799439012`, { method: 'PUT', token, body: { enabled: true } }),
  ]) assert.equal(res.status, 400);
  assert.equal(upstream.mock.callCount(), 0);
  assert.equal((await edit({ baseUrl: otherUrl, apiKey: newKey })).status, 200);
  assert.equal(upstream.mock.calls[0].arguments[0], `${otherUrl}/v1/chat/completions`);
  assert.equal(upstream.mock.calls[0].arguments[1].headers.Authorization, `Bearer ${newKey}`);
  for (const res of [
    await verify({ id, model: 'failing' }), await verify({ id, model: 'redirecting' }), await edit({ code: 'failing' }),
    await create({ code: 'failing', baseUrl: otherUrl, apiKey: newKey }),
  ]) {
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(typeof body.error, 'string');
    assert.ok(!body.error.includes(newKey));
  }
});

test('web models chỉ cho owner và admin đọc, chỉ owner thấy khóa đã che', async (t) => {
  const { call, login, upstream } = await setup(t, [fixture]);
  const users = ['admin', 'viewer', 'pending'].map((role) => ({
    _id: role, provider: 'web', status: 'active', webAdmin: {
      loginEmail: `${role}@example.com`, passwordHash: config.ADMIN_WEB_PASSWORD_HASH,
      role: role === 'pending' ? 'admin' : role, credentialVersion: role, mustChangePassword: role === 'pending',
    },
  }));
  t.mock.method(User, 'findOne', async (filter) => users.find((user) => user.webAdmin.loginEmail === filter['webAdmin.loginEmail']));
  t.mock.method(User, 'findById', async (value) => users.find((user) => user._id === value));
  const owner = await login('owner');
  const admin = await login('admin@example.com');
  const viewer = await login('viewer@example.com');
  const pending = await login('pending@example.com');
  const expected = { id, code: 'test', name: 'Test', description: '', baseUrl, enabled: false, order: 2 };
  for (const [token, item] of [[owner, { ...expected, apiKey: 'sav...-key' }], [admin, expected]]) {
    const response = await call(path, { token });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [item]);
  }
  for (const token of [viewer, pending]) assert.equal((await call(path, { token })).status, 403);
  for (const [method, endpoint] of [['GET', path], ['POST', path], ['POST', `${path}/verify`], ['PUT', `${path}/${id}`], ['DELETE', `${path}/${id}`]]) {
    assert.equal((await call(endpoint, { method, token: 'mobile-token' })).status, 401);
    if (method === 'GET') continue;
    for (const token of [admin, viewer, pending]) assert.equal((await call(endpoint, { method, token })).status, 403);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test('owner tạo, sửa, bật tắt, xác thực và xóa model', async (t) => {
  const { call, login, upstream } = await setup(t);
  const token = await login('owner');
  const input = { code: 'test', name: 'Test', baseUrl, apiKey, order: 2 };
  const created = await call(path, { token, method: 'POST', body: input });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).model.apiKey, 'sav...-key');
  const endpoint = `${path}/${id}`;
  const updated = await call(endpoint, { token, method: 'PUT', body: { name: 'Changed', enabled: false } });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).model.enabled, false);
  assert.equal(upstream.mock.callCount(), 1);
  assert.equal((await (await call(path, { token })).json())[0].name, 'Changed');
  const verified = await call(`${path}/verify`, { token, method: 'POST', body: { id, model: 'test', baseUrl } });
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { ok: true });
  assert.equal(upstream.mock.calls[1].arguments[1].headers.Authorization, `Bearer ${apiKey}`);
  const deleted = await call(endpoint, { token, method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await (await call(path, { token })).json(), []);
});
