/**
 * video/gen/ingest.ts —— 成片入库（T-2026-0921-0002）
 *
 * 为什么必须做：供应商产物只保证保留 7 天（Higgsfield 官方口径），只存 URL = 资产会丢。
 * 流程：下载 → sha256 → 落自有媒体库（WORKLOOM_MEDIA_DIR，默认 <repo>/var/media）→
 *      asset-cms.register(kind=final_cut)（sha256 幂等去重）→ 返回 assetId 用于 render_jobs 回链。
 * 播放：签名 URL（HMAC + 过期时间），`/media/*` 路由校验后才吐文件——不做无鉴权裸目录。
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { getAppPool, getGatewayPool } from "@workloom/db";
import { register } from "@workloom/base/asset-cms";
import { newId } from "@workloom/shared";
import type { Scope } from "./db.js";
import { probeMedia } from "../media/ffmpeg.js";
import { fetchPublicProviderMedia } from "./public-provider-media.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../../../..");

export function mediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.WORKLOOM_MEDIA_DIR?.trim() || join(REPO_ROOT, "var/media");
}

export interface DownloadedMedia {
  relPath: string;
  absPath: string;
  sha256: string;
  bytes: number;
  contentType: string | null;
}

const DEFAULT_MAX_BYTES = 300 * 1024 * 1024; // 300MB：短视频上限；超限拒收，避免磁盘被写爆
type MediaStoreOptions = { workspaceId: string; maxBytes?: number };

function ingestDestination(opts: MediaStoreOptions) {
  const { workspaceId } = opts;
  if (!workspaceId || /[\/\\\0]/.test(workspaceId) || workspaceId === "." || workspaceId === "..") {
    throw new Error("工作区标识不能用作安全的媒体仓目录");
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) throw new Error("媒体下载大小上限无效");
  const relativeDirectory = join("video", workspaceId);
  const directory = join(mediaRoot(), relativeDirectory);
  return { maxBytes, relativeDirectory, directory, tempPath: join(directory, `.ingest-${randomUUID()}.tmp`) };
}

/** The same file descriptor supplies both digest and stored bytes. Never follow an input symlink. */
function readLocalSnapshot(path: string, maxBytes: number, onChunk?: (buffer: Buffer) => void): { sha256: string; bytes: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("本地产物不是普通文件");
    if (stat.size > maxBytes) throw new Error("成片超过大小上限，已拒收");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1));
    let bytes = 0;
    for (;;) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null);
      if (size === 0) break;
      bytes += size;
      if (bytes > maxBytes) throw new Error("成片超过大小上限，已拒收");
      const chunk = buffer.subarray(0, size);
      hash.update(chunk);
      onChunk?.(chunk);
    }
    if (bytes === 0) throw new Error("本地产物为空");
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    closeSync(fd);
  }
}

