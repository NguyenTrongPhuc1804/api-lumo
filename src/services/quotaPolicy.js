import mongoose from 'mongoose';

export const QuotaPolicy = mongoose.model('QuotaPolicy', new mongoose.Schema({
  _id: String,
  guestLimit: Number,
  freeLimit: Number,
  updatedBy: String,
  updatedAt: Date,
  revision: Number,
  bonusRules: mongoose.Schema.Types.Mixed,
  audit: [{ _id: false, updatedBy: String, updatedAt: Date, changes: [mongoose.Schema.Types.Mixed] }],
}));

const policyId = 'translation';

export function defaultFreeLimit() {
  return Number(process.env.FREE_DAILY_LIMIT) || 100;
}

export async function readQuotaPolicy() {
  const policy = await QuotaPolicy.findById(policyId, { audit: 0 });
  return {
    guestLimit: policy?.guestLimit ?? 3,
    freeLimit: policy?.freeLimit ?? defaultFreeLimit(),
    updatedBy: policy?.updatedBy ?? null,
    updatedAt: policy?.updatedAt ?? null,
    revision: policy?.revision ?? 0,
  };
}

export const bonusRuleKeys = ['checkIn', 'referral', 'rewardedVideo'];

export async function readBonusRules() {
  const doc = await QuotaPolicy.findById(policyId, { audit: 0 });
  return { revision: doc?.revision ?? 0, rules: Object.fromEntries(bonusRuleKeys.map((key) => [key, doc?.bonusRules?.[key] ?? null])) };
}

export async function readPolicyAudit() {
  const doc = await QuotaPolicy.findById(policyId).select('audit').lean();
  return { items: doc?.audit ?? [] };
}

export async function saveQuotaPolicy({ revision, updatedBy, updatedAt, rule, bonus, ...limits }) {
  const doc = await QuotaPolicy.findById(policyId, { audit: 0 });
  const current = {
    guestLimit: doc?.guestLimit ?? 3, freeLimit: doc?.freeLimit ?? defaultFreeLimit(),
    revision: doc?.revision ?? 0, updatedBy: doc?.updatedBy ?? null, updatedAt: doc?.updatedAt ?? null,
  };
  const conflict = () => Object.assign(new Error('Chính sách đã thay đổi. Hãy tải lại trước khi lưu.'), { status: 409 });
  if (revision !== current.revision) throw conflict();
  const rules = Object.fromEntries(bonusRuleKeys.map((key) => [key, doc?.bonusRules?.[key] ?? null]));
  const previous = rule && rules[rule];
  const changes = rule
    ? (previous && Object.keys(bonus).every((key) => previous[key] === bonus[key]) ? [] : [{ field: `bonusRules.${rule}`, before: previous, after: bonus }])
    : Object.keys(limits).filter((key) => current[key] !== limits[key]).map((key) => ({ field: key, before: current[key], after: limits[key] }));
  if (!changes.length) return rule ? { rules, revision } : current;
  const fields = rule ? { bonusRules: { ...rules, [rule]: bonus } } : limits;
  const filter = { _id: policyId, revision: doc?.revision ?? { $exists: false } };
  try {
    const result = await QuotaPolicy.updateOne(filter, {
      $set: { ...fields, updatedBy, updatedAt }, $inc: { revision: 1 },
      $push: { audit: { $each: [{ updatedBy, updatedAt, changes }], $position: 0, $slice: 50 } },
    }, { upsert: !doc });
    if (!result.matchedCount && !result.upsertedCount) throw conflict();
  } catch (error) {
    if (error.code === 11000) throw conflict();
    throw error;
  }
  return rule ? { rules: fields.bonusRules, revision: revision + 1 } : { ...current, ...limits, updatedBy, updatedAt, revision: revision + 1 };
}
