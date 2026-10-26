import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { ApiError } from "../domain/errors.mjs";
import { parseStrictJson } from "../domain/strict-json.mjs";

export const RENDERER_VERSION = "pengmanager.deterministic-renderers/v1";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BINARY_SHA = "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584";
const FONT_SHA = "a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da";
const FONT_KEY = "engines/video-edit/bundles/ai-video/library/fonts/cn/NotoSansSC-Variable.ttf";
const BINARY_PIN_KEY = "engines/video-edit/bundles/ai-video/connectors/color-bridge/kit/ffmpeg-pin.json";
const FONT_PIN_KEY = "engines/video-edit/bundles/ai-video/connectors/subtitle-bridge/kit/fonts-pin.json";
const MODULE_KEYS = ["src/content-ops-worker/renderers.mjs", "src/domain/strict-json.mjs", "src/domain/errors.mjs"];
export const sourceClosureFiles = Object.freeze([...MODULE_KEYS, BINARY_PIN_KEY, FONT_PIN_KEY, FONT_KEY]);
export const RENDERER_PINS = Object.freeze({ ffmpegSha256: BINARY_SHA, fontSha256: FONT_SHA, platform: "darwin-arm64" });
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 8_000_000;
const MAX_PAGES = 12;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const failure = (code, message, details, status = 422) => new ApiError(status, code, message, details);
const invalid = (message, details) => { throw failure("RENDER_INPUT_INVALID", message, details); };
const notReady = reason => failure("ADAPTER_NOT_READY", "固定渲染依赖尚未就绪。", { reason }, 503);

