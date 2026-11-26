import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdminModelsRouter, readModelFields, toClient } from "../src/routes/models.js";
import express from "express";
import mongoose from "mongoose";
import { AiModel } from "../src/models/AiModel.js";
test("description preserves lines, clears explicitly and validates type/length", () => {
  assert.equal(readModelFields({ description: "  Dịch manga\nTiếng Việt  " }).description, "Dịch manga\nTiếng Việt");
  assert.equal(readModelFields({ description: "" }).description, "");
  assert.equal(Object.hasOwn(readModelFields({ name: "New" }), "description"), false);
  assert.throws(() => readModelFields({ description: 42 }), /mô tả/i);
  assert.throws(() => readModelFields({ description: "a".repeat(501) }), /500/);
});
test("coin price defaults to zero and rejects invalid inputs", () => {
  assert.equal(new AiModel({ code: 'a', name: 'A' }).coinPrice, 0);
  assert.equal(toClient({ code: 'a', name: 'A' }, false).coinPrice, 0);
  assert.equal(readModelFields({ coinPrice: 5 }).coinPrice, 5);
  for (const coinPrice of [-1, 1.5, '5', 10001]) assert.throws(() => readModelFields({ coinPrice }), /xu/);
});

test("description round trips without leaking full keys, old records default empty", () => {
  const doc = { _id: "1", code: "test", name: "Test", apiKey: "secret-key-value", description: "Hello\nWorld" };
  assert.equal(toClient(doc, false).description, doc.description);
  assert.equal(toClient(doc, true).description, doc.description);
  assert.notEqual(toClient(doc, true).apiKey, doc.apiKey);
  assert.equal(Object.hasOwn(toClient(doc, false), "apiKey"), false);
  assert.equal(toClient({ code: "old", name: "Old" }, false).description, "");
});
test("invalid descriptions return JSON 400; description-only PUT persists without verification", async () => {
  const state = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  const findById = AiModel.findById;
  const saved = { code: "test", name: "Test", baseUrl: "", apiKey: "", description: "Old", async save() {}, toObject() { return { ...this }; } };
  AiModel.findById = async () => saved;
  const app = express();
  app.use(express.json());
  app.use('/api/admin-web', createAdminModelsRouter((req, res, next) => {
    req.adminWeb = { role: 'owner' };
    next();
  }));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { 'Content-Type': 'application/json' };
    const bad = await fetch(`${base}/api/admin-web/models`, { method: 'POST', headers, body: JSON.stringify({ description: 'a'.repeat(501) }) });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type'), /json/);
    assert.match((await bad.json()).error, /500/);
    const response = await fetch(`${base}/api/admin-web/models/id`, { method: 'PUT', headers, body: JSON.stringify({ description: '' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model.description, '');
    assert.equal(saved.description, '');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    AiModel.findById = findById;
    mongoose.connection.readyState = state;
  }
});

test("schema accepts missing description and rejects overlong descriptions", () => {
  assert.equal(new AiModel({ code: "a", name: "A" }).description, "");
  assert.ok(new AiModel({ code: "a", name: "A", description: "a".repeat(501) }).validateSync());
});
