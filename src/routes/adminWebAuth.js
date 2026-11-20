import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';

const deriveKey = promisify(scrypt);
const sessionDuration = 8 * 60 * 60 * 1000;
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

export function createAdminWebAuth(config = process.env, now = Date.now) {
  const router = Router();
  const sessions = new Map();
  const { ADMIN_WEB_ALLOWED_ORIGINS: origins = '', ADMIN_WEB_USERNAME: username, ADMIN_WEB_PASSWORD_HASH: hash } = config;
  const allowedOrigins = origins.split(',').map((origin) => origin.trim()).filter(Boolean);
  const credentials = /^([a-f0-9]{32}):([a-f0-9]{128})$/i.exec(hash ?? '');
  const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, message: { error: 'Quá nhiều lần đăng nhập. Vui lòng thử lại sau.' } });

  function cors(req, res, next) {
    res.vary('Origin');
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    if (!origin) return next();
    if (origin === 'null' || !allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
    }
    res.set('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, HEAD, POST');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      return res.status(204).end();
    }
    next();
  }

  function requireSession(req, res, next) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') ?? '')?.[1];
    const key = token && tokenHash(token);
    if (!key || (sessions.get(key) ?? 0) <= now()) {
      if (key) sessions.delete(key);
      return res.status(401).json({ error: 'Cần đăng nhập quản trị' });
    }
    req.adminWebSession = key;
    next();
  }

  router.post('/login', loginLimit, async (req, res) => {
    if (!username || !credentials || !allowedOrigins.length) {
      return res.status(503).json({ error: 'Chưa cấu hình đăng nhập web quản trị' });
    }
    if (!req.get('origin')) return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
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
    return res.json({ username, token });
  });
  router.get('/session', requireSession, (_req, res) => res.json({ username }));
  router.post('/logout', requireSession, (req, res) => {
    sessions.delete(req.adminWebSession);
    res.json({ ok: true });
  });
  return { router, cors, requireSession };
}
