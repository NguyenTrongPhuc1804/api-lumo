import mongoose from 'mongoose';
import { quotaIdentity } from './dailyQuota.js';

export const CoinWallet = mongoose.model('CoinWallet', new mongoose.Schema({
  _id: String,
  rewardCoins: { type: Number, default: 0 },
  revokedPlayTokens: [String],
  proCoins: [{ _id: false, periodId: String, coins: Number, expiresAt: Date, revoked: Boolean, playTokenKey: String }],
}));

const CoinDebit = mongoose.model('CoinDebit', new mongoose.Schema({
  walletId: String,
  reward: Number,
  pro: [{ _id: false, periodId: String, coins: Number }],
  refunded: { type: Boolean, default: false },
}));

export function proExpiresAt(wallet, now = new Date()) {
  return (wallet?.proCoins ?? []).reduce((latest, lot) =>
    lot.playTokenKey && !lot.revoked && !wallet.revokedPlayTokens?.includes(lot.playTokenKey) && lot.expiresAt > now && (!latest || lot.expiresAt > latest) ? lot.expiresAt : latest, null);
}

export async function grantPlayPeriod(period, playTokenKey, coins) {
  const id = period.walletId;
  try {
    await CoinWallet.updateOne({ _id: id }, { $setOnInsert: { rewardCoins: 0 } }, { upsert: true });
  } catch (err) {
    if (err.code !== 11000) throw err;
  }
  await CoinWallet.updateOne({ _id: id, revokedPlayTokens: { $ne: playTokenKey }, 'proCoins.periodId': { $ne: period.periodId } }, {
    $push: { proCoins: { periodId: period.periodId, expiresAt: period.expiresAt, coins, playTokenKey, revoked: false } },
  });
  await CoinWallet.updateOne({ _id: id, proCoins: { $elemMatch: { periodId: period.periodId, playTokenKey, revoked: false } } }, {
    $max: { 'proCoins.$.expiresAt': period.expiresAt },
  });
}

export async function revokePlayToken(playTokenKey, walletId) {
  if (walletId) {
    try {
      await CoinWallet.updateOne({ _id: walletId }, { $addToSet: { revokedPlayTokens: playTokenKey } }, { upsert: true });
    } catch (err) {
      if (err.code !== 11000) throw err;
      await CoinWallet.updateOne({ _id: walletId }, { $addToSet: { revokedPlayTokens: playTokenKey } });
    }
  }
  await CoinWallet.updateMany({ 'proCoins.playTokenKey': playTokenKey }, {
    $addToSet: { revokedPlayTokens: playTokenKey },
    $set: { 'proCoins.$[lot].revoked': true },
  }, { arrayFilters: [{ 'lot.playTokenKey': playTokenKey }] });
}

export function coinPaymentsEnabled() {
  return process.env.COIN_PAYMENTS_ENABLED === 'true';
}

export function walletBalance(wallet, now = new Date()) {
  return (wallet?.rewardCoins ?? 0) + (wallet?.proCoins ?? []).reduce((sum, lot) =>
    lot.expiresAt > now && !lot.revoked && !wallet.revokedPlayTokens?.includes(lot.playTokenKey) ? sum + lot.coins : sum, 0);
}

export function planCoinDebit(wallet, cost, now = new Date()) {
  if (!Number.isSafeInteger(cost) || cost <= 0) throw new Error('Giá xu không hợp lệ');
  if (walletBalance(wallet, now) < cost) return null;
  const pro = [];
  let remaining = cost;
  const lots = (wallet.proCoins ?? []).filter((lot) => lot.expiresAt > now && !lot.revoked && !wallet.revokedPlayTokens?.includes(lot.playTokenKey) && lot.coins > 0)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  for (const lot of lots) {
    const coins = Math.min(remaining, lot.coins);
    pro.push({ periodId: lot.periodId, coins });
    remaining -= coins;
    if (!remaining) break;
  }
  return { pro, reward: remaining };
}

export async function readCoinBalance(user) {
  if (!coinPaymentsEnabled()) return 0;
  return walletBalance(await CoinWallet.findById(quotaIdentity(user)).lean());
}

export async function debitCoins(user, cost) {
  const walletId = quotaIdentity(user);
  return mongoose.connection.transaction(async (session) => {
    const wallet = await CoinWallet.findById(walletId).session(session);
    const now = new Date();
    const debit = planCoinDebit(wallet, cost, now);
    if (!debit) return null;
    wallet.rewardCoins -= debit.reward;
    for (const part of debit.pro) wallet.proCoins.find((lot) => lot.periodId === part.periodId).coins -= part.coins;
    await wallet.save({ session });
    const record = new CoinDebit({ walletId, ...debit });
    await record.save({ session });
    return { id: record.id, balance: walletBalance(wallet, now) };
  });
}

export async function refundCoins(id) {
  await mongoose.connection.transaction(async (session) => {
    const debit = await CoinDebit.findOneAndUpdate({ _id: id, refunded: false }, { $set: { refunded: true } }, { session });
    if (!debit) return;
    const wallet = await CoinWallet.findById(debit.walletId).session(session);
    if (!wallet) throw new Error('Không tìm thấy ví xu để hoàn');
    wallet.rewardCoins += debit.reward;
    const now = new Date();
    for (const part of debit.pro) {
      const lot = wallet.proCoins.find((entry) => entry.periodId === part.periodId);
      if (lot && !lot.revoked && !wallet.revokedPlayTokens?.includes(lot.playTokenKey) && lot.expiresAt > now) lot.coins += part.coins;
    }
    await wallet.save({ session });
  });
}