function publishMediaSnapshot(destination: ReturnType<typeof ingestDestination>, digest: { sha256: string; bytes: number },
  extension: string, contentType: string | null): DownloadedMedia {
  const name = `${digest.sha256}.${extension}`;
  const absPath = join(destination.directory, name);
  try {
    // Same-directory hard link publishes the complete file atomically without overwriting existing evidence.
    linkSync(destination.tempPath, absPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = readLocalSnapshot(absPath, destination.maxBytes);
    if (prior.bytes !== digest.bytes || prior.sha256 !== digest.sha256) {
      throw new Error("媒体仓现有内容地址与实际字节不符");
    }
  }
  return { relPath: join(destination.relativeDirectory, name).split(sep).join("/"), absPath, ...digest, contentType };
}

/**
 * 取供应商/本地产物到媒体库（sha256 幂等；超限拒收）。
 *
 * 支持两种来源：
 *   · `http(s)://` —— 远端供应商产物（限量流式落盘、同一份字节计算 sha256）；
 *   · `file://`    —— **本地渲染产物**（T-2026-0926-0020 新增）。
 *     为什么必须支持：手绘白板引擎是本地确定性渲染器，产物天然在磁盘上，
 *     没有远端 URL。若这里只认 http(s)，白板片就永远进不了媒资库，
 *     只能被迫写一条平行入库路径——违反"零平行实现"的口径。
 */
export async function downloadToMediaStore(
  uri: string,
  opts: MediaStoreOptions & { fetchImpl?: typeof fetch } = { workspaceId: "unknown" },
): Promise<DownloadedMedia> {
  if (/^file:\/\//i.test(uri)) return storeLocalFile(uri, opts);
  if (uri.startsWith("/")) return storeLocalFile(uri, opts);   // 本仓产物的裸绝对路径写法
  const url = new URL(uri);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("不支持该远端产物地址");
  const destination = ingestDestination(opts);
  const { maxBytes } = destination;
  // C-06 修复：大文件下载 5 分钟超时（此前无超时，慢源/断流会永久拖住整个 poll 批次）
  const signal = AbortSignal.timeout(Number(process.env.MEDIA_DOWNLOAD_TIMEOUT_MS ?? 300_000));
  const res = opts.fetchImpl
    ? await opts.fetchImpl(uri, { redirect: "error", signal })
    : await fetchPublicProviderMedia(uri, signal);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`成片下载失败：HTTP ${res.status}`);
  }
  const declared = res.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await res.body?.cancel();
    throw new Error("成片超过大小上限或声明长度无效，已拒收");
  }
  if (!res.body) throw new Error("成片下载响应为空");
  const contentType = res.headers.get("content-type");
  const ext = contentType?.includes("webm") ? "webm" : contentType?.includes("png") ? "png"
    : contentType?.includes("jpeg") || contentType?.includes("jpg") ? "jpg" : "mp4";
  const reader = res.body.getReader();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    mkdirSync(destination.directory, { recursive: true });
    file = await open(destination.tempPath, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("成片超过大小上限，已拒收");
      const chunk = Buffer.from(value);
      await file.writeFile(chunk);
      hash.update(chunk);
    }
    if (bytes === 0) throw new Error("成片下载响应为空");
    await file.sync();
    return publishMediaSnapshot(destination, { sha256: hash.digest("hex"), bytes }, ext, contentType);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined); // stream may already be closed after transport failure
    throw error;
  } finally {
    reader.releaseLock();
    if (file) {
      try { await file.close(); }
      finally { rmSync(destination.tempPath, { force: true }); }
    }
  }
}

/** 本地文件 → 媒体仓（拷贝 + sha256 + 同名幂等；超限拒收，不落半成品） */
export function storeLocalFile(
  uri: string,
  opts: MediaStoreOptions,
): DownloadedMedia {
  // 兼容三种写法：file:///abs/path、file://localhost/abs/path、裸绝对路径。
  // 裸路径支持是刻意的：调用方（白板 provider / 渲染器产物）拿到的是文件系统路径，
  // 强制先拼 file:// 反而容易拼错（相对路径会变成 URL 的 host，见 ERR_INVALID_FILE_URL_HOST）。
  const srcPath = /^file:\/\//i.test(uri) ? fileURLToPath(uri) : uri;
  const destination = ingestDestination(opts);
  const ext = srcPath.toLowerCase().endsWith(".webm") ? "webm"
    : srcPath.toLowerCase().endsWith(".png") ? "png"
      : /\.jpe?g$/i.test(srcPath) ? "jpg" : "mp4";
  mkdirSync(destination.directory, { recursive: true });
  const fd = openSync(destination.tempPath, "wx", 0o600);
  try {
    const digest = readLocalSnapshot(srcPath, destination.maxBytes, chunk => writeFileSync(fd, chunk));
    fsyncSync(fd);
    return publishMediaSnapshot(destination, digest, ext, null);
  } finally {
    try { closeSync(fd); }
    finally { rmSync(destination.tempPath, { force: true }); }
  }
}

/* ================= 成片注册（asset-cms） ================= */

