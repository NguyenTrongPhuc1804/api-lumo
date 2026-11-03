import { timingSafeEqual } from "node:crypto";

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

// Chi cho phep goi API quan tri neu x-admin-key dung. Khong co ADMIN_KEY thi khoa luon, khong dung tam APP_KEY
export function requireAdminKey(req, res, next) {
  const expected = Buffer.from(process.env.ADMIN_KEY || "");
  const received = Buffer.from(req.get("x-admin-key") || "");

  const isValid = expected.length > 0 && expected.length === received.length && timingSafeEqual(expected, received);
  if (!isValid) {
    return res.status(401).json({ error: "Sai hoac thieu x-admin-key" });
  }
  next();
}
