import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers/test-app.js";
import { createAuthRouter } from "../src/routes/auth.js";
import { User } from "../src/models/User.js";

const fakeExchange = async () => ({ providerId: "g1", email: "a@x.com", name: "A", avatar: "" });

// Stub DB de test khong can MongoDB.
function stubUser() {
  const previous = User.findOneAndUpdate;
  User.findOneAndUpdate = async () => ({ _id: "u1", role: "user", name: "A", email: "a@x.com", avatar: "", async save() {} });
  return () => {
    User.findOneAndUpdate = previous;
  };
}

test("start chuyển hướng Google kèm state", async () => {
  process.env.GOOGLE_CLIENT_ID = "client-1";
  process.env.OAUTH_REDIRECT_BASE = "https://lumo.example";
  process.env.JWT_SECRET = "test-secret";
  const server = await startTestServer(createAuthRouter({ exchangeGoogleCode: fakeExchange }));
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/google/start`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const url = new URL(res.headers.get("location"));
    assert.equal(url.origin, "https://accounts.google.com");
    assert.equal(url.searchParams.get("client_id"), "client-1");
    assert.equal(url.searchParams.get("redirect_uri"), "https://lumo.example/api/auth/google/callback");
    assert.ok(url.searchParams.get("state"));
  } finally {
    await server.close();
  }
});

test("callback với state sai bị từ chối", async () => {
  process.env.JWT_SECRET = "test-secret";
  const server = await startTestServer(createAuthRouter({ exchangeGoogleCode: fakeExchange }));
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/google/callback?code=c&state=bad`, { redirect: "manual" });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test("callback thiếu state bị từ chối", async () => {
  process.env.JWT_SECRET = "test-secret";
  const server = await startTestServer(createAuthRouter({ exchangeGoogleCode: fakeExchange }));
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/google/callback?code=c`, { redirect: "manual" });
    assert.equal(res.status, 400);
  } finally {
    await server.close();
  }
});

test("callback hợp lệ tạo user và chuyển về app kèm token", async () => {
  process.env.JWT_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "client-1";
  process.env.OAUTH_REDIRECT_BASE = "https://lumo.example";
  process.env.APP_DEEP_LINK = "lumolens://auth";
  const restore = stubUser();
  const server = await startTestServer(createAuthRouter({ exchangeGoogleCode: fakeExchange }));
  try {
    const start = await fetch(`${server.baseUrl}/api/auth/google/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const res = await fetch(`${server.baseUrl}/api/auth/google/callback?code=c&state=${state}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /^lumolens:\/\/auth\?token=/);
  } finally {
    restore();
    await server.close();
  }
});

test("đổi mã thất bại thì chuyển về app kèm mã lỗi, không lộ chi tiết", async () => {
  process.env.JWT_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "client-1";
  process.env.OAUTH_REDIRECT_BASE = "https://lumo.example";
  process.env.APP_DEEP_LINK = "lumolens://auth";
  const failing = async () => {
    throw new Error("secret detail");
  };
  const server = await startTestServer(createAuthRouter({ exchangeGoogleCode: failing }));
  try {
    const start = await fetch(`${server.baseUrl}/api/auth/google/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const res = await fetch(`${server.baseUrl}/api/auth/google/callback?code=c&state=${state}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.match(location, /error=/);
    assert.equal(location.includes("secret"), false);
  } finally {
    await server.close();
  }
});

test("state của phiên khác không dùng lại được", async () => {
  process.env.JWT_SECRET = "test-secret";
  process.env.GOOGLE_CLIENT_ID = "client-1";
  process.env.OAUTH_REDIRECT_BASE = "https://lumo.example";
  const other = await startTestServer(createAuthRouter({ exchangeGoogleCode: fakeExchange }));
  try {
    // State ký bằng secret khác phải bị từ chối.
    const forged = (await import("jsonwebtoken")).default.sign({ n: "x" }, "wrong-secret");
    const res = await fetch(`${other.baseUrl}/api/auth/google/callback?code=c&state=${forged}`, { redirect: "manual" });
    assert.equal(res.status, 400);
  } finally {
    await other.close();
  }
});

test("facebook trả 501 vì chưa bật", async () => {
  const server = await startTestServer(createAuthRouter({ exchangeGoogleCode: fakeExchange }));
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/facebook/start`);
    assert.equal(res.status, 501);
  } finally {
    await server.close();
  }
});
