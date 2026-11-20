import { createHmac } from "node:crypto";
import { DailyQuota } from "../models/DailyQuota.js";

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

export function quotaPeriod(now = new Date()) {
  const local = new Date(now.getTime() + VN_OFFSET_MS);
  const usageDate = local.toISOString().slice(0, 10);
  local.setUTCHours(24, 0, 0, 0);
  return { usageDate, expiresAt: new Date(local.getTime() - VN_OFFSET_MS) };
}

export function quotaIdentity(user) {
  const secret = process.env.QUOTA_HMAC_SECRET;
  if (!secret?.trim()) throw new Error("Thieu QUOTA_HMAC_SECRET");
  const { provider, providerId } = user;
  if (!provider || !providerId) throw new Error("Tai khoan thieu danh tinh dang nhap");
  return createHmac("sha256", secret).update(JSON.stringify([provider, providerId])).digest("hex");
}

export async function readDailyUsage(user, now) {
  const { usageDate } = quotaPeriod(now);
  const row = await DailyQuota.findOne({ identityKey: quotaIdentity(user), usageDate });
  return { usageDate, usageCount: row?.usageCount ?? 0 };
}

export async function chargeDailyUsage(user, limit, cost = 1, now) {
  const { usageDate, expiresAt } = quotaPeriod(now);
  const key = { identityKey: quotaIdentity(user), usageDate };
  if (!Number.isSafeInteger(cost) || cost < 1) throw new Error("So luot tru khong hop le");
  if (cost > limit) return { ok: false, remaining: 0, usageDate };

  try {
    await DailyQuota.updateOne(key, { $setOnInsert: { usageCount: 0, expiresAt } }, { upsert: true });
  } catch (err) {
    // Request khác vừa tạo bộ đếm cho đúng danh tính và ngày này.
    if (err.code !== 11000 || err.keyPattern?.identityKey !== 1 || err.keyPattern?.usageDate !== 1) throw err;
  }
  const row = await DailyQuota.findOneAndUpdate(
    { ...key, usageCount: { $lte: limit - cost } },
    { $inc: { usageCount: cost } },
    { new: true }
  );
  return row ? { ok: true, remaining: limit - row.usageCount, usageDate } : { ok: false, remaining: 0, usageDate };
}

export async function refundDailyUsage(user, usageDate, cost = 1) {
  if (!usageDate) return;
  if (!Number.isSafeInteger(cost) || cost < 1) throw new Error("So luot hoan khong hop le");
  await DailyQuota.updateOne(
    { identityKey: quotaIdentity(user), usageDate, usageCount: { $gte: cost }, expiresAt: { $gt: new Date() } },
    { $inc: { usageCount: -cost } }
  );
}
