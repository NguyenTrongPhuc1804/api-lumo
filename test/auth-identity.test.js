import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { roleFor, signToken, verifyToken, findOrCreateUser } from "../src/services/tokens.js";
import { User } from "../src/models/User.js";

test("email trong ADMIN_EMAILS thành admin, không phân biệt hoa thường", () => {
  process.env.ADMIN_EMAILS = " boss@x.com , Other@y.com ";
  assert.equal(roleFor("BOSS@x.com"), "admin");
  assert.equal(roleFor(" other@Y.com "), "admin");
  assert.equal(roleFor("nobody@z.com"), "user");
  assert.equal(roleFor(""), "user");
});

test("ADMIN_EMAILS rỗng thì không ai là admin", () => {
  process.env.ADMIN_EMAILS = "";
  assert.equal(roleFor("boss@x.com"), "user");
});

test("token ký và xác minh được, sai chữ ký thì ném lỗi", () => {
  process.env.JWT_SECRET = "test-secret";
  const token = signToken("user-1");
  assert.equal(verifyToken(token).userId, "user-1");
  assert.throws(() => verifyToken(token + "x"));
});

test("token hết hạn bị từ chối", () => {
  process.env.JWT_SECRET = "test-secret";
  const expired = jwt.sign({ userId: "u" }, "test-secret", { expiresIn: -1 });
  assert.throws(() => verifyToken(expired));
});

test("role chỉ được nâng, không bị hạ khi email rời ADMIN_EMAILS", async () => {
  const previous = User.findOneAndUpdate;
  const doc = { role: "admin", saved: 0, async save() { this.saved++; } };
  User.findOneAndUpdate = async () => doc;
  try {
    process.env.ADMIN_EMAILS = "";
    const result = await findOrCreateUser({ provider: "google", providerId: "g1", email: "a@x.com", name: "A", avatar: "" });
    assert.equal(result.role, "admin");
    assert.equal(doc.saved, 0);
  } finally {
    User.findOneAndUpdate = previous;
  }
});

test("user mới có email trong ADMIN_EMAILS được nâng thành admin", async () => {
  const previous = User.findOneAndUpdate;
  const doc = { role: "user", saved: 0, async save() { this.saved++; } };
  User.findOneAndUpdate = async () => doc;
  try {
    process.env.ADMIN_EMAILS = "boss@x.com";
    await findOrCreateUser({ provider: "google", providerId: "g1", email: "boss@x.com", name: "A", avatar: "" });
    assert.equal(doc.role, "admin");
    assert.equal(doc.saved, 1);
  } finally {
    User.findOneAndUpdate = previous;
  }
});

test("upsert theo provider + providerId, không ghi đè role bằng $set", async () => {
  const previous = User.findOneAndUpdate;
  let receivedFilter;
  let receivedUpdate;
  User.findOneAndUpdate = async (filter, update) => {
    receivedFilter = filter;
    receivedUpdate = update;
    return { role: "user", save: async () => {} };
  };
  try {
    process.env.ADMIN_EMAILS = "";
    await findOrCreateUser({ provider: "google", providerId: "g1", email: "a@x.com", name: "A", avatar: "" });
    assert.deepEqual(receivedFilter, { provider: "google", providerId: "g1" });
    assert.equal(Object.hasOwn(receivedUpdate.$set, "role"), false);
    assert.equal(Object.hasOwn(receivedUpdate.$setOnInsert, "role"), false);
    assert.equal(receivedUpdate.$setOnInsert.status, "active");
    assert.equal(receivedUpdate.$setOnInsert.plan, "free");
  } finally {
    User.findOneAndUpdate = previous;
  }
});

test("schema có index duy nhất theo provider + providerId và enum đúng", () => {
  const indexes = User.schema.indexes();
  const uniqueIndex = indexes.find(([fields]) => fields.provider === 1 && fields.providerId === 1);
  assert.ok(uniqueIndex, "thiếu index provider + providerId");
  assert.equal(uniqueIndex[1].unique, true);
  const doc = new User({ provider: "google", providerId: "g1", email: "a@x.com", name: "A" });
  assert.equal(doc.role, "user");
  assert.equal(doc.status, "active");
  assert.equal(doc.plan, "free");
  assert.equal(doc.usageCount, undefined); // Bộ đếm mới không nằm trên hồ sơ.
  assert.equal(doc.usageDate, undefined);
});
