import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { requireUser, requireAdminUser } from "../src/middleware/auth.js";
import { signToken } from "../src/services/tokens.js";
import { User } from "../src/models/User.js";

// Dung server that de kiem tra middleware qua HTTP.
function makeServer(path, middleware) {
  const app = express();
  app.get(path, middleware, (req, res) => res.json({ ok: true }));
  return app.listen(0, "127.0.0.1");
}

async function withServer(app, run) {
  await new Promise((resolve) => app.once("listening", resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    await run(base);
  } finally {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
}

function stubUser(document) {
  const previous = User.findById;
  User.findById = async () => document;
  return () => {
    User.findById = previous;
  };
}

test("thiếu token trả 401", async () => {
  const app = makeServer("/me", requireUser);
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/me`);
    assert.equal(res.status, 401);
  });
});

test("token sai chữ ký trả 401 với thông báo phiên hết hạn", async () => {
  process.env.JWT_SECRET = "test-secret";
  const app = makeServer("/me", requireUser);
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/me`, { headers: { Authorization: "Bearer bad.token.here" } });
    assert.equal(res.status, 401);
    assert.match((await res.json()).error, /hết hạn/);
  });
});

test("token hợp lệ nhưng user không còn tồn tại trả 401", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUser(null);
  const app = makeServer("/me", requireUser);
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${signToken("gone")}` } });
      assert.equal(res.status, 401);
    });
  } finally {
    restore();
  }
});

test("tài khoản bị khoá trả 403", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUser({ _id: "u1", role: "user", status: "blocked" });
  const app = makeServer("/me", requireUser);
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${signToken("u1")}` } });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /khoá/);
    });
  } finally {
    restore();
  }
});

test("user thường gọi middleware admin bị 403", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUser({ _id: "u1", role: "user", status: "active" });
  const app = makeServer("/admin", requireAdminUser);
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/admin`, { headers: { Authorization: `Bearer ${signToken("u1")}` } });
      assert.equal(res.status, 403);
    });
  } finally {
    restore();
  }
});

test("admin đi qua được middleware admin", async () => {
  process.env.JWT_SECRET = "test-secret";
  const restore = stubUser({ _id: "u1", role: "admin", status: "active" });
  const app = makeServer("/admin", requireAdminUser);
  try {
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/admin`, { headers: { Authorization: `Bearer ${signToken("u1")}` } });
      assert.equal(res.status, 200);
    });
  } finally {
    restore();
  }
});
