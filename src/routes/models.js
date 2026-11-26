import { Router } from "express";
import mongoose from "mongoose";
import { AiModel } from "../models/AiModel.js";
import { requireAppKey } from "../middleware/auth.js";
import { verifyModel } from "../services/aiTranslation.js";
import { readQuotaPolicy } from "../services/quotaPolicy.js";

const router = Router();

// Khong bao gio tra apiKey day du ra ngoai
function maskKey(key) {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 3)}...${key.slice(-4)}` : "********";
}

export function toClient(doc, withKey, adminFields = withKey) {
  const { _id, code, name, baseUrl, apiKey, enabled, order, description = "", coinPrice = 0 } = doc;
  if (!adminFields) return { code, name, description, coinPrice };
  return { id: _id, code, name, description, coinPrice, baseUrl, ...(withKey && { apiKey: maskKey(apiKey) }), enabled, order };
}

// Bo ky tu dieu khien hay bi dinh khi dan tu clipboard (vd \u0016 o dau chuoi)
function cleanText(value) {
  return String(value).replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

export function readModelFields(body) {
  const fields = {};
  if (Object.hasOwn(body, "description")) {
    if (typeof body.description !== "string") {
      const error = new Error("Mô tả phải là chuỗi văn bản");
      error.status = 400;
      throw error;
    }
    fields.description = body.description.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
    if (fields.description.length > 500) {
      const error = new Error("Mô tả tối đa 500 ký tự");
      error.status = 400;
      throw error;
    }
  }
  for (const key of ["code", "name", "baseUrl", "apiKey"]) {
    if (typeof body[key] === "string" && body[key].trim()) fields[key] = cleanText(body[key]);
  }
  if (Object.hasOwn(body, "coinPrice")) {
    if (!Number.isInteger(body.coinPrice) || body.coinPrice < 0 || body.coinPrice > 10000) {
      throw Object.assign(new Error("Giá xu phải là số nguyên từ 0 đến 10.000"), { status: 400 });
    }
    fields.coinPrice = body.coinPrice;
  }
  if (typeof body.enabled === "boolean") fields.enabled = body.enabled;
  if (typeof body.order === "number") fields.order = body.order;
  return fields;
}

// GET /api/models - App goi de lay danh sach model dang bat (khong co key)
router.get("/models", requireAppKey, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }
  const list = await AiModel.find({ enabled: true }).sort({ order: 1, createdAt: 1 }).lean();
  const { sharedAiModelId } = list.length ? await readQuotaPolicy() : {};
  res.json(list.map((doc) => ({
    ...toClient(doc, false),
    ...(sharedAiModelId && String(doc._id) === sharedAiModelId && (doc.coinPrice ?? 0) === 0 && { sharedAi: true }),
  })));
});

const verificationError = "Kiểm tra model thất bại. Vui lòng kiểm tra cấu hình kết nối.";

async function needsNewKey(baseUrl, apiKey, current) {
  const currentUrl = cleanText(current?.baseUrl ?? "");
  const savedKey = cleanText(current?.apiKey ?? "");
  if (!apiKey) return Boolean(savedKey) && baseUrl !== currentUrl;
  if (apiKey === maskKey(savedKey) || (baseUrl !== currentUrl && apiKey === savedKey)) return true;

  // Không cho dùng lại khóa đã cấu hình ở một endpoint khác.
  const endpoint = (value) => cleanText(value ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
  const savedUrls = await AiModel.distinct("baseUrl", { apiKey });
  return savedUrls.some((url) => endpoint(url) !== endpoint(baseUrl));
}

const newKeyError = "Cần nhập API key mới phù hợp với Base URL.";

async function listModels(req, res) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }
  const list = await AiModel.find().sort({ order: 1, createdAt: 1 }).lean();
  res.json(list.map((doc) => {
    const { baseUrl = "", enabled = true, order = 0 } = doc;
    return toClient({ ...doc, baseUrl, enabled, order }, req.adminWeb.role === "owner", true);
  }));
}

// Kiểm tra kết nối mà không lưu model.
async function verifyModelRoute(req, res) {
  const { id, model, baseUrl, apiKey } = req.body ?? {};
  if (!model || typeof model !== "string" || !model.trim()) {
    return res.status(400).json({ ok: false, error: "Thieu ma model" });
  }

  if (id !== undefined && !mongoose.isObjectIdOrHexString(id)) {
    return res.status(400).json({ ok: false, error: "ID model không hợp lệ" });
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    return res.status(400).json({ ok: false, error: "Base URL không hợp lệ" });
  }
  const current = id ? await AiModel.findById(id).select("baseUrl apiKey").lean() : null;
  if (id && !current) return res.status(404).json({ ok: false, error: "Không tìm thấy model" });
  const targetUrl = cleanText(baseUrl ?? current?.baseUrl ?? "");
  const suppliedKey = typeof apiKey === "string" ? cleanText(apiKey) : "";
  const targetKey = suppliedKey || cleanText(current?.apiKey ?? "");
  if (!targetUrl || !targetKey) {
    return res.status(400).json({ ok: false, error: "Model phải có Base URL và API key." });
  }
  if (await needsNewKey(targetUrl, suppliedKey, current)) {
    return res.status(400).json({ ok: false, error: newKeyError });
  }

  try {
    const startedAt = performance.now();
    await verifyModel(model.trim(), targetUrl, targetKey);
    const latencyMs = Math.round(performance.now() - startedAt);
    res.json({ ok: true, latencyMs });
  } catch {
    res.status(400).json({ ok: false, error: verificationError });
  }
}

async function createModel(req, res) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }

  const fields = readModelFields(req.body ?? {});
  const { code, name, baseUrl = "", apiKey = "", enabled = true, order = 0 } = fields;

  if (!fields.code) return res.status(400).json({ error: "code khong duoc de trong" });
  if (!fields.name) return res.status(400).json({ error: "name khong duoc de trong" });
  if (!baseUrl || !apiKey) return res.status(400).json({ error: "Model phải có Base URL và API key." });

  const existed = await AiModel.findOne({ code: code.trim() });
  if (existed) {
    return res.status(409).json({ error: `Model voi code '${code.trim()}' da ton tai` });
  }

  try {
    if (await needsNewKey(baseUrl, apiKey)) return res.status(400).json({ error: newKeyError });
    await verifyModel(code, baseUrl, apiKey);
  } catch {
    return res.status(400).json({ error: verificationError });
  }

  const created = await AiModel.create({
    code: code.trim(),
    name: name.trim(),
    description: fields.description ?? "",
    baseUrl: typeof baseUrl === "string" ? baseUrl.trim() : "",
    apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
    enabled: Boolean(enabled),
    order: Number(order) || 0,
    coinPrice: fields.coinPrice ?? 0,
  });

  res.status(201).json({ ok: true, model: toClient(created.toObject(), true) });
}

async function updateModel(req, res) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }

  const current = await AiModel.findById(req.params.id);
  if (!current) return res.status(404).json({ error: "Khong tim thay model" });

  const body = req.body ?? {};
  const fields = readModelFields(body);
  if (Object.hasOwn(body, "baseUrl")) {
    if (typeof body.baseUrl !== "string") return res.status(400).json({ error: "Base URL không hợp lệ" });
    fields.baseUrl = cleanText(body.baseUrl);
  }
  if (fields.code && fields.code !== current.code) {
    const clash = await AiModel.findOne({ code: fields.code });
    if (clash) return res.status(409).json({ error: `Model voi code '${fields.code}' da ton tai` });
  }

  const nextCode = fields.code || current.code;
  const nextBaseUrl = fields.baseUrl ?? current.baseUrl;
  const nextApiKey = fields.apiKey ?? current.apiKey;

  const shouldVerify = nextBaseUrl !== current.baseUrl || nextApiKey !== current.apiKey || nextCode !== current.code;
  if ((shouldVerify || fields.enabled === true)
    && await needsNewKey(cleanText(nextBaseUrl ?? ""), fields.apiKey, current)) {
    return res.status(400).json({ error: newKeyError });
  }
  if (shouldVerify || (fields.enabled === true && !current.enabled)) {
    try {
      await verifyModel(nextCode, nextBaseUrl, nextApiKey);
    } catch {
      return res.status(400).json({ error: verificationError });
    }
  }

  Object.assign(current, fields);
  try {
    await current.save();
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      return res.status(409).json({ error: "Model đã thay đổi. Vui lòng tải lại và thử lại." });
    }
    throw error;
  }

  res.json({ ok: true, model: toClient(current.toObject(), true) });
}

async function deleteModel(req, res) {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }

  const deleted = await AiModel.findByIdAndDelete(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Khong tim thay model de xoa" });
  }

  res.json({ ok: true });
}

export function createAdminModelsRouter(authorize) {
  const adminRouter = Router();
  const modelsPath = "/models";
  const canRead = [authorize, (req, res, next) => {
    if (!["owner", "admin"].includes(req.adminWeb.role)) return res.status(403).json({ error: "Không có quyền xem model" });
    next();
  }];
  const canWrite = [authorize, (req, res, next) => {
    if (req.adminWeb.role !== "owner") return res.status(403).json({ error: "Chỉ chủ quản trị được thực hiện thao tác này" });
    next();
  }];

  adminRouter.get(modelsPath, canRead, (req, res) => listModels(req, res));
  adminRouter.post(`${modelsPath}/verify`, canWrite, (req, res) => verifyModelRoute(req, res));
  adminRouter.post(modelsPath, canWrite, (req, res) => createModel(req, res));
  adminRouter.put(`${modelsPath}/:id`, canWrite, (req, res) => updateModel(req, res));
  adminRouter.delete(`${modelsPath}/:id`, canWrite, deleteModel);

  // Chuyển lỗi validation metadata sang JSON; giữ nguyên xử lý các lỗi khác.
  adminRouter.use((error, req, res, next) => {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    next(error);
  });
  return adminRouter;
}

export default router;
