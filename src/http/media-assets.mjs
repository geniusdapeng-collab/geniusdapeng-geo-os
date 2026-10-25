import { pipeline } from "node:stream/promises";
import { ApiError } from "../domain/errors.mjs";

function rangeFor(value, size) {
  if (typeof value !== "string" || !value.toLowerCase().startsWith("bytes=")) return null;
  const found = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!found || (!found[1] && !found[2])) return false;
  let start, end;
  if (!found[1]) {
    const count = Number(found[2]);
    if (!Number.isSafeInteger(count) || count < 1) return false;
    start = Math.max(0, size - count); end = size - 1;
  } else {
    start = Number(found[1]); end = found[2] ? Number(found[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

// Authentication/CSRF belongs to the HTTP router. Public reads independently
// recheck exact-release authorization in MediaAssets before any 200/206/304.
export async function serveMediaAsset(req, res, { mediaAssets, assetId, sha256, publicAccess = false }) {
  if (!["GET", "HEAD"].includes(req.method)) throw new ApiError(405, "METHOD_NOT_ALLOWED", "只支持读取素材。");
  const { asset, handle } = await mediaAssets.openVerifiedAsset(assetId, { sha256, publicAccess });
  let streaming = false;
  try {
    const etag = `"${asset.sha256}"`;
    const headers = {
      "Content-Type": asset.mime === "text/vtt" ? "text/vtt; charset=utf-8" : asset.mime,
      "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Accept-Ranges": "bytes", ETag: etag,
    };
    const conditions = String(req.headers["if-none-match"] ?? "").split(",").map(item => item.trim().replace(/^W\//, ""));
    if (conditions.includes(etag) || conditions.includes("*")) {
      res.writeHead(304, headers); res.end(); return;
    }
    let range = null;
    if (req.method === "GET" && (!req.headers["if-range"] || req.headers["if-range"] === etag)) {
      range = rangeFor(req.headers.range, asset.size);
    }
    if (range === false) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${asset.size}`, "Content-Length": "0" }); res.end(); return;
    }
    const start = range?.start ?? 0, end = range?.end ?? asset.size - 1;
    res.writeHead(range ? 206 : 200, { ...headers, "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${asset.size}` } : {}) });
    if (req.method === "HEAD") { res.end(); return; }
    streaming = true;
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } catch (error) {
    if (streaming || res.headersSent) {
      res.destroy(error);
      if (!["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE"].includes(error.code)) throw error;
      return;
    }
    throw error;
  } finally { await handle.close(); }
}
