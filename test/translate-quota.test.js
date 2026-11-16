import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import { AiModel } from "../src/models/AiModel.js";
import { Translation } from "../src/models/Translation.js";
import { User } from "../src/models/User.js";
import { signToken } from "../src/services/tokens.js";

// todayKey phai duoc stub de test "sang ngay moi" khong phu thuoc dong ho that.
process.env.JWT_SECRET = "test-secret";
process.env.FREE_DAILY_LIMIT = "1";

const { default: router } = await import("../src/routes/translate.js");

const freeUser = () => ({
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
    findOneAndUpdate: User.findOneAndUpdate,
    updateOne: User.updateOne,
    modelFindOne: AiModel.findOne,
    translationFind: Translation.find,
    bulkWrite: Translation.bulkWrite,
    readyState: mongoose.connection.readyState,
    fetch: globalThis.fetch,
  };
  User.findById = async (id) => (id === state.user._id ? state.user : null);
  AiModel.findOne = () => ({ lean: async () => ({ code: "test", baseUrl: "https://model.test", apiKey: "secret" }) });
  Translation.find = async ({ key }) => {
    if (!state.cached) return [];
    // find duoc goi voi { key: { $in: [...] } }, khong phai mang truc tiep.
    const count = Array.isArray(key?.$in) ? key.$in.length : 0;
    return count > 0 ? [{ text: state.cached.text, translated: state.cached.translated }] : [];
  };
  Translation.bulkWrite = async () => ({ acknowledged: true });

  mongoose.connection.readyState = 1;

  // Mini Mongo trong bo nho: chi ho tro dung hai kieu filter ma quota.js dung,
  // de test kiem tra that su co tang bo dem chu khong phai gia lap ket qua.
  User.findOneAndUpdate = async (filter, update) => {
    const user = state.user;
    if (filter.usageDate === "today-placeholder") return null;
    const matchToday = typeof filter.usageDate === "string" && user.usageDate === filter.usageDate
      && user.usageCount < filter.usageCount.$lt;
    const matchNewDay = filter.usageDate && filter.usageDate.$ne !== undefined && user.usageDate !== filter.usageDate.$ne;

    if (matchToday) {
      user.usageCount += update.$inc.usageCount;
      return user;
    }
    if (matchNewDay) {
      user.usageDate = update.$set.usageDate;
      user.usageCount = update.$set.usageCount;
      return user;
    }
    return null;
  };
  User.updateOne = async (filter, update) => {
    if (filter._id === state.user._id) state.user.usageCount += update.$inc.usageCount;
    return { acknowledged: true };
  };

  const previousBulkWrite = Translation.bulkWrite;

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
    User.findOneAndUpdate = previous.findOneAndUpdate;
    User.updateOne = previous.updateOne;
    AiModel.findOne = previous.modelFindOne;
    Translation.find = previous.translationFind;
    Translation.bulkWrite = previousBulkWrite;
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
  const state = { user: freeUser(), cached: { text: "Hello", translated: "Xin chào" }, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["Hello"] }, state });
  assert.equal(res.status, 200);
  assert.equal(state.modelCalls, 0);
  assert.equal(res.body.remaining, 1);
});

test("gọi model thật thì trừ đúng một lượt", async () => {
  const state = { user: freeUser(), cached: null, modelCalls: 0 };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 200);
  assert.equal(state.modelCalls, 1);
  assert.equal(res.body.remaining, 0);
});

test("hết lượt trả 429 và không gọi model", async () => {
  const user = { ...freeUser(), usageDate: new Date().toISOString().slice(0, 10), usageCount: 1 };
  const state = { user, cached: null, modelCalls: 0 };
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

test("model lỗi thì không mất lượt", async () => {
  const state = { user: freeUser(), cached: null, modelCalls: 0, modelFails: true };
  const res = await callTranslate({ body: { texts: ["New sentence"] }, state });
  assert.equal(res.status, 502);
  assert.equal(state.user.usageCount, 0);
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
