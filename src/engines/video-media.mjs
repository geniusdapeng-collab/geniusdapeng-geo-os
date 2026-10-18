import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function toSrtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

export class VideoMediaEngine {
  constructor({
    rootDir,
    engineRoot = join(rootDir, "engines", "video-edit"),
    ffmpeg = process.env.WL_FFMPEG || process.env.WORKLOOM_POST_FFMPEG_PATH || "ffmpeg",
    ffprobe = process.env.WL_FFPROBE || process.env.WORKLOOM_POST_FFPROBE_PATH || "ffprobe",
  }) {
    this.rootDir = resolve(rootDir);
    this.engineRoot = resolve(engineRoot);
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.jobsRoot = join(this.rootDir, "var", "media", "jobs");
  }

  async health() {
    try {
      const [ffmpegVersion, ffprobeVersion, tsxPackage] = await Promise.all([
        execFileAsync(this.ffmpeg, ["-version"], { timeout: 10_000 }),
        execFileAsync(this.ffprobe, ["-version"], { timeout: 10_000 }),
        access(join(this.rootDir, "node_modules", "tsx", "package.json")),
        access(
          join(
            this.engineRoot,
            "scripts",
            "tools",
            "edit-post.mts",
          ),
        ),
      ]);
      return {
        ok: true,
        configured: true,
        mode: "in-process-video-edit-engine",
        engineRoot: this.engineRoot,
        ffmpeg: ffmpegVersion.stdout.split("\n")[0],
        ffprobe: ffprobeVersion.stdout.split("\n")[0],
        tsx: Boolean(tsxPackage),
        capabilities: [
          "timeline",
          "post-production",
          "subtitles",
          "color",
          "transitions",
          "cover",
          "delivery-package",
          "feedback-triage",
        ],
      };
    } catch (error) {
      return {
        ok: false,
        configured: false,
        mode: "in-process-video-edit-engine",
        engineRoot: this.engineRoot,
        error: error.message,
      };
    }
  }

