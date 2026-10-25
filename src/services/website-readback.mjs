import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { ApiError } from "../domain/errors.mjs";
import { parsePublicRoute } from "../../public/publication-view.js";
import { renderWebsiteDocument } from "../http/public-website.mjs";

const fail = (code, message) => new ApiError(502, code, message);

export function createWebsiteReadback({ origin, fetchImpl = globalThis.fetch, timeoutMs = 15_000,
  maxDocumentBytes = 4 * 1024 * 1024, maxAssetBytes = 50 * 1024 * 1024, clock = () => new Date(),
  allowLoopback = false } = {}) {
  let base;
  try { base = new URL(origin); } catch { throw new Error("READBACK_ORIGIN_INVALID"); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
      !(base.protocol === "https:" || (allowLoopback && local && base.protocol === "http:"))) throw new Error("READBACK_ORIGIN_INVALID");
  let templatePromise;
  const template = () => templatePromise ??= readFile(new URL("../../public/site.html", import.meta.url), "utf8")
    .catch(error => { templatePromise = null; throw error; });

  async function read(path, maximum, expectedType, expectedSize, deadlineSignal) {
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw fail("READBACK_URL_INVALID", "回读地址必须属于当前受保护的官网 origin。");
    let result;
    const controller = new AbortController();
    try {
      result = await fetchImpl(url.href, { method: "GET", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(deadlineSignal ? [deadlineSignal] : [])]),
        headers: { Accept: expectedType, "Accept-Encoding": "identity", "Cache-Control": "no-cache" } });
      if (result.status !== 200 || (result.url && result.url !== url.href)) throw fail("READBACK_HTTP_MISMATCH", "官网回读状态或结果地址不符。");
      const type = result.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (type !== expectedType) throw fail("READBACK_MEDIA_TYPE_MISMATCH", "官网回读内容类型不符。");
      const declared = result.headers.get("content-length");
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw fail("READBACK_SIZE_INVALID", "官网回读体积无效或超过限制。");
      const chunks = []; let length = 0;
      if (!result.body) throw fail("READBACK_BODY_MISSING", "官网回读没有正文。");
      for await (const chunk of result.body) {
        length += chunk.length;
        if (length > maximum) throw fail("READBACK_SIZE_INVALID", "官网回读体积超过限制。");
        chunks.push(Buffer.from(chunk));
      }
      if ((declared && Number(declared) !== length) || (expectedSize !== undefined && expectedSize !== length)) throw fail("READBACK_SIZE_MISMATCH", "官网回读附件字节数不符。");
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw fail("READBACK_UNAVAILABLE", "官网真实回读未完成，请保留未验证状态后重试。");
    } finally {
      controller.abort();
    }
  }

  return async function verifyWebsite(expected) {
    const deadlineSignal = AbortSignal.timeout(30_000);
    if (!expected || typeof expected !== "object" || !/^\/(?:zh|en)\/(?:articles|visuals|videos)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expected.canonicalPath) ||
        expected.canonicalUrl !== `${base.origin}${expected.canonicalPath}` || !/^[a-f0-9]{64}$/.test(expected.snapshotHash)) throw fail("READBACK_SNAPSHOT_INVALID", "回读目标与已审核官网快照不符。");
    const route = parsePublicRoute(expected.canonicalPath);
    if (route.kind !== "detail" || route.locale !== expected.locale || route.format !== expected.format) throw fail("READBACK_SNAPSHOT_INVALID", "回读语言或栏目与快照不符。");
    const apiPath = `/public-api/content/${route.locale}/${route.format}/${route.slug}`;
    const jsonBytes = await read(apiPath, maxDocumentBytes, "application/json", undefined, deadlineSignal);
    let actual;
    try { actual = JSON.parse(jsonBytes.toString("utf8")); } catch { throw fail("READBACK_JSON_INVALID", "官网内容回读不是有效 JSON。"); }
    if (!isDeepStrictEqual(actual, JSON.parse(JSON.stringify(expected)))) throw fail("READBACK_CONTENT_MISMATCH", "官网正文、结构、来源或附件与已审核快照不一致。");
    const page = (await read(expected.canonicalPath, maxDocumentBytes, "text/html", undefined, deadlineSignal)).toString("utf8");
    const seeds = [...page.matchAll(/<script id="site-data" type="application\/json">([\s\S]*?)<\/script>/g)];
    let seed, profile;
    try {
      if (seeds.length !== 1) throw new Error("seed count");
      seed = JSON.parse(seeds[0][1]);
      profile = JSON.parse((await read("/public-api/profile", maxDocumentBytes, "application/json", undefined, deadlineSignal)).toString("utf8"));
    } catch { throw fail("READBACK_RENDER_MISMATCH", "官网初始 HTML 的内容数据区域不完整。"); }
    const listing = { items: [], total: 0, nextCursor: null };
    const profileWithoutTime = value => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "generatedAt")) : null;
    if (!isDeepStrictEqual(Object.keys(seed).sort(), ["detail", "listing", "profile", "route"]) ||
        !isDeepStrictEqual(seed.route, route) || !isDeepStrictEqual(seed.detail, actual) || !isDeepStrictEqual(seed.listing, listing) ||
        !profileWithoutTime(seed.profile) || !isDeepStrictEqual(profileWithoutTime(seed.profile), profileWithoutTime(profile))) {
      throw fail("READBACK_RENDER_MISMATCH", "官网浏览器载入的数据与真实公开回读不一致。");
    }
    const expectedPage = renderWebsiteDocument(await template(), route, { profile: seed.profile, listing, detail: actual }, { origin: base.origin });
    // The exact trusted template and validated hydration data bind the visible
    // article and subsequent browser rendering to the same approved document.
    if (page !== expectedPage) throw fail("READBACK_RENDER_MISMATCH", "官网初始 HTML 没有按已审核模板呈现完整内容。");
    const assetHashes = [];
    for (const asset of expected.assets) {
      if (asset.url !== `/public-media/${asset.assetId}/${asset.sha256}` || !/^[A-Za-z0-9_-]{1,100}$/.test(asset.assetId) || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
          !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxAssetBytes) throw fail("READBACK_ASSET_INVALID", "审核快照中的媒体地址或体积不符。");
      const bytes = await read(asset.url, maxAssetBytes, asset.mime, asset.size, deadlineSignal);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== asset.sha256) throw fail("READBACK_ASSET_MISMATCH", "官网媒体字节与审核哈希不一致。");
      if (!assetHashes.some(row => row.assetId === asset.assetId && row.sha256 === sha256)) assetHashes.push({ assetId: asset.assetId, sha256 });
    }
    return { releaseId: expected.releaseId, snapshotHash: expected.snapshotHash, canonicalUrl: expected.canonicalUrl,
      verifiedAt: clock().toISOString(), method: "server_readback", assetHashes };
  };
}
