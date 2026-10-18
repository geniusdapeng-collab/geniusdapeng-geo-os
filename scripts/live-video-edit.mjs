import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { VideoEditAdapter } from "../src/adapters/video-edit.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const defaultEngineRoot = join(rootDir, "engines", "video-edit");
const upstreamRoot = resolve(
  process.env.VIDEO_EDIT_ROOT || defaultEngineRoot,
);
const adapter = new VideoEditAdapter({ upstreamRoot });
const health = await adapter.health();
if (!health.ok) {
  throw new Error(`video-edit 健康检查失败：${health.error || "unknown"}`);
}

const enrichment = await adapter.enrichCover({
  platform: process.env.VIDEO_COVER_PLATFORM || "xiaohongshu",
  theme: process.env.VIDEO_COVER_THEME || "知识科普",
  text: "为什么 GEO 需要证据控制面",
});
const feedbackTriage = await adapter.triageFeedback({
  feedback: "封面文字太挤，配乐再安静一点",
});
const pin = JSON.parse(
  await readFile(join(rootDir, "upstreams", "workloom-video-edit.pin.json"), "utf8"),
);
const commit = process.env.VIDEO_EDIT_ROOT
  ? (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: upstreamRoot })).stdout.trim()
  : pin.commit;
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const receipt = {
  schemaVersion: "pengstack.live-receipt/v1",
  kind: "video-edit-production-adapter",
  completedAt: new Date().toISOString(),
  upstream: {
    repository: "geniusdapeng-collab/WorkLoom-video-edit",
    commit,
  },
  health: {
    ...health,
    upstreamRoot: relative(rootDir, upstreamRoot),
  },
  enrichment,
  feedbackTriage,
};
const receiptDir = join(rootDir, "docs", "evidence");
await mkdir(receiptDir, { recursive: true });
await writeFile(
  join(receiptDir, `video-edit-live-${date}.json`),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(receipt, null, 2));
