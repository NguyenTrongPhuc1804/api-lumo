import mongoose from "mongoose";

// Luu cache ban dich de khong phai goi model lai cho cung mot cau
const translationSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true }, // sha256(sourceLang|targetLang|text)
  sourceLang: String,
  targetLang: String,
  text: String,
  translated: String,
  // Tu dong xoa sau 30 ngay
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

export const Translation = mongoose.model("Translation", translationSchema);
