import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from './helpers/test-app.js';
import { createQuotaPolicyRouter } from '../src/routes/quotaPolicy.js';
import { QuotaPolicy } from '../src/services/quotaPolicy.js';
import { AiUsage, readAiUsage, recordAiCall } from '../src/services/aiUsage.js';

test('thống kê dùng 24 khung giờ UTC và tính tỷ trọng theo lượt gọi', async (t) => {
  const now = new Date('2026-11-21T13:37:00Z');
  t.mock.method(AiUsage, 'updateOne', async (filter, update, options) => {
    assert.equal(filter._id, '2026-11-21T13:00:00.000Z:guest');
    assert.equal(update.$inc.calls, 1);
    assert.equal(options.upsert, true);
  });
  t.mock.method(AiUsage, 'aggregate', async ([match]) => {
    assert.equal(match.$match.hour.$gte.toISOString(), '2026-11-20T14:00:00.000Z');
    return [{ _id: 'guest', calls: 2 }, { _id: 'free', calls: 1 }];
  });
  await recordAiCall('guest', now);
  const usage = await readAiUsage(now);
  assert.equal(usage.total, 3);
  assert.deepEqual(usage.groups, [{ key: 'guest', calls: 2, share: 66.7 }, { key: 'free', calls: 1, share: 33.3 }]);
});

test('bonus lưu riêng, nhật ký ghi đúng một lần và bản cũ không được ghi đè', async (t) => {
  let doc;
  t.mock.method(QuotaPolicy, 'findById', () => Object.assign(Promise.resolve(doc ?? null), { select: () => ({ lean: async () => doc ?? null }) }));
  t.mock.method(QuotaPolicy, 'updateOne', async (filter, change, options) => {
    if (doc && filter.revision !== doc.revision) return { matchedCount: 0 };
    if (!doc && !options.upsert) return { matchedCount: 0 };
    doc = { ...doc, ...change.$set, revision: (doc?.revision ?? 0) + 1, audit: [...change.$push.audit.$each, ...(doc?.audit ?? [])] };
    return { matchedCount: 1 };
  });
  const app = createQuotaPolicyRouter({ authorize(req, _res, next) { req.adminWeb = { role: req.get('role'), username: 'owner-test' }; next(); } });
  const server = await startTestServer(app);
  const call = (path, role, method = 'GET', data) => fetch(`${server.baseUrl}/api/${path}`, {
    method, headers: { role, 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const bonus = { revision: 0, reward: 3, maxClaims: 1, period: 'day' };
  try {
    assert.equal((await call('bonus-rules', 'viewer')).status, 403);
    const initial = await (await call('bonus-rules', 'admin')).json();
    assert.equal(initial.rules.checkIn, null);
    assert.equal((await call('bonus-rules/checkIn', 'admin', 'PATCH', bonus)).status, 403);
    assert.equal((await call('bonus-rules/checkIn', 'owner', 'PATCH', { ...bonus, reward: 0 })).status, 400);
    assert.equal((await call('bonus-rules/checkIn', 'owner', 'PATCH', bonus)).status, 200);
    assert.equal((await call('bonus-rules/checkIn', 'owner', 'PATCH', { ...bonus, reward: 4 })).status, 409);
    assert.equal((await call('bonus-rules/checkIn', 'owner', 'PATCH', { ...bonus, revision: 1 })).status, 200);
    assert.equal((await call('quota-policy', 'owner', 'PUT', { revision: 1, guestLimit: 5, freeLimit: 100 })).status, 200);
    const { items } = await (await call('quota-policy/audit', 'admin')).json();
    assert.equal(items.length, 2);
    assert.deepEqual(items[0].changes, [{ field: 'guestLimit', before: 3, after: 5 }]);
    assert.equal(items[1].changes[0].field, 'bonusRules.checkIn');
    assert.equal(items[1].updatedBy, 'owner-test');
    const saved = await (await call('bonus-rules', 'admin')).json();
    assert.equal(saved.rules.checkIn.reward, 3);
    assert.equal(saved.rules.referral, null);
  } finally { await server.close(); }
});
