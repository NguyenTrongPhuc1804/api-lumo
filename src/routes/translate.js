import { createHash } from "node:crypto";
import { Router } from "express";
import mongoose from "mongoose";
import { AiModel } from "../models/AiModel.js";
import { Translation } from "../models/Translation.js";
import { translateBatch } from "../services/aiTranslation.js";
import { requireUser } from "../middleware/auth.js";
import { consumeQuota, limitFor, refundQuota } from "../services/quota.js";
import { chargeDailyUsage, quotaIdentity, readDailyUsage, refundDailyUsage } from "../services/dailyQuota.js";
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
router.post('/guest/ai-translation', guestRate(20), requireGuest, (req, res) => translate(req, res, true));
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
  let sharedRequestId;
  let replay = false;
  try {
    const now = new Date();
    const pro = paidOnly && !guest && !isAdmin && Boolean(await verifiedProExpiry(req.user, now));
    if (paidOnly && !pro && !isAdmin && !model) return res.status(403).json({ code: 'PAID_TRANSLATION_REQUIRED' });
    const policy = (paidOnly && !pro && !isAdmin) || (!guest && !isAdmin && !(req.user.dailyLimit > 0)) ? await readQuotaPolicy() : null;
    const limit = guest || isAdmin ? 0 : limitFor(req.user, policy?.freeLimit);
    let remaining = limit;
    if (guest && !paidOnly) {
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
    if (paidOnly && !pro && !isAdmin) {
      const sharedModel = modelConfig && policy?.sharedAiModelId === String(modelConfig._id) && coinPrice === 0;
      if (mode !== 'game' || (req.body.automatic !== undefined && req.body.automatic !== false) ||
          (guest ? !sharedModel : coinPrice === 0 && !sharedModel)) {
        return res.status(403).json({ code: 'PAID_TRANSLATION_REQUIRED' });
      }
      if (sharedModel) {
        const requestId = basicRequestId({ body: { requestId: req.body.requestId } });
        if (!requestId) return res.status(400).json({ code: 'INVALID_REQUEST' });
        // Bind the ID to the exact request; replay must not buy a different translation.
        const fingerprint = createHash('sha256').update(JSON.stringify([model, sourceLang, targetLang, texts])).digest('hex');
        const usageId = `ai:${requestId}:${fingerprint}`;
        if (guest) {
          const trial = await chargeGuestTrial(req.guestKey, usageId, true);
          if (!trial) return res.status(429).json({ code: 'TRIAL_EXHAUSTED', remaining: 0 });
          replay = trial.replay;
          remaining = trial.remaining;
          guestCharged = !replay;
        } else {
          const quota = await chargeDailyUsage(req.user, limit, 1, now, usageId, true);
          if (!quota.ok) return res.status(429).json({ code: 'DAILY_LIMIT', remaining: 0 });
          replay = quota.replay === true;
          remaining = quota.remaining;
          if (!replay) chargedDate = quota.usageDate;
        }
        sharedRequestId = usageId;
      }
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

    if (replay && missing.length > 0) {
      return res.status(409).json({ code: 'AI_REQUEST_ALREADY_USED' });
    }
    if (missing.length > 0) {
      // Với model trả xu và luồng cũ, chỉ trừ khi phải gọi AI.
      if (!guest && coinPrice > 0) {
        coinDebit = await debitCoins(req.user, coinPrice);
        if (!coinDebit) return res.status(429).json({ code: 'INSUFFICIENT_COINS', error: 'Không đủ xu để dùng model này' });
      } else if (!isAdmin && !guest && !sharedRequestId) {
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
        else if (chargedDate && !sharedRequestId) await refundQuota(req.user, chargedDate);
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
        await Translation.bulkWrite(operations).catch(() => console.warn("TRANSLATION_CACHE_WRITE_FAILED"));
      }
    }

    if (!isAdmin && !guest && !sharedRequestId && missing.length === 0) {
      const usage = await readDailyUsage(req.user);
      remaining = Math.max(0, limit - usage.usageCount);
    }

    // 5. Tra ket qua dung thu tu cua request
    res.json({ translations: texts.map((t) => resultByText.get(t)), cached: cachedCount, remaining: isAdmin || coinDebit ? null : remaining, ...(coinDebit && { coinBalance: coinDebit.balance }) });
  } catch {
    if (guestCharged) await refundGuestTrial(req.guestKey, sharedRequestId).catch(() => console.warn("Không hoàn được lượt khách"));
    else if (sharedRequestId && chargedDate) {
      await refundDailyUsage(req.user, chargedDate, 1, sharedRequestId).catch(() => console.warn('Không hoàn được lượt Free'));
    }
    console.error("TRANSLATION_FAILED");
    res.status(502).json({ error: "Khong dich duoc, thu lai sau" });
  }
}

export default router;
