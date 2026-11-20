import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateDailyQuota } from "../scripts/migrate-daily-quota.js";
import { DailyQuota } from "../src/models/DailyQuota.js";
import { User } from "../src/models/User.js";
import { quotaIdentity, quotaPeriod } from "../src/services/dailyQuota.js";

process.env.QUOTA_HMAC_SECRET = "test-secret";

test("migration only copies the selected day and never adds twice or reduces usage", async (t) => {
  const user = { provider: "google", providerId: "g1", usageCount: 3 };
  const sourceDate = "2026-11-20";
  const { usageDate, expiresAt } = quotaPeriod();
  let count = 2;
  let writes = 0;
  t.mock.method(User, "find", (filter) => {
    assert.deepEqual(filter, { usageDate: sourceDate, usageCount: { $gt: 0 } });
    return { select: () => ({ lean: () => ({ cursor: async function* () { yield user; } }) }) };
  });
  t.mock.method(DailyQuota, "updateOne", async (filter, update, opts) => {
    assert.deepEqual(filter, { identityKey: quotaIdentity(user), usageDate });
    assert.deepEqual(update.$setOnInsert, { expiresAt });
    assert.equal(opts.upsert, true);
    count = Math.max(count, update.$max.usageCount);
    writes++;
  });
  assert.equal((await migrateDailyQuota({ sourceDate })).scanned, 1);
  assert.equal(writes, 0);
  await migrateDailyQuota({ sourceDate, targetDate: usageDate, apply: true });
  await migrateDailyQuota({ sourceDate, targetDate: usageDate, apply: true });
  assert.equal(count, 3);
  count = 4;
  await migrateDailyQuota({ sourceDate, targetDate: usageDate, apply: true });
  assert.equal(count, 4);
});

test("migration rejects missing or impossible dates", async () => {
  for (const sourceDate of [undefined, "2026-2-3", "2026-02-30"]) {
    await assert.rejects(migrateDailyQuota({ sourceDate }), /source-date/);
  }
});

test("migration cannot be replayed on a later day with the same target", async (t) => {
  const find = t.mock.method(User, "find", () => { throw new Error("must not query"); });
  const now = () => new Date("2026-11-28T17:00:00Z");
  await assert.rejects(migrateDailyQuota({ sourceDate: "2026-11-28", targetDate: "2026-11-28", apply: true, now }), /target-date/);
  await assert.rejects(migrateDailyQuota({ sourceDate: "2026-11-28", apply: true, now }), /target-date/);
  assert.equal(find.mock.callCount(), 0);
});

test("migration stops before writing into a new quota day", async (t) => {
  const times = [new Date("2026-11-28T16:59:59Z"), new Date("2026-11-28T17:00:00Z")];
  t.mock.method(User, "find", () => ({ select: () => ({ lean: () => ({ cursor: async function* () { yield {}; } }) }) }));
  const write = t.mock.method(DailyQuota, "updateOne", async () => {});
  await assert.rejects(migrateDailyQuota({ sourceDate: "2026-11-28", targetDate: "2026-11-28", apply: true, now: () => times.shift() }), /ky han muc/);
  assert.equal(write.mock.callCount(), 0);
});
