import { randomBytes, scryptSync } from "node:crypto";

// Cach dung (PowerShell):
//   $env:ADMIN_WEB_PASSWORD_INPUT = "mat-khau-moi-dai-tren-12-ky-tu"
//   node scripts/hash-admin-password.js
//   Remove-Item Env:ADMIN_WEB_PASSWORD_INPUT
// Dung bien moi truong thay vi tham so dong lenh de mat khau khong nam trong lich su lenh.
const password = process.env.ADMIN_WEB_PASSWORD_INPUT ?? "";
if (password.length < 12 || password.length > 512) {
  console.error("ADMIN_WEB_PASSWORD_INPUT phai dai tu 12 den 512 ky tu");
  process.exit(1);
}

const salt = randomBytes(16);
const key = scryptSync(password, salt, 64);
console.log(`ADMIN_WEB_PASSWORD_HASH=${salt.toString("hex")}:${key.toString("hex")}`);
