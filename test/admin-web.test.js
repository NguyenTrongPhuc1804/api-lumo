import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scryptSync } from 'node:crypto';
import express from 'express';
import { createAdminWebAuth } from '../src/routes/adminWebAuth.js';
import { createAdminUsersRouter } from '../src/routes/adminUsers.js';
import { User } from '../src/models/User.js';
import { DailyQuota } from '../src/models/DailyQuota.js';
import { createAuthRouter } from '../src/routes/auth.js';
import { signToken } from '../src/services/tokens.js';
import { Types } from 'mongoose';

async function serveAccounts(t) {
  const auth = createAdminWebAuth(config);
  const app = express();
  app.use('/api/admin-web', auth.cors);
  app.use(express.json());
  app.use('/api/admin-web/auth', auth.router);
  app.use('/api/admin-web', createAdminUsersRouter({ prefix: '', authorize: auth.requireSession }));
  app.use('/api', createAdminUsersRouter(), createAuthRouter());
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return (path, body, token) => fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

const userId = '507f1f77bcf86cd799439011';
const mobileAdminId = '507f1f77bcf86cd799439012';
const otherWebAdminId = '507f1f77bcf86cd799439013';

test('owner quản lý tài khoản web độc lập và phiên viewer chỉ được đọc', async (t) => {
  const call = await serveAccounts(t);
  const web = '/admin-web';
  const accounts = `${web}/auth/accounts`;
  const session = `${web}/auth/session`;
  const login = async (username, password) => {
    const response = await call(`${web}/auth/login`, { username, password });
    assert.equal(response.status, 200);
    return response.json();
  };
  const owner = await login('test-admin', 'test-only-password');
  assert.equal((await call(accounts)).status, 401);
  const input = { email: ' VIEWER@EXAMPLE.COM ', password: 'temp', role: 'viewer' };
  for (const invalid of [{ role: 'owner' }, { role: 'Viewer' }, { email: 'a@' }, { email: `${'x'.repeat(254)}@x.com` }, { password: ' ' }]) {
    assert.equal((await call(accounts, { ...input, ...invalid }, owner.token)).status, 400);
  }

  process.env.JWT_SECRET = 'test-secret';
  process.env.QUOTA_HMAC_SECRET = 'test-quota-secret';
  const googleId = new Types.ObjectId().toString();
  const users = new Map([[googleId, {
    _id: googleId, provider: 'google', providerId: 'google-fixture', role: 'admin', status: 'active',
    email: 'google@example.com', webAdmin: { loginEmail: 'google@example.com', credentialVersion: 'existing' },
  }], [userId, { _id: userId, provider: 'google', providerId: 'other-google', role: 'user', status: 'active', email: 'viewer@example.com' }]]);
  t.mock.method(User.collection, 'insertOne', async (user) => {
    if ([...users.values()].some((row) => row.webAdmin?.loginEmail === user.webAdmin.loginEmail)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    users.set(String(user._id), structuredClone({ ...user, _id: String(user._id) }));
    return { insertedId: user._id };
  });
  t.mock.method(User, 'findOne', async (filter) => structuredClone([...users.values()].find((user) =>
    user.webAdmin?.loginEmail === filter['webAdmin.loginEmail'] && filter.provider.$in.includes(user.provider))));
  t.mock.method(User, 'findById', async (id) => structuredClone(users.get(String(id))));
  function matches(user, filter) {
    return Object.entries(filter).every(([field, expected]) => {
      if (field === '$and') return expected.every((part) => matches(user, part));
      if (field === '$or') return expected.some((part) => matches(user, part));
      const value = field === 'webAdmin.role' ? user.webAdmin?.role : user[field];
      if (expected instanceof RegExp) return typeof value === 'string' && expected.test(value);
      if (typeof expected === 'object' && '$ne' in expected) return value !== expected.$ne;
      return value === expected;
    });
  }
  const matchingUsers = (filter) => [...users.values()].filter((user) => matches(user, filter));
  t.mock.method(User, 'find', (filter) => {
    const items = matchingUsers(filter);
    return { sort: () => Object.assign(Promise.resolve(items), { skip: (offset) => ({ limit: async (limit) => items.slice(offset, offset + limit) }) }) };
  });
  t.mock.method(User, 'countDocuments', async (filter) => matchingUsers(filter).length);
  t.mock.method(User, 'updateOne', async (filter, { $set }) => {
    const user = users.get(String(filter._id));
    if (!user || filter.provider !== user.provider) return { matchedCount: 0 };
    const version = filter['webAdmin.credentialVersion'];
    if (version && (version.$exists === false ? user.webAdmin : version !== user.webAdmin?.credentialVersion)) return { matchedCount: 0 };
    if ($set.webAdmin && [...users.values()].some((row) => row !== user && row.webAdmin?.loginEmail === $set.webAdmin.loginEmail)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    for (const [field, value] of Object.entries($set)) {
      if (field.startsWith('webAdmin.')) user.webAdmin[field.split('.')[1]] = value;
      else user[field] = value;
    }
    return { matchedCount: 1 };
  });
  t.mock.method(User, 'deleteOne', async (filter) => ({ deletedCount: users.get(String(filter._id))?.provider === filter.provider && users.delete(String(filter._id)) ? 1 : 0 }));

  t.mock.method(DailyQuota, 'find', async () => []);
  const loginEmailIndex = User.schema.indexes().find(([fields]) => fields['webAdmin.loginEmail'] === 1);
  assert.equal(loginEmailIndex?.[1].unique, true);
  assert.deepEqual(loginEmailIndex[1].partialFilterExpression, { 'webAdmin.loginEmail': { $type: 'string' } });
  const responses = await Promise.all([call(accounts, input, owner.token), call(accounts, input, owner.token)]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [201, 409]);
  const { id, ...details } = await responses.find((res) => res.status === 201).json();
  assert.deepEqual(details, { email: 'viewer@example.com', role: 'viewer' });
  assert.deepEqual(await (await call(accounts, undefined, owner.token)).json(), { items: [{ id, ...details }] });
  const ownerList = async (query = '') => {
    const response = await call(`${web}/users${query}`, undefined, owner.token);
    assert.equal(response.status, 200);
    return response.json();
  };
  const { items: sameEmail, total: sameEmailTotal } = await ownerList('?q=viewer%40example.com');
  assert.equal(sameEmailTotal, 2);
  assert.deepEqual(sameEmail.map(({ id, provider }) => [id, provider]), [[userId, 'google'], [id, 'web']]);
  const webRow = sameEmail[1];
  assert.equal(webRow.role, 'user');
  assert.equal(webRow.webAdminRole, 'viewer');
  for (const field of ['dailyLimit', 'usageCount', 'providerId', 'webAdmin']) assert.equal(Object.hasOwn(webRow, field), false);
  const usersPage = await ownerList('?q=viewer%40example.com&role=user&limit=1&page=2');
  assert.equal(usersPage.total, 2);
  assert.deepEqual(usersPage.items.map((item) => item.id), [id]);
  assert.deepEqual((await ownerList('?role=admin')).items.map((item) => item.id), [googleId]);
  const original = users.get(id);
  assert.equal(original.provider, 'web');
  assert.match(original.webAdmin.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const pending = await login(details.email, 'temp');
  assert.deepEqual(await (await call(session, undefined, pending.token)).json(), { username: details.email, role: 'viewer', mustChangePassword: true });
  assert.equal((await call(`${web}/users`, undefined, pending.token)).status, 403);
  const changed = await call(`${web}/auth/change-password`, { password: 'new' }, pending.token);
  assert.equal(changed.status, 200);
  const viewer = await changed.json();
  assert.equal(viewer.role, 'viewer');
  assert.equal((await call(session, undefined, pending.token)).status, 401);
  for (const [path, token] of [[`${web}/users`, viewer.token], ['/admin/users', signToken(googleId)]]) {
    const list = await call(path, undefined, token);
    assert.equal(list.status, 200);
    const { items, total } = await list.json();
    assert.equal(total, 2);
    assert.deepEqual(items.map((item) => item.id).sort(), [googleId, userId].sort());
  }
  assert.equal((await call('/me', undefined, signToken(id))).status, 401);
  assert.equal((await call(`/admin/users/${id}/block`, {}, signToken(googleId))).status, 404);
  assert.equal((await call(accounts, { ...input, email: ' GOOGLE@EXAMPLE.COM ' }, owner.token)).status, 409);
  assert.equal((await call(`${web}/auth/users/${userId}/grant`, { password: 'temp' }, owner.token)).status, 409);
  assert.equal((await call(`${accounts}/${googleId}/revoke`, {}, owner.token)).status, 404);
  assert.equal((await call(`${accounts}/${googleId}/role`, { role: 'viewer' }, owner.token)).status, 404);
  assert.equal((await call(`${accounts}/${googleId}/reset-password`, { password: 'temp' }, owner.token)).status, 404);
  // Quyền phiên lấy từ DB, không lấy từ lúc phát token.
  original.webAdmin.role = 'admin';
  assert.equal((await (await call(session, undefined, viewer.token)).json()).role, 'admin');
  original.webAdmin.role = 'viewer';
  for (const action of ['block', 'unblock']) assert.equal((await call(`${web}/users/${userId}/${action}`, {}, viewer.token)).status, 403);
  assert.equal((await call(accounts, undefined, viewer.token)).status, 403);
  assert.equal((await call(accounts, input, viewer.token)).status, 403);
  const account = `${accounts}/${id}`;
  for (const action of ['role', 'reset-password', 'revoke']) assert.equal((await call(`${account}/${action}`, {}, viewer.token)).status, 403);
  assert.equal((await call(`${web}/users/${id}/block`, {}, owner.token)).status, 404);
  assert.equal((await call(`${web}/auth/users/${id}/revoke`, {}, owner.token)).status, 404);
  assert.equal((await call(`${account}/role`, { role: 'owner' }, owner.token)).status, 400);
  assert.deepEqual(await (await call(`${account}/role`, { role: 'admin' }, owner.token)).json(), { ok: true });
  assert.equal((await call(session, undefined, viewer.token)).status, 401);
  const admin = await login(details.email, 'new');
  assert.equal(admin.role, 'admin');
  assert.deepEqual((await ownerList('?role=admin')).items.map(({ id, role }) => [id, role]), [[googleId, 'admin'], [id, 'admin']]);
  assert.equal((await (await call(`${web}/users`, undefined, admin.token)).json()).items.some((item) => item.provider === 'web'), false);
  assert.equal((await call(accounts, input, admin.token)).status, 403);
  assert.deepEqual(await (await call(`${account}/reset-password`, { password: 'reset' }, owner.token)).json(), { ok: true });
  assert.equal((await call(session, undefined, admin.token)).status, 401);
  const reset = await login(details.email, 'reset');
  assert.equal(reset.role, 'admin');
  assert.equal(reset.mustChangePassword, true);
  const oldVersion = original.webAdmin.credentialVersion;
  assert.deepEqual(await (await call(`${account}/revoke`, {}, owner.token)).json(), { ok: true });
  assert.equal(users.has(id), false);
  const remaining = await ownerList('?q=viewer%40example.com');
  assert.equal(remaining.total, 1);
  assert.deepEqual(remaining.items.map(({ id, provider }) => [id, provider]), [[userId, 'google']]);
  const regrant = await call(accounts, input, owner.token);
  assert.equal(regrant.status, 201);
  const { id: newId } = await regrant.json();
  assert.notEqual(newId, id);
  assert.notEqual(users.get(newId).webAdmin.credentialVersion, oldVersion);
  assert.equal((await call(session, undefined, reset.token)).status, 401);
});

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
  assert.deepEqual(listFilter.$and, [{ $or: [
    { provider: { $ne: 'web' }, role: 'user' },
    { provider: 'web', 'webAdmin.role': 'viewer' },
  ] }]);
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
    for (const [field, value] of Object.entries(update.$set ?? {})) {
      if (field.startsWith('webAdmin.')) user.webAdmin[field.split('.')[1]] = value;
    }
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
  // Quyền Google cũ chưa lưu vai trò web vẫn được xem là admin.
  delete user.webAdmin.role;
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
