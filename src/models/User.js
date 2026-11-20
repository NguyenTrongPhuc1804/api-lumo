import mongoose from "mongoose";

const webAdminSchema = new mongoose.Schema({
  loginEmail: { type: String, required: true },
  passwordHash: { type: String, required: true, select: false },
  mustChangePassword: { type: Boolean, required: true },
  credentialVersion: { type: String, required: true },
  role: { type: String, enum: ['admin', 'viewer'] },
}, { _id: false });

// Moi tai khoan gan voi mot nha cung cap dang nhap (google/facebook).
// Mot email dung 2 nha cung cap se thanh 2 tai khoan rieng.
const userSchema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ["google", "facebook", "web"] },
  providerId: { type: String, required: true },
  email: { type: String, default: "", trim: true, lowercase: true },
  name: { type: String, default: "", trim: true },
  avatar: { type: String, default: "" },
  role: { type: String, enum: ["user", "admin"], default: "user" },
  status: { type: String, enum: ["active", "blocked"], default: "active" },
  plan: { type: String, default: "free" }, // de san cho goi tra phi sau nay
  // 0 nghia la dung FREE_DAILY_LIMIT trong .env
  dailyLimit: { type: Number, default: 0, min: 0 },
  // Bo dem cu: chi giu schema de doc du lieu khi chuyen sang DailyQuota.
  usageDate: String,
  usageCount: { type: Number, min: 0 },
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now },
  webAdmin: { type: webAdminSchema },
});

// Cung mot tai khoan nha cung cap chi tao ra mot user
userSchema.index({ provider: 1, providerId: 1 }, { unique: true });

userSchema.index({ 'webAdmin.loginEmail': 1 }, {
  unique: true, partialFilterExpression: { 'webAdmin.loginEmail': { $type: 'string' } },
});

export const User = mongoose.model("User", userSchema);
