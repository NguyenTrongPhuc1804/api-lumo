import { createHash } from 'node:crypto';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { coinPaymentsEnabled } from './coinWallet.js';

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
const pushAuth = new OAuth2Client();

export function playProConfig() {
  if (!coinPaymentsEnabled() || process.env.PLAY_PRO_ENABLED !== 'true') return null;
  const config = {
    productId: process.env.PLAY_PRO_PRODUCT_ID?.trim(),
    basePlanId: process.env.PLAY_PRO_BASE_PLAN_ID?.trim(),
    monthlyCoins: Number(process.env.PLAY_PRO_MONTHLY_COINS),
    packageName: 'com.lumolens.app',
    audience: process.env.PLAY_RTDN_AUDIENCE?.trim(),
    pushEmail: process.env.PLAY_RTDN_SERVICE_ACCOUNT?.trim(),
    subscription: process.env.PLAY_RTDN_SUBSCRIPTION?.trim(),
    allowTest: process.env.PLAY_PRO_ALLOW_TEST === 'true',
  };
  if (!config.productId || !config.basePlanId || !config.audience || !config.pushEmail || !config.subscription ||
    !Number.isSafeInteger(config.monthlyCoins) || config.monthlyCoins < 1) {
    throw new Error('Thiếu cấu hình Google Play Pro hoặc Pub/Sub');
  }
  return config;
}

export function playWalletId(purchase) {
  const id = purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId;
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) ? id : null;
}

export function readPaidPeriod(purchase, config, now = new Date()) {
  const walletId = playWalletId(purchase);
  if (!walletId || (purchase.testPurchase && !config.allowTest)) return null;
  if (!['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED'].includes(purchase.subscriptionState)) return null;
  const item = purchase.lineItems?.find((line) => line.productId === config.productId && line.autoRenewingPlan &&
    line.offerDetails?.basePlanId === config.basePlanId && !line.offerDetails.offerId);
  const expiresAt = new Date(item?.expiryTime);
  if (!(expiresAt > now) || typeof item.latestSuccessfulOrderId !== 'string' || !item.latestSuccessfulOrderId) return null;
  return { walletId, periodId: item.latestSuccessfulOrderId, expiresAt };
}

export function playTokenKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

export async function getPlayPurchase(config, token) {
  const { data } = await auth.request({
    url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.packageName}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`,
    timeout: 10000,
  });
  return data;
}

export async function acknowledgePlayPurchase(config, token) {
  await auth.request({
    url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${config.packageName}/purchases/subscriptions/${encodeURIComponent(config.productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
    method: 'POST', data: {}, timeout: 10000,
  });
}

export async function isPlayPush(config, authorization) {
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    const ticket = await pushAuth.verifyIdToken({ idToken: authorization.slice(7), audience: config.audience });
    const claims = ticket.getPayload();
    return claims?.email_verified === true && claims.email === config.pushEmail;
  } catch {
    return false;
  }
}
