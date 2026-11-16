import { test } from "node:test";
import assert from "node:assert/strict";
import { toClientUser } from "../src/routes/auth.js";
import { consumeQuota, refundQuota, todayKey, limitFor } from "../src/services/quota.js";
import { User } from "../src/models/User.js";

// Mini collection trong bo nho, chi ho tro dung cac filter quota.js dung.
function fakeUsers(initial) {
  const state = { ...initial, incCalls: [], updateCalls: [] };
  const previous = { findOneAndUpdate: User.findOneAndUpdate, updateOne: User.updateOne };

  User.findOneAndUpdate = async (filter, update) => {
    const today = todayKey();
    if (typeof filter.usageDate === "string" && filter.usageDate !== today) return null;
    if (filter.usageDate === today) {
      if (filter.usageCount?.$lt !== undefined) {
        if (state.usageDate !== today || state.usageCount >= filter.usageCount.$lt) return null;
      }
      state.usageCount += update.$inc.usageCount;
      state.incCalls.push(update.$inc.usageCount);
      return { ...state };
    }
    if (filter.usageDate?.$ne !== undefined) {
      if (state.usageDate === filter.usageDate.$ne) return null;
      state.usageDate = update.$set.usageDate;
      state.usageCount = update.$set.usageCount;
      return { ...state };
    }
    return null;
  };

  User.updateOne = async (filter, update) => {
    state.updateCalls.push({ filter, update });
    if (filter.usageDate !== undefined && state.usageDate !== filter.usageDate) return { acknowledged: true };
    if (filter.usageCount?.$gte !== undefined && state.usageCount < filter.usageCount.$gte) return { acknowledged: true };
    state.usageCount += update.$inc.usageCount;
    return { acknowledged: true };
  };

  return {
    state,
    restore() {
      User.findOneAndUpdate = previous.findOneAndUpdate;
      User.updateOne = previous.updateOne;
    },
  };
}

test("/api/me trả hạn mức thật từ FREE_DAILY_LIMIT, không phải 0", () => {
  process.env.FREE_DAILY_LIMIT = "42";
  const user = { _id: "u1", role: "user", dailyLimit: 0, usageDate: todayKey(), usageCount: 5 };
  const payload = toClientUser(user);
  assert.equal(payload.dailyLimit, 42);
  assert.equal(payload.usageCount, 5);
  assert.equal(payload.isAdmin, false);
});

test("/api/me không tính lượt của ngày hôm qua", () => {
  process.env.FREE_DAILY_LIMIT = "42";
  const user = { _id: "u1", role: "user", dailyLimit: 0, usageDate: "2020-01-01", usageCount: 40 };
  const payload = toClientUser(user);
  assert.equal(payload.usageCount, 0);
  assert.equal(payload.dailyLimit, 42);
});

test("admin vẫn báo hạn mức để app hiện đúng nhãn", () => {
  process.env.FREE_DAILY_LIMIT = "42";
  const payload = toClientUser({ _id: "a1", role: "admin", dailyLimit: 0, usageDate: todayKey(), usageCount: 3 });
  assert.equal(payload.isAdmin, true);
  assert.equal(payload.dailyLimit, 42);
});

test("limitFor ưu tiên dailyLimit riêng của tài khoản", () => {
  process.env.FREE_DAILY_LIMIT = "42";
  assert.equal(limitFor({ dailyLimit: 500 }), 500);
  assert.equal(limitFor({ dailyLimit: 0 }), 42);
});

test("refund chỉ trừ khi bộ đếm còn ở đúng ngày đã trừ", async () => {
  const fake = fakeUsers({ usageDate: todayKey(), usageCount: 3 });
  try {
    await refundQuota({ _id: "u1" }, todayKey());
    assert.equal(fake.state.usageCount, 2);
    assert.equal(fake.state.updateCalls[0].filter.usageDate, todayKey());
  } finally {
    fake.restore();
  }
});

test("refund không đụng vào bộ đếm của ngày mới", async () => {
  const fake = fakeUsers({ usageDate: todayKey(), usageCount: 1 });
  try {
    await refundQuota({ _id: "u1" }, "2020-01-01");
    assert.equal(fake.state.usageCount, 1, "không được trừ vào ngày khác");
  } finally {
    fake.restore();
  }
});

test("refund không trừ xuống dưới 0", async () => {
  const fake = fakeUsers({ usageDate: todayKey(), usageCount: 0 });
  try {
    await refundQuota({ _id: "u1" }, todayKey());
    assert.equal(fake.state.usageCount, 0);
  } finally {
    fake.restore();
  }
});

test("refund không làm gì khi không có ngày đã trừ", async () => {
  const fake = fakeUsers({ usageDate: todayKey(), usageCount: 2 });
  try {
    await refundQuota({ _id: "u1" }, "");
    assert.equal(fake.state.usageCount, 2);
    assert.equal(fake.state.updateCalls.length, 0);
  } finally {
    fake.restore();
  }
});

test("consumeQuota trả số còn lại đã trừ, không phải số cũ", async () => {
  process.env.FREE_DAILY_LIMIT = "5";
  const fake = fakeUsers({ usageDate: todayKey(), usageCount: 2 });
  try {
    const result = await consumeQuota({ _id: "u1" });
    assert.equal(result.ok, true);
    assert.equal(result.remaining, 2);
    assert.equal(result.usageDate, todayKey());
  } finally {
    fake.restore();
  }
});

test("consumeQuota không vượt hạn mức", async () => {
  process.env.FREE_DAILY_LIMIT = "1";
  const fake = fakeUsers({ usageDate: todayKey(), usageCount: 1 });
  try {
    const result = await consumeQuota({ _id: "u1" });
    assert.equal(result.ok, false);
    assert.equal(fake.state.usageCount, 1);
  } finally {
    fake.restore();
  }
});
