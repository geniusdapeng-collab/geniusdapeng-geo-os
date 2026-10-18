import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { VideoMediaEngine } from "../src/engines/video-media.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const fixtureDir = join(rootDir, "var", "media", "fixtures");
await mkdir(fixtureDir, { recursive: true });
const ffmpeg = process.env.WL_FFMPEG || join(process.env.HOME, ".local", "bin", "ffmpeg");
const ffprobe = process.env.WL_FFPROBE || join(process.env.HOME, ".local", "bin", "ffprobe");
const sources = [];

for (const [index, color] of ["0x1d4ed8", "0x0f766e"].entries()) {
  const file = join(fixtureDir, `pengstack-live-source-${index + 1}.mp4`);
  await execFileAsync(
    ffmpeg,
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=640x360:r=30:d=3`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${440 + index * 120}:duration=3`,
      "-vf",
      `drawbox=x=40:y=220:w=560:h=4:color=white@0.8:t=fill`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      file,
    ],
    { timeout: 60_000 },
  );
  sources.push(file);
}

const engine = new VideoMediaEngine({ rootDir, ffmpeg, ffprobe });
const result = await engine.render({
  sources,
  title: "证据优先的 AI 产品系统",
  coverTitle: "4 层证据链",
  hook: "Claim → 内容 → 回执 → 复测",
  platform: "微信视频号",
  subtitleText: "先确认事实，再生成内容，发布后保留回执并复测。",
});

const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const receipt = {
  schemaVersion: "pengstack.live-receipt/v1",
  kind: "integrated-video-edit-media-render",
  completedAt: result.completedAt,
  jobId: result.jobId,
  engine: {
    mode: "in-process-video-edit-engine",
    upstreamCommit: "2412a5b4e49f2d19601752758ce5274d2e88772c",
  },
  title: result.title,
  platform: result.platform,
  variants: result.variants,
  sourceMeta: result.sourceMeta.map((source) => ({
    sourceId: source.sourceId,
    file: relative(rootDir, source.path),
    sha256: source.sha256,
    durationSeconds: source.durationSeconds,
  })),
  manifestHash: result.manifestHash,
  postQuality: {
    ...result.manifest.postQuality,
    path: relative(rootDir, result.manifest.postQuality.path),
  },
  outputs: result.outputs.map((output) => ({
    file: relative(rootDir, output.path),
    bytes: output.bytes,
    sha256: output.sha256,
  })),
  finalDir: relative(rootDir, result.finalDir),
};
const receiptDir = join(rootDir, "docs", "evidence");
await mkdir(receiptDir, { recursive: true });
await writeFile(
  join(receiptDir, `media-render-live-${date}.json`),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(receipt, null, 2));
