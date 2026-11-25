import mongoose from "mongoose";

const dailyQuotaSchema = new mongoose.Schema({
  identityKey: { type: String, required: true },
  usageDate: { type: String, required: true },
  usageCount: { type: Number, min: 0, default: 0 },
  expiresAt: { type: Date, required: true },
  basicRequests: [{ _id: false, id: String, cost: Number }],
});

dailyQuotaSchema.index({ identityKey: 1, usageDate: 1 }, { unique: true });
dailyQuotaSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DailyQuota = mongoose.model("DailyQuota", dailyQuotaSchema);
