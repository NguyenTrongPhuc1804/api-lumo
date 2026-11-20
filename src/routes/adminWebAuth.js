import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

const deriveKey = promisify(scrypt);
const sessionDuration = 8 * 60 * 60 * 1000;
const cookieName = 'lumo_admin_session';
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function createAdminWebAuth(config = process.env, now = Date.now) {
  const router = Router();
  const sessions = new Map();
  const { ADMIN_WEB_ORIGIN: origin, ADMIN_WEB_USERNAME: username, ADMIN_WEB_PASSWORD_HASH: hash } = config;
  const credentials = /^([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(hash ?? '');
  const https = Boolean(origin?.startsWith('https://'));
  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin ?? '');
  const enabled = Boolean(username && credentials && (https || (config.NODE_ENV !== 'production' && local)));
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: https, path: '/' };
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, message: { error: 'Quá nhiều lần đăng nhập. Vui lòng thử lại sau.' } });

  function requireOrigin(req, res, next) {
    if (!origin || req.get('origin') !== origin) return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
    next();
  }

  function requireSession(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const token = /(?:^|;\s*)lumo_admin_session=([a-f0-9]{64})(?=;|$)/.exec(req.get('cookie') ?? '')?.[1];
    const key = token && tokenHash(token);
    if (!enabled || !key || (sessions.get(key) ?? 0) <= now()) {
      if (key) sessions.delete(key);
      return res.status(401).json({ error: 'Cần đăng nhập quản trị' });
    }
    req.adminWebSession = key;
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    return requireOrigin(req, res, next);
  }

  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.post('/login', loginLimit, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Chưa cấu hình đăng nhập web quản trị' });
    if (req.get('origin') !== origin) return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
    const { username: supplied, password } = req.body ?? {};
    if (typeof supplied !== 'string' || typeof password !== 'string' || password.length > 512) {
      return res.status(400).json({ error: 'Thông tin đăng nhập không hợp lệ' });
    }
    const candidate = await deriveKey(password, Buffer.from(credentials[1], 'hex'), 64);
    if (!timingSafeEqual(candidate, Buffer.from(credentials[2], 'hex')) || supplied !== username) {
      return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }
    const time = now();
    for (const [key, expires] of sessions) if (expires <= time) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(tokenHash(token), time + sessionDuration);
    return res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionDuration }).json({ username });
  });
  router.get('/session', requireSession, (_req, res) => res.json({ username }));
  router.post('/logout', requireSession, (req, res) => {
    sessions.delete(req.adminWebSession);
    res.clearCookie(cookieName, cookieOptions).json({ ok: true });
  });
  return { router, requireSession };
}
