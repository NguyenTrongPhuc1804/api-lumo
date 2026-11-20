import { chargeDailyUsage, refundDailyUsage } from "./dailyQuota.js";

export function limitFor(user) {
  if (user.dailyLimit > 0) return user.dailyLimit;
  return Number(process.env.FREE_DAILY_LIMIT) || 100;
}

export async function consumeQuota(user, cost = 1) {
  return chargeDailyUsage(user, limitFor(user), cost);
}

export async function refundQuota(user, usageDate, cost = 1) {
  try {
    await refundDailyUsage(user, usageDate, cost);
  } catch (err) {
    console.warn("Hoan luot that bai:", err.message);
  }
}
