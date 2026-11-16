import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import mongoose from "mongoose";
import modelRouter from "../src/routes/models.js";
import { signToken } from "../src/services/tokens.js";
import { AiModel } from "../src/models/AiModel.js";
import { User } from "../src/models/User.js";

const admin = { _id: "admin-1", role: "admin", status: "active" };
const normal = { _id: "user-2", role: "user", status: "active" };

function stub() {
  const previous = { findById: User.findById, modelFind: AiModel.find, readyState: mongoose.connection.readyState };
  User.findById = async (id) => (String(id) === "admin-1" ? admin : String(id) === "user-2" ? normal : null);
  AiModel.find = () => ({ sort: () => ({ lean: async () => [] }) });
  mongoose.connection.readyState = 1;
  return () => {
    User.findById = previous.findById;
    AiModel.find = previous.modelFind;
    mongoose.connection.readyState = previous.readyState;
  };
}

async function serve() {
  const app = express();
  app.use(express.json());
  app.use("/api", modelRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("x-admin-key không còn dùng được", async () => {
  process.env.JWT_SECRET = "test-secret";
  process.env.ADMIN_KEY = "still-set";
  const restore = stub();
  const server = await serve();
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/models`, { headers: { "x-admin-key": "still-set" } });
    assert.equal(res.status, 401);
  } finally {
    restore();
    await server.close();
  }
});

test("admin JWT đọc được danh sách model", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stub();
  const server = await serve();
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/models`, { headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 200);
  } finally {
    restore();
    await server.close();
  }
});

test("user thường bị 403", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stub();
  const server = await serve();
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/models`, { headers: { Authorization: `Bearer ${signToken("user-2")}` } });
    assert.equal(res.status, 403);
  } finally {
    restore();
    await server.close();
  }
});

test("GET /api/models vẫn nhận x-app-key và không cần token", async () => {
  process.env.APP_KEY = "app-key";
  const restore = stub();
  const server = await serve();
  try {
    const res = await fetch(`${server.baseUrl}/api/models`, { headers: { "x-app-key": "app-key" } });
    assert.equal(res.status, 200);
  } finally {
    restore();
    await server.close();
  }
});

test("GET /api/models không nhận token thay cho x-app-key", async () => {
  process.env.APP_KEY = "app-key";
  process.env.JWT_SECRET = "test-secret";
  const restore = stub();
  const server = await serve();
  try {
    const res = await fetch(`${server.baseUrl}/api/models`, { headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 401);
  } finally {
    restore();
    await server.close();
  }
});
