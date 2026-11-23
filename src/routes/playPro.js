import { Router } from 'express';
import { requireUser } from '../middleware/auth.js';
import { quotaIdentity } from '../services/dailyQuota.js';
import { CoinWallet, grantPlayPeriod, revokePlayToken } from '../services/coinWallet.js';
import { acknowledgePlayPurchase, getPlayPurchase, isPlayPush, playProConfig, playTokenKey, playWalletId, readPaidPeriod } from '../services/playPro.js';

const validToken = (token) => typeof token === 'string' && /^[\x21-\x7e]{1,4096}$/.test(token);

export function createPlayProRouter(config) {
  const router = Router();
  if (!config) return router;

  async function applyPurchase(purchase, token) {
    const period = readPaidPeriod(purchase, config);
    if (!period) return null;
    const key = playTokenKey(token);
    await grantPlayPeriod(period, key, config.monthlyCoins);
    const wallet = await CoinWallet.findOne({ _id: period.walletId, revokedPlayTokens: { $ne: key }, proCoins: { $elemMatch: { periodId: period.periodId, playTokenKey: key, revoked: false } } }).select('_id').lean();
    if (!wallet) return null;
    if (purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING') {
      await acknowledgePlayPurchase(config, token);
    }
    return period;
  }

  router.post('/subscription/google-play/verify', requireUser, async (req, res) => {
    const token = req.body?.purchaseToken;
    if (!validToken(token)) return res.status(400).json({ error: 'Mã giao dịch không hợp lệ' });
    try {
      const purchase = await getPlayPurchase(config, token);
      if (playWalletId(purchase) !== quotaIdentity(req.user)) return res.status(403).json({ error: 'Giao dịch không thuộc tài khoản Lumo này' });
      const period = await applyPurchase(purchase, token);
      if (!period) return res.status(409).json({ error: 'Chưa có kỳ Pro hợp lệ để khôi phục' });
      return res.json({ expiresAt: period.expiresAt });
    } catch (err) {
      if ([400, 404, 410].includes(err.response?.status)) return res.status(400).json({ error: 'Giao dịch không hợp lệ hoặc đã hết hạn' });
      console.error('Google Play: lỗi xác minh', err.name, err.response?.status ?? err.code ?? '');
      return res.status(503).json({ error: 'Chưa xác minh được giao dịch. Vui lòng thử khôi phục lại.' });
    }
  });

  router.post('/subscription/google-play/rtdn', async (req, res) => {
    if (!await isPlayPush(config, req.get('authorization'))) return res.sendStatus(401);
    if (req.body?.subscription !== config.subscription) return res.sendStatus(403);
    let event;
    try {
      event = JSON.parse(Buffer.from(req.body.message.data, 'base64').toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }
    if (event?.packageName !== config.packageName) return res.sendStatus(204);
    const notice = event.subscriptionNotification;
    if (!validToken(notice?.purchaseToken)) return res.sendStatus(204);
    const token = notice.purchaseToken;
    try {
      const purchase = await getPlayPurchase(config, token);
      if (notice.notificationType === 12) {
        await revokePlayToken(playTokenKey(token), playWalletId(purchase));
      } else {
        await applyPurchase(purchase, token);
      }
      return res.sendStatus(204);
    } catch (err) {
      if ([404, 410].includes(err.response?.status)) {
        if (notice.notificationType === 12) {
          try { await revokePlayToken(playTokenKey(token)); } catch { return res.sendStatus(503); }
        }
        return res.sendStatus(204);
      }
      return res.sendStatus(503);
    }
  });

  return router;
}
