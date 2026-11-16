import { Router } from "express";
import { User } from "../models/User.js";
import { requireAdminUser } from "../middleware/auth.js";
import { toClientUser } from "./auth.js";

// Danh sach tai khoan cho admin. Khong bao gio tra providerId.
function toAdminListItem(user) {
  return {
    ...toClientUser(user),
    provider: user.provider ?? "",
    status: user.status ?? "active",
    createdAt: user.createdAt ?? null,
    lastLoginAt: user.lastLoginAt ?? null,
  };
}

function positiveInt(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function createAdminUsersRouter() {
  const router = Router();

  router.get("/admin/users", requireAdminUser, async (req, res) => {
    const page = positiveInt(req.query.page, 1, 100000);
    const limit = positiveInt(req.query.limit, 20, 100);

    try {
      const [items, total] = await Promise.all([
        User.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        User.countDocuments(),
      ]);
      res.json({ items: items.map(toAdminListItem), total, page, limit });
    } catch {
      res.status(503).json({ error: "Database chua ket noi" });
    }
  });

  // Khoa / mo khoa tai khoan. Khong cho admin tu khoa chinh minh
  // de khong tu loai minh khoi he thong.
  const setStatus = (status) => async (req, res) => {
    const { id } = req.params;
    if (String(req.user._id ?? req.user.id) === String(id)) {
      return res.status(400).json({ error: "Không thể tự khoá tài khoản của mình" });
    }

    try {
      const user = await User.findById(id);
      if (!user) return res.status(404).json({ error: "Khong tim thay tai khoan" });
      user.status = status;
      await user.save();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: "Database chua ket noi" });
    }
  };

  router.post("/admin/users/:id/block", requireAdminUser, setStatus("blocked"));
  router.post("/admin/users/:id/unblock", requireAdminUser, setStatus("active"));

  return router;
}
