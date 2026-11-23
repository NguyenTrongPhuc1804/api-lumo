import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { CoinWallet, grantPlayPeriod, revokePlayToken, proExpiresAt, walletBalance } from '../src/services/coinWallet.js';
import { readPaidPeriod } from '../src/services/playPro.js';

const walletId = 'a'.repeat(64);
const config = { productId: 'lumo_pro', basePlanId: 'monthly', allowTest: false };
const now = new Date('2027-01-01');
const purchase = {
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: walletId },
  lineItems: [{ productId: 'lumo_pro', offerDetails: { basePlanId: 'monthly' }, autoRenewingPlan: {}, expiryTime: '2027-02-01', latestSuccessfulOrderId: 'GPA.example..0' }],
};

test('Play cấp theo đơn hàng thành công, hủy gia hạn vẫn dùng đến cuối kỳ', () => {
  for (const state of ['ACTIVE', 'CANCELED']) {
    assert.deepEqual(readPaidPeriod({ ...purchase, subscriptionState: `SUBSCRIPTION_STATE_${state}` }, config, now), {
      walletId, periodId: 'GPA.example..0', expiresAt: new Date('2027-02-01'),
    });
  }
});

test('Play không cấp xu cho trạng thái chờ, kỳ hết hạn, sai gói, ưu đãi hoặc thiếu đơn hàng', () => {
  for (const invalid of [
    { ...purchase, subscriptionState: 'SUBSCRIPTION_STATE_PENDING' },
    { ...purchase, subscriptionState: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' },
    { ...purchase, testPurchase: {} },
    { ...purchase, externalAccountIdentifiers: {} },
    ...[{ expiryTime: '2027-01-01' }, { productId: 'other' }, { latestSuccessfulOrderId: undefined }, { offerDetails: { basePlanId: 'monthly', offerId: 'trial' } }].map((patch) => ({ ...purchase, lineItems: [{ ...purchase.lineItems[0], ...patch }] })),
  ]) assert.equal(readPaidPeriod(invalid, config, now), null);
});

const uri = process.env.COIN_WALLET_TEST_URI;
test('MongoDB: chỉ cấp một lần khi xác minh đồng thời, không cấp lại sau thu hồi', { skip: !uri }, async () => {
  await mongoose.connect(uri, { dbName: `lumo_play_test_${randomUUID().replaceAll('-', '')}`, serverSelectionTimeoutMS: 5000 });
  try {
    const period = readPaidPeriod(purchase, config, now);
    await CoinWallet.createCollection();
    await Promise.all(Array.from({ length: 5 }, () => grantPlayPeriod(period, 'purchase-hash', 100)));
    let wallet = await CoinWallet.findById(walletId).lean();
    assert.equal(wallet.proCoins.length, 1);
    assert.equal(walletBalance(wallet, now), 100);
    assert.deepEqual(proExpiresAt(wallet, now), period.expiresAt);
    await revokePlayToken('purchase-hash', walletId);
    await grantPlayPeriod({ ...period, periodId: 'GPA.example..1' }, 'purchase-hash', 100);
    wallet = await CoinWallet.findById(walletId).lean();
    assert.equal(wallet.proCoins.length, 1);
    assert.equal(walletBalance(wallet, now), 0);
    assert.equal(proExpiresAt(wallet, now), null);
  } finally {
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});
