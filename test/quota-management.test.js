import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTestServer } from './helpers/test-app.js';
import { createQuotaPolicyRouter } from '../src/routes/quotaPolicy.js';
import { QuotaPolicy } from '../src/services/quotaPolicy.js';
import { AiModel } from '../src/models/AiModel.js';

test('chỉ Owner được chọn một model đang bật và không tính xu cho Guest/Free', async (t) => {
  const id = 'abc123abc123abc123abc123';
  t.mock.method(AiModel, 'exists', async (filter) => filter._id === id && filter.enabled === true && filter.$or?.[0].coinPrice === 0 ? { _id: id } : null);
  const app = createQuotaPolicyRouter({
    authorize(req, _res, next) { req.adminWeb = { role: req.get('role'), username: 'owner-test' }; next(); },
    save: async (fields) => fields,
  });
  const server = await startTestServer(app);
  const save = (role, sharedAiModelId) => fetch(`${server.baseUrl}/api/quota-policy`, {
    method: 'PUT', headers: { role, 'content-type': 'application/json' },
    body: JSON.stringify({ guestLimit: 3, freeLimit: 100, revision: 0, sharedAiModelId }),
  });
  try {
    assert.equal((await save('admin', id)).status, 403);
    assert.equal((await save('owner', [id])).status, 400);
    assert.equal((await save('owner', '000000000000000000000000')).status, 400);
    assert.equal((await (await save('owner', id)).json()).sharedAiModelId, id);
    assert.equal((await (await save('owner', null)).json()).sharedAiModelId, null);
  } finally { await server.close(); }
});
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
    const { 'bonusRules.referral': referral, ...fields } = change.$set;
    doc = { ...doc, ...fields, revision: (doc?.revision ?? 0) + 1, audit: [...change.$push.audit.$each, ...(doc?.audit ?? [])] };
    if (referral) doc.bonusRules = { ...doc.bonusRules, referral };
    return { matchedCount: 1 };
  });
  const app = createQuotaPolicyRouter({ authorize(req, _res, next) { req.adminWeb = { role: req.get('role'), username: 'owner-test' }; next(); } });
  const server = await startTestServer(app);
  const call = (path, role, method = 'GET', data) => fetch(`${server.baseUrl}/api/${path}`, {
    method, headers: { role, 'content-type': 'application/json' }, body: JSON.stringify(data),
  });
  const bonus = { revision: 0, reward: 3, maxClaims: 1, period: 'month' };
  try {
    assert.equal((await call('bonus-rules', 'viewer')).status, 403);
    const initial = await (await call('bonus-rules', 'admin')).json();
    assert.equal(initial.rules.referral, null);
    assert.equal((await call('bonus-rules/referral', 'admin', 'PATCH', bonus)).status, 403);
    assert.equal((await call('bonus-rules/referral', 'owner', 'PATCH', { ...bonus, reward: 0 })).status, 400);
    assert.equal((await call('bonus-rules/referral', 'owner', 'PATCH', bonus)).status, 200);
    assert.equal((await call('bonus-rules/referral', 'owner', 'PATCH', { ...bonus, reward: 4 })).status, 409);
    assert.equal((await call('bonus-rules/referral', 'owner', 'PATCH', { ...bonus, revision: 1 })).status, 200);
    assert.equal((await call('quota-policy', 'owner', 'PUT', { revision: 1, guestLimit: 5, freeLimit: 100 })).status, 200);
    const { items } = await (await call('quota-policy/audit', 'admin')).json();
    assert.equal(items.length, 2);
    assert.deepEqual(items[0].changes, [{ field: 'guestLimit', before: 3, after: 5 }]);
    assert.equal(items[1].changes[0].field, 'bonusRules.referral');
    assert.equal(items[1].updatedBy, 'owner-test');
    const saved = await (await call('bonus-rules', 'admin')).json();
    assert.equal(saved.rules.referral.reward, 3);
    assert.equal(saved.rules.referral.enabled, false);
    assert.equal(saved.rules.rewardedVideo, null);
    assert.equal((await call('bonus-rules/checkIn', 'owner', 'PATCH', bonus)).status, 404);
    const enable = { ...bonus, revision: 2, enabled: true };
    assert.equal((await call('bonus-rules/referral', 'admin', 'PATCH', enable)).status, 403);
    assert.equal((await call('bonus-rules/referral', 'owner', 'PATCH', { ...enable, enabled: 'true' })).status, 400);
    const toggled = await call('bonus-rules/referral', 'owner', 'PATCH', enable);
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json()).rules.referral.enabled, true);
    const audit = await (await call('quota-policy/audit', 'admin')).json();
    assert.equal(audit.items[0].changes[0].before.enabled, false);
    assert.equal(audit.items[0].changes[0].after.enabled, true);
    const edited = await call('bonus-rules/referral', 'owner', 'PATCH', { ...bonus, revision: 3, reward: 4 });
    assert.equal((await edited.json()).rules.referral.enabled, true);
  } finally { await server.close(); }
});
