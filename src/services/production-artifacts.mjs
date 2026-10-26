import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { parseStrictJson } from "../domain/strict-json.mjs";
import { editorialEtag, editorialInput, editorialSensitiveFindings, editorialText } from "../domain/editorial.mjs";
import { inspectMediaBytes } from "./media-assets.mjs";
import { JsonStore } from "../storage/json-store.mjs";

const MiB = 1024 * 1024;
const ID = /^ART-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = "pengmanager.artifact-validator/v1";
const MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4", "text/vtt"]);
const TEXT = new Set(["text/plain", "text/markdown", "text/x-diff", "text/csv", "text/javascript", "text/x-python", "application/json", "application/x-ipynb+json", "application/x-subrip", "text/x-ass"]);
const TYPES = Object.freeze([...MEDIA, ...TEXT, "application/pdf", "application/zip", "audio/wav", "application/x-safetensors"]);
export const SOURCE_ARTIFACT_TYPES = Object.freeze({
  source_image: ["image/png", "image/jpeg", "image/webp"], source_video: ["video/mp4"],
  transcript: ["text/plain", "text/markdown"], timed_captions: ["text/vtt", "application/x-subrip", "text/x-ass"],
  code: ["text/plain", "text/markdown", "text/javascript", "text/x-python", "text/x-diff", "application/zip", "application/json"],
  dataset: ["text/csv", "application/json"], notebook: ["application/x-ipynb+json"],
  run_log: ["text/plain", "application/json"],
  rights_evidence: ["text/plain", "text/markdown", "application/json", "application/pdf", "image/png", "image/jpeg"],
  model_weights: ["application/x-safetensors"],
});
const queues = new WeakMap();
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const own = process.getuid?.();
const ordinary = (info, directory = false) => (directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink()
  && (own === undefined || info.uid === own) && (info.mode & 0o077) === 0 && (directory || info.nlink === 1);

function utf8(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail(415, "NATIVE_ARTIFACT_INVALID", "文本附件不是有效 UTF-8。"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) fail(415, "NATIVE_ARTIFACT_INVALID", "文本附件含有不支持的控制字符。");
  if (/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b|\b(?:cookie|set-cookie|sessionid)\s*[:=]\s*\S+/i.test(text)) fail(400, "ARTIFACT_CREDENTIALS_NOT_ALLOWED", "附件不能包含实际凭据或浏览器会话。");
  return text;
}
function safeName(name) {
  if (typeof name !== "string" || !name || name.length > 180 || /[\\/\u0000-\u001f]/u.test(name) || name === "." || name === "..") fail(400, "ARTIFACT_INVALID_NAME", "附件名称不能包含路径或控制字符。");
  return name;
}
function notebook(bytes) {
  const book = parseStrictJson(bytes, { maxBytes: 8 * MiB, maxDepth: 32, maxArray: 4096, maxString: 2 * MiB });
  if (!book || book.nbformat !== 4 || !Number.isSafeInteger(book.nbformat_minor) || !Array.isArray(book.cells) || book.cells.length > 1000 ||
      !book.metadata || typeof book.metadata !== "object" || Array.isArray(book.metadata)) fail(415, "NOTEBOOK_INVALID", "只支持有界的 notebook v4 静态文件。");
  let codeCells = 0, markdownCells = 0;
  for (const cell of book.cells) {
    if (!cell || !["code", "markdown", "raw"].includes(cell.cell_type) || !(typeof cell.source === "string" || Array.isArray(cell.source) && cell.source.every(row => typeof row === "string"))) fail(415, "NOTEBOOK_INVALID", "notebook 单元格结构无效。");
    if (cell.outputs !== undefined && !Array.isArray(cell.outputs)) fail(415, "NOTEBOOK_INVALID", "notebook 输出必须是有界数组。");
    if (cell.cell_type === "code") codeCells++;
    else if (cell.cell_type === "markdown") markdownCells++;
    if (cell.attachments && Object.keys(cell.attachments).length) fail(415, "NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED", "当前静态预览不接受嵌入附件。");
    for (const output of cell.outputs ?? []) {
      if (!output || !["stream", "error", "display_data", "execute_result"].includes(output.output_type)) fail(415, "NOTEBOOK_INVALID", "notebook 输出类型无效。");
      if (output.data && Object.keys(output.data).some(mime => mime !== "text/plain")) fail(415, "NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED", "notebook 富媒体输出需独立作为已验证附件提交；不会执行或渲染内嵌 HTML。");
    }
  }
  return { kind: "notebook", cells: book.cells.length, codeCells, markdownCells, executeCode: false, executionVerified: false };
}
function pdf(bytes) {
  const text = bytes.toString("latin1");
  // One classic xref section, generation zero, direct stream lengths. Validate
  // object extents before skipping binary streams: a forged Length must never
  // hide another indexed object's active dictionary. PDF Reference §3.2.7:
  // opensource.adobe.com/dc-acrobat-sdk-docs/library/plugin/Plugins_Cos.html
  if (!/^%PDF-1\.[4-7][\r\n]/.test(text) || !/%%EOF\s*$/.test(text)) fail(415, "PDF_INVALID", "PDF 文件头或结尾不完整。");
  const pointer = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  const xrefAt = Number(pointer?.[1]), header = /^xref\r?\n0[ \t]+(\d+)\r?\n/.exec(text.slice(xrefAt));
  if (!pointer || !Number.isSafeInteger(xrefAt) || xrefAt < 9 || xrefAt >= pointer.index || !header) fail(415, "PDF_INVALID", "PDF 需要单段完整的传统交叉引用表。");
  const count = Number(header[1]), entries = [], objects = new Map(); let cursor = xrefAt + header[0].length;
  if (!Number.isSafeInteger(count) || count < 2 || count > 4096) fail(415, "PDF_INVALID", "PDF 对象数量无效或超过当前上限。");
  for (let index = 0; index < count; index++) {
    const entry = /^(\d{10}) (\d{5}) ([nf]) ?\r?\n/.exec(text.slice(cursor));
    if (!entry || (index === 0 ? entry[1] !== "0000000000" || entry[2] !== "65535" || entry[3] !== "f" : entry[3] !== "n" || entry[2] !== "00000")) fail(415, "PDF_INVALID", "PDF 交叉引用条目不属于当前已验证子集。");
    if (index) entries.push({ id: index, offset: Number(entry[1]) }); cursor += entry[0].length;
  }
  const trailer = text.slice(cursor, pointer.index), root = /\/Root\s+(\d+)\s+0\s+R\b/.exec(trailer), size = /\/Size\s+(\d+)\b/.exec(trailer);
  if (!/^trailer\s*<<[\s\S]*>>\s*$/.test(trailer) || !root || !size || Number(size[1]) !== count || Number(root[1]) >= count || Number(root[1]) < 1 || /\/(?:Prev|XRefStm)\b/.test(trailer)) fail(415, "PDF_INVALID", "PDF 根目录、对象数量或更新结构不属于当前子集。");
  entries.sort((a, b) => a.offset - b.offset);
  if (new Set(entries.map(entry => entry.offset)).size !== entries.length || entries.some(entry => entry.offset < 9 || entry.offset >= xrefAt)) fail(415, "PDF_INVALID", "PDF 对象偏移重叠或越界。");
  const structural = [text.slice(0, entries[0].offset), trailer];
  for (const [index, entry] of entries.entries()) {
    const raw = text.slice(entry.offset, entries[index + 1]?.offset ?? xrefAt);
    const prefix = new RegExp(`^${entry.id} 0 obj[ \\t\\r\\n]+`).exec(raw), suffix = /endobj[ \t\r\n]*$/.exec(raw);
    if (!prefix || !suffix || suffix.index < prefix[0].length) fail(415, "PDF_INVALID", "PDF 实际对象与交叉引用范围不符。");
    const body = raw.slice(prefix[0].length, suffix.index), stream = /(?:\r\n|\n|[ \t])stream\r?\n/.exec(body);
    let dictionary = body;
    if (stream) {
      dictionary = body.slice(0, stream.index);
      if (!/^\s*<<[\s\S]*>>\s*$/.test(dictionary)) fail(415, "PDF_INVALID", "PDF 流缺少准确直接字典。");
      const lengths = [...dictionary.matchAll(/\/Length\s+(\d+)\b/g)];
      if (lengths.length !== 1 || /\/Length\s+\d+\s+\d+\s+R\b/.test(dictionary)) fail(415, "PDF_INVALID", "PDF 当前只接受唯一的直接流长度。");
      const length = Number(lengths[0][1]), end = stream.index + stream[0].length + length;
      if (!Number.isSafeInteger(length) || end > body.length || !/^(?:\r\n|\r|\n)?endstream[ \t\r\n]*$/.test(body.slice(end))) fail(415, "PDF_INVALID", "PDF 实际流字节与声明长度不一致。");
    } else if (/\b(?:stream|endstream)\b/.test(body)) fail(415, "PDF_INVALID", "PDF 流语法不完整。");
    if (/\b\d+\s+\d+\s+obj\b|\bendobj\b/.test(dictionary)) fail(415, "PDF_INVALID", "PDF 对象范围内含未登记对象。");
    structural.push(dictionary); objects.set(entry.id, dictionary);
  }
  const passive = structural.join("\n");
  if (/\/(?:JS|JavaScript|OpenAction|A|AA|Annots|Launch|EmbeddedFiles?|Filespec|RichMedia|Rendition|Movie|Sound|XFA|Encrypt|URI|SubmitForm|ImportData|AcroForm|ObjStm|XRef|F|FFilter|FDecodeParms|GoToR|GoToE)\b|#[a-fA-F0-9]{2}/.test(passive)) fail(415, "PDF_ACTIVE_CONTENT_UNSUPPORTED", "PDF 不符合当前被动文档子集；不接受脚本、表单、附件、外链动作或加密内容。");
  if (!/\/Type\s*\/Catalog\b/.test(objects.get(Number(root[1])))) fail(415, "PDF_INVALID", "PDF 根对象不是文档目录。");
  const pages = [...passive.matchAll(/\/Type\s*\/Page\b/g)].length;
  if (!pages || pages > 200) fail(415, "PDF_INVALID", "PDF 页数无效或超过当前上限。");
  return { kind: "document", pages, passiveSubset: true, previewMode: "attachment" };
}
function zip(bytes) {
  if (bytes.length < 22) fail(415, "ZIP_INVALID", "ZIP 文件不完整。");
  const trailer = bytes.length - 22;
  if (bytes.readUInt32LE(trailer) !== 0x06054b50 || bytes.readUInt16LE(trailer + 4) || bytes.readUInt16LE(trailer + 6) || bytes.readUInt16LE(trailer + 20)) fail(415, "ZIP_INVALID", "只支持无注释、单卷的有界 ZIP。");
  const count = bytes.readUInt16LE(trailer + 10), directoryBytes = bytes.readUInt32LE(trailer + 12), start = bytes.readUInt32LE(trailer + 16);
  if (!count || count > 1000 || count !== bytes.readUInt16LE(trailer + 8) || start + directoryBytes !== trailer) fail(415, "ZIP_INVALID", "ZIP 目录或文件数量无效。");
  const names = new Set(), files = []; let at = start, total = 0, previousEnd = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > trailer || bytes.readUInt32LE(at) !== 0x02014b50) fail(415, "ZIP_INVALID", "ZIP 中央目录无效。");
    const flags = bytes.readUInt16LE(at + 8), method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16);
    const compressed = bytes.readUInt32LE(at + 20), size = bytes.readUInt32LE(at + 24), length = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32), offset = bytes.readUInt32LE(at + 42);
    const external = bytes.readUInt32LE(at + 38), mode = external >>> 16;
    if (flags & ~0x800 || ![0, 8].includes(method) || extra || comment || at + 46 + length > trailer || mode && (mode & 0xf000) !== 0x8000) fail(415, "ZIP_UNSUPPORTED", "ZIP 含加密、链接、特殊文件或未支持扩展。");
    const name = utf8(bytes.subarray(at + 46, at + 46 + length));
    if (!name || name.length > 240 || name.startsWith("/") || /[\\:\u0000-\u001f]/u.test(name) || name.split("/").some(part => !part || part === "." || part === "..") || names.has(name.toLowerCase())) fail(415, "ZIP_UNSAFE_PATH", "ZIP 文件名含路径穿越、重复或不安全形式。");
    names.add(name.toLowerCase()); total += size;
    if (total > 100 * MiB || size > 16 * MiB || offset !== previousEnd || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50 ||
        bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt32LE(offset + 14) !== crc ||
        bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== size || bytes.readUInt16LE(offset + 26) !== length || bytes.readUInt16LE(offset + 28)) fail(415, "ZIP_INVALID", "ZIP 本地目录与中央目录不一致或超限。");
    const payloadStart = offset + 30 + length, end = payloadStart + compressed;
    if (end > start || !bytes.subarray(offset + 30, payloadStart).equals(bytes.subarray(at + 46, at + 46 + length))) fail(415, "ZIP_INVALID", "ZIP 数据偏移无效。");
    let content;
    try { content = method === 0 ? bytes.subarray(payloadStart, end) : inflateRawSync(bytes.subarray(payloadStart, end), { maxOutputLength: size + 1 }); }
    catch { fail(415, "ZIP_INVALID", "ZIP 压缩数据无效。"); }
    if (content.length !== size || crc32(content) !== crc) fail(415, "ZIP_INVALID", "ZIP 实际字节校验失败。");
    // Only passive source packages enter this initial private native contract.
    const extension = name.split(".").at(-1).toLowerCase();
    if (!["md", "txt", "json", "csv", "py", "js", "mjs", "ts", "tsx", "jsx", "yml", "yaml", "toml", "diff", "patch", "ipynb"].includes(extension)) fail(415, "ZIP_ENTRY_UNSUPPORTED", "ZIP 只接受被动源码与文档；二进制和可执行文件需独立受控合同。");
    if (extension === "ipynb") notebook(content); else utf8(content);
    files.push({ name, bytes: size, sha256: digest(content) }); previousEnd = end; at += 46 + length;
  }
  if (at !== trailer || previousEnd !== start) fail(415, "ZIP_INVALID", "ZIP 含未登记的数据。");
  return { kind: "source_bundle", files, extracted: false, executed: false };
}
function wav(bytes) {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.length) fail(415, "WAV_INVALID", "WAV 容器无效。");
  let at = 12, format, dataBytes = 0;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) fail(415, "WAV_INVALID", "WAV 分段不完整。");
    const kind = bytes.toString("ascii", at, at + 4), size = bytes.readUInt32LE(at + 4), end = at + 8 + size;
    if (end + (size & 1) > bytes.length) fail(415, "WAV_INVALID", "WAV 分段长度无效。");
    if (kind === "fmt ") {
      if (format || size !== 16 || bytes.readUInt16LE(at + 8) !== 1) fail(415, "WAV_UNSUPPORTED", "当前只接受 PCM WAV。");
      format = { channels: bytes.readUInt16LE(at + 10), sampleRate: bytes.readUInt32LE(at + 12), byteRate: bytes.readUInt32LE(at + 16), alignment: bytes.readUInt16LE(at + 20), bits: bytes.readUInt16LE(at + 22) };
      if (![1, 2].includes(format.channels) || ![8, 16, 24, 32].includes(format.bits) || format.sampleRate < 8000 || format.sampleRate > 192000 || format.alignment !== format.channels * format.bits / 8 || format.byteRate !== format.sampleRate * format.alignment) fail(415, "WAV_INVALID", "WAV 音频参数无效。");
    } else if (kind === "data") { if (dataBytes || !format || !size || size % format.alignment) fail(415, "WAV_INVALID", "WAV 音频段无效。"); dataBytes = size; }
    else fail(415, "WAV_UNSUPPORTED", "WAV 含当前合同未支持的扩展段。");
    at = end + (size & 1);
  }
  if (!format || !dataBytes) fail(415, "WAV_INVALID", "WAV 缺少音频数据。");
  return { kind: "audio", channels: format.channels, sampleRate: format.sampleRate, durationMs: Math.ceil(dataBytes / format.byteRate * 1000) };
}
function safetensors(bytes) {
  // Official format and project schema: github.com/safetensors/safetensors.
  // Only a bounded byte-aligned subset is accepted. Models are never loaded.
  if (bytes.length < 10) fail(415, "SAFETENSORS_INVALID", "张量附件缺少完整文件头。");
  const rawLength = bytes.readBigUInt64LE(0);
  if (rawLength < 2n || rawLength > 1048576n || rawLength > BigInt(bytes.length - 8)) fail(415, "SAFETENSORS_INVALID", "张量文件头长度无效或超过当前上限。");
  const length = Number(rawLength), rawHeader = bytes.subarray(8, 8 + length);
  if (rawHeader[0] !== 0x7b) fail(415, "SAFETENSORS_INVALID", "张量文件头必须是 JSON 对象。");
  const header = parseStrictJson(utf8(rawHeader), { maxBytes: 1048576, maxDepth: 8, maxArray: 4096, maxString: 10000 });
  if (!header || typeof header !== "object" || Array.isArray(header)) fail(415, "SAFETENSORS_INVALID", "张量文件头不是对象。");
  const sizes = { F16: 2, F32: 4, F64: 8, I8: 1, I16: 2, I32: 4, I64: 8, U8: 1, U16: 2, U32: 4, U64: 8 };
  const tensors = []; let elements = 0n;
  for (const [name, tensor] of Object.entries(header)) {
    if (name === "__metadata__") {
      if (!tensor || typeof tensor !== "object" || Array.isArray(tensor) || Object.values(tensor).some(value => typeof value !== "string")) fail(415, "SAFETENSORS_INVALID", "张量元数据只接受字符串映射。");
      continue;
    }
    if (!name || name.length > 1024 || !tensor || typeof tensor !== "object" || Array.isArray(tensor) ||
        Object.keys(tensor).sort().join(",") !== "data_offsets,dtype,shape" || !Object.hasOwn(sizes, tensor.dtype)) fail(415, "SAFETENSORS_DTYPE_UNSUPPORTED", "张量类型不属于当前已验证的字节对齐子集。");
    if (!Array.isArray(tensor.shape) || tensor.shape.length > 16 || tensor.shape.some(value => !Number.isSafeInteger(value) || value < 0 || value > 281474976710655) ||
        !Array.isArray(tensor.data_offsets) || tensor.data_offsets.length !== 2 || tensor.data_offsets.some(value => !Number.isSafeInteger(value) || value < 0)) fail(415, "SAFETENSORS_INVALID", "张量形状或字节偏移无效。");
    const count = tensor.shape.reduce((total, value) => total * BigInt(value), 1n), [start, end] = tensor.data_offsets;
    if (end < start || end > bytes.length - 8 - length || BigInt(end - start) !== count * BigInt(sizes[tensor.dtype])) fail(415, "SAFETENSORS_INVALID", "张量实际字节数与形状、类型或缓冲区不一致。");
    elements += count; tensors.push({ name, dtype: tensor.dtype, shape: [...tensor.shape], start, end });
  }
  if (!tensors.length || !elements) fail(415, "MODEL_WEIGHTS_EMPTY", "模型来源必须含真实的非空张量数据。");
  tensors.sort((a, b) => a.start - b.start || a.end - b.end);
  let end = 0;
  for (const tensor of tensors) { if (tensor.start !== end) fail(415, "SAFETENSORS_INVALID", "张量缓冲区不能有重叠或未登记空洞。"); end = tensor.end; }
  if (end !== bytes.length - 8 - length) fail(415, "SAFETENSORS_INVALID", "张量文件含未登记尾部字节。");
  return { kind: "model_weights", tensorCount: tensors.length, elements: Number(elements), tensors, loaded: false, inferenceVerified: false, trainingVerified: false };
}
export function inspectProductionArtifact(bytes, mime) {
  if (!Buffer.isBuffer(bytes) || !TYPES.includes(mime) || !bytes.length) fail(415, "NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "附件类型未获当前验证器支持。");
  if (MEDIA.has(mime)) return inspectMediaBytes(bytes, mime);
  if (mime === "application/pdf") return pdf(bytes);
  if (mime === "application/zip") return zip(bytes);
  if (mime === "audio/wav") return wav(bytes);
  if (mime === "application/x-safetensors") return safetensors(bytes);
  if (mime === "application/x-ipynb+json") return notebook(bytes);
  const text = utf8(bytes);
  if (mime === "application/json") parseStrictJson(bytes, { maxBytes: 8 * MiB, maxString: 2 * MiB });
  if (mime === "text/x-diff" && (!/^(?:diff --git |--- )/m.test(text) || /^(?:---|\+\+\+)\s+(?:\/[a-z]|[A-Za-z]:|.*(?:^|\/)\.\.(?:\/|$))/m.test(text))) fail(415, "DIFF_INVALID", "差异文件缺少头信息或含不安全路径。");
  if (mime === "application/x-subrip" && !/^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/.test(text)) fail(415, "CAPTION_INVALID", "SRT 时间轴格式无效。");
  if (mime === "text/x-ass" && (!/^\[Script Info\]/m.test(text) || !/^\[Events\]/m.test(text) || /^(?:\[Fonts\]|\[Graphics\]|fontname:|filename:)/mi.test(text))) fail(415, "CAPTION_INVALID", "ASS 不符合纯字幕合同。");
  return { kind: ["application/x-subrip", "text/x-ass"].includes(mime) ? "caption" : "text", characters: text.length, lines: text.split("\n").length, preview: text.slice(0, 12000), previewTruncated: text.length > 12000, executed: false };
}
async function ancestors(path) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(503, "ARTIFACT_UNSAFE_STORAGE", "附件目录含链接或特殊路径。");
  }
}
async function readHandle(handle, size) {
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) { const result = await handle.read(bytes, offset, size - offset, offset); if (!result.bytesRead) fail(503, "ARTIFACT_BYTES_UNAVAILABLE", "附件字节不完整。"); offset += result.bytesRead; }
  return bytes;
}
async function syncDirectory(path) {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
export class ProductionArtifacts {
  constructor({ store, maxArtifactBytes = 50 * MiB, maxTotalBytes = 500 * MiB } = {}) {
    if (!store?.filePath || !Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < maxArtifactBytes) throw new TypeError("Invalid artifact store configuration.");
    this.store = store; this.root = join(dirname(resolve(store.filePath)), "worker-artifacts");
    this.objects = join(this.root, "objects"); this.staging = join(this.root, "staging"); this.maxArtifactBytes = maxArtifactBytes; this.maxTotalBytes = maxTotalBytes;
  }
  async initialize() {
    await ancestors(dirname(this.root));
    for (const path of [this.root, this.objects, this.staging]) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw new ApiError(503, "ARTIFACT_STORAGE_UNAVAILABLE", "附件目录创建失败。"); }
      if (!ordinary(await lstat(path), true)) fail(503, "ARTIFACT_UNSAFE_STORAGE", "附件目录要求私有权限和当前所有者。");
    }
    return { types: [...TYPES], validatorVersion: VERSION, maxArtifactBytes: this.maxArtifactBytes, maxTotalBytes: this.maxTotalBytes };
  }
  async checkDirectories() {
    await ancestors(dirname(this.root));
    for (const path of [this.root, this.objects, this.staging]) if (!ordinary(await lstat(path), true)) fail(503, "ARTIFACT_UNSAFE_STORAGE", "附件目录权限或所有者已变化。");
  }
  sourceCapabilities() {
    return { roles: structuredClone(SOURCE_ARTIFACT_TYPES), maxArtifactBytes: this.maxArtifactBytes, maxTotalBytes: this.maxTotalBytes, validatorVersion: VERSION };
  }
  listSourceArtifacts() {
    return { ...this.sourceCapabilities(), items: (this.store.snapshot().productionArtifacts ?? []).filter(row => row.origin === "administrator_upload" && row.committed === true)
      .map(row => ({ ...structuredClone(row), etag: editorialEtag(row) })) };
  }
  async uploadSource(readable, metadata, ctx) {
    editorialInput(metadata, ["storyId", "role", "mime", "size", "sha256", "name"]);
    if (!["local", "session"].includes(ctx?.method)) fail(403, "ARTIFACT_ADMIN_REQUIRED", "源文件登记需要管理员。");
    const actor = editorialText(ctx.actor, "actor", 120);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey ?? "")) fail(400, "IDEMPOTENCY_KEY_REQUIRED", "源文件登记需要有效幂等键。");
    const allowedMimes = Object.hasOwn(SOURCE_ARTIFACT_TYPES, metadata.role) ? SOURCE_ARTIFACT_TYPES[metadata.role] : null;
    if (!allowedMimes?.includes(metadata.mime)) fail(415, "SOURCE_ARTIFACT_ROLE_MISMATCH", "真实源文件的用途与 MIME 类型不匹配。");
    const keyHash = hashObject(["source-artifact-upload", actor, ctx.idempotencyKey]), requestHash = hashObject(metadata);
    const state = this.store.snapshot(), previous = state.contentOpsRequests?.find(row => row.keyHash === keyHash);
    if (previous && previous.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "源文件幂等键已用于不同上传。");
    const story = state.stories?.find(row => row.id === metadata.storyId);
    if (!story) fail(404, "STORY_NOT_FOUND", "请先创建真实选题再登记其源文件。");
    if (!previous) {
      if (!ctx.ifMatch) fail(428, "PRECONDITION_REQUIRED", "源文件登记需要选题的准确 If-Match。");
      if (ctx.ifMatch !== editorialEtag(story)) fail(412, "PRECONDITION_FAILED", "选题已变化，请刷新后核对源文件用途。");
      if (story.status === "archived") fail(409, "STORY_ARCHIVED", "归档选题不能接受新源文件。");
    }
    const sourceUploadId = "SRC-" + keyHash.slice(0, 24), artifactId = "ART-" + keyHash.slice(0, 32);
    const staged = await this.stage(readable, { ...metadata, artifactId }, {
      taskId: sourceUploadId, attemptId: sourceUploadId, outputSpec: [{ role: metadata.role, allowedMimes, maxBytes: this.maxArtifactBytes }],
    });
    return (await this.store.mutate({ type: "artifact.source_uploaded", actor, payload: { artifactId, sourceUploadId, storyId: metadata.storyId, sha256: staged.sha256 } }, next => {
      next.contentOpsRequests ??= []; const prior = next.contentOpsRequests.find(row => row.keyHash === keyHash);
      if (prior) { if (prior.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "源文件幂等键冲突。"); return JsonStore.noChange(prior.result); }
      const current = next.stories.find(row => row.id === metadata.storyId);
      if (!current || editorialEtag(current) !== ctx.ifMatch) fail(412, "PRECONDITION_FAILED", "源文件落盘期间选题已变化；私有字节已保留，可重新核对后恢复。");
      if (current.status === "archived") fail(409, "STORY_ARCHIVED", "选题在上传期间已归档。");
      next.productionArtifacts ??= [];
      if (next.productionArtifacts.some(row => row.id === artifactId)) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "源附件已有不同登记，请核对原记录。");
      const artifact = { ...staged, taskId: null, attemptId: null, sourceUploadId, origin: "administrator_upload", storyId: current.id,
        createdBy: actor, status: "committed", committed: true, commitStatus: "committed", review: null };
      next.productionArtifacts.push(artifact);
      const result = { ...structuredClone(artifact), etag: editorialEtag(artifact) };
      next.contentOpsRequests.push({ keyHash, requestHash, result: structuredClone(result), at: new Date().toISOString() }); return result;
    })).result;
  }
  async stage(readable, metadata, { taskId, attemptId, outputSpec } = {}) {
    const previous = queues.get(this.store) ?? Promise.resolve();
    const run = previous.then(() => this.stageOnce(readable, metadata, { taskId, attemptId, outputSpec })); queues.set(this.store, run.catch(() => undefined)); return run;
  }
  async recoverLinkedUpload(id, metadata) {
    const target = join(this.objects, `${id}.bin`);
    let info;
    try { info = await lstat(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (info.nlink === 1) return;
    // A crash between exclusive publication and staging cleanup leaves exactly
    // these two links. Never remove an unknown hardlink or infer content by name.
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 2 || info.size !== metadata.size ||
        (own !== undefined && info.uid !== own) || (info.mode & 0o077) !== 0) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "附件存在无法识别的文件链接；原字节已保留。");
    const matches = [];
    for (const name of await readdir(this.staging)) {
      const path = join(this.staging, name), candidate = await lstat(path);
      if (candidate.ino === info.ino && candidate.dev === info.dev) {
        if (!/^[a-f0-9]{32}\.upload$/.test(name) || candidate.isSymbolicLink() || !candidate.isFile()) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "附件暂存链接不符合受控上传格式。");
        matches.push(path);
      }
    }
    if (matches.length !== 1) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "无法准确识别附件上传中断的暂存链接。");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat(), bytes = await readHandle(handle, metadata.size), after = await handle.stat();
      if (before.ino !== info.ino || before.dev !== info.dev || before.nlink !== 2 || after.nlink !== 2 ||
          before.size !== metadata.size || after.size !== before.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || digest(bytes) !== metadata.sha256) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "中断附件的实际字节与原请求不符。");
      const candidate = await lstat(matches[0]);
      if (candidate.ino !== info.ino || candidate.dev !== info.dev || candidate.isSymbolicLink() || candidate.nlink !== 2) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "暂存链接在恢复期间发生变化。");
      await syncDirectory(this.objects);
      await unlink(matches[0]);
      await syncDirectory(this.staging);
      if (!ordinary(await handle.stat())) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "附件仍存在无法识别的文件链接。");
    } finally { await handle.close(); }
  }
  async stageOnce(readable, metadata, { taskId, attemptId, outputSpec }) {
    if (!metadata || !TYPES.includes(metadata.mime) || !SHA.test(metadata.sha256 ?? "") || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > this.maxArtifactBytes) fail(400, "ARTIFACT_INVALID_METADATA", "附件类型、大小和摘要必须准确。");
    const name = safeName(metadata.name ?? "artifact");
    const specs = Array.isArray(outputSpec) ? outputSpec : [outputSpec];
    const spec = specs.find(item => item && item.role === metadata.role && (item.mime === metadata.mime || (item.allowedMimes ?? item.mimeTypes ?? []).includes(metadata.mime)));
    if (!spec || metadata.size > (spec.maxBytes ?? spec.bytes ?? this.maxArtifactBytes)) fail(403, "ARTIFACT_OUTPUT_SCOPE_DENIED", "附件不属于当前任务预声明的输出类型、用途或大小。");
    const id = metadata.artifactId ?? `ART-${randomBytes(16).toString("hex")}`;
    if (!ID.test(id) || typeof taskId !== "string" || typeof attemptId !== "string" || !readable?.[Symbol.asyncIterator]) fail(400, "ARTIFACT_INVALID_METADATA", "附件必须绑定准确任务和尝试。");
    await this.checkDirectories();
    await this.recoverLinkedUpload(id, metadata);
    let used = 0;
    for (const directory of [this.objects, this.staging]) for (const entry of await readdir(directory)) {
      const info = await lstat(join(directory, entry)); if (!ordinary(info)) fail(503, "ARTIFACT_UNSAFE_STORAGE", "附件存储含不安全文件。"); used += info.size;
    }
    const temporary = join(this.staging, `${randomBytes(16).toString("hex")}.upload`), target = join(this.objects, `${id}.bin`);
    let orphan;
    try { orphan = await lstat(target); } catch (error) { if (error.code !== "ENOENT") throw new ApiError(503, "ARTIFACT_STORAGE_UNAVAILABLE", "附件恢复状态无法读取。"); }
    if (orphan && (!ordinary(orphan) || orphan.size !== metadata.size)) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "既有附件与准确上传大小或存储类型不符；原文件已保留。");
    if (used + (orphan ? 0 : metadata.size) > this.maxTotalBytes) fail(429, "WORKSPACE_QUOTA_EXCEEDED", "附件存储额度不足。");
    let handle, created = false;
    try {
      if (!orphan) { handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true; }
      const hash = createHash("sha256"); let size = 0;
      for await (const value of readable) {
        if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(400, "ARTIFACT_INVALID_BODY", "附件必须使用二进制上传。");
        const chunk = Buffer.from(value); size += chunk.length;
        if (size > metadata.size) fail(413, "ARTIFACT_TOO_LARGE", "附件超过预声明大小。");
        hash.update(chunk); if (handle) await handle.writeFile(chunk);
      }
      if (size !== metadata.size || hash.digest("hex") !== metadata.sha256) fail(400, "ARTIFACT_HASH_MISMATCH", "附件实际大小或摘要不符。");
      if (orphan) handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const storedBytes = await readHandle(handle, size);
      if (orphan && (!ordinary(await handle.stat()) || digest(storedBytes) !== metadata.sha256)) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "同一附件标识已有不同字节，原文件已保留。");
      const inspection = inspectProductionArtifact(storedBytes, metadata.mime);
      if (!orphan) { await handle.sync(); await handle.chmod(0o400); }
      await handle.close(); handle = null;
      if (!orphan) {
        try { await link(temporary, target); }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { const info = await existing.stat(); if (!ordinary(info) || info.size !== size || digest(await readHandle(existing, size)) !== metadata.sha256) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "同一附件标识已有不同字节，原文件已保留。"); }
          finally { await existing.close(); }
        }
      }
      await syncDirectory(this.objects);
      return { id, taskId, attemptId, role: metadata.role, mime: metadata.mime, size, bytes: size, sha256: metadata.sha256, name, validatorVersion: VERSION, inspection, status: "staged", createdAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (readable.aborted || ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) throw new ApiError(400, "ARTIFACT_UPLOAD_INTERRUPTED", "附件上传中断；保留同一幂等键恢复。");
      throw new ApiError(503, "ARTIFACT_STORAGE_UNAVAILABLE", "附件保存失败；可使用原请求核对恢复。");
    } finally { if (handle) await handle.close(); if (created) { await unlink(temporary); await syncDirectory(this.staging); } }
  }
  async openVerifiedArtifact(id, options = {}) { return this.openStoredArtifact(id, options, true); }
  // Full backups retain quarantined evidence too; this capability is never
  // exposed to worker byte routes or package construction.
  async openBackupArtifact(id, options = {}) { return this.openStoredArtifact(id, options, false); }
  async openStoredArtifact(id, { state = this.store.snapshot(), sha256 } = {}, requireCommitted = true) {
    const artifact = (state.productionArtifacts ?? []).find(row => row.id === id);
    if (!ID.test(id ?? "") || !artifact || requireCommitted && (artifact.committed !== true || artifact.commitStatus !== "committed") || (sha256 !== undefined && sha256 !== artifact.sha256)) fail(404, "ARTIFACT_NOT_FOUND", "已提交附件不存在。");
    if (!SHA.test(artifact.sha256 ?? "") || !Number.isSafeInteger(artifact.size) || artifact.size < 1 || artifact.size > this.maxArtifactBytes || !TYPES.includes(artifact.mime)) fail(503, "ARTIFACT_METADATA_INVALID", "附件登记信息无效。");
    let handle;
    try {
      await this.checkDirectories(); handle = await open(join(this.objects, `${id}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat();
      if (!ordinary(before) || before.size !== artifact.size) fail(503, "ARTIFACT_BYTES_UNAVAILABLE", "附件文件类型、权限或大小无效。");
      const bytes = await readHandle(handle, before.size), after = await handle.stat();
      if (digest(bytes) !== artifact.sha256 || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(503, "ARTIFACT_BYTES_UNAVAILABLE", "附件字节与登记摘要不符或校验期间发生变化。");
      inspectProductionArtifact(bytes, artifact.mime); return { artifact: structuredClone(artifact), handle };
    } catch (error) { if (handle) await handle.close(); if (error instanceof ApiError) throw error; throw new ApiError(503, "ARTIFACT_BYTES_UNAVAILABLE", "附件暂不可读取。"); }
  }
  getArtifact(id) {
    const artifact = (this.store.snapshot().productionArtifacts ?? []).find(row => row.id === id && row.committed === true && row.commitStatus === "committed");
    if (!ID.test(id ?? "") || !artifact) fail(404, "ARTIFACT_NOT_FOUND", "已提交附件不存在。");
    return { ...structuredClone(artifact), etag: editorialEtag(artifact) };
  }
  async preview(id) {
    const opened = await this.openVerifiedArtifact(id);
    try {
      const bytes = await readHandle(opened.handle, opened.artifact.size), artifact = opened.artifact;
      if (artifact.mime === "application/x-ipynb+json") {
        const book = parseStrictJson(bytes, { maxBytes: 8 * MiB, maxDepth: 32, maxArray: 4096, maxString: 2 * MiB });
        return { artifactId: id, sha256: artifact.sha256, kind: "notebook", executeCode: false, cells: book.cells.map(cell => ({
          type: cell.cell_type, source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
          outputs: (cell.outputs ?? []).map(output => ({ type: output.output_type,
            text: output.text ?? output.data?.["text/plain"] ?? output.traceback ?? [] })),
        })) };
      }
      if (TEXT.has(artifact.mime)) return { artifactId: id, sha256: artifact.sha256, kind: "text", text: utf8(bytes), truncated: false };
      return { artifactId: id, sha256: artifact.sha256, ...artifact.inspection };
    } finally { await opened.handle.close(); }
  }
  async verifyReferences(refs, { reviewed = true } = {}) {
    if (!Array.isArray(refs) || refs.length > 256) fail(400, "ARTIFACT_INVALID_REFERENCES", "附件引用必须是有界数组。");
    const result = [];
    for (const ref of refs) {
      const artifact = this.getArtifact(ref.id);
      if (artifact.sha256 !== ref.sha256 || artifact.size !== ref.bytes || artifact.mime !== ref.mime ||
          reviewed && (artifact.status !== "reviewed" || artifact.review?.rightsConfirmed !== true || artifact.review?.privacyConfirmed !== true || artifact.review?.licenseConfirmed !== true ||
            artifact.rightsReviewHash !== ref.rightsReviewHash || artifact.privacyReviewHash !== ref.privacyReviewHash)) fail(409, "RIGHTS_CHANGED", "附件字节、类型、大小、许可或审核发生变化。");
      const opened = await this.openVerifiedArtifact(artifact.id, { sha256: ref.sha256 }); await opened.handle.close();
      result.push({ artifactId: artifact.id, sha256: artifact.sha256 });
    }
    return result;
  }
  async importMedia(id, input, ctx, mediaAssets) {
    editorialInput(input, ["sha256"]);
    if (!["local", "session"].includes(ctx?.method)) fail(403, "ARTIFACT_ADMIN_REQUIRED", "素材导入需要管理员。");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey ?? "")) fail(400, "IDEMPOTENCY_KEY_REQUIRED", "素材导入需要有效幂等键。");
    const keyHash = hashObject(["artifact-import-media", id, ctx.actor, ctx.idempotencyKey]), requestHash = hashObject(input);
    const prior = this.store.snapshot().contentOpsRequests?.find(row => row.keyHash === keyHash);
    if (prior) { if (prior.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "素材导入幂等键已用于其他请求。"); return structuredClone(prior.result); }
    const artifact = this.getArtifact(id);
    if (!ctx.ifMatch) fail(428, "PRECONDITION_REQUIRED", "素材导入需要 If-Match。");
    if (ctx.ifMatch !== artifact.etag) fail(412, "PRECONDITION_FAILED", "附件版本已变化。");
    if (input.sha256 !== artifact.sha256 || !MEDIA.has(artifact.mime)) fail(422, "NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "此附件不能作为现有媒体导入。");
    let media;
    if (artifact.mediaAssetId) {
      media = mediaAssets.getAsset(artifact.mediaAssetId);
      if (media.sha256 !== artifact.sha256 || media.status === "revoked") fail(409, "ARTIFACT_MEDIA_LINK_CHANGED", "已有素材桥接的字节或权利已变化，请保留历史并重新核对。");
    } else {
      const opened = await this.openVerifiedArtifact(id, { sha256: input.sha256 });
      try { media = await mediaAssets.upload(opened.handle.createReadStream({ start: 0, autoClose: false }), {
        contentType: artifact.mime, contentLength: artifact.size, name: artifact.name, expectedSha256: artifact.sha256,
      }, ctx); } finally { await opened.handle.close(); }
    }
    return (await this.store.mutate({ type: "artifact.media_imported", actor: ctx.actor, payload: { artifactId: id, assetId: media.id, sha256: media.sha256 } }, state => {
      state.contentOpsRequests ??= []; const previous = state.contentOpsRequests.find(row => row.keyHash === keyHash);
      if (previous) { if (previous.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "素材导入幂等键冲突。"); return JsonStore.noChange(previous.result); }
      const current = state.productionArtifacts.find(row => row.id === id);
      if (!current || current.sha256 !== artifact.sha256 || current.committed !== true || current.status === "revoked") fail(409, "ARTIFACT_CHANGED", "素材导入期间附件发生变化。");
      if (editorialEtag(current) !== ctx.ifMatch) fail(412, "PRECONDITION_FAILED", "附件在素材导入期间已变化；已上传的私有素材仍保留，可核对后恢复。");
      if (current.mediaAssetId && current.mediaAssetId !== media.id) fail(409, "ARTIFACT_MEDIA_LINK_CHANGED", "附件已关联其他素材；原私有文件已保留。");
      current.mediaAssetId = media.id;
      const result = { ...media, sourceArtifactId: id, artifactEtag: editorialEtag(current) };
      state.contentOpsRequests.push({ keyHash, requestHash, result: structuredClone(result), at: new Date().toISOString() }); return result;
    })).result;
  }
  async review(id, input, ctx) {
    editorialInput(input, ["sha256", "rightsConfirmed", "privacyConfirmed", "licenseConfirmed", "note"]);
    if (!["local", "session"].includes(ctx?.method)) fail(403, "ARTIFACT_ADMIN_REQUIRED", "附件权利审阅需要管理员。");
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey ?? "")) fail(400, "IDEMPOTENCY_KEY_REQUIRED", "附件审阅需要有效幂等键。");
    if (!SHA.test(input.sha256 ?? "") || input.rightsConfirmed !== true || input.privacyConfirmed !== true || input.licenseConfirmed !== true) fail(400, "ARTIFACT_REVIEW_REQUIRED", "请核对准确字节、权利、许可及隐私。");
    const note = editorialText(input.note, "note", 2000), actor = editorialText(ctx.actor, "actor", 120), keyHash = hashObject(["artifact-review", id, actor, ctx.idempotencyKey]), requestHash = hashObject(input);
    if (editorialSensitiveFindings({ note }).length) fail(400, "ARTIFACT_SENSITIVE_METADATA", "审核说明含有敏感资料。");
    const opened = await this.openVerifiedArtifact(id, { sha256: input.sha256 }); await opened.handle.close();
    return (await this.store.mutate({ type: "artifact.reviewed", actor: ctx.actor, payload: { artifactId: id, sha256: input.sha256 } }, state => {
      state.contentOpsRequests ??= []; const previous = state.contentOpsRequests.find(row => row.keyHash === keyHash);
      if (previous) { if (previous.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "附件审核幂等键已用于不同请求。"); return JsonStore.noChange(previous.result); }
      const artifact = state.productionArtifacts.find(row => row.id === id);
      if (!artifact || artifact.sha256 !== input.sha256 || artifact.committed !== true || artifact.status === "revoked") fail(409, "ARTIFACT_CHANGED", "附件已变化或撤销。");
      if (!ctx.ifMatch) fail(428, "PRECONDITION_REQUIRED", "附件审核需要 If-Match。");
      if (ctx.ifMatch !== editorialEtag(artifact)) fail(412, "PRECONDITION_FAILED", "附件版本已变化。");
      const reviewedAt = new Date().toISOString(); artifact.status = "reviewed";
      artifact.review = { sha256: artifact.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true, note, reviewedBy: ctx.actor, reviewedAt };
      artifact.rightsReviewHash = hashObject({ artifactId: id, sha256: artifact.sha256, rightsConfirmed: true, licenseConfirmed: true, note, reviewedBy: ctx.actor, reviewedAt });
      artifact.privacyReviewHash = hashObject({ artifactId: id, sha256: artifact.sha256, privacyConfirmed: true, note, reviewedBy: ctx.actor, reviewedAt });
      const result = { ...structuredClone(artifact), etag: editorialEtag(artifact) };
      state.contentOpsRequests.push({ keyHash, requestHash, result: structuredClone(result), at: reviewedAt }); return result;
    })).result;
  }
}
