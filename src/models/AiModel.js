import mongoose from "mongoose";

// Luu danh sach cac model AI dung de dich
const aiModelSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, trim: true }, // vi du: google/gemini-flash-lite
  name: { type: String, required: true, trim: true }, // ten hien thi, vi du: Gemini Flash-Lite (nhanh)
  description: { type: String, default: "", trim: true, maxlength: 500 },
  baseUrl: { type: String, default: "", trim: true }, // Model chỉ gọi được AI khi có URL riêng.
  apiKey: { type: String, default: "", trim: true }, // Không dùng khóa mặc định của server.
  enabled: { type: Boolean, default: true },
  order: { type: Number, default: 0 },
  coinPrice: { type: Number, default: 0, min: 0, max: 10000, validate: Number.isInteger },
  createdAt: { type: Date, default: Date.now },
}, { optimisticConcurrency: true });

export const AiModel = mongoose.model("AiModel", aiModelSchema);
