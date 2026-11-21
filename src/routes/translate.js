import { createHash } from "node:crypto";
import { Router } from "express";
import mongoose from "mongoose";
import { AiModel } from "../models/AiModel.js";
import { Translation } from "../models/Translation.js";
import { translateBatch } from "../services/gemini.js";
import { requireUser } from "../middleware/auth.js";
import { consumeQuota, limitFor, refundQuota } from "../services/quota.js";
import { readDailyUsage } from "../services/dailyQuota.js";
import { rateLimit } from "express-rate-limit";
import { readQuotaPolicy } from "../services/quotaPolicy.js";
import { chargeGuestTrial, readGuestToken, refundGuestTrial, startGuestTrial } from "../services/guestTrial.js";

const router = Router();

const MAX_ITEMS = 50;
const MAX_CHARS_PER_ITEM = 2000;

// Co model thi tinh vao khoa cache, de moi model giu ban dich rieng
function makeKey(sourceLang, targetLang, text, model) {
  const base = `${sourceLang}|${targetLang}|${text}`;
  return createHash("sha256").update(model ? `${base}|${model}` : base).digest("hex");
}

// POST /api/translate
// body: { texts: ["Hello", "World"], sourceLang: "auto", targetLang: "vi" }
// tra ve: { translations: ["Xin chao", "The gioi"], cached: 1 }
const guestRate = (limit) => rateLimit({ windowMs: 60_000, limit, handler: (_req, res) => {
  res.status(429).json({ code: "RATE_LIMITED", error: "Thao tác quá nhanh, vui lòng thử lại sau" });
} });

router.post("/guest/session", guestRate(12), async (req, res) => {
  const { installId } = req.body ?? {};
  if (typeof installId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(installId)) {
    return res.status(400).json({ error: "Mã bản cài không hợp lệ" });
  }
  try {
    res.json(await startGuestTrial(installId.toLowerCase()));
  } catch {
    res.status(503).json({ error: "Không tải được lượt dùng thử" });
  }
});

router.post("/guest/translate", guestRate(20), (req, res, next) => {
  try {
    req.guestKey = readGuestToken((req.get("authorization") ?? "").replace(/^Bearer /, ""));
  } catch {
    return res.status(401).json({ error: "Phiên dùng thử đã hết hạn" });
  }
  next();
}, translate);
router.post("/translate", requireUser, translate);

