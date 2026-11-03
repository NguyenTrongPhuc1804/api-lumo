import mongoose from "mongoose";

// Luu danh sach cac model AI dung de dich
const aiModelSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true }, // vi du: google/gemini-flash-lite
  name: { type: String, required: true, trim: true }, // ten hien thi, vi du: Gemini Flash-Lite (nhanh)
  baseUrl: { type: String, default: "", trim: true }, // de trong thi dung REVID_BASE_URL trong .env
  apiKey: { type: String, default: "", trim: true }, // de trong thi dung REVID_API_KEY trong .env
  enabled: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

export const AiModel = mongoose.model("AiModel", aiModelSchema);
