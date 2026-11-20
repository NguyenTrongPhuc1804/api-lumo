import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { isValidObjectId } from 'mongoose';
import { User } from '../models/User.js';

const deriveKey = promisify(scrypt);
const sessionDuration = 8 * 60 * 60 * 1000;
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const readBearer = (req) => /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') ?? '')?.[1];
const normalizeEmail = (email) => email?.trim().toLowerCase() ?? '';
const validPassword = (password) => typeof password === 'string' && password.length <= 512 && Boolean(password.trim());
const activeStatus = { $in: ['active', null] };
const passwordError = 'Mật khẩu không được để trống và không quá 512 ký tự';
const hashPattern = /^([a-f0-9]{32}):([a-f0-9]{128})$/i;

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}

async function matchesPassword(password, hash) {
  const parts = hashPattern.exec(hash ?? '');
  if (!parts) return false;
  const key = await deriveKey(password, Buffer.from(parts[1], 'hex'), 64);
  return timingSafeEqual(key, Buffer.from(parts[2], 'hex'));
}

export function createAdminWebAuth(config = process.env, now = Date.now) {
  const router = Router();
  const sessions = new Map();
  const { ADMIN_WEB_ALLOWED_ORIGINS: origins = '', ADMIN_WEB_USERNAME: username, ADMIN_WEB_PASSWORD_HASH: hash } = config;
  const allowedOrigins = origins.split(',').map((origin) => origin.trim()).filter(Boolean);
  const ownerConfigured = hashPattern.test(hash ?? '');
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

  function issueSession(res, { username, role, mustChangePassword = false, userId, credentialVersion }) {
    const time = now();
    for (const [key, session] of sessions) if (session.expires <= time) sessions.delete(key);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(tokenHash(token), { username, role, userId, credentialVersion, expires: time + sessionDuration });
    return res.json({ username, token, role, mustChangePassword });
  }

  async function requireToken(req, res, next) {
    const token = readBearer(req);
    const key = token && tokenHash(token);
    const session = sessions.get(key);
    if (session?.expires > now()) {
      if (session.role === 'owner') {
        req.adminWeb = { ...session, key, mustChangePassword: false };
        return next();
      }
      try {
        const user = await User.findById(session.userId);
        if (user?.provider === 'google' && (user.status === 'active' || user.status == null)
          && user.webAdmin?.credentialVersion && user.webAdmin.credentialVersion === session.credentialVersion
          && sessions.get(key) === session && session.expires > now()) {
          req.adminWeb = { ...session, key, mustChangePassword: user.webAdmin.mustChangePassword };
          return next();
        }
      } catch {
        return res.status(503).json({ error: 'Database chưa kết nối' });
      }
    }
    sessions.delete(key);
    return res.status(401).json({ error: 'Cần đăng nhập quản trị' });
  }

  const requireSession = [requireToken, (req, res, next) => {
    if (req.adminWeb.mustChangePassword) return res.status(403).json({ error: 'Cần đổi mật khẩu tạm' });
    next();
  }];
  const requireOwner = [requireToken, (req, res, next) => {
    if (req.adminWeb.role !== 'owner') return res.status(403).json({ error: 'Chỉ chủ quản trị được thực hiện thao tác này' });
    next();
  }];

  router.post('/login', loginLimit, async (req, res) => {
    if (!username || !ownerConfigured || !allowedOrigins.length) {
      return res.status(503).json({ error: 'Chưa cấu hình đăng nhập web quản trị' });
    }
    if (!req.get('origin')) return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
    const { username: supplied, password } = req.body ?? {};
    if (typeof supplied !== 'string' || typeof password !== 'string' || password.length > 512) {
      return res.status(400).json({ error: 'Thông tin đăng nhập không hợp lệ' });
    }
    const email = normalizeEmail(supplied);
    if (email !== normalizeEmail(username) && email.includes('@') && email.length <= 254) {
      try {
        const user = await User.findOne({ 'webAdmin.loginEmail': email, provider: 'google', status: activeStatus }, '+webAdmin.passwordHash');
        // Dùng hash của owner làm dự phòng để không bỏ qua chi phí scrypt khi email không tồn tại.
        const matched = await matchesPassword(password, user?.webAdmin?.passwordHash ?? hash);
        if (matched && user?.webAdmin?.passwordHash) {
          const { credentialVersion, mustChangePassword } = user.webAdmin;
          return issueSession(res, { username: email, role: 'admin', userId: String(user._id), credentialVersion, mustChangePassword });
        }
      } catch {
        return res.status(503).json({ error: 'Database chưa kết nối' });
      }
    } else if (await matchesPassword(password, hash) && supplied === username) {
      return issueSession(res, { username, role: 'owner' });
    }
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
  });
  router.post('/change-password', requireToken, async (req, res) => {
    const { userId, key, credentialVersion, mustChangePassword, username } = req.adminWeb;
    if (!mustChangePassword) return res.status(403).json({ error: 'Không có yêu cầu đổi mật khẩu tạm' });
    const { password } = req.body ?? {};
    if (!validPassword(password)) return res.status(400).json({ error: passwordError });
    try {
      const user = await User.findById(userId, '+webAdmin.passwordHash');
      if (user?.webAdmin?.credentialVersion !== credentialVersion) return res.status(401).json({ error: 'Phiên đã hết hiệu lực' });
      if (await matchesPassword(password, user.webAdmin.passwordHash)) {
        return res.status(400).json({ error: 'Mật khẩu mới phải khác mật khẩu tạm' });
      }
      const webAdmin = {
        loginEmail: username, passwordHash: await hashPassword(password),
        mustChangePassword: false, credentialVersion: randomBytes(16).toString('hex'),
      };
      if (!(sessions.get(key)?.expires > now())) return res.status(401).json({ error: 'Phiên đã hết hiệu lực' });
      const result = await User.updateOne({ _id: userId, status: activeStatus, 'webAdmin.credentialVersion': credentialVersion }, { $set: { webAdmin } });
      if (!result.matchedCount) return res.status(401).json({ error: 'Phiên đã hết hiệu lực' });
      sessions.delete(key);
      return issueSession(res, { username, role: 'admin', userId, credentialVersion: webAdmin.credentialVersion });
    } catch {
      return res.status(503).json({ error: 'Database chưa kết nối' });
    }
  });

  for (const action of ['grant', 'reset-password', 'revoke']) {
    router.post(`/users/:id/${action}`, requireOwner, async (req, res) => {
      const { id } = req.params;
      const { password } = req.body ?? {};
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'ID tài khoản không hợp lệ' });
      if (action !== 'revoke' && !validPassword(password)) return res.status(400).json({ error: passwordError });
      try {
        const user = await User.findById(id);
        if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
        if (action === 'grant' ? user.webAdmin : !user.webAdmin) {
          return res.status(409).json({ error: 'Trạng thái quyền web admin không phù hợp' });
        }
        const filter = { _id: id, 'webAdmin.credentialVersion': user.webAdmin?.credentialVersion ?? { $exists: false } };
        // Thu hồi xóa luôn version; lần cấp mới sinh một version khác.
        let update = { $unset: { webAdmin: 1 } };
        if (action !== 'revoke') {
          const loginEmail = user.webAdmin?.loginEmail ?? normalizeEmail(user.email);
          if (user.provider !== 'google' || user.status === 'blocked' || !loginEmail.includes('@') || loginEmail.length > 254) {
            return res.status(400).json({ error: 'Cần tài khoản Google đang hoạt động và có email' });
          }
          if (loginEmail === normalizeEmail(username)) return res.status(409).json({ error: 'Email trùng tên chủ quản trị' });
          filter.status = activeStatus;
          filter.provider = 'google';
          if (action === 'grant') filter.email = user.email;
          update = { $set: { webAdmin: {
            loginEmail, passwordHash: await hashPassword(password), mustChangePassword: true,
            credentialVersion: randomBytes(16).toString('hex'),
          } } };
        }
        const result = await User.updateOne(filter, update);
        if (!result.matchedCount) return res.status(409).json({ error: 'Tài khoản đã thay đổi, vui lòng tải lại' });
        return res.json({ ok: true });
      } catch (error) {
        if (error.code === 11000) return res.status(409).json({ error: 'Email đã được cấp quyền web admin' });
        return res.status(503).json({ error: 'Database chưa kết nối' });
      }
    });
  }

  router.get('/session', requireToken, (req, res) => {
    const { username, role, mustChangePassword } = req.adminWeb;
    res.json({ username, role, mustChangePassword });
  });
  router.post('/logout', (req, res) => {
    const token = readBearer(req);
    if (token) sessions.delete(tokenHash(token));
    res.json({ ok: true });
  });
  return { router, cors, requireSession };
}