function record(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(`${label} 必须是普通对象。`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !keys.includes(key) || !descriptor || !Object.hasOwn(descriptor, "value")) invalid(`${label} 含不支持的字段。`);
  }
  return value;
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} 超出允许范围。`);
  return value;
}

function list(value, min, max, label) {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) invalid(`${label} 必须是限额内的完整普通数组。`);
  return value;
}

function text(value, label, max = 12_000, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim())) invalid(`${label} 缺失或过长。`);
  if (/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) || [...value].some(char => { const point = char.codePointAt(0); return point >= 0xd800 && point <= 0xdfff; })) invalid(`${label} 含不支持的控制字符或 Unicode。`);
  return value;
}

function passiveText(value, label, max, allowEmpty = false) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || [...value].some(char => { const point = char.codePointAt(0); return point >= 0xd800 && point <= 0xdfff; })) invalid(`${label} 不是限额内的被动 Unicode 文本。`);
  return value;
}

function bytes(value, label, max = MAX_FILE_BYTES) {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > max) invalid(`${label} 必须是限额内的非空字节。`);
  // A task must not be able to change a shared backing buffer while it is hashed/rendered.
  if (value.buffer instanceof SharedArrayBuffer) invalid(`${label} 不接受共享内存。`);
  return Buffer.from(value);
}

function boundBytes(value, expected, label, max) {
  const result = bytes(value, label, max);
  if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected) || sha(result) !== expected) throw failure("ARTIFACT_HASH_MISMATCH", `${label} 字节与绑定摘要不一致。`);
  return result;
}

function output(data, mime, metadata) {
  if (data.length > MAX_OUTPUT_BYTES) throw failure("WORKSPACE_QUOTA_EXCEEDED", "真实产物超过输出字节上限。", { maxBytes: MAX_OUTPUT_BYTES }, 429);
  return { bytes: data, mime, sha256: sha(data), metadata: { rendererVersion: RENDERER_VERSION, ...metadata } };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const value of data) crc = CRC_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const a = Math.abs(prediction - left), b = Math.abs(prediction - above), c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

// Deliberately limited to completely decoded, non-interlaced 8-bit RGB/RGBA PNG.
// Palette/grayscale/APNG are refused, rather than accepting an unexamined image.
function decodePng(data) {
  if (data.length < 45 || !data.subarray(0, 8).equals(PNG_MAGIC)) throw failure("ARTIFACT_INVALID", "输入不是完整 PNG 文件。");
  let cursor = 8, header = null, ended = false, seenData = false, dataEnded = false;
  const compressed = [];
  while (cursor < data.length) {
    if (cursor + 12 > data.length) throw failure("ARTIFACT_INVALID", "PNG 数据块不完整。");
    const length = data.readUInt32BE(cursor), end = cursor + 12 + length;
    if (end > data.length) throw failure("ARTIFACT_INVALID", "PNG 数据块越界。");
    const type = data.toString("latin1", cursor + 4, cursor + 8), chunk = data.subarray(cursor + 8, cursor + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase() || crc32(data.subarray(cursor + 4, end - 4)) !== data.readUInt32BE(end - 4)) throw failure("ARTIFACT_INVALID", "PNG 数据块校验失败。");
    if (cursor === 8 && type !== "IHDR") throw failure("ARTIFACT_INVALID", "PNG 缺少首部。");
    if (type === "IHDR") {
      if (header || length !== 13) throw failure("ARTIFACT_INVALID", "PNG 首部无效。");
      const width = chunk.readUInt32BE(0), height = chunk.readUInt32BE(4);
      if (!width || !height || width > 4096 || height > 4096 || width * height > MAX_PIXELS) throw failure("WORKSPACE_QUOTA_EXCEEDED", "PNG 解码尺寸超过限额。", { maxPixels: MAX_PIXELS }, 429);
      if (chunk[8] !== 8 || ![2, 6].includes(chunk[9]) || chunk[10] !== 0 || chunk[11] !== 0 || chunk[12] !== 0) throw failure("NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "仅支持非交错 8 位 RGB/RGBA PNG。");
      header = { width, height, channels: chunk[9] === 6 ? 4 : 3 };
    } else if (type === "IDAT") {
      if (!header || dataEnded) throw failure("ARTIFACT_INVALID", "PNG 图像块顺序无效。");
      seenData = true; compressed.push(chunk);
    } else if (type === "IEND") {
      if (length !== 0 || !seenData || end !== data.length) throw failure("ARTIFACT_INVALID", "PNG 尾部或图像数据无效。");
      ended = true;
    } else {
      if (["acTL", "fcTL", "fdAT"].includes(type) || type[0] === type[0].toUpperCase()) throw failure("NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "PNG 包含不支持的图像扩展。");
      if (seenData) dataEnded = true;
    }
    cursor = end;
  }
  if (!ended || !header) throw failure("ARTIFACT_INVALID", "PNG 文件未完整结束。");
  const stride = header.width * header.channels, expected = (stride + 1) * header.height;
  let scanlines;
  try { scanlines = inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); }
  catch { throw failure("ARTIFACT_INVALID", "PNG 压缩图像不能完整解码。"); }
  if (scanlines.length !== expected) throw failure("ARTIFACT_INVALID", "PNG 解码字节数不符。");
  const pixels = Buffer.alloc(stride * header.height);
  for (let row = 0; row < header.height; row++) {
    const filter = scanlines[row * (stride + 1)];
    if (filter > 4) throw failure("ARTIFACT_INVALID", "PNG 行过滤器无效。");
    for (let column = 0; column < stride; column++) {
      const at = row * stride + column, left = column >= header.channels ? pixels[at - header.channels] : 0;
      const above = row ? pixels[at - stride] : 0, upperLeft = row && column >= header.channels ? pixels[at - stride - header.channels] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, upperLeft)][filter];
      pixels[at] = (scanlines[row * (stride + 1) + 1 + column] + predictor) & 255;
    }
  }
  return { ...header, pixels };
}

export function inspectPngBytes(value) {
  const data = bytes(value, "PNG", MAX_OUTPUT_BYTES), decoded = decodePng(data);
  return { width: decoded.width, height: decoded.height, channels: decoded.channels, bytes: data.length, sha256: sha(data), decodedPixels: decoded.width * decoded.height };
}

function fontMetrics(data) {
  // This parser only reads the pinned OpenType font's cmap/head/hhea/hmtx tables.
  const tables = new Map();
  for (let at = 12, count = data.readUInt16BE(4); count > 0; count--, at += 16) tables.set(data.toString("ascii", at, at + 4), data.readUInt32BE(at + 8));
  const units = data.readUInt16BE(tables.get("head") + 18), metricsCount = data.readUInt16BE(tables.get("hhea") + 34), hmtx = tables.get("hmtx"), cmap = tables.get("cmap");
  let format12 = null, format4 = null;
  for (let index = 0, count = data.readUInt16BE(cmap + 2); index < count; index++) {
    const row = cmap + 4 + 8 * index, platform = data.readUInt16BE(row), encoding = data.readUInt16BE(row + 2), offset = cmap + data.readUInt32BE(row + 4);
    if (platform !== 0 && !(platform === 3 && [1, 10].includes(encoding))) continue;
    if (data.readUInt16BE(offset) === 12) format12 = offset;
    if (data.readUInt16BE(offset) === 4) format4 = offset;
  }
  if (!units || !metricsCount || (!format12 && !format4)) throw notReady("font_tables_invalid");
  function glyph(point) {
    if (format12) {
      let lo = 0, hi = data.readUInt32BE(format12 + 12) - 1;
      while (lo <= hi) {
        const middle = (lo + hi) >>> 1, at = format12 + 16 + middle * 12, first = data.readUInt32BE(at), last = data.readUInt32BE(at + 4);
        if (point < first) hi = middle - 1;
        else if (point > last) lo = middle + 1;
        else return data.readUInt32BE(at + 8) + point - first;
      }
    }
    if (format4 && point <= 0xffff) {
      const count = data.readUInt16BE(format4 + 6) / 2, ends = format4 + 14, starts = ends + count * 2 + 2, deltas = starts + count * 2, ranges = deltas + count * 2;
      for (let index = 0; index < count; index++) {
        if (point > data.readUInt16BE(ends + index * 2)) continue;
        const first = data.readUInt16BE(starts + index * 2); if (point < first) return 0;
        const delta = data.readInt16BE(deltas + index * 2), range = data.readUInt16BE(ranges + index * 2);
        if (!range) return (point + delta) & 0xffff;
        const result = data.readUInt16BE(ranges + index * 2 + range + (point - first) * 2);
        return result ? (result + delta) & 0xffff : 0;
      }
    }
    return 0;
  }
  return { advance(character, size) {
    const point = character.codePointAt(0), index = glyph(point);
    if (!index) throw failure("TEXT_GLYPH_UNSUPPORTED", "固定字体不能显示输入中的某个字符。", { codePoint: `U+${point.toString(16).toUpperCase()}` });
    return data.readUInt16BE(hmtx + Math.min(index, metricsCount - 1) * 4) * size / units;
  } };
}

function wrap(value, size, width, maxLines, metrics, field) {
  const lines = [], segmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
  let current = "", advance = 0, start = 0;
  for (const { segment, index } of segmenter.segment(value)) {
    if (segment === "\n") { lines.push({ text: current, start, end: index }); current = ""; advance = 0; start = index + 1; continue; }
    let measured = 0;
    for (const character of segment) measured += metrics.advance(character, size);
    // Leave a full em for glyph overhangs and use a conservative advance margin.
    if (measured * 1.03 > width - size) throw failure("TEXT_OVERFLOW", "文本中的字形超过模板宽度。", { field });
    if (current && (advance + measured) * 1.03 > width - size) {
      lines.push({ text: current, start, end: index }); current = ""; advance = 0; start = index;
    }
    current += segment; advance += measured;
  }
  lines.push({ text: current, start, end: value.length });
  if (lines.length > maxLines) throw failure("TEXT_OVERFLOW", "完整文本超过模板可读容量，请明确分页或修改文案。", { field, maxLines, actualLines: lines.length });
  return { field, text: value, unit: "utf16", sourceRange: { start: 0, end: value.length }, lines };
}

function cardInput(input, forcedLayout) {
  record(input, ["layoutId", "title", "body", "footer", "sourceImages", "width", "height"], "卡片输入");
  const layoutId = forcedLayout ?? input.layoutId ?? "editorial-card-v1";
  if (!["editorial-card-v1", "editorial-cover-v1", "document-page-v1"].includes(layoutId) || (forcedLayout && input.layoutId && input.layoutId !== forcedLayout)) invalid("模板不受支持。");
  const [defaultWidth, defaultHeight] = layoutId === "editorial-cover-v1" ? [1280, 720] : layoutId === "document-page-v1" ? [1240, 1754] : [1080, 1440];
  const width = input.width ?? defaultWidth, height = input.height ?? defaultHeight;
  if (width !== defaultWidth || height !== defaultHeight) invalid("尺寸必须与固定模板一致。", { layoutId, width: defaultWidth, height: defaultHeight });
  const title = text(input.title, "标题", 1000), body = text(input.body, "正文", 12_000), footer = text(input.footer ?? "", "页脚", 600, true);
  const sourceImages = list(input.sourceImages ?? [], 0, 2, "真实截图").map(image => {
    record(image, ["bytes", "sha256", "alt"], "截图");
    const imageBytes = boundBytes(image.bytes, image.sha256, "截图");
    const decoded = decodePng(imageBytes);
    return { bytes: imageBytes, sha256: sha(imageBytes), alt: text(image.alt, "截图替代文字", 600), width: decoded.width, height: decoded.height };
  });
  return { layoutId, title, body, footer, width, height, sourceImages };
}

async function regularBytes(path, limit) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw notReady("dependency_file_invalid");
    const result = await handle.readFile();
    if (result.length !== stat.size) throw notReady("dependency_changed");
    return result;
  } finally { if (handle) await handle.close(); }
}

async function dependencies(ffmpegPath) {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw notReady("unsupported_platform");
  let executable, font, binaryPinBytes, fontPinBytes, moduleBytes;
  try {
    [executable, font, binaryPinBytes, fontPinBytes, moduleBytes] = await Promise.all([
      regularBytes(ffmpegPath, 80 * 1024 * 1024), regularBytes(join(ROOT, FONT_KEY), 25 * 1024 * 1024),
      regularBytes(join(ROOT, BINARY_PIN_KEY), 64 * 1024), regularBytes(join(ROOT, FONT_PIN_KEY), 256 * 1024),
      Promise.all(MODULE_KEYS.map(key => regularBytes(join(ROOT, key), 512 * 1024)))
    ]);
  } catch (error) { if (error instanceof ApiError) throw error; throw notReady("dependency_missing_or_unreadable"); }
  let binaryPin, fontPin;
  try { binaryPin = parseStrictJson(binaryPinBytes); fontPin = parseStrictJson(fontPinBytes); }
  catch { throw notReady("pin_manifest_invalid"); }
  if (!binaryPin || typeof binaryPin !== "object" || Array.isArray(binaryPin) || !fontPin || typeof fontPin !== "object" || Array.isArray(fontPin) || !Array.isArray(fontPin.fonts)) throw notReady("pin_manifest_invalid");
  if (binaryPin.targets?.["darwin-arm64"]?.ffmpeg?.sha256 !== BINARY_SHA || fontPin.fonts.find(entry => entry && typeof entry === "object" && entry.id === "noto-sans-sc-variable")?.sha256 !== FONT_SHA) throw notReady("pin_manifest_changed");
  if (sha(executable) !== BINARY_SHA || executable.readUInt32LE(0) !== 0xfeedfacf || executable.readUInt32LE(4) !== 0x0100000c) throw notReady("binary_pin_or_arch_mismatch");
  if (sha(font) !== FONT_SHA) throw notReady("font_pin_mismatch");
  const sources = [
    ...MODULE_KEYS.map((key, index) => ({ key, bytes: moduleBytes[index].length, sha256: sha(moduleBytes[index]) })),
    { key: BINARY_PIN_KEY, bytes: binaryPinBytes.length, sha256: sha(binaryPinBytes) },
    { key: FONT_PIN_KEY, bytes: fontPinBytes.length, sha256: sha(fontPinBytes) },
    { key: FONT_KEY, bytes: font.length, sha256: FONT_SHA },
    { key: "owner-configured-ffmpeg", bytes: executable.length, sha256: BINARY_SHA }
  ];
  const closure = { schema: "pengmanager.renderer-source-closure/v1", rendererVersion: RENDERER_VERSION, platform: "darwin-arm64", sources };
  return { executable, font, metrics: fontMetrics(font), sourceClosure: { ...closure, sha256: sha(Buffer.from(JSON.stringify(closure))) } };
}

function aborted(signal) { if (signal?.aborted) throw failure("RENDER_CANCELLED", "渲染已取消。", undefined, 409); }

async function runFixed(executable, args, cwd, timeoutMs, signals = []) {
  if (signals.some(signal => signal.aborted)) throw failure("RENDER_CANCELLED", "底层进程启动前已取消。", { executed: false, dryRun: false, nativeProcesses: 0, elapsedMs: 0 }, 409);
  return new Promise((resolve, reject) => {
    let settled = false, timer, total = 0, stdout = [], reason = null, didSpawn = false;
    const startedAt = Date.now();
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
    const stop = code => { reason ??= code; child.kill("SIGKILL"); };
    const cancel = () => stop("RENDER_CANCELLED");
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); for (const signal of signals) signal.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(result);
    };
    for (const signal of signals) signal.addEventListener("abort", cancel, { once: true });
    if (signals.some(signal => signal.aborted)) cancel();
    timer = setTimeout(() => stop("RENDER_TIMEOUT"), timeoutMs);
    child.stdout.on("data", chunk => { total += chunk.length; if (total > 256 * 1024) stop("RENDER_FAILED"); else stdout.push(chunk); });
    child.stderr.on("data", chunk => { total += chunk.length; if (total > 256 * 1024) stop("RENDER_FAILED"); });
    child.on("spawn", () => { didSpawn = true; });
    const execution = () => ({ executed: didSpawn, dryRun: false, nativeProcesses: didSpawn ? 1 : 0, elapsedMs: Date.now() - startedAt });
    child.on("error", () => finish(failure("ADAPTER_NOT_READY", "固定渲染进程不可用。", { reason: "native_process_unavailable", ...execution() }, 503)));
    child.on("close", code => {
      if (reason) return finish(failure(reason, "固定渲染进程未完成。", execution(), reason === "RENDER_CANCELLED" ? 409 : 422));
      if (code !== 0) return finish(failure("RENDER_FAILED", "固定渲染进程失败，未产生可提交成品。", { exitCode: code, ...execution() }));
      finish(null, { stdout: Buffer.concat(stdout).toString("utf8"), ...execution(), exitCode: 0 });
    });
  });
}

async function privateParent(workRoot) {
  const directory = workRoot ?? await realpath(tmpdir());
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (workRoot && ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())))) throw failure("WORKSPACE_PRIVATE_DIRECTORY_REQUIRED", "渲染根目录必须为当前用户的私有普通目录。", undefined, 403);
  return directory;
}

async function withWorkspace(config, deps, operation) {
  aborted(config.signal);
  if (typeof config.runNativeCall !== "function") throw notReady("local_dispatch_hook_required");
  const parent = await privateParent(config.workRoot), directory = await mkdtemp(join(parent, "pm-content-render-"));
  let used = 0;
  const deadline = Date.now() + config.maxRenderMs;
  const charge = length => { used += length; if (used > config.maxTempBytes) throw failure("WORKSPACE_QUOTA_EXCEEDED", "渲染临时文件超过本次限额。", { maxBytes: config.maxTempBytes }, 429); };
  const stagedFiles = [];
  const write = async (name, data, executable = false) => {
    charge(data.length); aborted(config.signal);
    const path = join(directory, name); let handle;
    try { handle = await open(path, "wx", executable ? 0o700 : 0o600); await handle.writeFile(data); await handle.sync(); }
    finally { if (handle) await handle.close(); }
    if (executable) await chmod(path, 0o700);
    stagedFiles.push({ key: name, bytes: data.length, sha256: sha(data) });
    return path;
  };
  try {
    // Execute an immutable, verified private snapshot, closing the hash-to-exec path race.
    const executable = await write("ffmpeg", deps.executable, true);
    await write("font.ttf", deps.font);
    const result = await operation({ directory, write, executable, charge, run: async (callKey, args) => {
      aborted(config.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw failure("RENDER_TIMEOUT", "渲染超过本次期限。");
      const requestHash = sha(Buffer.from(JSON.stringify({ schema: "pengmanager.fixed-render-call/v1", callKey, sourceClosureHash: deps.sourceClosure.sha256, args, inputFiles: stagedFiles })));
      let invoked = false, actualResult;
      const result = await config.runNativeCall({ callKey, requestHash, upperBound: { inputTokens: 0, outputTokens: 0, renderSeconds: Math.ceil(remaining / 1000), tempBytes: config.maxTempBytes, nativeProcesses: 1 } }, async (runOptions = {}) => {
        record(runOptions, ["signal"], "底层执行选项");
        if (runOptions.signal !== undefined && !(runOptions.signal instanceof AbortSignal)) invalid("底层取消信号无效。");
        if (invoked) throw failure("NATIVE_DUPLICATE_DISPATCH", "同一底层派发许可不能启动第二次进程。", undefined, 409);
        invoked = true;
        const allowedMs = deadline - Date.now();
        if (allowedMs <= 0) throw failure("RENDER_TIMEOUT", "派发前渲染期限已到。");
        actualResult = await runFixed(executable, args, directory, allowedMs, [...new Set([config.signal, runOptions.signal].filter(Boolean))]);
        return actualResult;
      });
      if (!actualResult || result?.stdout !== actualResult.stdout || result?.executed !== true || result?.dryRun !== false || result?.nativeProcesses !== 1 || result?.exitCode !== 0) throw failure("NATIVE_EXECUTION_UNVERIFIED", "固定渲染调用未返回真实执行结果。");
      return result.stdout;
    } });
    aborted(config.signal);
    return { ...result, metadata: { ...result.metadata, temporaryBytes: used } };
  } finally { await rm(directory, { recursive: true, force: false }); }
}

async function cardInWorkspace(card, deps, workspace, index = 0) {
  const { width, height, sourceImages } = card, compact = card.layoutId === "editorial-cover-v1", unit = width / 1080;
  const pad = Math.round(72 * unit), titleSize = Math.round((compact ? 52 : 64) * unit), bodySize = Math.round((compact ? 26 : 34) * unit), footerSize = Math.round(23 * unit), altSize = Math.round(22 * unit);
  const contentWidth = width - 2 * pad, titleY = Math.round(118 * unit), titleStep = Math.ceil(titleSize * 1.55);
  const title = wrap(card.title, titleSize, contentWidth, compact ? 2 : 3, deps.metrics, "title");
  const bodyY = titleY + title.lines.length * titleStep + Math.round(24 * unit), bodyStep = Math.ceil(bodySize * 1.7);
  const footerY = height - Math.round(105 * unit), imageTop = sourceImages.length ? Math.round(height * (compact ? 0.56 : 0.54)) : null;
  const bodyBottom = imageTop ? imageTop - Math.round(30 * unit) : footerY - Math.round(54 * unit);
  const body = wrap(card.body, bodySize, contentWidth, Math.max(0, Math.floor((bodyBottom - bodyY) / bodyStep)), deps.metrics, "body");
  const footer = wrap(card.footer, footerSize, contentWidth, 2, deps.metrics, "footer");
  const coverages = [title, body, footer], filters = [];
  const color = "0xf6f8fc", args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-filter_complex_threads", "1", "-threads", "1", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:r=1:d=1`];
  const draws = [`drawbox=x=${pad}:y=${Math.round(72 * unit)}:w=${Math.round(94 * unit)}:h=${Math.round(9 * unit)}:color=0x148a91:t=fill`];
  let lineIndex = 0;
  async function drawLines(coverage, size, y, step, colorHex) {
    for (let line = 0; line < coverage.lines.length; line++) {
      const lineText = coverage.lines[line].text; if (!lineText) continue;
      const name = `page-${index}-line-${lineIndex++}.txt`;
      await workspace.write(name, Buffer.from(lineText, "utf8"));
      draws.push(`drawtext=fontfile=font.ttf:textfile=${name}:expansion=none:fontsize=${size}:fontcolor=${colorHex}:borderw=${coverage.field === "title" ? 2 : 1}:bordercolor=${colorHex}:x=${pad}:y=${y + line * step}`);
    }
  }
  await drawLines(title, titleSize, titleY, titleStep, "0x152c48");
  await drawLines(body, bodySize, bodyY, bodyStep, "0x30445c");
  await drawLines(footer, footerSize, footerY, Math.ceil(footerSize * 1.65), "0x52677f");
  filters.push(`[0:v]${draws.join(",")}[base]`);
  let previous = "base";
  const gap = Math.round(24 * unit), slotWidth = Math.floor((contentWidth - gap * (sourceImages.length - 1)) / Math.max(1, sourceImages.length));
  const imageHeight = imageTop ? footerY - imageTop - Math.round(115 * unit) : 0;
  if (sourceImages.length && imageHeight < 80) throw failure("TEXT_OVERFLOW", "该模板没有足够的完整截图空间。");
  const imageMetadata = [];
  for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex++) {
    const image = sourceImages[imageIndex], name = `page-${index}-source-${imageIndex}.png`, x = pad + imageIndex * (slotWidth + gap);
    await workspace.write(name, image.bytes);
    args.push("-protocol_whitelist", "file", "-i", name);
    const alt = wrap(image.alt, altSize, slotWidth, 2, deps.metrics, `sourceImages[${imageIndex}].alt`);
    coverages.push(alt);
    const altFilters = [];
    for (let line = 0; line < alt.lines.length; line++) {
      if (!alt.lines[line].text) continue;
      const altName = `page-${index}-alt-${imageIndex}-${line}.txt`;
      await workspace.write(altName, Buffer.from(alt.lines[line].text));
      altFilters.push(`drawtext=fontfile=font.ttf:textfile=${altName}:expansion=none:fontsize=${altSize}:fontcolor=0x52677f:borderw=1:bordercolor=0x52677f:x=${x}:y=${imageTop + imageHeight + Math.round(20 * unit) + line * Math.ceil(altSize * 1.65)}`);
    }
    const next = `withimage${imageIndex}`;
    filters.push(`[${imageIndex + 1}:v]scale=w=${slotWidth}:h=${imageHeight}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=${slotWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:color=0xe4eaf2[img${imageIndex}]`);
    filters.push(`[${previous}][img${imageIndex}]overlay=x=${x}:y=${imageTop}:eof_action=repeat${altFilters.length ? `,${altFilters.join(",")}` : ""}[${next}]`);
    previous = next;
    imageMetadata.push({ index: imageIndex, sha256: image.sha256, bytes: image.bytes.length, sourceWidth: image.width, sourceHeight: image.height, alt: image.alt, fit: "contain", box: { x, y: imageTop, width: slotWidth, height: imageHeight } });
  }
  filters.push(`[${previous}]format=rgb24[out]`);
  const scriptName = `page-${index}-filters.txt`, resultName = `page-${index}.png`;
  await workspace.write(scriptName, Buffer.from(filters.join(";\n")));
  args.push("-filter_complex_script", scriptName, "-map", "[out]", "-frames:v", "1", "-c:v", "png", "-threads:v", "1", "-map_metadata", "-1", "-f", "image2", resultName);
  await workspace.run(`${card.layoutId === "document-page-v1" ? "document.page" : "image.compose"}.${index}`, args);
  const path = join(workspace.directory, resultName), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw failure("ARTIFACT_INVALID", "渲染器没有产生限额内的真实 PNG。");
  workspace.charge(stat.size);
  const resultBytes = await regularBytes(path, MAX_FILE_BYTES), decoded = decodePng(resultBytes);
  if (decoded.width !== width || decoded.height !== height || decoded.channels !== 3) throw failure("ARTIFACT_INVALID", "渲染输出的真实尺寸或像素类型不符。");
  return output(resultBytes, "image/png", { layoutId: card.layoutId, width, height, textCoverage: coverages, sourceImages: imageMetadata, sourceClosureHash: deps.sourceClosure.sha256, fontSha256: FONT_SHA, binarySha256: BINARY_SHA });
}

