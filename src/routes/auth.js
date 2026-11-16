import { Router } from "express";
import jwt from "jsonwebtoken";
import { findOrCreateUser, signToken } from "../services/tokens.js";
import { exchangeGoogleCode as realExchangeGoogleCode } from "../services/google.js";
import { requireUser } from "../middleware/auth.js";
import { limitFor, todayKey } from "../services/quota.js";

// Ten tham so trong duong dan, tranh go nham o nhieu cho
const STATE_TTL = "10m";

// Hop le hoa mot user thanh JSON tra cho app. Khong bao gio tra providerId.
// Han muc phai dung limitFor() vi dailyLimit = 0 nghia la "lay tu .env",
// neu tra thang 0 thi app hieu nham la khong gioi han.
export function toClientUser(user) {
  // Bo dem chi co nghia trong ngay cua no; sang ngay moi thi coi nhu 0.
  const usedToday = user.usageDate === todayKey() ? user.usageCount ?? 0 : 0;
  return {
    id: String(user._id ?? user.id ?? ""),
    email: user.email ?? "",
    name: user.name ?? "",
    avatar: user.avatar ?? "",
    role: user.role ?? "user",
    plan: user.plan ?? "free",
    isAdmin: user.role === "admin",
    dailyLimit: limitFor(user),
    usageCount: usedToday,
    usageDate: user.usageDate ?? "",
  };
}

// State ngan gon: ky bang JWT_SECRET, song 10 phut, chan request gia mao.
function makeState() {
  return jwt.sign({ kind: "oauth-state" }, process.env.JWT_SECRET, { expiresIn: STATE_TTL });
}

function checkState(state) {
  try {
    const payload = jwt.verify(String(state || ""), process.env.JWT_SECRET);
    return payload?.kind === "oauth-state";
  } catch {
    return false;
  }
}

function deepLink(params) {
  const base = process.env.APP_DEEP_LINK || "lumolens://auth";
  const query = new URLSearchParams(params).toString();
  return `${base}?${query}`;
}

export function createAuthRouter({ exchangeGoogleCode = realExchangeGoogleCode } = {}) {
  const router = Router();

  router.get("/auth/google/start", (req, res) => {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || "",
      redirect_uri: `${process.env.OAUTH_REDIRECT_BASE || ""}/api/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state: makeState(),
      access_type: "online",
      prompt: "select_account",
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  router.get("/auth/google/callback", async (req, res) => {
    const { code, state } = req.query;

    if (!checkState(state)) {
      return res.status(400).json({ error: "Phiên đăng nhập không hợp lệ hoặc đã hết hạn" });
    }
    if (typeof code !== "string" || !code) {
      return res.redirect(deepLink({ error: "google_denied" }));
    }

    try {
      const profile = await exchangeGoogleCode(code);
      const user = await findOrCreateUser({ provider: "google", ...profile });

      if (user.status === "blocked") {
        return res.redirect(deepLink({ error: "account_blocked" }));
      }

      return res.redirect(deepLink({ token: signToken(user._id) }));
    } catch {
      // Khong lo chi tiet loi ra URL, chi tra ma ngan cho app hien thi.
      return res.redirect(deepLink({ error: "google_failed" }));
    }
  });

  // Chua bat Facebook: giu cho de sau nay chi can them bien moi truong.
  router.get("/auth/facebook/start", (req, res) => res.status(501).json({ error: "Chưa bật đăng nhập Facebook" }));
  router.get("/auth/facebook/callback", (req, res) => res.status(501).json({ error: "Chưa bật đăng nhập Facebook" }));

  router.get("/me", requireUser, (req, res) => res.json(toClientUser(req.user)));

  return router;
}
