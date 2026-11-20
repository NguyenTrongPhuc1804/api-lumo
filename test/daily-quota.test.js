import { test } from "node:test";
import assert from "node:assert/strict";
import { DailyQuota } from "../src/models/DailyQuota.js";
import { quotaPeriod, quotaIdentity, readDailyUsage, chargeDailyUsage, refundDailyUsage } from "../src/services/dailyQuota.js";

const user = { provider: "google", providerId: "g1" };
const today = new Date("2026-11-28T16:59:59Z");
const tomorrow = new Date("2026-11-28T17:00:00Z");
process.env.QUOTA_HMAC_SECRET = "test-quota-secret";

test("Vietnam midnight starts a new quota day regardless of VPS timezone", () => {
  assert.deepEqual(quotaPeriod(today), { usageDate: "2026-11-28", expiresAt: tomorrow });
  assert.deepEqual(quotaPeriod(tomorrow), { usageDate: "2026-11-29", expiresAt: new Date("2026-11-29T17:00:00Z") });
});

test("quota identity follows the provider login, not the profile", () => {
  assert.match(quotaIdentity(user), /^[a-f0-9]{64}$/);
  assert.equal(quotaIdentity(user), quotaIdentity({ ...user, email: "new@example.test", _id: "new" }));
  assert.notEqual(quotaIdentity(user), quotaIdentity({ ...user, provider: "facebook" }));
  assert.notEqual(quotaIdentity(user), quotaIdentity({ ...user, providerId: "g2" }));
  const secret = process.env.QUOTA_HMAC_SECRET;
  delete process.env.QUOTA_HMAC_SECRET;
  try { assert.throws(() => quotaIdentity(user), /QUOTA_HMAC_SECRET/); }
  finally { process.env.QUOTA_HMAC_SECRET = secret; }
});

test("parallel first charges share one counter and respect the cap", async (t) => {
  let row;
  t.mock.method(DailyQuota, "updateOne", async (key, update, options) => {
    assert.equal(options.upsert, true);
    assert.equal(key.usageDate, "2026-11-28");
    assert.equal(key.identityKey, quotaIdentity(user));
    if (!row) row = { ...update.$setOnInsert };
    else throw Object.assign(new Error("duplicate"), { code: 11000, keyPattern: { identityKey: 1, usageDate: 1 } });
  });
  t.mock.method(DailyQuota, "findOneAndUpdate", async (filter, update) => {
    if (row.usageCount > filter.usageCount.$lte) return null;
    row.usageCount += update.$inc.usageCount;
    return { ...row };
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => chargeDailyUsage(user, 5, 2, today)));
  assert.equal(results.filter((result) => result.ok).length, 2);
  assert.equal(row.usageCount, 4);
  assert.equal((await chargeDailyUsage(user, 5, 6, today)).ok, false);
});

test("a new day never reads the old counter, even before TTL cleanup", async (t) => {
  t.mock.method(DailyQuota, "findOne", async ({ usageDate }) => usageDate === "2026-11-28" ? { usageCount: 5 } : null);
  assert.deepEqual(await readDailyUsage(user, today), { usageDate: "2026-11-28", usageCount: 5 });
  assert.deepEqual(await readDailyUsage(user, tomorrow), { usageDate: "2026-11-29", usageCount: 0 });
});

test("collection makes the identity and day unique and expires old rows", () => {
  const indexes = DailyQuota.schema.indexes();
  assert.ok(indexes.some(([key, options]) => key.identityKey === 1 && key.usageDate === 1 && options.unique));
  assert.ok(indexes.some(([key, options]) => key.expiresAt === 1 && options.expireAfterSeconds === 0));
});
