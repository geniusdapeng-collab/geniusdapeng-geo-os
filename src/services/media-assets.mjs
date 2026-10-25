import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { crc32, inflateSync } from "node:zlib";
import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { scanSensitiveText } from "../domain/policy.mjs";
import { JsonStore } from "../storage/json-store.mjs";

const MiB = 1024 * 1024;
const IDS = /^MED-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const KINDS = { "image/png": "image", "image/jpeg": "image", "image/webp": "image", "video/mp4": "video", "text/vtt": "caption" };
const ROLES = { cover: "image", image: "image", poster: "image", video: "video", subtitle: "caption" };
const queues = new WeakMap();
const own = process.getuid?.();

function fail(status, code, message) { throw new ApiError(status, code, message); }
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }
function text(value, max, required = true, multiline = false) {
  const forbidden = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u : /[\u0000-\u001f\u007f]/u;
  if (typeof value !== "string" || value.length > max || forbidden.test(value) || (required && !value.trim())) {
    fail(400, "MEDIA_INVALID_INPUT", "素材输入无效。");
  }
  if (scanSensitiveText(value).length || /\b(?:cookies?|set-cookie|sessionid|session_id)\s*[:=]\s*\S+/i.test(value)) {
    fail(400, "MEDIA_SENSITIVE_METADATA", "素材名称与审核记录不能包含敏感资料或登录凭据。");
  }
  return value.trim();
}
function context(ctx) {
  if (!object(ctx) || ctx.method === "agent" || typeof ctx.actor !== "string" || !ctx.actor.trim()) {
    fail(403, "MEDIA_ADMIN_REQUIRED", "素材写入需要管理员身份。");
  }
  if (typeof ctx.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(ctx.idempotencyKey)) {
    fail(400, "IDEMPOTENCY_KEY_REQUIRED", "请提供 8–128 位有效的幂等键。");
  }
  return { ...ctx, actor: text(ctx.actor, 160), keyHash: hashObject(["media", ctx.actor, ctx.idempotencyKey]) };
}
export function mediaAssetEtag(asset) {
  const { etag, ...snapshot } = asset;
  return `"${hashObject(snapshot)}"`;
}
function dto(asset) { return { ...structuredClone(asset), etag: mediaAssetEtag(asset) }; }
function findAsset(state, id) {
  if (!IDS.test(id ?? "")) fail(404, "MEDIA_NOT_FOUND", "素材不存在。");
  const asset = (state.mediaAssets ?? []).find(item => item.id === id);
  if (!asset) fail(404, "MEDIA_NOT_FOUND", "素材不存在。");
  return asset;
}
function match(asset, ctx) {
  if (!ctx.ifMatch) fail(428, "IF_MATCH_REQUIRED", "请读取当前素材版本后重试。");
  if (ctx.ifMatch !== mediaAssetEtag(asset)) fail(412, "MEDIA_VERSION_CONFLICT", "素材已改变，请刷新后重试。");
}
function replay(state, ctx, fingerprint) {
  const prior = (state.mediaAssetRequests ?? []).find(item => item.keyHash === ctx.keyHash);
  if (!prior) return null;
  if (prior.fingerprint !== fingerprint) fail(409, "IDEMPOTENCY_CONFLICT", "此幂等键已用于不同请求。");
  return structuredClone(prior.result);
}
function remember(state, ctx, fingerprint, result, at) {
  state.mediaAssetRequests ??= [];
  state.mediaAssetRequests.push({ keyHash: ctx.keyHash, fingerprint, result: structuredClone(result), at });
}
function serial(store, action) {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.then(action);
  queues.set(store, run.catch(() => undefined));
  return run;
}
async function noSymlinkAncestors(path) {
  const root = parse(path).root;
  let current = root;
  for (const part of path.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail(503, "MEDIA_UNSAFE_STORAGE", "素材存储目录不安全。");
  }
}
function privateOrdinary(info, directory = false) {
  return (directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink()
    && (own === undefined || info.uid === own) && (info.mode & 0o077) === 0;
}
function formatError() { fail(415, "MEDIA_INVALID_FORMAT", "文件内容与支持的图片、MP4 或纯文本 VTT 格式不符。"); }
function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > 16384 || height > 16384 || width * height > 64000000) formatError();
  return { width, height };
}
function png(data) {
  if (!data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) formatError();
  let offset = 8, size, image, depth, color, interlace, palette = false, ended = false, idat = false, pastIdat = false;
  const compressed = [];
  while (offset < data.length) {
    if (offset + 12 > data.length) formatError();
    size = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const end = offset + size + 12;
    if (!/^[A-Za-z]{4}$/.test(type) || end > data.length || crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) formatError();
    if (offset === 8 && type !== "IHDR") formatError();
    if (type === "IHDR") {
      if (image || size !== 13) formatError();
      image = dimensions(data.readUInt32BE(offset + 8), data.readUInt32BE(offset + 12));
      depth = data[offset + 16]; color = data[offset + 17]; interlace = data[offset + 20];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || data[offset + 18] !== 0 || data[offset + 19] !== 0 || data[offset + 20] > 1) formatError();
    } else if (type === "IDAT") {
      if (pastIdat || (color === 3 && !palette)) formatError();
      idat = true;
      compressed.push(data.subarray(offset + 8, end - 4));
    } else {
      if (idat) pastIdat = true;
      if (type === "IEND") {
        if (size !== 0 || end !== data.length || !idat) formatError();
        ended = true;
      } else if (type === "PLTE") {
        if (palette || idat || [0, 4].includes(color) || size < 3 || size > 768 || size % 3 !== 0 || (color === 3 && size / 3 > 2 ** depth)) formatError();
        palette = true;
      } else if (type[0] === type[0].toUpperCase() || ["acTL", "fcTL", "fdAT"].includes(type)) formatError();
    }
    offset = end;
  }
  if (!image || !ended) formatError();
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const rows = passes.map(([x, y, dx, dy]) => {
    const width = Math.max(0, Math.ceil((image.width - x) / dx));
    const height = Math.max(0, Math.ceil((image.height - y) / dy));
    return { height: width ? height : 0, bytes: Math.ceil(width * channels * depth / 8) + 1 };
  });
  const expected = rows.reduce((total, row) => total + row.height * row.bytes, 0);
  if (expected < 1 || expected > 128 * MiB) formatError();
  let decoded;
  try {
    const input = Buffer.concat(compressed);
    const inflated = inflateSync(input, { maxOutputLength: expected + 1, info: true });
    if (inflated.engine.bytesWritten !== input.length || inflated.buffer.length !== expected) formatError();
    decoded = inflated.buffer;
  } catch { formatError(); }
  let scanline = 0;
  for (const row of rows) {
    for (let index = 0; index < row.height; index++) {
      if (decoded[scanline] > 4) formatError();
      scanline += row.bytes;
    }
  }
  return image;
}
function jpeg(data) {
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) formatError();
  let offset = 2, image, scans = 0;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) formatError();
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (offset !== data.length || !image || !scans) formatError();
      return image;
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > data.length) formatError();
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) formatError();
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (image || size < 8 || data[offset + 2] !== 8) formatError();
      image = dimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) formatError();
    offset += size;
    if (marker === 0xda) {
      scans++;
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset++; continue; }
        const next = data[offset + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        if (next === 0xff) { offset++; continue; }
        break;
      }
    }
  }
  formatError();
}
function webp(data) {
  if (data.length < 20 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WEBP"
    || data.readUInt32LE(4) + 8 !== data.length) formatError();
  let offset = 12, image, encoded = false;
  const seen = new Set();
  while (offset < data.length) {
    if (offset + 8 > data.length) formatError();
    const type = data.toString("ascii", offset, offset + 4), size = data.readUInt32LE(offset + 4), start = offset + 8;
    const end = start + size;
    if (end + (size & 1) > data.length || seen.has(type) || !["VP8 ", "VP8L", "VP8X", "ALPH", "ICCP", "EXIF", "XMP "].includes(type)) formatError();
    seen.add(type);
    if (type === "VP8X") {
      if (offset !== 12 || size !== 10 || (data[start] & 0xc3) || data.readUIntLE(start + 1, 3) !== 0) formatError();
      image = dimensions(data.readUIntLE(start + 4, 3) + 1, data.readUIntLE(start + 7, 3) + 1);
    } else if (type === "VP8 ") {
      if (size < 10 || encoded || (data[start] & 1) || data.toString("hex", start + 3, start + 6) !== "9d012a") formatError();
      const actual = dimensions(data.readUInt16LE(start + 6) & 0x3fff, data.readUInt16LE(start + 8) & 0x3fff);
      if (image && (image.width !== actual.width || image.height !== actual.height)) formatError();
      image = actual; encoded = true;
    } else if (type === "VP8L") {
      if (size < 5 || encoded || data[start] !== 0x2f || (data[start + 4] & 0xe0)) formatError();
      const packed = data.readUInt32LE(start + 1);
      const actual = dimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
      if (image && (image.width !== actual.width || image.height !== actual.height)) formatError();
      image = actual; encoded = true;
    }
    if ((size & 1) && data[end] !== 0) formatError();
    offset = end + (size & 1);
  }
  if (!image || !encoded) formatError();
  return image;
}
function boxes(data, start = 0, end = data.length) {
  const result = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end || result.length > 100000) formatError();
    let size = data.readUInt32BE(offset), header = 8;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > end) formatError();
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) formatError();
      size = Number(large); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end || !/^[\x20-\x7e]{4}$/.test(type)) formatError();
    result.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}