  async #run(script, args, env = {}) {
    const command = [
      "--import",
      "tsx",
      join(this.engineRoot, "scripts", "tools", script),
      ...args,
    ];
    const result = await execFileAsync(process.execPath, command, {
      cwd: this.engineRoot,
      timeout: 20 * 60_000,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        ...process.env,
        WL_FFMPEG: this.ffmpeg,
        WL_FFPROBE: this.ffprobe,
        ...env,
      },
    });
    return {
      command: [process.execPath, ...command],
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async #probe(file) {
    const { stdout } = await execFileAsync(
      this.ffprobe,
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height,r_frame_rate",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        file,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const body = JSON.parse(stdout);
    const video = (body.streams ?? []).find((stream) => stream.codec_type === "video");
    const [numerator, denominator] = String(video?.r_frame_rate ?? "0/1")
      .split("/")
      .map(Number);
    return {
      width: Number(video?.width ?? 0),
      height: Number(video?.height ?? 0),
      fps: denominator ? numerator / denominator : 0,
      durationSeconds: Number(body.format?.duration ?? 0),
      hasAudio: (body.streams ?? []).some((stream) => stream.codec_type === "audio"),
    };
  }

  async render({
    sources,
    title,
    coverTitle = "4 层证据链",
    hook = "",
    platform = "微信公众号",
    subtitleText,
    variants = ["clean-tech", "natural-clean"],
  }) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error("媒体渲染至少需要一个本地视频源。");
    }
    if (!title?.trim()) {
      throw new Error("媒体渲染需要标题。");
    }
    const sourceFiles = sources.map((file) => resolve(String(file)));
    const jobId = `media-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const jobDir = join(this.jobsRoot, jobId);
    const deliveryDir = join(jobDir, "delivery");
    const finalDir = join(jobDir, "final");
    const workDir = join(jobDir, "work");
    const musicDir = join(jobDir, "music");
    await Promise.all([
      mkdir(jobDir, { recursive: true }),
      mkdir(workDir, { recursive: true }),
      mkdir(musicDir, { recursive: true }),
    ]);

    const sourceMeta = [];
    for (const [index, file] of sourceFiles.entries()) {
      const bytes = await readFile(file);
      const probe = await this.#probe(file);
      sourceMeta.push({
        sourceId: `S${index + 1}`,
        path: file,
        sha256: sha256Bytes(bytes),
        width: probe.width,
        height: probe.height,
        fps: probe.fps || 30,
        durationSeconds: probe.durationSeconds,
        hasAudio: probe.hasAudio,
      });
    }

    const outputWidth = sourceMeta[0].width || undefined;
    const outputHeight = sourceMeta[0].height || undefined;
    let cursor = 0;
    const segments = sourceMeta.map((source, index) => {
      const duration = Math.max(0.6, Math.min(4, source.durationSeconds || 4));
      const segment = {
        seq: index,
        segmentId: `clip-${index + 1}`,
        sourceId: source.sourceId,
        sourceIn: 0,
        sourceOut: duration,
        durationSeconds: duration,
        motive: "程序化首轮剪辑",
        transitionIn: { type: "cut", durationSeconds: 0 },
      };
      cursor += duration;
      return segment;
    });

    const timeline = {
      schemaVersion: "workloom.video-edit/edit-timeline/v2",
      timelineId: jobId,
      pacing: { profile: "documentary" },
      target: {
        durationSeconds: cursor,
        aspectRatio:
          outputWidth >= outputHeight ? "16:9" : "9:16",
        fps: sourceMeta[0].fps || 30,
        platform,
      },
      sources: sourceMeta,
      segments,
      audioDesign: { originalAudioPolicy: "keep" },
    };
    const timelinePath = join(jobDir, "timeline.json");
    await writeFile(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`, "utf8");

    const subtitleLines = [];
    let subtitleCursor = 0;
    for (const [index, segment] of segments.entries()) {
      const start = subtitleCursor + 0.1;
      const end = subtitleCursor + segment.durationSeconds - 0.1;
      const cue =
        subtitleText?.trim() ||
        `${title}${index === 0 ? "｜证据优先的 AI 产品系统" : ""}`;
      subtitleLines.push(
        `${index + 1}\n${toSrtTime(start)} --> ${toSrtTime(end)}\n${cue}\n`,
      );
      subtitleCursor += segment.durationSeconds;
    }
    const subtitlePath = join(jobDir, "captions.zh.srt");
    await writeFile(subtitlePath, subtitleLines.join("\n"), "utf8");

    const musicFile = join(musicDir, "pengstack-local-ambient.m4a");
    await execFileAsync(
      this.ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=220:duration=${Math.max(12, cursor + 2)}`,
        "-af",
        "volume=0.18,tremolo=f=0.15:d=0.35",
        "-c:a",
        "aac",
        musicFile,
      ],
      { timeout: 60_000 },
    );
    await writeFile(
      join(musicDir, "tracks.json"),
      `${JSON.stringify(
        {
          tracks: [
            {
              id: "pengstack-local-ambient",
              title: "PengStack Local Ambient",
              style: "corporate-clean",
              mood: "干净、克制",
              file: "pengstack-local-ambient.m4a",
              durationSec: Math.max(12, cursor + 2),
              license: "workloom-self-generated",
              source: "offline-synthetic-fixture",
              artist: "PengStack",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const env = {
      WORKLOOM_POST_WORK_DIR: workDir,
      WORKLOOM_POST_ALLOWED_ROOTS: `${jobDir}:${this.engineRoot}`,
      WORKLOOM_COLOR_ALLOWED_ROOTS: `${jobDir}:${this.engineRoot}`,
      WORKLOOM_SUBTITLE_ALLOWED_ROOTS: `${jobDir}:${this.engineRoot}:/System/Library/Fonts`,
      WORKLOOM_BGM_ALLOWED_ROOTS: `${jobDir}:${this.engineRoot}`,
      WORKLOOM_BGM_LIBRARY_DIR: musicDir,
      WORKLOOM_BGM_HOME: join(jobDir, "bgm-home"),
      WORKLOOM_BGM_DISCOVER: "0",
      WORKLOOM_VISUAL_BRIDGE_URL: "http://127.0.0.1:1",
    };

    const postArgs = [
      "--timeline",
      timelinePath,
      "--out-dir",
      deliveryDir,
      "--variants",
      variants.join(","),
      "--subtitle",
      subtitlePath,
      "--title",
      title,
      "--platform",
      platform,
      "--clarity",
      "off",
      "--bgm-pack",
      musicDir,
      "--json",
    ];
    if (outputWidth && outputHeight) {
      postArgs.push(
        "--width",
        String(outputWidth),
        "--height",
        String(outputHeight),
      );
    }
    const post = await this.#run("edit-post.mts", postArgs, env);
    const packageRun = await this.#run(
      "edit-package.mts",
      [
        "--delivery",
        deliveryDir,
        "--final-only",
        "--title",
        title,
        "--out",
        finalDir,
      ],
      env,
    );

    const manifestPath = join(deliveryDir, "delivery-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const files = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (full.endsWith(".mp4") || full.endsWith(".png")) {
          const bytes = await readFile(full);
          const info = await stat(full);
          files.push({
            path: full,
            bytes: info.size,
            sha256: sha256Bytes(bytes),
          });
        }
      }
    }
    await walk(finalDir);

    const receipt = {
      schemaVersion: "pengstack.media-render/v1",
      jobId,
      status: "succeeded",
      title,
      platform,
      variants,
      timelinePath,
      subtitlePath,
      deliveryDir,
      finalDir,
      sourceMeta,
      manifestPath,
      manifestHash: sha256Bytes(await readFile(manifestPath)),
      manifest,
      outputs: files,
      commands: {
        post: post.command,
        package: packageRun.command,
      },
      completedAt: new Date().toISOString(),
    };
    await writeFile(
      join(jobDir, "job.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
      "utf8",
    );
    return receipt;
  }

  async listJobs(limit = 20) {
    try {
      const entries = await readdir(this.jobsRoot, { withFileTypes: true });
      const jobs = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const receipt = JSON.parse(
            await readFile(join(this.jobsRoot, entry.name, "job.json"), "utf8"),
          );
          jobs.push({
            jobId: receipt.jobId,
            status: receipt.status,
            title: receipt.title,
            platform: receipt.platform,
            variants: receipt.variants,
            completedAt: receipt.completedAt,
            outputCount: receipt.outputs.length,
            finalDir: receipt.finalDir,
          });
        } catch {
          // Partial or failed jobs are surfaced only when they have a receipt.
        }
      }
      return jobs
        .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
        .slice(0, limit);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}
