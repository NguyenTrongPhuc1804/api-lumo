import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import express from 'express';
import { createAdminWebAuth } from '../src/routes/adminWebAuth.js';
import { createAdminUsersRouter } from '../src/routes/adminUsers.js';
import { User } from '../src/models/User.js';
import { DailyQuota } from '../src/models/DailyQuota.js';

const userId = '507f1f77bcf86cd799439011';
const mobileAdminId = '507f1f77bcf86cd799439012';
const otherWebAdminId = '507f1f77bcf86cd799439013';

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
  let now = Date.now();
  const auth = createAdminWebAuth(config, () => now);
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
  const { token: expiring } = await (await post('/auth/login')).json();
  now += 8 * 60 * 60 * 1000;
  assert.equal((await fetch(`${base}/auth/session`, { headers: { Authorization: `Bearer ${expiring}` } })).status, 401);
  assert.equal((await post('/auth/login')).status, 200);
  assert.equal((await post('/auth/login')).status, 200);
  assert.equal((await post('/auth/login')).status, 429);
});

test('phiên web được cấp quyền, đổi mật khẩu và không sống lại sau khi thu hồi', async (t) => {
  process.env.QUOTA_HMAC_SECRET = 'test-quota-secret';
  const user = { _id: userId, email: 'user@example.com', provider: 'google', providerId: 'fixture-google-id', status: 'active', role: 'user' };
  const users = new Map([
    [userId, user],
    [mobileAdminId, { _id: mobileAdminId, role: 'admin' }],
    [otherWebAdminId, { _id: otherWebAdminId, webAdmin: { credentialVersion: 'other' } }],
    ['507f1f77bcf86cd799439014', { provider: 'facebook', status: 'active', email: 'facebook@example.com' }],
    ['507f1f77bcf86cd799439015', { provider: 'google', status: 'blocked', email: 'blocked@example.com' }],
    ['507f1f77bcf86cd799439016', { provider: 'google', status: 'active', email: '' }],
  ]);
  t.mock.method(User, 'findById', async (id) => structuredClone(users.get(id.toLowerCase())));
  t.mock.method(User, 'findOne', async (filter) => user.webAdmin?.loginEmail === filter['webAdmin.loginEmail'] && filter.status.$in.includes(user.status) ? structuredClone(user) : null);
  t.mock.method(User, 'updateOne', async (filter, update) => {
    if (filter._id !== userId) return { matchedCount: 0 };
    const version = filter['webAdmin.credentialVersion'];
    if (version && (version.$exists === false ? Boolean(user.webAdmin) : user.webAdmin?.credentialVersion !== version)) return { matchedCount: 0 };
    if (filter.status && !filter.status.$in.includes(user.status)) return { matchedCount: 0 };
    if (update.$set?.status) user.status = update.$set.status;
    if (update.$set?.['webAdmin.credentialVersion']) user.webAdmin.credentialVersion = update.$set['webAdmin.credentialVersion'];
    if (update.$set?.webAdmin) user.webAdmin = update.$set.webAdmin;
    if (update.$unset?.webAdmin !== undefined) delete user.webAdmin;
    return { matchedCount: 1 };
  });
  t.mock.method(User, 'find', () => ({ sort: () => ({ skip: () => ({ limit: async () => [user] }) }) }));
  t.mock.method(User, 'countDocuments', async () => 1);
  t.mock.method(DailyQuota, 'find', async () => []);

  const auth = createAdminWebAuth(config);
  const app = express();
  app.use(auth.cors, express.json());
  app.use('/auth', auth.router);
  app.use(createAdminUsersRouter({ prefix: '', authorize: auth.requireSession }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, body, token) => fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const login = async (username, password) => {
    const response = await call('/auth/login', { username, password });
    assert.equal(response.status, 200);
    return response.json();
  };
  const owner = await login('test-admin', 'test-only-password');
  assert.deepEqual(await (await call('/auth/session', undefined, owner.token)).json(), { username: 'test-admin', role: 'owner', mustChangePassword: false });
  const path = `/auth/users/${userId}`;
  const password = '2';
  for (const id of ['507f1f77bcf86cd799439014', '507f1f77bcf86cd799439015', '507f1f77bcf86cd799439016']) {
    assert.equal((await call(`/auth/users/${id}/grant`, { password }, owner.token)).status, 400);
  }
  for (const invalid of ['', ' ', 2, 'x'.repeat(513)]) {
    assert.equal((await call(`${path}/grant`, { password: invalid }, owner.token)).status, 400);
  }
  assert.deepEqual(await (await call(`${path}/grant`, { password }, owner.token)).json(), { ok: true });
  assert.match(user.webAdmin.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.equal(user.role, 'user');
  const pending = await login(' USER@EXAMPLE.COM ', password);
  assert.equal(pending.mustChangePassword, true);
  assert.deepEqual(await (await call('/auth/session', undefined, pending.token)).json(), { username: user.email, role: 'admin', mustChangePassword: true });
  assert.equal((await call('/users', undefined, pending.token)).status, 403);
  assert.equal((await call(`${path}/revoke`, {}, pending.token)).status, 403);
  for (const invalid of [password, ' ', 'x'.repeat(513)]) {
    assert.equal((await call('/auth/change-password', { password: invalid }, pending.token)).status, 400);
  }
  const changed = await call('/auth/change-password', { password: '1' }, pending.token);
  assert.equal(changed.status, 200);
  const admin = await changed.json();
  const { token, ...sessionDetails } = admin;
  assert.deepEqual(sessionDetails, { username: user.email, role: 'admin', mustChangePassword: false });
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(token, pending.token);
  assert.equal((await call('/auth/session', undefined, pending.token)).status, 401);
  assert.deepEqual(await (await call('/auth/session', undefined, admin.token)).json(), { username: user.email, role: 'admin', mustChangePassword: false });
  for (const session of [owner, admin]) {
    const response = await call('/users', undefined, session.token);
    assert.equal(response.status, 200);
    const { items: [row] } = await response.json();
    assert.equal(row.webAdminGranted, true);
    assert.equal(row.webAdminLoginEmail, session.role === 'owner' ? user.email : undefined);
    for (const hidden of ['webAdmin', 'passwordHash', 'credentialVersion']) assert.equal(hidden in row, false);
  }
  for (const action of ['grant', 'reset-password', 'revoke']) {
    assert.equal((await call(`${path}/${action}`, { password }, admin.token)).status, 403);
  }
  assert.equal((await call(`/users/${userId.toUpperCase()}/block`, {}, admin.token)).status, 400);
  for (const id of [mobileAdminId, otherWebAdminId]) {
    assert.equal((await call(`/users/${id}/block`, {}, admin.token)).status, 403);
  }
  assert.equal((await call(`/users/${userId}/block`, {}, owner.token)).status, 200);
  assert.equal((await call(`/users/${userId}/unblock`, {}, owner.token)).status, 200);
  assert.equal((await call('/auth/session', undefined, admin.token)).status, 401);
  const reauthenticated = await login(user.email, '1');
  assert.equal((await call(`${path}/reset-password`, { password }, owner.token)).status, 200);
  assert.equal((await call('/auth/session', undefined, reauthenticated.token)).status, 401);
  const afterReset = await login(user.email, password);
  assert.equal(afterReset.mustChangePassword, true);
  const revokedVersion = user.webAdmin.credentialVersion;
  assert.equal((await call(`${path}/revoke`, {}, owner.token)).status, 200);
  assert.equal((await call('/auth/session', undefined, afterReset.token)).status, 401);
  assert.equal((await call(`${path}/grant`, { password }, owner.token)).status, 200);
  assert.notEqual(user.webAdmin.credentialVersion, revokedVersion);
  assert.equal((await call('/auth/session', undefined, afterReset.token)).status, 401);
  const afterGrant = await login(user.email, password);
  assert.equal((await call('/auth/logout', {}, afterGrant.token)).status, 200);
  assert.equal((await call('/auth/session', undefined, afterGrant.token)).status, 401);
});
