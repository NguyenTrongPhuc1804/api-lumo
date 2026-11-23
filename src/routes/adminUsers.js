import { randomBytes } from "node:crypto";
import { Router } from "express";
import { User } from "../models/User.js";
import { requireAdminUser } from "../middleware/auth.js";
import { toClientUser } from "./auth.js";
import { DailyQuota } from "../models/DailyQuota.js";
import { readQuotaPolicy } from "../services/quotaPolicy.js";
import { quotaIdentity, quotaPeriod } from "../services/dailyQuota.js";
import { CoinWallet, coinPaymentsEnabled, proExpiresAt } from "../services/coinWallet.js";

// Danh sach tai khoan cho admin. Khong bao gio tra providerId.
function toAdminListItem(user, usage, freeLimit) {
  return {
    ...toClientUser(user, usage, freeLimit),
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

export function createAdminUsersRouter({ prefix = "/admin", authorize = requireAdminUser } = {}) {
  const router = Router();

  router.get(`${prefix}/users`, authorize, async (req, res) => {
    const page = positiveInt(req.query.page, 1, 100000);
    const limit = positiveInt(req.query.limit, 20, 100);

    const { q = "", role = "", status = "" } = req.query;
    if (typeof q !== "string" || q.length > 100 || !["", "user", "admin"].includes(role) || !["", "active", "blocked"].includes(status)) {
      return res.status(400).json({ error: "Bộ lọc tài khoản không hợp lệ" });
    }
    const search = q.trim();
    const isOwner = req.adminWeb?.role === "owner";
    const mobileOnly = { provider: { $ne: "web" } };
    const filter = isOwner ? {} : { ...mobileOnly };
    if (role && isOwner) {
      filter.$and = [{ $or: [
        { ...mobileOnly, role },
        { provider: "web", "webAdmin.role": role === "user" ? "viewer" : "admin" },
      ] }];
    } else if (role) filter.role = role;
    if (status) filter.status = status === "active" ? { $in: ["active", null] } : status;
    if (search) {
      const literal = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: literal }, { email: literal }];
      if (/^[a-f0-9]{24}$/i.test(search)) filter.$or.push({ _id: search });
    }
    try {
      const [items, total] = await Promise.all([
        User.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
        User.countDocuments(filter),
      ]);
      const { usageDate } = quotaPeriod();
      const keys = items.map((user) => user.provider === "web" ? null : quotaIdentity(user));
      const quotaKeys = keys.filter(Boolean);
      const [rows, policy] = quotaKeys.length ? await Promise.all([
        DailyQuota.find({ identityKey: { $in: quotaKeys }, usageDate }), readQuotaPolicy(),
      ]) : [[], null];
      const coinsEnabled = coinPaymentsEnabled();
      const wallets = coinsEnabled && quotaKeys.length ? await CoinWallet.find({ _id: { $in: quotaKeys } }).lean() : [];
      const expiries = new Map(wallets.map((wallet) => [wallet._id, proExpiresAt(wallet)]));
      const counts = new Map(rows.map((row) => [row.identityKey, row.usageCount]));
      res.json({
        items: items.map((user, index) => {
          if (user.provider === "web") {
            const webAdminRole = user.webAdmin?.role;
            return {
              id: String(user._id), email: user.email, provider: "web",
              role: webAdminRole === "admin" ? "admin" : "user", webAdminRole,
              status: user.status ?? "active", createdAt: user.createdAt ?? null, lastLoginAt: null,
            };
          }
          return {
            ...toAdminListItem(user, { usageDate, usageCount: counts.get(keys[index]) ?? 0 }, policy?.freeLimit),
            ...(coinsEnabled && { plan: expiries.get(keys[index]) ? 'pro' : 'free', proExpiresAt: expiries.get(keys[index]) ?? null }),
            ...(req.adminWeb && { webAdminGranted: Boolean(user.webAdmin) }),
            ...(isOwner && user.webAdmin && { webAdminLoginEmail: user.webAdmin.loginEmail }),
          };
        }),
        total, page, limit,
      });
    } catch {
      res.status(503).json({ error: "Database chua ket noi" });
    }
  });

  // Khoa / mo khoa tai khoan. Khong cho admin tu khoa chinh minh
  // de khong tu loai minh khoi he thong.
  const setStatus = (status) => async (req, res) => {
    if (req.adminWeb?.role === "viewer") return res.status(403).json({ error: "Tài khoản chỉ có quyền xem" });
    const { id } = req.params;
    const actorId = req.adminWeb?.userId ?? req.user?._id ?? req.user?.id;
    if (actorId && String(actorId) === id) {
      return res.status(400).json({ error: "Không thể tự khoá tài khoản của mình" });
    }

    try {
      const user = await User.findById(id);
      if (!user || user.provider === "web") return res.status(404).json({ error: "Khong tim thay tai khoan" });
      if (actorId && String(actorId) === String(user._id)) {
        return res.status(400).json({ error: "Không thể tự khoá tài khoản của mình" });
      }
      const filter = { _id: id, provider: { $ne: "web" } };
      if (req.adminWeb?.role === "admin") {
        if (user.role === "admin" || user.webAdmin) {
          return res.status(403).json({ error: "Không thể thay đổi trạng thái của quản trị viên khác" });
        }
        filter.role = { $ne: "admin" };
        filter.webAdmin = { $exists: false };
      }
      const changes = { status };
      if (status === "blocked") {
        // Chặn thao tác đồng thời với cấp/thu hồi quyền hoặc đổi mật khẩu.
        filter["webAdmin.credentialVersion"] = user.webAdmin?.credentialVersion ?? { $exists: false };
        if (user.webAdmin) changes["webAdmin.credentialVersion"] = randomBytes(16).toString("hex");
      }
      const result = await User.updateOne(filter, { $set: changes });
      if (!result.matchedCount) return res.status(409).json({ error: "Tài khoản đã thay đổi, vui lòng tải lại" });
      res.json({ ok: true });
    } catch {
      res.status(503).json({ error: "Database chua ket noi" });
    }
  };

  router.post(`${prefix}/users/:id/block`, authorize, setStatus("blocked"));
  router.post(`${prefix}/users/:id/unblock`, authorize, setStatus("active"));

  return router;
}
