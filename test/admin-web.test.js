import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import express from 'express';
import { createAdminWebAuth } from '../src/routes/adminWebAuth.js';
import { createAdminUsersRouter } from '../src/routes/adminUsers.js';
import { User } from '../src/models/User.js';

const origin = 'http://127.0.0.1:5178';
const salt = '0123456789abcdef0123456789abcdef';
const config = { ADMIN_WEB_ALLOWED_ORIGINS: `${origin}, https://admin.example`, ADMIN_WEB_USERNAME: 'test-admin', ADMIN_WEB_PASSWORD_HASH: `${salt}:${scryptSync('test-only-password', Buffer.from(salt, 'hex'), 64).toString('hex')}` };

test('CORS chỉ cho phép các origin trong danh sách gọi API web admin', async (t) => {
  const auth = createAdminWebAuth({ ...config, NODE_ENV: 'production' });
  const app = express();
  app.use('/admin-web', auth.cors);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/admin-web/users`;
  const preflight = (host) => fetch(url, { method: 'OPTIONS', headers: {
    Origin: host, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type',
  } });
  for (const host of [origin, 'https://admin.example']) {
    const response = await preflight(host);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), host);
    assert.match(response.headers.get('access-control-allow-headers'), /authorization/i);
    assert.match(response.headers.get('access-control-allow-headers'), /content-type/i);
    assert.equal(response.headers.get('vary'), 'Origin');
  }
  const denied = await preflight('https://admin.example.evil.example');
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('Bearer token riêng của web admin bảo vệ danh sách và bị thu hồi khi đăng xuất', async (t) => {
  const auth = createAdminWebAuth(config);
  const app = express();
  app.use(auth.cors, express.json());
  app.use('/auth', auth.router);
  app.use(createAdminUsersRouter({ prefix: '', authorize: auth.requireSession }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, { token, host = origin, password = 'test-only-password' } = {}) => fetch(base + path, {
    method: 'POST', headers: { Origin: host, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ username: 'test-admin', password }),
  });
  assert.equal((await fetch(`${base}/users`, { headers: { Authorization: 'Bearer mobile-token' } })).status, 401);
  assert.equal((await post('/auth/login', { password: 'wrong' })).status, 401);
  assert.equal((await post('/auth/login', { host: 'https://other.example' })).status, 403);
  const login = await post('/auth/login');
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('set-cookie'), null);
  assert.equal(login.headers.get('cache-control'), 'no-store');
  assert.equal(login.headers.get('access-control-allow-origin'), origin);
  const { token } = await login.json();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await fetch(`${base}/users`, { headers: { Cookie: `lumo_admin_session=${token}` } })).status, 401);
  let listFilter;
  let countFilter;
  t.mock.method(User, 'find', (filter) => {
    listFilter = filter;
    return { sort: () => ({ skip: (offset) => ({ limit: async () => { assert.equal(offset, 10); return []; } }) }) };
  });
  t.mock.method(User, 'countDocuments', async (filter) => { countFilter = filter; return 13; });
  const response = await fetch(`${base}/users?q=a.b&role=user&status=blocked&page=2&limit=10`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 13);
  assert.deepEqual(listFilter, countFilter);
  assert.equal(listFilter.role, 'user');
  assert.equal(listFilter.status, 'blocked');
  assert.equal(listFilter.$or[0].name.test('a.b'), true);
  assert.equal(listFilter.$or[0].name.test('axb'), false);
  assert.equal((await post('/users/123/block', { token, host: 'https://other.example' })).status, 403);
  assert.equal((await post('/auth/logout', { token })).status, 200);
  assert.equal((await fetch(`${base}/users`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } })).status, 401);
});
