import { createHash } from "node:crypto";
import { Router } from "express";
import mongoose from "mongoose";
import { AiModel } from "../models/AiModel.js";
import { Translation } from "../models/Translation.js";
import { translateBatch } from "../services/gemini.js";
import { requireUser } from "../middleware/auth.js";
import { consumeQuota, limitFor, refundQuota } from "../services/quota.js";
import { chargeDailyUsage, quotaIdentity, readDailyUsage } from "../services/dailyQuota.js";
import { rateLimit } from "express-rate-limit";
import { readQuotaPolicy } from "../services/quotaPolicy.js";
import { chargeGuestTrial, readGuestToken, refundGuestTrial, startGuestTrial } from "../services/guestTrial.js";

import { CoinWallet, coinPaymentsEnabled, debitCoins, proExpiresAt, refundCoins } from '../services/coinWallet.js';

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

function requireGuest(req, res, next) {
  try {
    req.guestKey = readGuestToken((req.get("authorization") ?? "").replace(/^Bearer /, ""));
  } catch {
    return res.status(401).json({ error: "Phiên dùng thử đã hết hạn" });
  }
  next();
}

function basicRequestId(req) {
  const { requestId, ...extra } = req.body ?? {};
  return Object.keys(extra).length === 0 && typeof requestId === 'string' &&
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(requestId) ? requestId : null;
}

router.post('/guest/basic-translation', guestRate(20), requireGuest, async (req, res) => {
  const requestId = basicRequestId(req);
  if (!requestId) return res.status(400).json({ code: 'INVALID_REQUEST' });
  const remaining = await chargeGuestTrial(req.guestKey, requestId);
  if (remaining === null) return res.status(429).json({ code: 'TRIAL_EXHAUSTED', remaining: 0 });
  res.json({ remaining });
});
async function verifiedProExpiry(user, now) {
  if (!coinPaymentsEnabled()) return null;
  return proExpiresAt(await CoinWallet.findById(quotaIdentity(user)), now);
}

router.post('/basic-translation', requireUser, async (req, res) => {
  const { automatic = false, ...body } = req.body ?? {};
  const requestId = typeof automatic === 'boolean' ? basicRequestId({ body }) : null;
  if (!requestId) return res.status(400).json({ code: 'INVALID_REQUEST' });
  const now = new Date();
  const proUntil = await verifiedProExpiry(req.user, now);
  if (proUntil || (automatic && req.user.role === 'admin')) return res.json({ remaining: null });
  if (automatic) return res.status(403).json({ code: 'PAID_TRANSLATION_REQUIRED' });
  const limit = limitFor(req.user, req.user.dailyLimit > 0 ? undefined : (await readQuotaPolicy()).freeLimit);
  const quota = await chargeDailyUsage(req.user, limit, 1, now, requestId);
  if (!quota.ok) return res.status(429).json({ code: 'DAILY_LIMIT', remaining: 0 });
  res.json({ remaining: quota.remaining });
});
router.post('/basic-translation/offline', requireUser, async (req, res) => {
  const { count, ...body } = req.body ?? {};
  const requestId = basicRequestId({ body });
  if (!requestId || !Number.isInteger(count) || count < 1 || count > 20) {
    return res.status(400).json({ code: 'INVALID_REQUEST' });
  }
  const now = new Date();
  const proUntil = await verifiedProExpiry(req.user, now);
  if (proUntil) return res.json({ grantId: requestId, count: null, remaining: null, expiresAt: proUntil, serverTime: now });
  const limit = limitFor(req.user, req.user.dailyLimit > 0 ? undefined : (await readQuotaPolicy()).freeLimit);
  const quota = await chargeDailyUsage(req.user, limit, count, now, `offline:${requestId}`);
  if (!quota.ok) return res.status(429).json({ code: 'DAILY_LIMIT', remaining: quota.remaining });
  res.json({ grantId: `${quota.usageDate}:${requestId}`, count, remaining: quota.remaining, expiresAt: quota.expiresAt, serverTime: now });
});
router.post("/guest/translate", guestRate(20), requireGuest, (req, res) => {
  if (process.env.REQUIRE_PAID_AI === 'true') return res.status(403).json({ code: 'PAID_TRANSLATION_REQUIRED' });
  return translate(req, res);
});
// Legacy endpoints remain available during rollout. Set REQUIRE_PAID_AI=true after upgrading clients.
router.post('/ai-translation', requireUser, (req, res) => translate(req, res, true));
router.post("/translate", requireUser, (req, res) => {
  if (process.env.REQUIRE_PAID_AI === 'true') return res.status(403).json({ code: 'UPDATE_REQUIRED' });
  return translate(req, res);
});

