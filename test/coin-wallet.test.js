import assert from 'node:assert/strict';
import { test } from 'node:test';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { debitCoins, planCoinDebit, refundCoins, walletBalance } from '../src/services/coinWallet.js';
import { quotaIdentity } from '../src/services/dailyQuota.js';

const now = new Date('2026-12-01T00:00:00Z');
const wallet = { rewardCoins: 4, proCoins: [
  { periodId: 'expired', coins: 99, expiresAt: now },
  { periodId: 'later', coins: 2, expiresAt: new Date('2027-02-01') },
  { periodId: 'soon', coins: 3, expiresAt: new Date('2027-01-01') },
] };

test('coin debit spends expiring coins first and never spends expired coins', () => {
  assert.equal(walletBalance(wallet, now), 9);
  assert.deepEqual(planCoinDebit(wallet, 6, now), {
    pro: [{ periodId: 'soon', coins: 3 }, { periodId: 'later', coins: 2 }], reward: 1,
  });
  assert.equal(planCoinDebit(wallet, 10, now), null);
  assert.equal(walletBalance(wallet, now), 9);
});

const testUri = process.env.COIN_WALLET_TEST_URI;
test('replica set: concurrent debits cannot overspend and repeated refunds restore once', { skip: !testUri }, async () => {
  process.env.QUOTA_HMAC_SECRET = 'coin-wallet-test-only';
  await mongoose.connect(testUri, { dbName: `lumo_coin_test_${randomUUID().replaceAll('-', '')}`, serverSelectionTimeoutMS: 5000 });
  try {
    const wallets = mongoose.model('CoinWallet');
    await wallets.createCollection();
    await mongoose.model('CoinDebit').createCollection();
    const user = { provider: 'google', providerId: 'coin-test' };
    const walletId = quotaIdentity(user);
    await wallets.create({ _id: walletId, rewardCoins: 4 });
    const results = await Promise.all([debitCoins(user, 3), debitCoins(user, 3)]);
    const charged = results.filter(Boolean);
    assert.equal(charged.length, 1);
    assert.equal((await wallets.findById(walletId)).rewardCoins, 1);
    await Promise.all([refundCoins(charged[0].id), refundCoins(charged[0].id)]);
    assert.equal((await wallets.findById(walletId)).rewardCoins, 4);
  } finally {
    try { await mongoose.connection.dropDatabase(); } finally { await mongoose.disconnect(); }
  }
});
