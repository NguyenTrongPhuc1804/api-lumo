import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import { AiModel } from "../src/models/AiModel.js";
import { Translation } from "../src/models/Translation.js";
import { User } from "../src/models/User.js";
import { DailyQuota } from "../src/models/DailyQuota.js";
import { quotaIdentity, quotaPeriod } from "../src/services/dailyQuota.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { startTestServer } from "./helpers/test-app.js";
import { signToken } from "../src/services/tokens.js";

// todayKey phai duoc stub de test "sang ngay moi" khong phu thuoc dong ho that.
process.env.JWT_SECRET = "test-secret";
process.env.FREE_DAILY_LIMIT = "1";

const { default: router } = await import("../src/routes/translate.js");
const { QuotaPolicy } = await import("../src/services/quotaPolicy.js");
QuotaPolicy.findById = async () => null;

process.env.QUOTA_HMAC_SECRET = "test-quota-secret";

test('model trả xu mặc định không gọi AI và không trừ lượt Free', async () => {
  const state = { user: freeUser(), coinPrice: 3, modelCalls: 0 };
  const result = await callTranslate({ body: { texts: ['Hi'], coinPrice: 0 }, state });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'COIN_PAYMENTS_DISABLED');
  assert.equal(state.modelCalls, 0);
  assert.equal(state.quota, undefined);
});

const freeUser = () => ({
  provider: "google",
  providerId: "g-free",
  _id: "user-free",
  role: "user",
  status: "active",
  plan: "free",
  dailyLimit: 0,
  usageDate: "",
  usageCount: 0,
});

function stubWorld(state) {
  const previous = {
    findById: User.findById,
    quota: { findOne: DailyQuota.findOne, findOneAndUpdate: DailyQuota.findOneAndUpdate, updateOne: DailyQuota.updateOne },
    modelFindOne: AiModel.findOne,
    translationFind: Translation.find,
    bulkWrite: Translation.bulkWrite,
    readyState: mongoose.connection.readyState,
    fetch: globalThis.fetch,
  };
  User.findById = async (id) => (id === state.user._id ? state.user : null);
  AiModel.findOne = () => ({ lean: async () => ({ code: "test", baseUrl: "https://model.test", apiKey: "secret", coinPrice: state.coinPrice }) });
  Translation.find = async ({ key }) => {
    if (!state.cached) return [];
    // find duoc goi voi { key: { $in: [...] } }, khong phai mang truc tiep.
    const count = Array.isArray(key?.$in) ? key.$in.length : 0;
    return count > 0 ? [{ text: state.cached.text, translated: state.cached.translated }] : [];
  };
  Translation.bulkWrite = async () => ({ acknowledged: true });

  mongoose.connection.readyState = 1;

  DailyQuota.findOne = async () => state.quota;
  DailyQuota.updateOne = async (filter, update) => {
    if (state.quotaFails) throw new Error("quota database down");
    if (update.$setOnInsert) state.quota ??= { ...update.$setOnInsert };
    if (update.$inc && state.quota) state.quota.usageCount += update.$inc.usageCount;
  };
  DailyQuota.findOneAndUpdate = async (filter, update) => {
    if (!state.quota || state.quota.usageCount > filter.usageCount.$lte) return null;
    state.quota.usageCount += update.$inc.usageCount;
    return state.quota;
  };

  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://model.test")) {
      state.modelCalls++;
      if (state.modelFails) throw new Error("model down");
      return new Response(JSON.stringify({ choices: [{ message: { content: '["Xin chào"]' } }] }));
    }
    // Chuyen tiep nguyen ven ca options, neu khong POST se thanh GET va bi 404.
    return previous.fetch(url, options);
  };

  return () => {
    User.findById = previous.findById;
    Object.assign(DailyQuota, previous.quota);
    AiModel.findOne = previous.modelFindOne;
    Translation.find = previous.translationFind;
    Translation.bulkWrite = previous.bulkWrite;
    mongoose.connection.readyState = previous.readyState;
    globalThis.fetch = previous.fetch;
  };
}

