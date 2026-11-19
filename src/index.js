import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import mongoose from "mongoose";
import { requireAppKey } from "./middleware/auth.js";
import translateRouter from "./routes/translate.js";
import modelsRouter from "./routes/models.js";
import { createAuthRouter } from "./routes/auth.js";
import { createAdminUsersRouter } from "./routes/adminUsers.js";

const app = express();

// Thieu JWT_SECRET thi moi request dang nhap se 500 hoac 401 kho hieu.
// Bao loi ro rang ngay luc khoi dong con hon de nguoi dung gap loi bi an.
if (!process.env.JWT_SECRET) {
  console.error("Thieu JWT_SECRET trong .env. Sinh bang: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
  process.exit(1);
}

// Chay sau nginx: tin 1 lop proxy de req.ip lay dung IP nguoi dung tu X-Forwarded-For
app.set("trust proxy", 1);

app.use(helmet());
app.use(express.json({ limit: "200kb" }));

// In ra moi request de biet app co goi toi server hay khong
app.use((req, res, next) => {
  res.on("finish", () => console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${req.ip})`));
  next();
});

// Trang phap ly cong khai, khong qua auth hay rate limit.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use("/legal", express.static(path.join(__dirname, "../public/legal")));

// Gioi han 60 request moi phut cho moi IP
app.use(rateLimit({ windowMs: 60 * 1000, limit: 60 }));

// Khong can app key de kiem tra server song hay chet
app.get("/health", (req, res) => {
  res.json({ ok: true, db: mongoose.connection.readyState === 1 });
});

app.use("/api", createAuthRouter());
app.use("/api", createAdminUsersRouter());
app.use("/api", translateRouter);
app.use("/api", modelsRouter);

const port = Number(process.env.PORT) || 3000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Server chay tai cong ${port}`);
});

// Ket noi Mongo khong chan server: neu Mongo chua bat thi van dich duoc, chi la khong cache
mongoose
  .connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log("Da ket noi MongoDB"))
  .catch((err) => console.warn("Chua ket noi duoc MongoDB, chay khong cache:", err.message));
