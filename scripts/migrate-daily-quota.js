import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { DailyQuota } from "../src/models/DailyQuota.js";
import { User } from "../src/models/User.js";
import { quotaIdentity, quotaPeriod } from "../src/services/dailyQuota.js";

export async function migrateDailyQuota({ sourceDate, targetDate, apply = false, now = () => new Date() }) {
  const date = new Date(`${sourceDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceDate) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== sourceDate) {
    throw new Error("Can --source-date=YYYY-MM-DD hop le");
  }
  if (!process.env.QUOTA_HMAC_SECRET?.trim()) throw new Error("Thieu QUOTA_HMAC_SECRET");
  const { usageDate, expiresAt } = quotaPeriod(now());
  if ((apply || targetDate !== undefined) && targetDate !== usageDate) {
    throw new Error("--target-date phai la ngay Viet Nam hien tai khi chuyen han muc");
  }
  let scanned = 0;
  const users = User.find({ usageDate: sourceDate, usageCount: { $gt: 0 } }).select("provider providerId usageCount").lean().cursor();
  for await (const user of users) {
    if (apply && quotaPeriod(now()).usageDate !== usageDate) throw new Error("Da doi ky han muc; dung migration");
    const identityKey = quotaIdentity(user);
    if (apply) {
      await DailyQuota.updateOne(
        { identityKey, usageDate },
        { $setOnInsert: { expiresAt }, $max: { usageCount: user.usageCount } },
        { upsert: true, setDefaultsOnInsert: false }
      );
    }
    scanned++;
  }
  return { scanned, usageDate, apply };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const sources = args.filter((arg) => arg.startsWith("--source-date="));
    const targets = args.filter((arg) => arg.startsWith("--target-date="));
    const apply = args.includes("--apply");
    if (sources.length !== 1 || targets.length > 1 || (apply && targets.length !== 1)
      || args.some((arg) => arg !== sources[0] && arg !== targets[0] && arg !== "--apply" && arg !== "--dry-run")
      || (apply && args.includes("--dry-run"))) {
      throw new Error("Dung --source-date=YYYY-MM-DD; --apply can --target-date=YYYY-MM-DD");
    }
    const sourceDate = sources[0].slice("--source-date=".length);
    const targetDate = targets[0]?.slice("--target-date=".length);
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 5000 });
    if (apply) await DailyQuota.createIndexes();
    console.log(await migrateDailyQuota({ sourceDate, targetDate, apply }));
  } catch (error) {
    // Khong in loi Mongo co the chua URI hoac khoa dinh danh.
    console.error("Migration that bai. Kiem tra tham so, cau hinh MongoDB, khoa HMAC va ky han muc.");
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
