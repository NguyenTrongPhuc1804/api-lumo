import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminUsersRouter } from "../src/routes/adminUsers.js";
import { signToken } from "../src/services/tokens.js";
import { User } from "../src/models/User.js";
import express from "express";
import { DailyQuota } from "../src/models/DailyQuota.js";
import { quotaIdentity, quotaPeriod } from "../src/services/dailyQuota.js";

const { QuotaPolicy } = await import("../src/services/quotaPolicy.js");
QuotaPolicy.findById = async () => null;

process.env.QUOTA_HMAC_SECRET = "test-quota-secret";

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

test("admin xem được số lượt từ bộ đếm mới mà không thấy định danh", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  const profile = { ...other, provider: "google", providerId: "secret-provider-id", usageCount: 88,
    webAdmin: { loginEmail: "fixture@example.com", credentialVersion: "fixture-version" },
  };
  const identityKey = quotaIdentity(profile);
  t.mock.method(DailyQuota, "find", async (filter) => {
    assert.deepEqual(filter, { identityKey: { $in: [identityKey] }, usageDate: quotaPeriod().usageDate });
    return [{ identityKey, usageCount: 3 }];
  });
  const restore = stubUsers({ "admin-1": admin }, {
    find: () => ({
      sort: () => ({ skip: () => ({ limit: async () => [profile] }) }),
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
    assert.equal(body.items[0].usageCount, 3);
    assert.equal("providerId" in body.items[0], false);
    assert.equal("identityKey" in body.items[0], false);
    assert.equal("webAdminGranted" in body.items[0], false);
    assert.equal("webAdminLoginEmail" in body.items[0], false);
  } finally {
    restore();
    await server.close();
  }
});

test("admin mobile khoá được user khác và vô hiệu hóa phiên web trong cùng thao tác", async (t) => {
  process.env.JWT_SECRET = "test-secret";
  const target = { ...other, webAdmin: { credentialVersion: "old" } };
  const restore = stubUsers({ "admin-1": admin, "user-2": target });
  t.mock.method(User, "updateOne", async (filter, update) => {
    assert.deepEqual(filter, { _id: "user-2", provider: { $ne: "web" }, "webAdmin.credentialVersion": "old" });
    target.status = update.$set.status;
    target.webAdmin.credentialVersion = update.$set["webAdmin.credentialVersion"];
    return { matchedCount: 1 };
  });
  const server = await serve(createAdminUsersRouter());
  try {
    const res = await fetch(`${server.baseUrl}/api/admin/users/user-2/block`, { method: "POST", headers: { Authorization: `Bearer ${signToken("admin-1")}` } });
    assert.equal(res.status, 200);
    assert.equal(target.status, "blocked");
    assert.match(target.webAdmin.credentialVersion, /^[a-f0-9]{32}$/);
    assert.notEqual(target.webAdmin.credentialVersion, "old");
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
