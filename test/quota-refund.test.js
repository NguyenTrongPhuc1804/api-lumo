import { test } from "node:test";
import assert from "node:assert/strict";
import { toClientUser } from "../src/routes/auth.js";
import { limitFor, refundQuota } from "../src/services/quota.js";
import { DailyQuota } from "../src/models/DailyQuota.js";
import { quotaPeriod } from "../src/services/dailyQuota.js";

process.env.QUOTA_HMAC_SECRET = "test-quota-secret";
process.env.FREE_DAILY_LIMIT = "42";
const user = { _id: "u1", provider: "google", providerId: "g1", role: "user", dailyLimit: 0 };

test("hồ sơ dùng số lượt từ bộ đếm mới và hạn mức mặc định", () => {
  const { usageDate } = quotaPeriod();
  const payload = toClientUser({ ...user, usageCount: 99 }, { usageDate, usageCount: 5 });
  assert.equal(payload.dailyLimit, 42);
  assert.equal(payload.usageCount, 5);
  assert.equal(payload.usageDate, usageDate);
  assert.equal(payload.isAdmin, false);
});

test("admin vẫn báo hạn mức để app hiện đúng nhãn", () => {
  const payload = toClientUser({ ...user, role: "admin" }, { usageDate: quotaPeriod().usageDate, usageCount: 0 });
  assert.equal(payload.isAdmin, true);
  assert.equal(payload.dailyLimit, 42);
});

test("limitFor ưu tiên dailyLimit riêng của tài khoản", () => {
  assert.equal(limitFor({ dailyLimit: 500 }), 500);
  assert.equal(limitFor({ dailyLimit: 0 }), 42);
});

test("hoàn lượt chỉ cập nhật bản ghi còn hạn của đúng ngày và không xuống âm", async (t) => {
  const calls = [];
  t.mock.method(DailyQuota, "updateOne", async (...args) => calls.push(args));
  await refundQuota(user, "");
  assert.equal(calls.length, 0);
  await refundQuota(user, "2020-01-01", 2);
  assert.equal(calls.length, 1);
  const [filter, change, options] = calls[0];
  assert.equal(filter.usageDate, "2020-01-01");
  assert.deepEqual(filter.usageCount, { $gte: 2 });
  assert.ok(filter.expiresAt.$gt instanceof Date);
  assert.deepEqual(change, { $inc: { usageCount: -2 } });
  assert.equal(options?.upsert, undefined);
});