function mp4(data) {
  const top = boxes(data);
  if (top[0]?.type !== "ftyp" || top.filter(box => box.type === "ftyp").length !== 1 || top[0].end - top[0].start < 8
    || top.filter(box => box.type === "moov").length !== 1 || !top.some(box => box.type === "mdat" && box.end > box.start)
    || top.some(box => !["ftyp", "moov", "mdat", "free", "skip", "wide", "moof", "mfra", "sidx", "styp"].includes(box.type))) formatError();
  const filetype = top[0];
  if ((filetype.end - filetype.start) % 4 !== 0) formatError();
  const brands = [data.toString("ascii", filetype.start, filetype.start + 4)];
  for (let offset = filetype.start + 8; offset < filetype.end; offset += 4) brands.push(data.toString("ascii", offset, offset + 4));
  if (!brands.some(brand => /^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash)$/.test(brand))) formatError();
  const moov = top.find(box => box.type === "moov");
  const movie = boxes(data, moov.start, moov.end);
  if (!movie.some(box => box.type === "mvhd") || !movie.some(box => box.type === "trak")) formatError();
  let video = false;
  for (const track of movie.filter(box => box.type === "trak")) {
    const children = boxes(data, track.start, track.end);
    const mdia = children.find(box => box.type === "mdia");
    if (!children.some(box => box.type === "tkhd") || !mdia) formatError();
    const media = boxes(data, mdia.start, mdia.end);
    const handler = media.find(box => box.type === "hdlr");
    if (!handler || handler.end - handler.start < 12) formatError();
    const type = data.toString("ascii", handler.start + 8, handler.start + 12);
    if (!["vide", "soun"].includes(type)) formatError();
    video ||= type === "vide";
    const minf = media.find(box => box.type === "minf");
    if (!minf) formatError();
    const info = boxes(data, minf.start, minf.end);
    const dinf = info.find(box => box.type === "dinf");
    if (!dinf || !info.some(box => box.type === "stbl")) formatError();
    const dref = boxes(data, dinf.start, dinf.end).find(box => box.type === "dref");
    if (!dref || dref.end - dref.start < 8) formatError();
    const refs = boxes(data, dref.start + 8, dref.end);
    if (refs.length !== data.readUInt32BE(dref.start + 4) || refs.some(ref => ref.type !== "url " || ref.end - ref.start !== 4
      || (data.readUInt32BE(ref.start) & 0xffffff) !== 1)) formatError();
  }
  if (!video) formatError();
  return {};
}
function caption(data) {
  if (data.length > MiB) formatError();
  let value;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { formatError(); }
  value = value.replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t][^\n]*)?\n\n/.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) formatError();
  const groups = value.trimEnd().split(/\n{2,}/).slice(1);
  let previous = -1, count = 0;
  const stamp = input => {
    const found = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(input);
    if (!found) formatError();
    return ((Number(found[1] ?? 0) * 60 + Number(found[2])) * 60 + Number(found[3])) * 1000 + Number(found[4]);
  };
  const identifiers = new Set();
  for (const group of groups) {
    if (/^NOTE(?:[ \t\n]|$)/.test(group)) continue;
    const lines = group.split("\n");
    if (!lines[0].includes("-->")) {
      const id = lines.shift();
      if (!id || identifiers.has(id) || /[<>]/.test(id)) formatError();
      identifiers.add(id);
    }
    const timing = /^(\S+)[ \t]+-->[ \t]+(\S+)$/.exec(lines.shift() ?? "");
    if (!timing || !lines.length || lines.some(line => /[<>]|-->/.test(line))) formatError();
    const start = stamp(timing[1]), end = stamp(timing[2]);
    if (start < previous || end <= start || !Number.isSafeInteger(end)) formatError();
    previous = start; count++;
  }
  if (!count) formatError();
  return {};
}
function inspect(data, mime) {
  if (mime === "image/png") return png(data);
  if (mime === "image/jpeg") return jpeg(data);
  if (mime === "image/webp") return webp(data);
  if (mime === "video/mp4") return mp4(data);
  return caption(data);
}
async function hashHandle(handle, size) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) fail(503, "MEDIA_BYTES_UNAVAILABLE", "素材文件不完整。");
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest("hex");
}

