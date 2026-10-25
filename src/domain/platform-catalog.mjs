import { readFileSync } from "node:fs";
import { ApiError } from "./errors.mjs";

const parsed = JSON.parse(readFileSync(new URL("../../data/platform-catalog.json", import.meta.url), "utf8"));
if (parsed.schema !== "pengmanager.platform-catalog/v1" || !Array.isArray(parsed.platforms) ||
    new Set(parsed.platforms.map(row => row.id)).size !== parsed.platforms.length ||
    parsed.platforms.some(row => !/^[a-z0-9-]{1,80}$/.test(row.id) || !row.name || !row.nameEn)) {
  throw new Error("Bundled platform catalog is invalid.");
}

export function platformCatalog() {
  return structuredClone(parsed);
}

export function platformById(id) {
  const row = parsed.platforms.find(item => item.id === id);
  if (!row) throw new ApiError(400, "PLATFORM_NOT_FOUND", "平台不在当前目录中。");
  return structuredClone(row);
}

export const LEGACY_PLATFORM_IDS = Object.freeze({
  "wechat-official": "微信公众号", zhihu: "知乎", xiaohongshu: "小红书", bilibili: "哔哩哔哩",
  douyin: "抖音", "wechat-channels": "微信视频号", jike: "即刻", juejin: "掘金", baijiahao: "百家号",
  toutiao: "今日头条", maimai: "脉脉", github: "GitHub", linkedin: "LinkedIn", x: "X", youtube: "YouTube", medium: "Medium",
});
