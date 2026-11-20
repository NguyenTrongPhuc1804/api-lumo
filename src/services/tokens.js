import jwt from "jsonwebtoken";
import { User } from "../models/User.js";

export const TOKEN_DAYS = 30;

export function signToken(userId) {
  return jwt.sign({ userId: String(userId) }, process.env.JWT_SECRET, { expiresIn: `${TOKEN_DAYS}d` });
}

// Nem loi neu token sai chu ky hoac het han; noi goi tu bat lay.
export function verifyToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (!payload || typeof payload.userId !== "string") throw new Error("Token không hợp lệ");
  return { userId: payload.userId };
}

// Doc danh sach email admin trong .env, so sanh khong phan biet hoa thuong.
export function roleFor(email) {
  const list = String(process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(email ?? "").trim().toLowerCase()) ? "admin" : "user";
}

// Tao moi hoac cap nhat thong tin hien thi khi dang nhap.
// Chi NANG quyen admin, khong bao gio ha: neu email bi xoa khoi ADMIN_EMAILS
// thi tai khoan van giu quyen, de khong tu khoa minh khoi he thong.
export async function findOrCreateUser({ provider, providerId, email, name, avatar }) {
  const user = await User.findOneAndUpdate(
    { provider, providerId },
    {
      $set: { email: email ?? "", name: name ?? "", avatar: avatar ?? "", lastLoginAt: new Date() },
      $setOnInsert: { status: "active", plan: "free", dailyLimit: 0 },
    },
    { new: true, upsert: true }
  );

  if (roleFor(email) === "admin" && user.role !== "admin") {
    user.role = "admin";
    await user.save();
  }
  return user;
}