export interface RegisterFinalCutInput {
  assetId: string;
  projectId?: string | null;
  sha256: string;
  /** 供应商原始 URL（保留为归因与回查线索；本地副本为准） */
  sourceUrl: string;
  localRelPath: string;
  provider: string;
  providerModel: string;
  jobId: string;
  scriptId: string;
  seconds?: number | null;
  by: string;
}

/**
 * 渲染产物登记的泛化入参（T-2026-0926-0007 规格书 §3.2）。
 *
 * 粒度修正：单镜 job 的产物是 **clip**（镜头片段），不是 final_cut（成片）。
 * 原实现把每个单镜产物都登记成 final_cut，导致"成片历史"里塞满 5 秒片段。
 * final_cut 语义从此只属于**合成成片**（交付包母版/变体、重剪产物）。
 */
export interface RegisterRenderedClipInput {
  assetId?: string;
  kind: "clip" | "final_cut";
  projectId?: string | null;
  sha256: string;
  sourceUrl: string;
  localRelPath: string;
  provider: string;
  providerModel: string;
  jobId: string;
  scriptId: string;
  seconds?: number | null;
  /** 素材名（缺省 kind + 时间由调用方补） */
  title?: string | null;
  /** 提示词冗余（检索依赖；来自 render_scripts.md） */
  prompt?: string | null;
  /** 片型（0042 扩展 explainer：口播解说片） */
  pipelineKind?: "narrative" | "marketing" | "explainer" | null;
  aspectRatio?: string | null;
  by: string;
}

export async function registerFinalCut(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: RegisterFinalCutInput,
): Promise<{ assetId: string; deduped: boolean }> {
  const r = await registerRenderedClip(app, gateway, scope, {
    ...input,
    kind: "final_cut",
  });
  return { assetId: r.assetId, deduped: r.deduped };
}

/**
 * 渲染产物登记（泛化版）：register() 之后补写 0039 媒资列（title/prompt/pipeline_kind/宽高/画幅）。
 * 补写用动态 import 引 `media/register-local` 的列助手（该模块反向依赖本文件的 mediaRoot，
 * 静态相互 import 会形成环；动态 import 在调用期解析，环被打破）。
 */
export async function registerRenderedClip(
  app: ReturnType<typeof getAppPool>,
  gateway: ReturnType<typeof getGatewayPool>,
  scope: Scope,
  input: RegisterRenderedClipInput,
): Promise<{ assetId: string; deduped: boolean }> {
  const [category, workspace, name, ...rest] = input.localRelPath.split("/");
  if (category !== "video" || workspace !== scope.workspaceId || rest.length
    || !/^[a-f0-9]{64}$/.test(input.sha256)
    || (name !== `${input.sha256}.mp4` && name !== `${input.sha256}.webm`)) {
    throw new Error("素材路径与当前工作区或内容地址不符");
  }
  const localAbs = resolveMediaPath(input.localRelPath);
  const format = localAbs.endsWith(".mp4") ? "mov" : localAbs.endsWith(".webm") ? "matroska" : null;
  if (!format) throw new Error("本地渲染产物需要 MP4 或 WebM 视频");
  if (readLocalSnapshot(localAbs, DEFAULT_MAX_BYTES).sha256 !== input.sha256) throw new Error("待登记视频字节与入库摘要不符");
  const probed = await probeMedia(localAbs, process.env, format);
  if (!probed.width || !probed.height || !probed.durationSeconds) throw new Error("渲染结果无法核实为有效的视频文件");
  const assetId = input.assetId ?? newId("VA");
  const r = await register(app, gateway, scope, {
    id: assetId,
    projectId: input.projectId ?? undefined,
    kind: input.kind,
    sourceUrl: input.sourceUrl,
    provenance: {
      source: "generated",
      provider: input.provider,
      providerModel: input.providerModel,
      jobId: input.jobId,
      scriptId: input.scriptId,
      localPath: input.localRelPath,
      ingestedAt: new Date().toISOString(),
    },
    licenseRisk: "none",
    sha256: input.sha256,
    meta: {
      durationSeconds: probed.durationSeconds,
      ...(input.seconds === null || input.seconds === undefined ? {} : { providerReportedSeconds: input.seconds }),
      localPath: input.localRelPath,
      jobId: input.jobId,
      scriptId: input.scriptId,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    },
    /** 单镜片段是"可复用的素材"而非"待发布的成片"：clip 直接 registered，成片沿用 draft 口径 */
    status: input.kind === "clip" ? "registered" : "draft",
    by: input.by,
  });
  const { applyMediaColumns } = await import("../media/columns.js");
  await applyMediaColumns(app, scope, r.asset.id, {
    title: input.title ?? null,
    prompt: input.prompt ?? null,
    pipelineKind: input.pipelineKind ?? null,
    durationSeconds: probed.durationSeconds,
    width: probed.width,
    height: probed.height,
    sourceType: "generated",
    aspectRatio: input.aspectRatio ?? null,
  }, { fillOnlyEmpty: r.deduped });
  return { assetId: r.asset.id, deduped: r.deduped };
}

