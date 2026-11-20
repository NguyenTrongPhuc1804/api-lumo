import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import express from 'express';
import { createAdminWebAuth } from '../src/routes/adminWebAuth.js';
import { createAdminUsersRouter } from '../src/routes/adminUsers.js';
import { User } from '../src/models/User.js';

const origin = 'http://127.0.0.1:5178';
const salt = '0123456789abcdef0123456789abcdef';
const config = { ADMIN_WEB_ORIGIN: origin, ADMIN_WEB_USERNAME: 'test-admin', ADMIN_WEB_PASSWORD_HASH: `${salt}:${scryptSync('test-only-password', Buffer.from(salt, 'hex'), 64).toString('hex')}` };

test('phiên web bảo vệ danh sách, lọc DB, chặn CSRF và thu hồi khi đăng xuất', async (t) => {
  const auth = createAdminWebAuth(config);
  const app = express();
  app.use(express.json());
  app.use('/auth', auth.router);
  app.use(createAdminUsersRouter({ prefix: '', authorize: auth.requireSession }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, { cookie, host = origin, password = 'test-only-password' } = {}) => fetch(base + path, {
    method: 'POST', headers: { Origin: host, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ username: 'test-admin', password }),
  });
  assert.equal((await fetch(`${base}/users`, { headers: { Authorization: 'Bearer mobile-token' } })).status, 401);
  assert.equal((await post('/auth/login', { password: 'wrong' })).status, 401);
  assert.equal((await post('/auth/login', { host: 'https://other.example' })).status, 403);
  const login = await post('/auth/login');
  assert.equal(login.status, 200);
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  const cookie = setCookie.split(';')[0];
  let listFilter;
  let countFilter;
  t.mock.method(User, 'find', (filter) => {
    listFilter = filter;
    return { sort: () => ({ skip: (offset) => ({ limit: async () => { assert.equal(offset, 10); return []; } }) }) };
  });
  t.mock.method(User, 'countDocuments', async (filter) => { countFilter = filter; return 13; });
  const response = await fetch(`${base}/users?q=a.b&role=user&status=blocked&page=2&limit=10`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 13);
  assert.deepEqual(listFilter, countFilter);
  assert.equal(listFilter.role, 'user');
  assert.equal(listFilter.status, 'blocked');
  assert.equal(listFilter.$or[0].name.test('a.b'), true);
  assert.equal(listFilter.$or[0].name.test('axb'), false);
  assert.equal((await post('/users/123/block', { cookie, host: 'https://other.example' })).status, 403);
  assert.equal((await post('/auth/logout', { cookie })).status, 200);
  assert.equal((await fetch(`${base}/users`, { headers: { Cookie: cookie } })).status, 401);
});
