import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranslations, verifyModel } from "../src/services/aiTranslation.js";

process.env.AI_PROVIDER_ALLOWED_ORIGINS = "https://approved-provider.test";

test("không dùng fallback từ biến REVID cũ khi model thiếu URL hoặc khóa", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ message: { content: '["Xin chao"]' } }],
  }));
  process.env.REVID_BASE_URL = "https://approved-provider.test";
  process.env.REVID_API_KEY = "fixture-legacy-key";
  try {
    await assert.rejects(verifyModel("test", undefined, "fixture-model-key"));
    await assert.rejects(verifyModel("test", "https://approved-provider.test", "   "));
    await assert.rejects(verifyModel("test"));
    assert.equal(globalThis.fetch.mock.callCount(), 0);
  } finally {
    delete process.env.REVID_BASE_URL;
    delete process.env.REVID_API_KEY;
  }
});

test("chỉ gọi đích HTTPS được duyệt với đúng khóa và không theo redirect", async (t) => {
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({
    choices: [{ message: { content: '["Xin chao"]' } }],
  }));

  for (const [url, key] of [
    ["https://unapproved.test", "fixture-custom-key"],
    ["http://approved-provider.test", "fixture-custom-key"],
    ["https://approved-provider.test", ""],
    ["https://approved-provider.test:8443", "fixture-custom-key"],
  ]) {
    await assert.rejects(verifyModel("test", url, key));
  }
  assert.equal(upstream.mock.callCount(), 0);

  await verifyModel("test", "https://approved-provider.test/api/v1/", "fixture-custom-key");
  const [url, options] = upstream.mock.calls[0].arguments;
  assert.equal(url, "https://approved-provider.test/api/v1/chat/completions");
  assert.equal(options.headers.Authorization, "Bearer fixture-custom-key");
  assert.equal(options.redirect, "error");
});

test("lỗi upstream chỉ giữ HTTP status, không đọc nội dung lỗi", async (t) => {
  const text = t.mock.fn(async () => "fixture-sensitive-response");
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 401, text }));
  await assert.rejects(verifyModel("test", "https://approved-provider.test", "fixture-custom-key"), { message: "API tra ve HTTP 401" });
  assert.equal(text.mock.callCount(), 0);
});

test("parse mang JSON thuan", () => {
  assert.deepEqual(parseTranslations('["Xin chao","The gioi"]', 2), ["Xin chao", "The gioi"]);
});

test("parse JSON nam trong khoi markdown", () => {
  assert.deepEqual(parseTranslations('```json\n["Xin chao"]\n```', 1), ["Xin chao"]);
});

test("bao loi khi sai so luong", () => {
  assert.throws(() => parseTranslations('["a"]', 2));
});

test("bao loi khi khong phai JSON", () => {
  assert.throws(() => parseTranslations("Xin chao", 1));
});