async function callTranslate({ body, state }) {
  const restore = stubWorld(state);
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken(state.user._id)}` },
      body: JSON.stringify({ targetLang: "vi", model: "test", ...body }),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("trúng cache không trừ lượt", async () => {
  const state = { user: freeUser(), quota: { usageCount: 1 }, cached: { text: "Hello", translated: "Xin chào" }, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["Hello"] }, state });
  assert.equal(res.status, 200);
  assert.equal(state.modelCalls, 0);
  assert.equal(res.body.remaining, 0);
  assert.equal(state.quota.usageCount, 1);
});

test("gọi model thật thì trừ đúng một lượt", async () => {
  const state = { user: freeUser(), cached: null, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 200);
  assert.equal(state.modelCalls, 1);
  assert.equal(res.body.remaining, 0);
});

test("hết lượt trả 429 và không gọi model", async () => {
  const state = { user: freeUser(), quota: { usageCount: 1 }, cached: null, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 429);
  assert.equal(state.modelCalls, 0);
});

test("admin không bị giới hạn", async () => {
  const user = { ...freeUser(), _id: "admin-1", role: "admin", usageDate: new Date().toISOString().slice(0, 10), usageCount: 9999 };
  const state = { user, cached: null, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 200);
});

test("tài khoản bị khoá trả 403", async () => {
  const user = { ...freeUser(), status: "blocked" };
  const state = { user, cached: null, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 403);
  assert.equal(state.modelCalls, 0);
});

test("kho hạn mức lỗi thì không gọi model", async () => {
  const state = { user: freeUser(), modelCalls: 0, quotaFails: true };
  const res = await callTranslate({ body: { texts: ["Hello"], mode: "manga" }, state });
  assert.equal(res.status, 502);
  assert.equal(state.modelCalls, 0);
});

test("model lỗi thì không mất lượt", async () => {
  const state = { user: freeUser(), cached: null, modelCalls: 0, modelFails: true };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 502);
  assert.equal(state.quota.usageCount, 0);
});

test("xoá và đăng nhập lại bằng cùng Google không làm mới lượt trong ngày", async () => {
  const old = freeUser();
  let profile = old;
  const rows = new Map();
  const keyOf = ({ identityKey, usageDate }) => `${identityKey}:${usageDate}`;
  const previousUser = { findById: User.findById, deleteOne: User.deleteOne, findOneAndUpdate: User.findOneAndUpdate };
  const previousQuota = { findOne: DailyQuota.findOne, findOneAndUpdate: DailyQuota.findOneAndUpdate, updateOne: DailyQuota.updateOne };
  User.findById = async (id) => profile?._id === id ? profile : null;
  User.deleteOne = async () => { profile = null; return { deletedCount: 1 }; };
  User.findOneAndUpdate = async (filter, update) => {
    profile = { ...filter, ...update.$set, ...update.$setOnInsert, _id: "new-profile", role: "user" };
    return profile;
  };
  DailyQuota.findOne = async (key) => rows.get(keyOf(key));
  DailyQuota.updateOne = async (key, update) => {
    if (!rows.has(keyOf(key))) rows.set(keyOf(key), { ...update.$setOnInsert });
  };
  DailyQuota.findOneAndUpdate = async (filter, update) => {
    const row = rows.get(keyOf(filter));
    if (!row || row.usageCount > filter.usageCount.$lte) return null;
    row.usageCount += update.$inc.usageCount;
    return row;
  };
  const identityKey = quotaIdentity(old);
  const { usageDate, expiresAt } = quotaPeriod();
  rows.set(keyOf({ identityKey, usageDate }), { usageCount: 1, expiresAt });

  const app = express.Router();
  app.use(createAuthRouter({ exchangeGoogleCode: async () => ({ providerId: old.providerId, email: "test@example.test" }) }));
  app.use(router);
  const server = await startTestServer(app);
  try {
    const deleted = await fetch(`${server.baseUrl}/api/me`, {
      method: "DELETE", headers: { Authorization: `Bearer ${signToken(old._id)}` },
    });
    assert.equal(deleted.status, 200);
    const start = await fetch(`${server.baseUrl}/api/auth/google/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const callback = await fetch(`${server.baseUrl}/api/auth/google/callback?code=test&state=${state}`, { redirect: "manual" });
    const token = new URL(callback.headers.get("location")).searchParams.get("token");
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const me = await (await fetch(`${server.baseUrl}/api/me`, { headers })).json();
    assert.equal(me.id, "new-profile");
    assert.equal(me.usageCount, 1);
    const result = await fetch(`${server.baseUrl}/api/translate`, {
      method: "POST", headers, body: JSON.stringify({ texts: ["Hello"], targetLang: "vi", mode: "manga" }),
    });
    assert.equal(result.status, 429);
  } finally {
    Object.assign(User, previousUser);
    Object.assign(DailyQuota, previousQuota);
    await server.close();
  }
});

test("x-app-key không còn dùng được cho dịch", async () => {
  const restore = stubWorld({ user: freeUser(), cached: null, modelCalls: 0 });
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-key": "anything" },
      body: JSON.stringify({ texts: ["Hi"], targetLang: "vi" }),
    });
    assert.equal(res.status, 401);
  } finally {
    restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
