import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { startTestServer } from "./helpers/test-app.js";

for (const file of ["privacy.html", "terms.html", "account-deletion.html"]) {
  test(`legal/${file} public HTML without external resources`, async () => {
    const router = express.Router();
    router.use(express.static(fileURLToPath(new URL("../public/legal/", import.meta.url))));
    const server = await startTestServer(router, "/legal");
    try {
      const res = await fetch(`${server.baseUrl}/legal/${file}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/html/);
      const html = await res.text();
      assert.match(html, /Lumo Lens/);
      assert.match(html, /href="mailto:phucnguyentrong1804@gmail\.com"/);
      assert.doesNotMatch(html, /đang chờ chủ ứng dụng|khi có địa chỉ liên hệ/i);
      if (file === "account-deletion.html") {
        assert.match(html, /3 ngày kể từ khi nhận được yêu cầu/i);
      }
      assert.match(html, /chưa qua tư vấn pháp lý/i);
      assert.match(html, /00:00 giờ Việt Nam/);
      assert.doesNotMatch(html, /gói và bộ đếm lượt dịch/);
      assert.doesNotMatch(html, /<script|(?:src|href)=["']https?:/i);
    } finally {
      await server.close();
    }
  });
}