function pdfFromPages(pages, title) {
  const objects = [null, null], kids = [];
  const stream = (dictionary, data) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from("\nendstream")]);
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index], image = decodePng(page.bytes), rgb = Buffer.alloc(image.width * image.height * 3);
    for (let pixel = 0; pixel < image.width * image.height; pixel++) {
      const alpha = image.channels === 4 ? image.pixels[pixel * 4 + 3] : 255;
      for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = Math.round((image.pixels[pixel * image.channels + channel] * alpha + 255 * (255 - alpha)) / 255);
    }
    const imageId = objects.length + 1;
    // The passive storage contract scans PDF syntax conservatively. Declare an
    // ASCIIHex wrapper so opaque compressed samples cannot look like PDF names.
    const encoded = Buffer.from(`${deflateSync(rgb, { level: 9 }).toString("hex")}>`, "ascii");
    objects.push(stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode]`, encoded));
    const width = image.width / 2, height = image.height / 2, contentId = objects.length + 1;
    objects.push(stream("", Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im${index} Do\nQ\n`)));
    const pageId = objects.length + 1;
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`));
    kids.push(`${pageId} 0 R`);
  }
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`);
  const infoId = objects.length + 1, titleBytes = Buffer.from(`\ufeff${title}`, "utf16le"); titleBytes.swap16();
  objects.push(Buffer.from(`<< /Title <${titleBytes.toString("hex")}> /Producer (PengManager deterministic renderers v1) >>`));
  const chunks = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets = [0];
  let position = chunks[0].length;
  for (let index = 0; index < objects.length; index++) {
    offsets.push(position);
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), objects[index], Buffer.from("\nendobj\n")]);
    chunks.push(object); position += object.length;
  }
  const xref = position;
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export async function renderVtt(input) {
  record(input, ["durationMs", "cues", "locale"], "字幕输入");
  const durationMs = integer(input.durationMs, 1, 86_400_000, "真实时长");
  if (input.locale !== undefined && !["zh-CN", "en-US"].includes(input.locale)) invalid("字幕语言不受支持。");
  if (!Array.isArray(input.cues) || input.cues.length < 1 || input.cues.length > 2000) throw failure("CAPTION_TIMING_REQUIRED", "字幕需要限额内的真实时间映射。");
  list(input.cues, 1, 2000, "字幕时间映射");
  let previousEnd = 0;
  const timestamp = milliseconds => `${String(Math.floor(milliseconds / 3_600_000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")}.${String(milliseconds % 1000).padStart(3, "0")}`;
  const cues = input.cues.map((cue, index) => {
    record(cue, ["startMs", "endMs", "text"], "字幕 cue");
    const startMs = integer(cue.startMs, 0, durationMs, "字幕开始时间"), endMs = integer(cue.endMs, 1, durationMs, "字幕结束时间"), cueText = text(cue.text, "字幕文字", 5000);
    if (startMs >= endMs || startMs < previousEnd || /^\s*\n|\n\s*$|\n\s*\n|-->/u.test(cueText)) invalid("字幕时间必须有序且不重叠，文字不能包含块分隔符或时间箭头。");
    previousEnd = endMs;
    return { index, startMs, endMs, text: cueText };
  });
  const data = Buffer.from(`WEBVTT\n\n${cues.map(cue => `${cue.index + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${cue.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n`).join("\n")}\n`);
  if (data.length > 1024 * 1024) throw failure("WORKSPACE_QUOTA_EXCEEDED", "VTT 字节超过限额。", undefined, 429);
  return output(data, "text/vtt", { locale: input.locale ?? null, durationMs, cueCount: cues.length, cues, timingSource: "caller_supplied_timeline", timingValidation: "bounded_ordered_nonoverlapping", alignmentPerformed: false });
}

const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
function notebookText(value, label) {
  if (typeof value === "string") return passiveText(value, label, 100_000, true);
  list(value, 0, 4096, label);
  if (value.some(part => typeof part !== "string")) invalid(`${label} 必须是文本或文本数组。`);
  return passiveText(value.join(""), label, 100_000, true);
}

export async function previewNotebook(input) {
  record(input, ["bytes", "sha256"], "notebook 输入");
  const notebookBytes = boundBytes(input.bytes, input.sha256, "notebook", 1024 * 1024);
  const notebook = parseStrictJson(notebookBytes, { maxBytes: 1024 * 1024, maxDepth: 32, maxString: 100_000, maxArray: 4096 });
  record(notebook, ["nbformat", "nbformat_minor", "metadata", "cells"], "notebook");
  if (notebook.nbformat !== 4 || !Number.isSafeInteger(notebook.nbformat_minor) || notebook.nbformat_minor < 0 || notebook.nbformat_minor > 99 || !notebook.metadata || typeof notebook.metadata !== "object" || Array.isArray(notebook.metadata) || !Array.isArray(notebook.cells) || notebook.cells.length < 1 || notebook.cells.length > 300) invalid("仅支持非空、限额内的 nbformat 4 notebook。");
  let totalOutputs = 0;
  const coverage = [];
  const body = notebook.cells.map((cell, index) => {
    record(cell, ["cell_type", "metadata", "source", "id", "execution_count", "outputs", "attachments"], "notebook 单元格");
    if (!["code", "markdown", "raw"].includes(cell.cell_type) || !cell.metadata || typeof cell.metadata !== "object" || Array.isArray(cell.metadata)) invalid("notebook 单元格类型或元数据无效。");
    if (cell.attachments !== undefined) {
      if (!cell.attachments || typeof cell.attachments !== "object" || Array.isArray(cell.attachments)) invalid("notebook attachments 必须是普通对象。");
      if (Object.keys(cell.attachments).length) throw failure("NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "静态预览暂不支持 notebook 内嵌 attachments。");
    }
    if (cell.id !== undefined) text(cell.id, "单元格 ID", 128);
    const source = notebookText(cell.source, "单元格原文"), outputs = [];
    if (cell.cell_type === "code") {
      if (cell.execution_count !== null && (!Number.isSafeInteger(cell.execution_count) || cell.execution_count < 0)) invalid("代码单元格执行计数无效。");
      if (!Array.isArray(cell.outputs) || cell.outputs.length > 100) invalid("代码单元格输出无效。");
      for (const item of cell.outputs) {
        if (!item || typeof item !== "object" || Array.isArray(item)) invalid("notebook 输出必须是普通对象。");
        totalOutputs++;
        if (totalOutputs > 500) invalid("notebook 输出项过多。");
        if (item.output_type === "stream") {
          record(item, ["output_type", "name", "text"], "notebook stream");
          if (!["stdout", "stderr"].includes(item.name)) invalid("notebook stream 名称无效。");
          outputs.push(`<pre>${escapeHtml(notebookText(item.text, "已有输出"))}</pre>`);
        } else if (item.output_type === "error") {
          record(item, ["output_type", "ename", "evalue", "traceback"], "notebook error");
          outputs.push(`<pre>${escapeHtml(`${text(item.ename, "错误名", 500)}: ${text(item.evalue, "错误文本", 5000, true)}\n${notebookText(item.traceback, "已有错误输出")}`)}</pre>`);
        } else if (["display_data", "execute_result"].includes(item.output_type)) {
          record(item, ["output_type", "data", "metadata", ...(item.output_type === "execute_result" ? ["execution_count"] : [])], "notebook display");
          if (!item.metadata || typeof item.metadata !== "object" || Array.isArray(item.metadata)) invalid("notebook 已有输出元数据无效。");
          if (item.output_type === "execute_result" && item.execution_count !== null && (!Number.isSafeInteger(item.execution_count) || item.execution_count < 0)) invalid("已有输出的执行计数无效。");
          if (!item.data || typeof item.data !== "object" || Array.isArray(item.data)) invalid("notebook 输出 MIME 必须是普通对象。");
          if (Object.keys(item.data).some(mime => mime !== "text/plain")) throw failure("NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED", "notebook 富媒体输出需作为独立已验证附件提交；静态预览仅接受 text/plain。");
          record(item.data, ["text/plain"], "notebook 输出 MIME");
          if (Object.keys(item.data).length < 1) invalid("notebook 输出 MIME 不能为空。");
          for (const value of Object.values(item.data)) outputs.push(`<pre>${escapeHtml(notebookText(value, "已有文本输出"))}</pre>`);
        } else throw failure("NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "notebook 含不支持的已有输出类型。");
      }
    } else if (cell.outputs !== undefined || cell.execution_count !== undefined) invalid("非代码单元格不能伪装代码执行输出。");
    coverage.push({ index, cellType: cell.cell_type, sourceSha256: sha(Buffer.from(source)), sourceCharacters: source.length, suppliedOutputCount: cell.cell_type === "code" ? cell.outputs.length : 0, displayedOutputRepresentations: outputs.length });
    return `<section><h2>Cell ${index + 1} · ${cell.cell_type}</h2><pre>${escapeHtml(source)}</pre>${outputs.length ? `<h3>Supplied outputs · execution unverified</h3>${outputs.join("")}` : ""}</section>`;
  }).join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Notebook static preview</title><style>body{margin:0 auto;padding:28px;max-width:1080px;background:#f6f8fc;color:#152c48;font:16px/1.6 system-ui,sans-serif}section{margin:24px 0;padding:20px;background:white;border:1px solid #d9e2ee;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.65 ui-monospace,monospace}img{max-width:100%;height:auto}h1,h2,h3{line-height:1.3}h2{font-size:20px}h3{font-size:15px}</style></head><body><h1>Notebook static preview</h1><p>executeCode: false · No cell was executed by this renderer. Supplied results remain unverified.</p>${body}</body></html>`;
  return output(Buffer.from(html), "text/html; charset=utf-8", { sourceSha256: sha(notebookBytes), executeCode: false, executionStatus: "not_executed", suppliedResultsStatus: "unverified", cellCount: notebook.cells.length, suppliedOutputCount: totalOutputs, coverage, omittedOutputs: 0 });
}

const NATIVE_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "text/x-diff", "text/javascript", "text/x-python", "application/json", "application/x-ipynb+json", "application/x-safetensors", "image/png"]);
const NATIVE_ROLES = new Set(["readme", "license", "code", "diff", "dataset", "model", "notebook", "demo", "run_log", "screenshot"]);
const ROLE_MIMES = {
  readme: ["text/plain", "text/markdown"], license: ["text/plain", "text/markdown"], code: ["text/plain", "text/javascript", "text/x-python", "application/json"], diff: ["text/x-diff"],
  dataset: ["text/csv", "application/json"], model: ["application/x-safetensors"], notebook: ["application/x-ipynb+json", "application/json"],
  demo: ["text/plain", "text/javascript", "text/x-python", "application/json"], run_log: ["text/plain", "application/json"], screenshot: ["image/png"]
};
const NATIVE_REQUIREMENTS = { repository_change: ["readme", "diff"], model_card: ["readme", "model", "license"], dataset_card: ["readme", "dataset", "license"], notebook: ["notebook"], demo_bundle: ["readme", "demo", "license"] };

function passiveTensorInspection(data) {
  if (data.length < 10) throw failure("ARTIFACT_INVALID", "模型来源缺少真实 safetensors 文件头。");
  const length = data.readBigUInt64LE(0);
  if (length < 2n || length > 1048576n || length > BigInt(data.length - 8) || data[8] !== 0x7b) throw failure("ARTIFACT_INVALID", "safetensors 头部长度或起始字节无效。");
  const header = parseStrictJson(data.subarray(8, 8 + Number(length)), { maxBytes: 1048576, maxDepth: 8, maxArray: 4096, maxString: 10_000 });
  if (!header || typeof header !== "object" || Array.isArray(header)) throw failure("ARTIFACT_INVALID", "safetensors 头部必须是对象。");
  const widths = { F16: 2, F32: 4, F64: 8, I8: 1, I16: 2, I32: 4, I64: 8, U8: 1, U16: 2, U32: 4, U64: 8 }, ranges = [];
  let elements = 0n;
  for (const [name, tensor] of Object.entries(header)) {
    if (name === "__metadata__") {
      if (!tensor || typeof tensor !== "object" || Array.isArray(tensor) || Object.values(tensor).some(value => typeof value !== "string")) throw failure("ARTIFACT_INVALID", "safetensors 元数据必须为字符串映射。");
      continue;
    }
    if (!name || name.length > 1024 || !tensor || typeof tensor !== "object" || Array.isArray(tensor) || Object.keys(tensor).sort().join(",") !== "data_offsets,dtype,shape" || typeof tensor.dtype !== "string" || !Object.hasOwn(widths, tensor.dtype) || !Array.isArray(tensor.shape) || tensor.shape.length > 16 || tensor.shape.some(value => !Number.isSafeInteger(value) || value < 0 || value > 281474976710655) || !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2 || tensor.data_offsets.some(value => !Number.isSafeInteger(value) || value < 0)) throw failure("ARTIFACT_INVALID", "safetensors 张量声明无效或类型未支持。");
    const count = tensor.shape.reduce((total, value) => total * BigInt(value), 1n), [start, end] = tensor.data_offsets;
    if (end < start || end > data.length - 8 - Number(length) || BigInt(end - start) !== count * BigInt(widths[tensor.dtype])) throw failure("ARTIFACT_INVALID", "safetensors 张量实际字节与形状不符。");
    elements += count; ranges.push({ start, end });
  }
  if (!ranges.length || !elements) throw failure("ARTIFACT_MISSING", "模型来源必须包含真实非空张量字节。");
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  let end = 0;
  for (const range of ranges) { if (range.start !== end) throw failure("ARTIFACT_INVALID", "safetensors 缓冲区包含重叠或空洞。"); end = range.end; }
  if (end !== data.length - 8 - Number(length)) throw failure("ARTIFACT_INVALID", "safetensors 存在未登记尾部字节。");
  return { tensorCount: ranges.length, elements: Number(elements), loaded: false, trainingVerified: false, inferenceVerified: false };
}

export async function prepareNativeManifest(input) {
  record(input, ["kind", "title", "files", "baseCommit", "tag", "executeCode", "deploy"], "作品输入");
  if (typeof input.kind !== "string" || !Object.hasOwn(NATIVE_REQUIREMENTS, input.kind)) invalid("作品类型不受支持。");
  const title = text(input.title, "作品标题", 1000);
  if (input.executeCode !== undefined && input.executeCode !== false || input.deploy !== undefined && input.deploy !== false) invalid("作品准备不执行代码或部署。");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100) throw failure("ARTIFACT_MISSING", "作品需要真实文件。");
  list(input.files, 1, 100, "作品文件");
  if (input.kind === "repository_change" && (typeof input.baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(input.baseCommit))) invalid("仓库变更需要准确 baseCommit。");
  if (input.kind !== "repository_change" && (input.baseCommit !== undefined || input.tag !== undefined)) invalid("该作品不接受仓库变更设置。");
  if (input.tag !== undefined && input.tag !== null) text(input.tag, "tag", 128);
  const keys = new Set(), roles = new Set(); let totalBytes = 0;
  const fileData = [];
  const files = [];
  for (const file of input.files) {
    record(file, ["key", "role", "mime", "bytes", "sha256"], "作品文件");
    if (typeof file.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(file.key) || keys.has(file.key)) invalid("作品文件键必须唯一且不含路径。");
    if (!NATIVE_ROLES.has(file.role) || !NATIVE_MIMES.has(file.mime)) throw failure("NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "作品文件类型或角色不受支持。");
    if (!ROLE_MIMES[file.role].includes(file.mime)) invalid("作品文件 MIME 与角色不一致。");
    const data = boundBytes(file.bytes, file.sha256, "作品文件");
    totalBytes += data.length; if (totalBytes > MAX_OUTPUT_BYTES) throw failure("WORKSPACE_QUOTA_EXCEEDED", "作品总字节超过限额。", undefined, 429);
    let inspection = null;
    if (file.role === "notebook") {
      if (!["application/x-ipynb+json", "application/json"].includes(file.mime)) invalid("notebook 文件 MIME 不符。");
      await previewNotebook({ bytes: data, sha256: file.sha256 });
    } else if (file.mime === "image/png") decodePng(data);
    else if (file.mime === "application/x-safetensors") inspection = passiveTensorInspection(data);
    else if (["application/json"].includes(file.mime)) parseStrictJson(data, { maxBytes: MAX_FILE_BYTES });
    else if (file.mime.startsWith("text/")) {
      let decoded;
      try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { invalid("作品文本必须是有效 UTF-8。"); }
      passiveText(decoded, "作品文件正文", MAX_FILE_BYTES);
      if (file.role === "diff" && (!/^diff --git |^--- /m.test(decoded) || !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(decoded) || !/^[+-][^+-]/m.test(decoded))) invalid("仓库 diff 必须有实际统一变更内容。");
    }
    keys.add(file.key); roles.add(file.role);
    files.push({ key: file.key, role: file.role, mime: file.mime, bytes: data.length, sha256: sha(data), ...(inspection ? { inspection } : {}) });
    fileData.push({ key: file.key, role: file.role, mime: file.mime, sha256: sha(data), bytes: data });
  }
  const missingRoles = NATIVE_REQUIREMENTS[input.kind].filter(role => !roles.has(role));
  if (missingRoles.length) throw failure("ARTIFACT_MISSING", "作品缺少必需的真实文件角色。", { missingRoles });
  const manifest = { schema: "pengmanager.native-preparation-manifest/v1", kind: input.kind, title, ...(input.kind === "repository_change" ? { baseCommit: input.baseCommit, tag: input.tag ?? null } : {}), executeCode: false, deploy: false, executionStatus: "not_executed", suppliedResultsStatus: "unverified", files };
  return { ...output(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), "application/json", { kind: input.kind, actualFileCount: files.length, totalFileBytes: totalBytes, executeCode: false, deploy: false, executionStatus: "not_executed", files }), files: fileData };
}

// Only the local owner configures these paths/limits. They never come from a
// TaskBlueprint, model response, notebook, source text or arbitrary tool config.
export function createRenderers(options = {}) {
  record(options, ["ffmpegPath", "workRoot", "signal", "maxRenderMs", "maxTempBytes", "runNativeCall"], "本机渲染配置");
  const ffmpegPath = options.ffmpegPath ?? join(homedir(), ".local", "bin", "ffmpeg");
  if (typeof ffmpegPath !== "string" || !isAbsolute(ffmpegPath) || (options.workRoot !== undefined && (typeof options.workRoot !== "string" || !isAbsolute(options.workRoot)))) invalid("owner 配置必须使用准确本机绝对路径。");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) invalid("取消信号无效。");
  if (options.runNativeCall !== undefined && typeof options.runNativeCall !== "function") invalid("本机派发钩子无效。");
  const config = { ffmpegPath, workRoot: options.workRoot, signal: options.signal, runNativeCall: options.runNativeCall, maxRenderMs: integer(options.maxRenderMs ?? 30_000, 1, 60_000, "渲染期限"), maxTempBytes: integer(options.maxTempBytes ?? 128 * 1024 * 1024, 1, 512 * 1024 * 1024, "临时字节上限") };
  return Object.freeze({
    async readiness(readinessOptions = {}) {
      record(readinessOptions, ["probe"], "就绪检查选项");
      if (readinessOptions.probe !== undefined && typeof readinessOptions.probe !== "boolean") invalid("probe 必须为布尔值。");
      try {
        const deps = await dependencies(config.ffmpegPath);
        if (typeof config.runNativeCall !== "function") throw notReady("local_dispatch_hook_required");
        await privateParent(config.workRoot); aborted(config.signal);
        let temporaryBytes = 0;
        if (readinessOptions.probe === true) {
          const result = await withWorkspace(config, deps, async workspace => {
            const filters = await workspace.run("readiness.filters", ["-hide_banner", "-filters"]);
            for (const filter of ["drawtext", "drawbox", "overlay", "scale", "pad", "format", "color"]) if (!new RegExp(`\\s${filter}\\s`).test(filters)) throw notReady("required_filter_missing");
            return { metadata: {} };
          });
          temporaryBytes = result.metadata.temporaryBytes;
        }
        return { ready: true, rendererVersion: RENDERER_VERSION, capabilities: { image: true, document: true, captions: true, notebookPreview: true, nativeManifest: true }, sourceClosure: deps.sourceClosure, binarySha256: BINARY_SHA, fontSha256: FONT_SHA, inspection: readinessOptions.probe === true ? "fixed_native_filter_probe" : "pinned_files_only", filtersProbed: readinessOptions.probe === true, temporaryBytes, productionVerified: false };
      } catch (error) {
        if (!(error instanceof ApiError) && !["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error;
        return { ready: false, rendererVersion: RENDERER_VERSION, capabilities: { image: false, document: false, captions: true, notebookPreview: true, nativeManifest: true }, reason: error.code === "ADAPTER_NOT_READY" ? error.details.reason : error.code ?? "dependency_unavailable", productionVerified: false };
      }
    },
    async renderCard(input) {
      const card = cardInput(input), deps = await dependencies(config.ffmpegPath);
      return withWorkspace(config, deps, workspace => cardInWorkspace(card, deps, workspace));
    },
    async renderDocument(input) {
      record(input, ["title", "pages", "width", "height"], "文档输入");
      const title = text(input.title, "文档标题", 1000);
      list(input.pages, 1, MAX_PAGES, "完整文档页面");
      const cards = input.pages.map(page => cardInput({ ...record(page, ["title", "body", "footer", "sourceImages"], "文档页面"), width: input.width, height: input.height }, "document-page-v1"));
      const deps = await dependencies(config.ffmpegPath);
      return withWorkspace(config, deps, async workspace => {
        const pages = [];
        for (let index = 0; index < cards.length; index++) pages.push(await cardInWorkspace(cards[index], deps, workspace, index));
        const data = pdfFromPages(pages, title);
        return { ...output(data, "application/pdf", { title, pageCount: pages.length, pages: pages.map((page, index) => ({ index, width: page.metadata.width, height: page.metadata.height, bytes: page.bytes.length, sha256: page.sha256, title: cards[index].title, body: cards[index].body, textCoverage: page.metadata.textCoverage, sourceImages: page.metadata.sourceImages })), rasterPdf: true, textSearchable: false, sourceClosureHash: deps.sourceClosure.sha256, binarySha256: BINARY_SHA, fontSha256: FONT_SHA }), pages };
      });
    },
    renderVtt, previewNotebook, prepareNativeManifest
  });
}