export class MediaAssets {
  #store; #root; #objects; #staging; #maxAsset; #maxTotal; #authorizer; #initialized = false;
  #verified = new Map();
  constructor({ store, maxAssetBytes = 50 * MiB, maxTotalBytes = 500 * MiB, publicAssetAuthorizer = () => false }) {
    if (!store?.filePath || !Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1 || !Number.isSafeInteger(maxTotalBytes)
      || maxTotalBytes < maxAssetBytes || typeof publicAssetAuthorizer !== "function") throw new TypeError("Invalid media configuration.");
    this.#store = store;
    this.#root = join(dirname(resolve(store.filePath)), "media-assets");
    this.#objects = join(this.#root, "objects"); this.#staging = join(this.#root, "staging");
    this.#maxAsset = maxAssetBytes; this.#maxTotal = maxTotalBytes; this.#authorizer = publicAssetAuthorizer;
  }
  async initialize() {
    await noSymlinkAncestors(dirname(this.#root));
    for (const path of [this.#root, this.#objects, this.#staging]) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "素材目录创建失败。"); }
      if (!privateOrdinary(await lstat(path), true)) fail(503, "MEDIA_UNSAFE_STORAGE", "素材目录需要私有权限与受控所有者。");
    }
    this.#initialized = true;
    return { maxAssetBytes: this.#maxAsset, maxTotalBytes: this.#maxTotal, allowedTypes: Object.keys(KINDS) };
  }
  async #directories() {
    if (!this.#initialized) fail(503, "MEDIA_NOT_READY", "素材存储尚未初始化。");
    await noSymlinkAncestors(dirname(this.#root));
    for (const path of [this.#root, this.#objects, this.#staging]) {
      if (!privateOrdinary(await lstat(path), true)) fail(503, "MEDIA_UNSAFE_STORAGE", "素材目录不安全。");
    }
  }
  async #usage() {
    let total = 0;
    for (const path of [this.#objects, this.#staging]) {
      for (const name of await readdir(path)) {
        const info = await lstat(join(path, name));
        if (!privateOrdinary(info) || info.nlink !== 1) fail(503, "MEDIA_UNSAFE_STORAGE", "素材存储含有不安全的文件。");
        total += info.size;
        if (!Number.isSafeInteger(total)) fail(503, "MEDIA_UNSAFE_STORAGE", "素材存储大小无效。");
      }
    }
    return total;
  }
  listAssets() { return { items: (this.#store.snapshot().mediaAssets ?? []).map(dto) }; }
  getAsset(id) { return dto(findAsset(this.#store.snapshot(), id)); }
  async upload(readable, metadata, incoming) {
    const ctx = context(incoming);
    if (!object(metadata) || Object.keys(metadata).some(key => !["contentType", "contentLength", "name", "expectedSha256"].includes(key))) {
      fail(400, "MEDIA_INVALID_INPUT", "上传元数据无效。");
    }
    const mime = String(metadata.contentType ?? "").toLowerCase().trim();
    const normalizedMime = mime === "text/vtt; charset=utf-8" ? "text/vtt" : mime;
    if (!KINDS[normalizedMime]) fail(415, "MEDIA_UNSUPPORTED_TYPE", "支持 PNG、JPEG、静态 WebP、MP4 和纯文本 VTT。");
    const name = metadata.name === undefined ? undefined : text(metadata.name, 180);
    if (name && /[\\/]/.test(name)) fail(400, "MEDIA_INVALID_NAME", "素材名称不能包含路径。");
    const length = metadata.contentLength === undefined || metadata.contentLength === null ? null : Number(metadata.contentLength);
    if (length !== null && (!Number.isSafeInteger(length) || length < 1)) fail(400, "MEDIA_INVALID_LENGTH", "上传长度无效。");
    if (length !== null && length > this.#maxAsset) fail(413, "MEDIA_TOO_LARGE", "单个素材超过上传大小限制。");
    if (metadata.expectedSha256 !== undefined && !SHA.test(metadata.expectedSha256)) fail(400, "MEDIA_INVALID_HASH", "素材哈希无效。");
    if (!readable?.[Symbol.asyncIterator]) fail(400, "MEDIA_INVALID_BODY", "请发送二进制素材正文。");
    return serial(this.#store, async () => {
      await this.#directories();
      const prior = (this.#store.snapshot().mediaAssetRequests ?? []).find(item => item.keyHash === ctx.keyHash);
      const used = await this.#usage();
      // A stable opaque ID lets a retry recover the narrow crash window between
      // immutable object creation and the atomic state/journal commit.
      const id = `MED-${hashObject(["media-upload", ctx.keyHash]).slice(0, 32)}`;
      const finalPath = join(this.#objects, `${id}.bin`);
      let orphan = null;
      if (!prior) {
        try { orphan = await lstat(finalPath); }
        catch (error) { if (error.code !== "ENOENT") throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "素材存储读取失败。"); }
      }
      const temporary = join(this.#staging, `${randomBytes(16).toString("hex")}.upload`);
      let handle, temporaryOwned = false, finalOwned = false, committed = false;
      try {
        if (!prior && !orphan) {
          if (length !== null && used + length > this.#maxTotal) fail(413, "MEDIA_QUOTA_EXCEEDED", "素材总容量已达限制。");
          handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          temporaryOwned = true;
        }
        const hash = createHash("sha256"); let size = 0;
        for await (const value of readable) {
          if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(400, "MEDIA_INVALID_BODY", "素材正文必须为二进制。");
          const chunk = Buffer.from(value);
          size += chunk.length;
          if (size > this.#maxAsset || (length !== null && size > length)) fail(413, "MEDIA_TOO_LARGE", "素材超过允许的上传长度。");
          if (!prior && !orphan && used + size > this.#maxTotal) fail(413, "MEDIA_QUOTA_EXCEEDED", "素材总容量已达限制。");
          hash.update(chunk);
          if (handle) await handle.writeFile(chunk);
        }
        if (!size || (length !== null && length !== size)) fail(400, "MEDIA_LENGTH_MISMATCH", "素材正文长度不完整。");
        const sha256 = hash.digest("hex");
        if (metadata.expectedSha256 && metadata.expectedSha256 !== sha256) fail(400, "MEDIA_HASH_MISMATCH", "上传文件哈希与预期不符。");
        const fingerprint = hashObject({ operation: "upload", mime: normalizedMime, name: name ?? null, sha256, size });
        if (prior) return replay(this.#store.snapshot(), ctx, fingerprint);
        if (orphan) {
          handle = await open(finalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const info = await handle.stat();
          if (!privateOrdinary(info) || info.nlink !== 1 || info.size !== size || await hashHandle(handle, size) !== sha256) {
            fail(409, "MEDIA_RECOVERY_CONFLICT", "此上传键的待恢复文件与请求不符，请保留文件并检查恢复记录。");
          }
        } else await handle.sync();
        // Positional reads keep validation independent of the completed
        // streaming write offset. The bounded file never goes through JSON.
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const read = await handle.read(bytes, offset, size - offset, offset);
          if (!read.bytesRead) fail(503, "MEDIA_BYTES_UNAVAILABLE", "上传素材读取失败。");
          offset += read.bytesRead;
        }
        const parsed = inspect(bytes, normalizedMime);
        if (!orphan) await handle.chmod(0o400);
        await handle.close(); handle = null;
        await this.#directories();
        if (!orphan) {
          await link(temporary, finalPath); finalOwned = true;
          await unlink(temporary); temporaryOwned = false;
        }
        const asset = { id, sha256, size, mime: normalizedMime, kind: KINDS[normalizedMime], status: "staged", ...parsed,
          ...(name ? { name } : {}), createdAt: new Date().toISOString(), createdBy: ctx.actor };
        const result = dto(asset);
        const transaction = await this.#store.mutate({ type: "media.uploaded", actor: ctx.actor, payload: { assetId: id, sha256, size } }, state => {
          const previous = replay(state, ctx, fingerprint);
          if (previous) return JsonStore.noChange(previous);
          state.mediaAssets ??= [];
          if (state.mediaAssets.some(item => item.id === id)) fail(409, "MEDIA_RECOVERY_CONFLICT", "素材标识已存在，请检查恢复记录。");
          state.mediaAssets.push(asset);
          remember(state, ctx, fingerprint, result, asset.createdAt);
          return result;
        });
        committed = true;
        return transaction.result;
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (readable.aborted || ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"].includes(error.code)) {
          throw new ApiError(400, "MEDIA_UPLOAD_INTERRUPTED", "素材上传中断，请使用同一幂等键重试。");
        }
        throw new ApiError(503, "MEDIA_STORAGE_UNAVAILABLE", "素材保存失败，请使用同一幂等键重试。");
      } finally {
        if (handle) await handle.close();
        if (temporaryOwned) await unlink(temporary);
        if (finalOwned && !committed) await unlink(finalPath);
      }
    });
  }
  async review(id, input, incoming) {
    const ctx = context(incoming);
    if (!object(input) || Object.keys(input).some(key => !["sha256", "rightsConfirmed", "privacyConfirmed", "rightsNote"].includes(key))
      || !SHA.test(input.sha256 ?? "") || input.rightsConfirmed !== true || input.privacyConfirmed !== true) {
      fail(400, "MEDIA_REVIEW_REQUIRED", "请核对文件哈希，并确认版权授权与隐私检查。");
    }
    const rightsNote = text(input.rightsNote, 2000, true, true);
    const fingerprint = hashObject({ operation: "review", id, sha256: input.sha256, rightsNote, rightsConfirmed: true, privacyConfirmed: true });
    return (await this.#store.mutate({ type: "media.reviewed", actor: ctx.actor, payload: { assetId: id, sha256: input.sha256 } }, async state => {
      const previous = replay(state, ctx, fingerprint);
      if (previous) return JsonStore.noChange(previous);
      const asset = findAsset(state, id); match(asset, ctx);
      if (asset.sha256 !== input.sha256) fail(409, "MEDIA_HASH_MISMATCH", "审核哈希与当前文件不符。");
      if (asset.status === "revoked") fail(409, "MEDIA_REVOKED", "已撤销素材不能重新审核，请重新上传。");
      const opened = await this.openVerifiedAsset(id, { state });
      await opened.handle.close();
      asset.status = "reviewed";
      asset.review = { sha256: input.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote, reviewedBy: ctx.actor, reviewedAt: new Date().toISOString() };
      const result = dto(asset); remember(state, ctx, fingerprint, result, asset.review.reviewedAt);
      return result;
    })).result;
  }
  async revoke(id, input, incoming) {
    const ctx = context(incoming);
    if (!object(input) || Object.keys(input).some(key => key !== "reason")) fail(400, "MEDIA_INVALID_INPUT", "撤销输入无效。");
    const reason = text(input.reason, 2000, true, true), fingerprint = hashObject({ operation: "revoke", id, reason });
    return (await this.#store.mutate({ type: "media.revoked", actor: ctx.actor, payload: { assetId: id, reason } }, state => {
      const previous = replay(state, ctx, fingerprint);
      if (previous) return JsonStore.noChange(previous);
      const asset = findAsset(state, id); match(asset, ctx);
      asset.status = "revoked"; asset.revocation = { reason, revokedBy: ctx.actor, revokedAt: new Date().toISOString() };
      const result = dto(asset); remember(state, ctx, fingerprint, result, asset.revocation.revokedAt); return result;
    })).result;
  }
  async openVerifiedAsset(id, { sha256, publicAccess = false, state, forceVerify = false } = {}) {
    const asset = findAsset(state ?? this.#store.snapshot(), id);
    if (!SHA.test(asset.sha256 ?? "") || !KINDS[asset.mime] || asset.kind !== KINDS[asset.mime] || !Number.isSafeInteger(asset.size)
      || asset.size < 1 || asset.size > this.#maxAsset) fail(503, "MEDIA_METADATA_INVALID", "素材元数据无效。");
    if (sha256 !== undefined && sha256 !== asset.sha256) fail(404, "MEDIA_NOT_FOUND", "素材不存在。");
    if (publicAccess) {
      let allowed = false;
      try { allowed = this.#authorizer(id, asset.sha256) === true; } catch { allowed = false; }
      if (sha256 === undefined || asset.status !== "reviewed" || asset.review?.sha256 !== asset.sha256
        || asset.review?.rightsConfirmed !== true || asset.review?.privacyConfirmed !== true || !allowed) fail(404, "MEDIA_NOT_FOUND", "素材不存在。");
    }
    let handle;
    try {
      await this.#directories();
      handle = await open(join(this.#objects, `${id}.bin`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = await handle.stat();
      const signature = hashObject([info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs, asset.sha256]);
      if (!privateOrdinary(info) || info.nlink !== 1 || info.size !== asset.size) {
        fail(503, "MEDIA_BYTES_UNAVAILABLE", "素材文件不完整或校验失败。");
      }
      if (forceVerify || this.#verified.get(id) !== signature) {
        if (await hashHandle(handle, info.size) !== asset.sha256) fail(503, "MEDIA_BYTES_UNAVAILABLE", "素材文件校验失败。");
        const after = await handle.stat();
        if (signature !== hashObject([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs, asset.sha256])) fail(503, "MEDIA_BYTES_UNAVAILABLE", "素材校验期间文件发生改变。");
        this.#verified.set(id, signature);
      }
      // Revocation or withdrawal may have committed while the file was hashed.
      if (publicAccess) {
        const current = findAsset(this.#store.snapshot(), id);
        let allowed = false;
        try { allowed = this.#authorizer(id, asset.sha256) === true; } catch { allowed = false; }
        if (current.status !== "reviewed" || current.sha256 !== asset.sha256 || current.review?.sha256 !== asset.sha256
          || current.review?.rightsConfirmed !== true || current.review?.privacyConfirmed !== true || !allowed) fail(404, "MEDIA_NOT_FOUND", "素材不存在。");
      }
      return { asset: dto(asset), handle };
    } catch (error) {
      if (handle) await handle.close();
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "MEDIA_BYTES_UNAVAILABLE", "素材文件暂不可用。");
    }
  }
  async verifyForRelease(refs) {
    if (!Array.isArray(refs) || refs.length > 100) fail(400, "MEDIA_INVALID_REFERENCES", "素材引用列表无效。");
    const result = [];
    for (const ref of refs) {
      if (!object(ref) || !IDS.test(ref.assetId ?? "") || !SHA.test(ref.sha256 ?? "") || !ROLES[ref.role]) fail(400, "MEDIA_INVALID_REFERENCES", "素材引用必须包含准确标识、哈希和用途。");
      const asset = findAsset(this.#store.snapshot(), ref.assetId);
      if (asset.sha256 !== ref.sha256 || asset.status !== "reviewed" || asset.review?.sha256 !== ref.sha256
        || asset.review?.rightsConfirmed !== true || asset.review?.privacyConfirmed !== true || asset.kind !== ROLES[ref.role]) {
        fail(409, "MEDIA_NOT_APPROVED", "发布引用的素材未通过当前版本审核。");
      }
      const opened = await this.openVerifiedAsset(asset.id, { sha256: ref.sha256, forceVerify: true });
      try {
        const bytes = Buffer.alloc(asset.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) fail(503, "MEDIA_BYTES_UNAVAILABLE", "素材读取失败。");
          offset += read.bytesRead;
        }
        inspect(bytes, asset.mime);
        result.push(opened.asset);
      } finally { await opened.handle.close(); }
    }
    return result;
  }
}