async function translate(req, res, paidOnly = false) {
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
  let modelConfig;
  let coinDebit;
  let chargedDate;
  try {
    const now = new Date();
    const pro = paidOnly && Boolean(await verifiedProExpiry(req.user, now));
    const limit = guest || isAdmin ? 0 : limitFor(req.user, req.user.dailyLimit > 0 ? undefined : (await readQuotaPolicy()).freeLimit);
    let remaining = limit;
    if (guest) {
      remaining = await chargeGuestTrial(req.guestKey);
      if (remaining === null) return res.status(429).json({ code: "TRIAL_EXHAUSTED", error: "Đã hết lượt dùng thử", remaining: 0 });
      guestCharged = true;
      modelConfig = await AiModel.findOne({ enabled: true, $or: [{ coinPrice: 0 }, { coinPrice: { $exists: false } }] }).sort({ order: 1, _id: 1 }).lean();
      if (!modelConfig) throw new Error("Chưa có model cơ bản hoạt động");
      model = modelConfig.code;
    } else if (mongoose.connection.readyState === 1 && model) {
      modelConfig = await AiModel.findOne({ code: model, enabled: true }).lean();
      if (!modelConfig) return res.status(400).json({ error: "Model không tồn tại hoặc đang tắt" });
    }
    const coinPrice = modelConfig?.coinPrice ?? 0;
    if (paidOnly && !pro && !isAdmin && (mode === 'manga' || req.body.automatic === true || coinPrice === 0)) {
      return res.status(403).json({ code: 'PAID_TRANSLATION_REQUIRED' });
    }
    if (coinPrice > 0 && (guest || !coinPaymentsEnabled())) {
      return res.status(503).json({ code: 'COIN_PAYMENTS_DISABLED', error: 'Model trả xu chưa khả dụng' });
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
    const missing = mode === 'manga' ? texts : [...new Set(texts.filter((t) => !resultByText.has(t)))];

    if (missing.length > 0) {
      // Chỉ trừ lượt hoặc xu khi phải gọi AI.
      if (!guest && coinPrice > 0) {
        coinDebit = await debitCoins(req.user, coinPrice);
        if (!coinDebit) return res.status(429).json({ code: 'INSUFFICIENT_COINS', error: 'Không đủ xu để dùng model này' });
      } else if (!isAdmin && !guest) {
        const quota = await consumeQuota(req.user, 1, limit);
        if (!quota.ok) return res.status(429).json({ error: "Hết lượt dịch hôm nay", remaining: 0 });
        remaining = quota.remaining;
        chargedDate = quota.usageDate;
      }

      let translated;
      try {
        translated = await translateBatch(missing, sourceLang, targetLang, model, { mode, context, usageGroup, modelConfig });
      } catch (err) {
        if (coinDebit) await refundCoins(coinDebit.id).catch(() => console.error('Không hoàn được xu:', coinDebit.id));
        else if (chargedDate) await refundQuota(req.user, chargedDate);
        throw err;
      }
      if (mode === 'manga') return res.json({ translations: translated, cached: 0, remaining: isAdmin || coinDebit ? null : remaining, ...(coinDebit && { coinBalance: coinDebit.balance }) });

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
    res.json({ translations: texts.map((t) => resultByText.get(t)), cached: cachedCount, remaining: isAdmin || coinDebit ? null : remaining, ...(coinDebit && { coinBalance: coinDebit.balance }) });
  } catch (err) {
    if (guestCharged) await refundGuestTrial(req.guestKey).catch(() => console.warn("Không hoàn được lượt khách"));
    console.error("Dich loi:", err.message);
    res.status(502).json({ error: "Khong dich duoc, thu lai sau" });
  }
}

export default router;
