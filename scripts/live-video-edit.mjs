import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { VideoEditAdapter } from "../src/adapters/video-edit.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const upstreamRoot = resolve(
  process.env.VIDEO_EDIT_ROOT ||
    join(rootDir, "..", "upstreams", "WorkLoom-video-edit"),
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
const commit = (
  await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: upstreamRoot })
).stdout.trim();
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
    upstreamRoot: "../upstreams/WorkLoom-video-edit",
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
