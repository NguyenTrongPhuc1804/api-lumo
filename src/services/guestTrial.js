import { createHmac } from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { readQuotaPolicy } from './quotaPolicy.js';

export const GuestTrial = mongoose.model('GuestTrial', new mongoose.Schema({
  _id: String,
  used: Number,
  basicRequests: [String],
}));

export function signGuestToken(key) {
  return jwt.sign({ kind: 'guest-trial', key }, process.env.JWT_SECRET, { expiresIn: '15m' });
}

export function readGuestToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload.kind !== 'guest-trial' || typeof payload.key !== 'string') throw new Error('Phiên khách không hợp lệ');
  return payload.key;
}

export async function startGuestTrial(installId) {
  const key = createHmac('sha256', process.env.QUOTA_HMAC_SECRET).update(`guest:${installId}`).digest('hex');
  const [{ guestLimit, freeLimit }, usage] = await Promise.all([readQuotaPolicy(), GuestTrial.findById(key)]);
  return { token: signGuestToken(key), remaining: Math.max(0, guestLimit - (usage?.used ?? 0)), freeLimit };
}

export async function chargeGuestTrial(key, requestId, reportReplay = false) {
  const { guestLimit } = await readQuotaPolicy();
  if (guestLimit === 0) return null;
  await GuestTrial.updateOne({ _id: key }, { $setOnInsert: { used: 0 } }, { upsert: true }).catch((error) => {
    if (error.code !== 11000) throw error;
  });
  const filter = { _id: key, used: { $lt: guestLimit }, ...(requestId && { basicRequests: { $ne: requestId } }) };
  const update = { $inc: { used: 1 }, ...(requestId && { $push: { basicRequests: requestId } }) };
  const row = await GuestTrial.findOneAndUpdate(filter, update, { new: true });
  if (row) return reportReplay ? { remaining: guestLimit - row.used, replay: false } : guestLimit - row.used;
  if (!requestId) return null;
  const previous = await GuestTrial.findById(key);
  if (!previous?.basicRequests?.includes(requestId)) return null;
  const remaining = Math.max(0, guestLimit - previous.used);
  return reportReplay ? { remaining, replay: true } : remaining;
}

export async function refundGuestTrial(key, requestId) {
  await GuestTrial.updateOne(
    { _id: key, used: { $gt: 0 }, ...(requestId && { basicRequests: requestId }) },
    { $inc: { used: -1 }, ...(requestId && { $pull: { basicRequests: requestId } }) },
  );
}
