import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranslations } from "../src/services/gemini.js";

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
