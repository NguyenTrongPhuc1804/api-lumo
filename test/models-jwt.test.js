import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import modelRouter from "../src/routes/models.js";
import { signToken } from "../src/services/tokens.js";
import { AiModel } from "../src/models/AiModel.js";
import { User } from "../src/models/User.js";
import { QuotaPolicy } from "../src/services/quotaPolicy.js";

async function serve(t) {
  const app = express();
  app.use(express.json());
  app.use("/api", modelRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test("API quản lý model mobile trả 404 ngay cả với token admin", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  t.mock.method(User, "findById", async () => ({ _id: "admin-1", role: "admin", status: "active" }));
  const baseUrl = await serve(t);
  const headers = { Authorization: `Bearer ${signToken("admin-1")}` };
  for (const [method, suffix] of [["GET", ""], ["POST", ""], ["POST", "/verify"], ["PUT", "/id"], ["DELETE", "/id"]]) {
    const response = await fetch(`${baseUrl}/api/admin/models${suffix}`, { method, headers });
    assert.equal(response.status, 404, `${method} ${suffix}`);
  }
});

test("GET /api/models cần x-app-key và không lộ thông tin kết nối", async (t) => {
  process.env.APP_KEY = "app-key";
  process.env.JWT_SECRET = "test-secret";
  const readyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = readyState; });
  t.mock.method(QuotaPolicy, "findById", async () => null);
  t.mock.method(AiModel, "find", (query) => {
    assert.deepEqual(query, { enabled: true });
    return { sort: () => ({ lean: async () => [{ code: "test", name: "Test", apiKey: "fixture-key", baseUrl: "https://models.test" }] }) };
  });
  const baseUrl = await serve(t);
  const denied = await fetch(`${baseUrl}/api/models`, { headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
  assert.equal(denied.status, 401);
  const response = await fetch(`${baseUrl}/api/models`, { headers: { "x-app-key": "app-key" } });
  assert.equal(response.status, 200);
  const [model] = await response.json();
  assert.equal(model.code, "test");
  assert.equal(Object.hasOwn(model, "apiKey"), false);
  assert.equal(Object.hasOwn(model, "baseUrl"), false);
});
