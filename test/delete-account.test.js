import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthRouter } from "../src/routes/auth.js";
import { signToken } from "../src/services/tokens.js";
import { User } from "../src/models/User.js";
import { startTestServer } from "./helpers/test-app.js";

process.env.JWT_SECRET = "test-secret";

for (const scenario of [
  { name: "thiếu token", token: false, status: 401 },
  { name: "token sai", token: "invalid", status: 401 },
  { name: "xoá user và thu hồi phiên ngay", role: "user", status: 200 },
  { name: "admin tự xoá", role: "admin", status: 200 },
  { name: "tài khoản bị khoá", blocked: true, status: 403 },
  { name: "lỗi database khi xoá", fail: true, status: 503 },
  { name: "user biến mất giữa xác thực và xoá", missing: true, status: 404 },
]) {
  test(scenario.name, async () => {
    const previous = { findById: User.findById, deleteOne: User.deleteOne };
    let user = { _id: "u1", role: scenario.role || "user", status: scenario.blocked ? "blocked" : "active" };
    const deleted = [];
    User.findById = async () => user;
    User.deleteOne = async (filter) => {
      if (scenario.fail) throw new Error("offline");
      deleted.push(filter);
      user = null;
      return { deletedCount: scenario.missing ? 0 : 1 };
    };
    const server = await startTestServer(createAuthRouter());
    try {
      const headers = scenario.token === false ? {} : { Authorization: `Bearer ${scenario.token || signToken("u1")}` };
      const res = await fetch(`${server.baseUrl}/api/me`, { method: "DELETE", headers });
      assert.equal(res.status, scenario.status);
      if (scenario.status === 200) {
        assert.deepEqual(await res.json(), { ok: true });
        assert.deepEqual(deleted, [{ _id: "u1", provider: { $ne: "web" } }]);
        assert.equal(await User.findById("u1"), null);
        const retry = await fetch(`${server.baseUrl}/api/me`, { method: "DELETE", headers });
        assert.equal(retry.status, 401);
        assert.equal((await retry.json()).code, "ACCOUNT_NOT_FOUND");
      }
      if (scenario.status === 401 || scenario.status === 403) assert.equal(deleted.length, 0);
    } finally {
      Object.assign(User, previous);
      await server.close();
    }
  });
}
