import mongoose from "mongoose";

// Moi tai khoan gan voi mot nha cung cap dang nhap (google/facebook).
// Mot email dung 2 nha cung cap se thanh 2 tai khoan rieng.
const userSchema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ["google", "facebook"] },
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
});

// Cung mot tai khoan nha cung cap chi tao ra mot user
userSchema.index({ provider: 1, providerId: 1 }, { unique: true });

export const User = mongoose.model("User", userSchema);