/* ================= 签名媒体 URL（HMAC + 过期；播放/下载均走校验） ================= */

function secret(): string {
  const s = process.env.MEDIA_SIGNING_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!s) throw new Error("缺少 MEDIA_SIGNING_SECRET / JWT_SECRET：拒绝签发无签名媒体 URL（fail-closed）");
  return s;
}

/** 媒体签名密钥（上传凭证与播放签名共用一个秘密源；导出供 media/upload.ts 复用） */
export function mediaSigningSecret(): string {
  return secret();
}

/**
 * 路径 → workspaceId（媒体仓口径 `<大类>/<workspaceId>/<sha256><ext>`）。
 * 第二段即签发时的租户；推导失败返回空串（该路径不可能被本仓正常资源命中）。
 */
export function workspaceIdFromMediaPath(relPath: string): string {
  const segments = relPath.split("/").filter(Boolean);
  return segments.length >= 3 ? (segments[1] ?? "") : "";
}

/**
 * 签名媒体路径（HMAC + 过期时间）。
 *
 * T-2026-0926-0007 修复：签名载荷加入 workspaceId 绑定（规格书 §3.6）。
 * 原实现只签 relPath，令牌一旦被复制到同 workspace 内的另一条路径上仍可用；
 * 绑定 workspace 后，令牌的效力被收紧到「签发时那个租户的路径空间」——
 * 跨租户重放（即使猜中路径）签发与校验两侧的 ws 不同，签名必然不匹配。
 */
export function signMediaPath(relPath: string, ttlSec = 3600, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + Math.max(30, Math.floor(ttlSec));
  const ws = workspaceIdFromMediaPath(relPath);
  const sig = createHmac("sha256", secret()).update(`${ws}|${relPath}|${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifyMediaToken(relPath: string, token: string, now = Date.now()): { ok: boolean; reason?: string } {
  const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(token ?? "");
  if (!m) return { ok: false, reason: "token 格式非法" };
  const exp = Number(m[1]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return { ok: false, reason: "token 已过期" };
  const ws = workspaceIdFromMediaPath(relPath);
  const expect = createHmac("sha256", secret()).update(`${ws}|${relPath}|${exp}`).digest("base64url");
  const a = Buffer.from(expect);
  const b = Buffer.from(m[2]!);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "token 签名不匹配" };
  return { ok: true };
}

/** 解析并防目录穿越：只允许媒体根内的相对路径 */
export function resolveMediaPath(relPath: string): string {
  const root = resolve(mediaRoot());
  const abs = resolve(root, normalize(relPath).replace(/^([/\\])+/, ""));
  if (!abs.startsWith(root + sep)) throw new Error(`媒体路径越界：${relPath}`);
  return abs;
}

export function mediaUrl(relPath: string, ttlSec = 3600): string {
  const token = signMediaPath(relPath, ttlSec);
  return `/media/${relPath.split("/").map(encodeURIComponent).join("/")}?token=${token}`;
}
