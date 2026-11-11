import { createHash } from "node:crypto";
import { Router } from "express";
import mongoose from "mongoose";
import { Translation } from "../models/Translation.js";
import { translateBatch } from "../services/gemini.js";
import { requireAppKey } from "../middleware/auth.js";

const router = Router();

const MAX_ITEMS = 50;
const MAX_CHARS_PER_ITEM = 2000;

// Co model thi tinh vao khoa cache, de moi model giu ban dich rieng
function makeKey(sourceLang, targetLang, text, model) {
  const base = `${sourceLang}|${targetLang}|${text}`;
  return createHash("sha256").update(model ? `${base}|${model}` : base).digest("hex");
}

// POST /api/translate
// body: { texts: ["Hello", "World"], sourceLang: "auto", targetLang: "vi" }
// tra ve: { translations: ["Xin chao", "The gioi"], cached: 1 }
router.post("/translate", requireAppKey, async (req, res) => {
  const { texts, sourceLang = "auto", targetLang, mode = "game", context = [] } = req.body;
  if (mode !== "game" && mode !== "manga") return res.status(400).json({ error: "Mode khong hop le" });
  if (!Array.isArray(context) || context.length > 3 || context.some(turn =>
    !Array.isArray(turn) || turn.length === 0 || turn.length > 3000 || turn.some(pair =>
      !pair || Object.keys(pair).some(key => key !== "source" && key !== "translation") || typeof pair.source !== "string" || typeof pair.translation !== "string" ||
      !pair.source.length || !pair.translation.length))) {
    return res.status(400).json({ error: "Context khong hop le" });
  }
  const contextLength = context.reduce((total, turn) => total + turn.reduce((sum, pair) => sum + pair.source.length + pair.translation.length, 0), 0);
  if (contextLength > 6000 || (mode === "game" && context.length > 0)) {
    return res.status(400).json({ error: "Context vuot gioi han hoac khong dung mode" });
  }
  const model = typeof req.body.model === "string" ? req.body.model : "";

  // 1. Kiem tra du lieu dau vao
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_ITEMS) {
    return res.status(400).json({ error: `texts phai la mang 1 den ${MAX_ITEMS} phan tu` });
  }
  if (texts.some((t) => typeof t !== "string" || t.length > MAX_CHARS_PER_ITEM)) {
    return res.status(400).json({ error: `Moi cau phai la chuoi toi da ${MAX_CHARS_PER_ITEM} ky tu` });
  }
  if (typeof targetLang !== "string" || typeof sourceLang !== "string" || !targetLang) {
    return res.status(400).json({ error: "Thieu sourceLang hoac targetLang" });
  }

  try {
    if (mode === "manga") {
      const translations = await translateBatch(texts, sourceLang, targetLang, model, { mode, context });
      return res.json({ translations, cached: 0 });
    }
    // 2. Tim ban dich da luu (neu Mongo dang chay)
    const dbReady = mongoose.connection.readyState === 1 && mode === "game";
    const resultByText = new Map();

    if (dbReady) {
      const keys = texts.map((t) => makeKey(sourceLang, targetLang, t, model));
      const found = await Translation.find({ key: { $in: keys } });
      for (const item of found) {
        resultByText.set(item.text, item.translated);
      }
    }
    const cachedCount = resultByText.size;

    // 3. Chi dich nhung cau chua co, bo cau trung nhau
    const missing = [...new Set(texts.filter((t) => !resultByText.has(t)))];

    if (missing.length > 0) {
      const translated = await translateBatch(missing, sourceLang, targetLang, model);

      missing.forEach((text, i) => resultByText.set(text, translated[i]));

      // 4. Luu cache, loi o day khong lam hong request
      if (dbReady) {
        const operations = missing.map((text, i) => ({
          updateOne: {
            filter: { key: makeKey(sourceLang, targetLang, text, model) },
            update: { $set: { sourceLang, targetLang, text, translated: translated[i] } },
            upsert: true,
          },
        }));
        await Translation.bulkWrite(operations).catch((err) => console.warn("Luu cache loi:", err.message));
      }
    }

    // 5. Tra ket qua dung thu tu cua request
    res.json({ translations: texts.map((t) => resultByText.get(t)), cached: cachedCount });
  } catch (err) {
    console.error("Dich loi:", err.message);
    res.status(502).json({ error: "Khong dich duoc, thu lai sau" });
  }
});

export default router;
