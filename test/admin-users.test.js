import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminUsersRouter } from "../src/routes/adminUsers.js";
import { signToken } from "../src/services/tokens.js";
import { User } from "../src/models/User.js";
import express from "express";

// Thay User.findById de requireUser tra dung tai khoan theo token.
// Cac ham khac cua User duoc stub theo tung test.
function stubUsers(byId, extras = {}) {
  const previous = { findById: User.findById, find: User.find, countDocuments: User.countDocuments };
  User.findById = async (id) => byId[String(id)] ?? null;
  if (extras.find) User.find = extras.find;
  if (extras.countDocuments) User.countDocuments = extras.countDocuments;
  return () => Object.assign(User, previous);
}

// startTestServer khong gan express.json, ma route admin can doc body.
async function serve(router) {
  const app = express();
  app.use(express.json());
  app.use("/api", router);
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

const admin = { _id: "admin-1", role: "admin", status: "active", name: "Admin" };
const other = { _id: "user-2", role: "user", status: "active", name: "Other" };

test("người thường gọi API admin users bị 403", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUsers({ "user-2": other });
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${signToken("user-2")}` } });
    assert.equal(res.status, 403);
  } finally {
    restore();
    await server.close();
  }
});

test("admin xem được danh sách và không thấy providerId", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUsers({ "admin-1": admin }, {
    find: () => ({
      sort: () => ({ skip: () => ({ limit: async () => [{ ...other, providerId: "secret-provider-id" }] }) }),
    }),
    countDocuments: async () => 1,
  });
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].name, "Other");
    assert.equal("providerId" in body.items[0], false);
  } finally {
    restore();
    await server.close();
  }
});

test("admin khoá được user khác", async () => {
  process.env.JWT_SECRET = "test-secret";
  let savedStatus = "";
  const restore = stubUsers({ "admin-1": admin }, {
    findById: undefined,
  });
  // findById dung chung cho ca requireUser lan route, nen phai tra theo id.
  User.findById = async (id) => {
    if (String(id) === "user-2") {
      return { ...other, set status(v) { savedStatus = v; }, get status() { return savedStatus || "active"; }, save: async () => {} };
    }
    return admin;
  };
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users/user-2/block`, { method: "POST", headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 200);
    assert.equal(savedStatus, "blocked");
  } finally {
    restore();
    await server.close();
  }
});

test("admin không tự khoá chính mình", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUsers({ "admin-1": admin });
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users/admin-1/block`, { method: "POST", headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 400);
  } finally {
    restore();
    await server.close();
  }
});

test("khoá tài khoản không tồn tại trả 404", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUsers({ "admin-1": admin });
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users/nope/block`, { method: "POST", headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 404);
  } finally {
    restore();
    await server.close();
  }
});

test("phân trang kẹp limit trong khoảng 1..100", async () => {
  process.env.JWT_SECRET = "test-secret";
  let receivedLimit = 0;
  const restore = stubUsers({ "admin-1": admin }, {
    find: () => ({
      sort: () => ({ skip: () => ({ limit: async (value) => { receivedLimit = value; return []; } }) }),
    }),
    countDocuments: async () => 0,
  });
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users?limit=9999`, { headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal((await res.json()).limit, 100);
    assert.equal(receivedLimit, 100);
  } finally {
    restore();
    await server.close();
  }
});
