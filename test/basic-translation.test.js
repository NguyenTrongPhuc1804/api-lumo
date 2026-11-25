import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers/test-app.js';
import translateRouter from '../src/routes/translate.js';
import { GuestTrial, signGuestToken } from '../src/services/guestTrial.js';
import { QuotaPolicy } from '../src/services/quotaPolicy.js';
import { DailyQuota } from '../src/models/DailyQuota.js';
import { User } from '../src/models/User.js';
import { signToken } from '../src/services/tokens.js';
import { CoinWallet } from '../src/services/coinWallet.js';

process.env.JWT_SECRET = 'test-guest-key';
process.env.QUOTA_HMAC_SECRET = 'test-quota-key';

test('new AI requests from Free cannot use an unpaid model or omit the model', async (t) => {
  t.mock.method(User, 'findById', async () => ({ provider: 'google', providerId: 'account', dailyLimit: 2 }));
  const server = await startTestServer(translateRouter);
  try {
    const response = await fetch(`${server.baseUrl}/api/ai-translation`, {
      method: 'POST', body: JSON.stringify({ texts: ['test'], targetLang: 'vi' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken('account')}` },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PAID_TRANSLATION_REQUIRED');
  } finally { await server.close(); }
});

test('rollout flag disables legacy account and Guest AI endpoints', async (t) => {
  const oldFlag = process.env.REQUIRE_PAID_AI;
  process.env.REQUIRE_PAID_AI = 'true';
  t.mock.method(User, 'findById', async () => ({ provider: 'google', providerId: 'account' }));
  const server = await startTestServer(translateRouter);
  try {
    for (const [path, token, code] of [
      ['translate', signToken('account'), 'UPDATE_REQUIRED'],
      ['guest/translate', signGuestToken('installation'), 'PAID_TRANSLATION_REQUIRED'],
    ]) {
      const result = await fetch(`${server.baseUrl}/api/${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(result.status, 403);
      assert.equal((await result.json()).code, code);
    }
  } finally {
    await server.close();
    if (oldFlag === undefined) delete process.env.REQUIRE_PAID_AI;
    else process.env.REQUIRE_PAID_AI = oldFlag;
  }
});

test('Free authorizes a translation against the existing daily quota', async (t) => {
  t.mock.method(User, 'findById', async () => ({ provider: 'google', providerId: 'account', dailyLimit: 2 }));
  t.mock.method(DailyQuota, 'updateOne', async () => {});
  t.mock.method(DailyQuota, 'findOneAndUpdate', async (filter, update) => {
    assert.ok(filter.usageDate);
    assert.equal(filter.usageCount.$lte, 1);
    assert.equal(update.$inc.usageCount, 1);
    return { usageCount: 1 };
  });
  const server = await startTestServer(translateRouter);
  try {
    const result = await fetch(`${server.baseUrl}/api/basic-translation`, {
      method: 'POST', body: JSON.stringify({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken('account')}` },
    });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).remaining, 1);
  } finally { await server.close(); }
});

test('offline allocation charges Free once and grants a verified Pro expiry', async (t) => {
  const oldFlag = process.env.COIN_PAYMENTS_ENABLED;
  process.env.COIN_PAYMENTS_ENABLED = 'true';
  const expiry = new Date(Date.now() + 3600_000);
  let pro = false;
  t.mock.method(CoinWallet, 'findById', async () => pro ? { proCoins: [{ playTokenKey: 'verified', expiresAt: expiry }] } : null);
  t.mock.method(User, 'findById', async () => ({ provider: 'google', providerId: 'account', dailyLimit: 8 }));
  t.mock.method(DailyQuota, 'updateOne', async () => {});
  let used = 0;
  const grants = new Map();
  t.mock.method(DailyQuota, 'findOneAndUpdate', async (filter, update) => {
    assert.equal(filter.usageCount.$lte, 5);
    const { id, cost } = update.$push.basicRequests;
    assert.equal(id, filter['basicRequests.id'].$ne);
    assert.equal(cost, 3);
    if (used > filter.usageCount.$lte || grants.has(id)) return null;
    grants.set(id, cost);
    used += update.$inc.usageCount;
    return { usageCount: used };
  });
  t.mock.method(DailyQuota, 'findOne', async ({ basicRequests: { $elemMatch: { id, cost } } }) =>
    grants.get(id) === cost ? { usageCount: used } : null);
  const server = await startTestServer(translateRouter);
  try {
    const post = (token, requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') => fetch(`${server.baseUrl}/api/basic-translation/offline`, {
      method: 'POST', body: JSON.stringify({ requestId, count: 3 }),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    assert.equal((await post(signGuestToken('installation'))).status, 401);
    const token = signToken('account');
    const grant = await (await post(token)).json();
    assert.equal(grant.count, 3);
    assert.equal(grant.remaining, 5);
    assert.equal(new Date(grant.expiresAt).getUTCHours(), 17);
    assert.equal((await (await post(token)).json()).grantId, grant.grantId);
    assert.equal(used, 3);
    pro = true;
    const proGrant = await (await post(token)).json();
    assert.equal(proGrant.count, null);
    assert.equal(proGrant.expiresAt, expiry.toISOString());
    assert.equal(used, 3);
    pro = false;
    const concurrent = await Promise.all([
      post(token, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef'),
      post(token, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee0'),
    ]);
    assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 429]);
    assert.equal(used, 6);
  } finally {
    await server.close();
    if (oldFlag === undefined) delete process.env.COIN_PAYMENTS_ENABLED;
    else process.env.COIN_PAYMENTS_ENABLED = oldFlag;
  }
});

test('Guest authorizes local translation without text and retry does not charge twice', async (t) => {
  const requestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  let used = 0;
  t.mock.method(QuotaPolicy, 'findById', async () => ({ guestLimit: 1, freeLimit: 30 }));
  t.mock.method(GuestTrial, 'updateOne', async () => {});
  t.mock.method(GuestTrial, 'findOneAndUpdate', async () => used === 0 ? { used: ++used } : null);
  t.mock.method(GuestTrial, 'findById', async () => ({ used, basicRequests: [requestId] }));
  const server = await startTestServer(translateRouter);
  try {
    const post = (body, token = signGuestToken('installation')) => fetch(`${server.baseUrl}/api/guest/basic-translation`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    assert.equal((await post({ requestId }, 'bad')).status, 401);
    assert.equal((await post({ requestId, texts: ['private'] })).status, 400);
    assert.deepEqual(await (await post({ requestId })).json(), { remaining: 0 });
    assert.deepEqual(await (await post({ requestId })).json(), { remaining: 0 });
    assert.equal((await post({ requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef' })).status, 429);
    assert.equal(used, 1);
  } finally { await server.close(); }
});
