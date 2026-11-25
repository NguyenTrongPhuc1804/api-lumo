import { Router } from 'express';
import mongoose from 'mongoose';
import { AiModel } from '../models/AiModel.js';
import { bonusRuleKeys, logQuotaPolicy, readBonusRules, readPolicyAudit, readQuotaPolicy, saveQuotaPolicy } from '../services/quotaPolicy.js';

import { readAiUsage } from '../services/aiUsage.js';

const validRevision = (revision) => Number.isSafeInteger(revision) && revision >= 0;
const bonusPeriods = { referral: ['installation', 'month'], rewardedVideo: ['view', 'day'] };

export function createQuotaPolicyRouter({ authorize, read = readQuotaPolicy, save = saveQuotaPolicy }) {
  const router = Router();
  router.get('/quota-policy', authorize, async (req, res) => {
    if (!['owner', 'admin'].includes(req.adminWeb.role)) return res.sendStatus(403);
    try {
      const policy = await read();
      logQuotaPolicy('get.response', {
        revision: policy.revision, hasSharedAiField: Object.hasOwn(policy, 'sharedAiModelId'), sharedAiModelId: policy.sharedAiModelId,
        db: mongoose.connection.name, readPreference: mongoose.connection.getClient()?.options.readPreference?.mode,
      });
      res.json(policy);
    } catch (error) {
      logQuotaPolicy('get.error', { name: error.name, mongoCode: Number.isInteger(error.code) ? error.code : undefined });
      res.status(503).json({ error: 'Không tải được chính sách hạn mức' });
    }
  });
  router.put('/quota-policy', authorize, async (req, res) => {
    const { guestLimit, freeLimit, revision, sharedAiModelId } = req.body ?? {};
    const validModelId = typeof sharedAiModelId === 'string' && mongoose.isObjectIdOrHexString(sharedAiModelId);
    logQuotaPolicy('put.request', {
      role: req.adminWeb.role, revision: validRevision(revision) ? revision : 'invalid',
      sharedAiModelId: validModelId ? sharedAiModelId : sharedAiModelId === null ? null : sharedAiModelId === undefined ? 'omitted' : 'invalid',
    });
    if (req.adminWeb.role !== 'owner') return res.sendStatus(403);
    if (!validRevision(revision)) return res.status(400).json({ error: 'Cần tải phiên bản chính sách trước khi lưu' });
    if (!Number.isInteger(guestLimit) || guestLimit < 0 || guestLimit > 100 ||
        !Number.isInteger(freeLimit) || freeLimit < 1 || freeLimit > 10000) {
      return res.status(400).json({ error: 'Lượt thử phải từ 0 đến 100; lượt Free phải từ 1 đến 10.000' });
    }
    if (sharedAiModelId != null && !validModelId) {
      return res.status(400).json({ error: 'Model AI cho Free và Guest không hợp lệ' });
    }
    try {
      if (sharedAiModelId) {
        const eligible = Boolean(await AiModel.exists({ _id: sharedAiModelId, enabled: true, $or: [{ coinPrice: 0 }, { coinPrice: { $exists: false } }] }));
        logQuotaPolicy('put.model_check', { sharedAiModelId, eligible });
        if (!eligible) return res.status(400).json({ error: 'Hãy chọn model đang bật và không tính xu' });
      }
      const policy = await save({ guestLimit, freeLimit, revision,
        ...(sharedAiModelId !== undefined && { sharedAiModelId: sharedAiModelId?.toLowerCase() ?? null }),
        updatedBy: req.adminWeb.username, updatedAt: new Date() });
      logQuotaPolicy('put.response', { revision: policy.revision, hasSharedAiField: Object.hasOwn(policy, 'sharedAiModelId'), sharedAiModelId: policy.sharedAiModelId });
      res.json(policy);
    } catch (error) {
      logQuotaPolicy('put.error', { status: error.status === 409 ? 409 : 503, name: error.name, mongoCode: Number.isInteger(error.code) ? error.code : undefined });
      if (error.status === 409) return res.status(409).json({ error: error.message });
      res.status(503).json({ error: 'Không lưu được chính sách hạn mức' });
    }
  });

  for (const [path, load] of [['/bonus-rules', readBonusRules], ['/quota-policy/audit', readPolicyAudit], ['/quota-usage', () => readAiUsage()]]) {
    router.get(path, authorize, async (req, res) => {
      if (!['owner', 'admin'].includes(req.adminWeb.role)) return res.sendStatus(403);
      try { res.json(await load()); }
      catch { res.status(503).json({ error: 'Không tải được dữ liệu quản lý hạn mức' }); }
    });
  }

  router.patch('/bonus-rules/:rule', authorize, async (req, res) => {
    if (req.adminWeb.role !== 'owner') return res.sendStatus(403);
    const { rule } = req.params;
    if (!bonusRuleKeys.includes(rule)) return res.status(404).json({ error: 'Không tìm thấy quy tắc bonus' });
    const { reward, maxClaims, period, revision, enabled } = req.body ?? {};
    if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'Trạng thái bonus không hợp lệ' });
    if (!validRevision(revision) || !Number.isInteger(reward) || reward < 1 || reward > 10000 ||
        !Number.isInteger(maxClaims) || maxClaims < 1 || maxClaims > 100 || !bonusPeriods[rule].includes(period)) {
      return res.status(400).json({ error: 'Nhập 1–10.000 xu, 1–100 lần nhận và chu kỳ hợp lệ' });
    }
    try {
      res.json(await save({ rule, bonus: { reward, maxClaims, period, enabled }, revision, updatedBy: req.adminWeb.username, updatedAt: new Date() }));
    } catch (error) {
      if (error.status === 409) return res.status(409).json({ error: error.message });
      res.status(503).json({ error: 'Không lưu được cấu hình bonus' });
    }
  });
  return router;
}
