import { Router } from "express";
import mongoose from "mongoose";
import { AiModel } from "../models/AiModel.js";
import { requireAppKey, requireAdminKey } from "../middleware/auth.js";
import { verifyModel } from "../services/gemini.js";

const router = Router();

// Khong bao gio tra apiKey day du ra ngoai
function maskKey(key) {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 3)}...${key.slice(-4)}` : "********";
}

export function toClient(doc, withKey) {
  const { _id, code, name, baseUrl, apiKey, enabled, order, description = "" } = doc;
  return withKey ? { id: _id, code, name, description, baseUrl, apiKey: maskKey(apiKey), enabled, order } : { code, name, description };
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
  res.json(list.map((doc) => toClient(doc, false)));
});

// GET /api/admin/models - Lay toan bo model (ke ca da tat), apiKey chi tra dang che
router.get("/admin/models", requireAdminKey, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }
  const list = await AiModel.find().sort({ order: 1, createdAt: 1 }).lean();
  res.json(list.map((doc) => toClient(doc, true)));
});

// POST /api/admin/models/verify - Kiem tra mot model voi baseUrl va apiKey dang nhap, khong luu gi.
// De trong apiKey thi dung key da luu cua model (truong hop sua ten ma khong doi key).
router.post("/admin/models/verify", requireAdminKey, async (req, res) => {
  const { id, model, baseUrl, apiKey } = req.body;
  if (!model || typeof model !== "string" || !model.trim()) {
    return res.status(400).json({ ok: false, error: "Thieu ma model" });
  }

  let savedKey = "";
  if (!apiKey && id) {
    const doc = await AiModel.findById(id).select("apiKey").lean();
    savedKey = doc?.apiKey || "";
  }

  try {
    const sample = await verifyModel(model.trim(), baseUrl, apiKey || savedKey);
    res.json({ ok: true, sample });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/models - Tao model moi, goi thu model truoc khi luu
router.post("/admin/models", requireAdminKey, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }

  const fields = readModelFields(req.body);
  const { code, name, baseUrl = "", apiKey = "", enabled = true, order = 0 } = { ...req.body, ...fields };

  if (!fields.code) return res.status(400).json({ error: "code khong duoc de trong" });
  if (!fields.name) return res.status(400).json({ error: "name khong duoc de trong" });

  const existed = await AiModel.findOne({ code: code.trim() });
  if (existed) {
    return res.status(409).json({ error: `Model voi code '${code.trim()}' da ton tai` });
  }

  try {
    await verifyModel(code.trim(), baseUrl, apiKey);
  } catch (err) {
    return res.status(400).json({ error: `Kiem tra model that bai: ${err.message}` });
  }

  const created = await AiModel.create({
    code: code.trim(),
    name: name.trim(),
    description: fields.description ?? "",
    baseUrl: typeof baseUrl === "string" ? baseUrl.trim() : "",
    apiKey: typeof apiKey === "string" ? apiKey.trim() : "",
    enabled: Boolean(enabled),
    order: Number(order) || 0,
  });

  res.status(201).json({ ok: true, model: toClient(created.toObject(), true) });
});

// PUT /api/admin/models/:id - Sua model. Neu doi key hoac baseUrl thi goi thu lai
router.put("/admin/models/:id", requireAdminKey, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }

  const current = await AiModel.findById(req.params.id);
  if (!current) return res.status(404).json({ error: "Khong tim thay model" });

  const fields = readModelFields(req.body);
  if (fields.code && fields.code !== current.code) {
    const clash = await AiModel.findOne({ code: fields.code });
    if (clash) return res.status(409).json({ error: `Model voi code '${fields.code}' da ton tai` });
  }

  const nextCode = fields.code || current.code;
  const nextBaseUrl = fields.baseUrl ?? current.baseUrl;
  const nextApiKey = fields.apiKey ?? current.apiKey;

  if (nextBaseUrl !== current.baseUrl || nextApiKey !== current.apiKey || nextCode !== current.code) {
    try {
      await verifyModel(nextCode, nextBaseUrl, nextApiKey);
    } catch (err) {
      return res.status(400).json({ error: `Kiem tra model that bai: ${err.message}` });
    }
  }

  Object.assign(current, fields);
  await current.save();

  res.json({ ok: true, model: toClient(current.toObject(), true) });
});

// DELETE /api/admin/models/:id - Xoa model
router.delete("/admin/models/:id", requireAdminKey, async (req, res) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: "Database chua ket noi" });
  }

  const deleted = await AiModel.findByIdAndDelete(req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: "Khong tim thay model de xoa" });
  }

  res.json({ ok: true });
});

// Chi chuyen loi validation cua metadata thanh JSON; loi khac de middleware hien co xu ly.
router.use((error, req, res, next) => {
  if (error.status === 400) return res.status(400).json({ error: error.message });
  next(error);
});

export default router;
