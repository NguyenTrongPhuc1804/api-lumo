import { User } from "../models/User.js";

// Ngay theo gio server, dang YYYY-MM-DD.
export function todayKey(now = new Date()) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function limitFor(user) {
  if (user.dailyLimit > 0) return user.dailyLimit;
  return Number(process.env.FREE_DAILY_LIMIT) || 100;
}

// Tru luot theo kieu tang nguyen tu (atomic), de hai request dong thoi
// khong cung lot qua han muc.
// Tra ve { ok: true, remaining, usageDate } hoac { ok: false, remaining: 0 }.
export async function consumeQuota(user, cost = 1) {
  const limit = limitFor(user);
  const today = todayKey();

  // Nhanh 1: con trong ngay hom nay va con luot.
  const updated = await User.findOneAndUpdate(
    { _id: user._id, usageDate: today, usageCount: { $lt: limit } },
    { $inc: { usageCount: cost } },
    { new: true }
  );
  if (updated) return { ok: true, remaining: Math.max(0, limit - updated.usageCount), usageDate: today };

  // Nhanh 2: sang ngay moi thi dat lai bo dem.
  const reset = await User.findOneAndUpdate(
    { _id: user._id, usageDate: { $ne: today } },
    { $set: { usageDate: today, usageCount: cost } },
    { new: true }
  );
  if (reset) return { ok: true, remaining: Math.max(0, limit - reset.usageCount), usageDate: today };

  // Nhanh 3: mot request khac vua dat lai ngay truoc do, nen thu lai nhanh 1.
  // Khong co nhanh nay thi request thu hai trong ngay moi bi tra 429 oan.
  const retried = await User.findOneAndUpdate(
    { _id: user._id, usageDate: today, usageCount: { $lt: limit } },
    { $inc: { usageCount: cost } },
    { new: true }
  );
  if (retried) return { ok: true, remaining: Math.max(0, limit - retried.usageCount), usageDate: today };

  return { ok: false, remaining: 0, usageDate: today };
}

// Hoan lai luot khi goi model that bai, de nguoi dung khong bi tru oan.
// Chi hoan neu bo dem van con o dung ngay da tru: neu da sang ngay moi
// thi bo dem da reset, tru them se lam am hoac an luot cua ngay moi.
export async function refundQuota(user, usageDate, cost = 1) {
  if (!usageDate) return;
  try {
    await User.updateOne(
      { _id: user._id, usageDate, usageCount: { $gte: cost } },
      { $inc: { usageCount: -cost } }
    );
  } catch (err) {
    console.warn("Hoan luot that bai:", err.message);
  }
}
