import { timingSafeEqual } from "node:crypto";
import { User } from "../models/User.js";
import { verifyToken } from "../services/tokens.js";

// Chi cho phep app gui request neu header x-app-key dung
export function requireAppKey(req, res, next) {
  const expected = Buffer.from(process.env.APP_KEY || "");
  const received = Buffer.from(req.get("x-app-key") || "");

  // timingSafeEqual yeu cau 2 buffer cung do dai
  const isValid = expected.length > 0 && expected.length === received.length && timingSafeEqual(expected, received);

  if (!isValid) {
    return res.status(401).json({ error: "Sai app key" });
  }
  next();
}

// Doc token trong header Authorization: Bearer <token>, roi lay user tu DB.
// role va status luon doc tu DB nen khoa tai khoan co hieu luc ngay,
// khong can doi token.
export async function requireUser(req, res, next) {
  const header = req.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ error: "Cần đăng nhập" });
  }

  let userId;
  try {
    userId = verifyToken(token).userId;
  } catch {
    return res.status(401).json({ error: "Phiên đăng nhập đã hết hạn" });
  }

  let user;
  try {
    user = await User.findById(userId);
  } catch {
    return res.status(503).json({ error: "Database chua ket noi" });
  }
  if (!user) {
    return res.status(401).json({ error: "Phiên đăng nhập đã hết hạn", code: "ACCOUNT_NOT_FOUND" });
  }
  if (user.status === "blocked") {
    return res.status(403).json({ error: "Tài khoản đã bị khoá" });
  }

  req.user = user;
  next();
}

// Chi tai khoan admin moi duoc CRUD model
export async function requireAdminUser(req, res, next) {
  requireUser(req, res, () => {
    if (req.user?.role !== "admin") {
      return res.status(403).json({ error: "Tài khoản không có quyền quản lý model" });
    }
    next();
  });
}
