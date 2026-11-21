import mongoose from 'mongoose';

const HOUR = 3_600_000;
const groups = ['guest', 'free'];
const schema = new mongoose.Schema({ _id: String, hour: Date, group: String, calls: Number, expiresAt: Date }, { bufferCommands: false });
schema.index({ hour: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const AiUsage = mongoose.model('AiUsage', schema);

export async function recordAiCall(group, now = new Date()) {
  const hour = new Date(Math.floor(now.getTime() / HOUR) * HOUR);
  const _id = `${hour.toISOString()}:${group}`;
  const increment = { $inc: { calls: 1 } };
  try {
    await AiUsage.updateOne({ _id }, {
      ...increment, $setOnInsert: { hour, group, expiresAt: new Date(hour.getTime() + 48 * HOUR) },
    }, { upsert: true, maxTimeMS: 1000 });
  } catch (error) {
    if (error.code !== 11000) throw error;
    await AiUsage.updateOne({ _id }, increment, { maxTimeMS: 1000 });
  }
}

export async function readAiUsage(now = new Date()) {
  const currentHour = Math.floor(now.getTime() / HOUR) * HOUR;
  const from = new Date(currentHour - 23 * HOUR);
  const until = new Date(currentHour + HOUR);
  const rows = await AiUsage.aggregate([
    { $match: { hour: { $gte: from, $lt: until }, group: { $in: groups } } },
    { $group: { _id: '$group', calls: { $sum: '$calls' } } },
  ]);
  const counts = new Map(rows.map((row) => [row._id, row.calls]));
  const total = groups.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);
  return { from, until, total, groups: groups.map((key) => {
    const calls = counts.get(key) ?? 0;
    return { key, calls, share: total ? Math.round(calls / total * 1000) / 10 : 0 };
  }) };
}
