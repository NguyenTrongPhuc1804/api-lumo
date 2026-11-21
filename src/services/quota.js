import { chargeDailyUsage, refundDailyUsage } from "./dailyQuota.js";
import { defaultFreeLimit } from "./quotaPolicy.js";

export function limitFor(user, freeLimit = defaultFreeLimit()) {
  return user.dailyLimit > 0 ? user.dailyLimit : freeLimit;
}

export async function consumeQuota(user, cost = 1, limit = limitFor(user)) {
  return chargeDailyUsage(user, limit, cost);
}

export async function refundQuota(user, usageDate, cost = 1) {
  try {
    await refundDailyUsage(user, usageDate, cost);
  } catch (err) {
    console.warn("Hoan luot that bai:", err.message);
  }
}