async function translate(req, res) {
  const { texts, sourceLang = "auto", targetLang, mode = "game", context = [] } = req.body ?? {};
  if (mode !== "game" && mode !== "manga") return res.status(400).json({ error: "Mode khong hop le" });
  if (!Array.isArray(context) || context.length > 3 || context.some(turn =>
    !Array.isArray(turn) || turn.length === 0 || turn.length > 3000 || turn.some(pair =>
      !pair || Object.keys(pair).some(key => key !== "source" && key !== "translation") || typeof pair.source !== "string" || typeof pair.translation !== "string" ||
      !pair.source.length || !pair.translation.length))) {
    return res.status(400).json({ error: "Context khong hop le" });
  }
  const contextLength = context.reduce((total, turn) => total + turn.reduce((sum, pair) => sum + pair.source.length + pair.translation.length, 0), 0);
  if (contextLength > 6000 || (mode === "game" && context.length > 0)) {
    return res.status(400).json({ error: "Context vuot gioi han hoac khong dung mode" });
  }
  const guest = Boolean(req.guestKey);
  let model = typeof req.body.model === "string" ? req.body.model : "";

  // 1. Kiem tra du lieu dau vao
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_ITEMS) {
    return res.status(400).json({ error: `texts phai la mang 1 den ${MAX_ITEMS} phan tu` });
  }
  if (texts.some((t) => typeof t !== "string" || t.length > MAX_CHARS_PER_ITEM)) {
    return res.status(400).json({ error: `Moi cau phai la chuoi toi da ${MAX_CHARS_PER_ITEM} ky tu` });
  }
  if (typeof targetLang !== "string" || typeof sourceLang !== "string" || !targetLang) {
    return res.status(400).json({ error: "Thieu sourceLang hoac targetLang" });
  }

  // Theo gói, không theo vai trò quản trị. Chỉ Guest/Free đang hoạt động.
  const usageGroup = guest ? 'guest' : 'free';
  const isAdmin = req.user?.role === "admin";
  let guestCharged = false;
  try {
    const limit = guest || isAdmin ? 0 : limitFor(req.user, req.user.dailyLimit > 0 ? undefined : (await readQuotaPolicy()).freeLimit);
    let remaining = limit;
    if (guest) {
      remaining = await chargeGuestTrial(req.guestKey);
      if (remaining === null) return res.status(429).json({ code: "TRIAL_EXHAUSTED", error: "Đã hết lượt dùng thử", remaining: 0 });
      guestCharged = true;
      const selected = await AiModel.findOne({ enabled: true }).sort({ order: 1, _id: 1 }).lean();
      if (!selected) throw new Error("Chưa có model hoạt động");
      model = selected.code;
    }
    if (mode === "manga") {
      // Manga khong dung cache nen moi lan quet la mot luot that.
      let chargedDate = "";
      if (!isAdmin && !guest) {
        const quota = await consumeQuota(req.user, 1, limit);
        if (!quota.ok) return res.status(429).json({ error: "Hết lượt dịch hôm nay", remaining: 0 });
        remaining = quota.remaining;
        chargedDate = quota.usageDate;
      }
      try {
        const translations = await translateBatch(texts, sourceLang, targetLang, model, { mode, context, usageGroup });
        return res.json({ translations, cached: 0, remaining: isAdmin ? null : remaining });
      } catch (err) {
        if (!isAdmin && !guest) await refundQuota(req.user, chargedDate);
        throw err;
      }
    }
    // 2. Tim ban dich da luu (neu Mongo dang chay)
    const dbReady = mongoose.connection.readyState === 1 && mode === "game";
    const resultByText = new Map();

    if (dbReady) {
      const keys = texts.map((t) => makeKey(sourceLang, targetLang, t, model));
      const found = await Translation.find({ key: { $in: keys } });
      for (const item of found) {
        resultByText.set(item.text, item.translated);
      }
    }
    const cachedCount = resultByText.size;

    // 3. Chi dich nhung cau chua co, bo cau trung nhau
    const missing = [...new Set(texts.filter((t) => !resultByText.has(t)))];

    if (missing.length > 0) {
      // Chi tru luot khi that su phai goi model. Trung cache thi khong ton tien.
      let chargedDate = "";
      if (!isAdmin && !guest) {
        const quota = await consumeQuota(req.user, 1, limit);
        if (!quota.ok) return res.status(429).json({ error: "Hết lượt dịch hôm nay", remaining: 0 });
        remaining = quota.remaining;
        chargedDate = quota.usageDate;
      }

      let translated;
      try {
        translated = await translateBatch(missing, sourceLang, targetLang, model, { usageGroup });
      } catch (err) {
        // Goi model that bai thi tra lai luot da tru.
        if (!isAdmin && !guest) await refundQuota(req.user, chargedDate);
        throw err;
      }

      missing.forEach((text, i) => resultByText.set(text, translated[i]));

      // 4. Luu cache, loi o day khong lam hong request
      if (dbReady) {
        const operations = missing.map((text, i) => ({
          updateOne: {
            filter: { key: makeKey(sourceLang, targetLang, text, model) },
            update: { $set: { sourceLang, targetLang, text, translated: translated[i] } },
            upsert: true,
          },
        }));
        await Translation.bulkWrite(operations).catch((err) => console.warn("Luu cache loi:", err.message));
      }
    }

    if (!isAdmin && !guest && missing.length === 0) {
      const usage = await readDailyUsage(req.user);
      remaining = Math.max(0, limit - usage.usageCount);
    }

    // 5. Tra ket qua dung thu tu cua request
    res.json({ translations: texts.map((t) => resultByText.get(t)), cached: cachedCount, remaining: isAdmin ? null : remaining });
  } catch (err) {
    if (guestCharged) await refundGuestTrial(req.guestKey).catch(() => console.warn("Không hoàn được lượt khách"));
    console.error("Dich loi:", err.message);
    res.status(502).json({ error: "Khong dich duoc, thu lai sau" });
  }
}

export default router;
