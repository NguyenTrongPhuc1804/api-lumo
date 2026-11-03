// Goi model qua giao dien OpenAI chat/completions. baseUrl va apiKey lay theo tung model trong DB.

import mongoose from "mongoose";
import { AiModel } from "../models/AiModel.js";

const BASE_URL = process.env.REVID_BASE_URL || "https://revidapi.com";
const API_KEY = process.env.REVID_API_KEY;

// Model hay tra ve JSON trong khoi ```json ... ```, ham nay bo khoi do roi parse
export function parseTranslations(content, expectedCount) {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();

  const data = JSON.parse(cleaned);

  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new Error(`Model tra ve sai so luong: can ${expectedCount}`);
  }
  return data.map((item) => String(item));
}

async function callModel(model, texts, sourceLang, targetLang, customBaseUrl, customApiKey, opts = {}) {
  // Khi test ket noi chi can 1 cau ngan nen cho phep giam max_tokens.
  // temperature = null nghia la khong gui tham so nay (co model tu choi).
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature === undefined ? 0.2 : opts.temperature;
  const sourceText =
    sourceLang === "auto" ? "Detect the source language automatically." : `Source language: ${sourceLang}.`;

  const systemPrompt =
    `You are a translation engine for text captured from a phone screen. ${sourceText} ` +
    `Translate every item of the JSON array into the language with code "${targetLang}". ` +
    "Keep the same order and the same number of items. Keep numbers, names and emoji. " +
    "Return ONLY a JSON array of strings, no explanation.";

  // baseUrl co the dinh ky tu dieu khien khi dan tu clipboard, phai bo truoc khi goi
  const effectiveBaseUrl = (customBaseUrl || BASE_URL)
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/\/+$/, "");
  const effectiveApiKey = (customApiKey || API_KEY).trim();

  // Ho tro ca endpoint da co hoac chua co /v1
  const endpoint = effectiveBaseUrl.endsWith("/v1")
    ? `${effectiveBaseUrl}/chat/completions`
    : `${effectiveBaseUrl}/v1/chat/completions`;

  // Chi gui temperature khi co gia tri, de model khong ho tro tham so nay van chay duoc
  const requestBody = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(texts) },
    ],
    max_tokens: maxTokens,
    stream: false,
  };
  if (temperature !== null) requestBody.temperature = temperature;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${effectiveApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => "");
    throw new Error(`API tra ve ${res.status}: ${errorBody.slice(0, 600)}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("API khong tra ve noi dung");
  }
  return parseTranslations(content, texts.length);
}

// Goi thu 1 tu de kiem tra model co hoat dong khong truoc khi luu vao DB.
// Dung max_tokens nho cho nhanh va re, khong gui temperature de model nao cung nhan.
export async function verifyModel(model, customBaseUrl, customApiKey) {
  return await callModel(model, ["Hello"], "en", "vi", customBaseUrl, customApiKey, {
    maxTokens: 128,
    temperature: null,
  });
}

// Dich mot danh sach cau bang dung model trong DB (ke ca baseUrl va apiKey cua model do)
export async function translateBatch(texts, sourceLang, targetLang, modelCode) {
  if (!modelCode) throw new Error("Chua chon model dich");
  if (mongoose.connection.readyState !== 1) {
    throw new Error("Database chua ket noi, khong doc duoc model");
  }

  const doc = await AiModel.findOne({ code: modelCode, enabled: true }).lean();
  if (!doc) throw new Error(`Model '${modelCode}' khong ton tai hoac dang tat`);

  return await callModel(doc.code, texts, sourceLang, targetLang, doc.baseUrl, doc.apiKey);
}
