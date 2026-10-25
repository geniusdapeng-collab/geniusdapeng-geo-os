import { ApiError } from "../domain/errors.mjs";
import { serveMediaAsset } from "./media-assets.mjs";

const ID = "([A-Za-z0-9_-]{1,100})";

function query(input, allowed) {
  for (const key of input.keys()) {
    if (!allowed.includes(key) || input.getAll(key).length !== 1) {
      throw new ApiError(400, "EDITORIAL_QUERY_INVALID", "查询参数无效或重复。");
    }
  }
}

function context(request, principal) {
  if (principal?.method === "agent") {
    throw new ApiError(403, "AGENT_SCOPE_DENIED", "受限 Agent 无权编辑、审批或发布官网内容。");
  }
  return {
    actor: principal?.actor || "PengManager",
    method: principal?.method || "local",
    idempotencyKey: request.headers["idempotency-key"],
    ifMatch: request.headers["if-match"],
  };
}

function send(response, status, payload, writeJson) {
  writeJson(response, status, payload, payload?.etag ? { ETag: payload.etag } : {});
}

// Called only after the existing administrator authentication and source checks.
// No route in this module grants or broadens the restricted bearer capability.
export async function routeEditorialApi({
  request, response, url, principal, editorial, mediaAssets, readJsonBody,
  writeJson, methodNotAllowed,
}) {
  if (!editorial) return false;
  const path = url.pathname;
  const fixed = {
    "/api/editorial/bootstrap": { GET: () => editorial.bootstrap() },
    "/api/platforms": { GET: () => editorial.catalog() },
    "/api/accounts": {
      GET: () => editorial.listAccounts(),
      POST: (body, ctx) => editorial.createAccount(body, ctx),
    },
    "/api/destinations": {
      GET: () => editorial.listDestinations(),
      POST: (body, ctx) => editorial.createDestination(body, ctx),
    },
    "/api/stories": {
      GET: () => editorial.listStories(),
      POST: (body, ctx) => editorial.createStory(body, ctx),
    },
    "/api/website/releases": {
      GET: () => editorial.listReleases(),
      POST: (body, ctx) => editorial.createRelease(body, ctx),
    },
  };
  const patterns = [
    [new RegExp(`^/api/accounts/${ID}$`), (id) => ({
      GET: () => editorial.getAccount(id),
      PATCH: (body, ctx) => editorial.updateAccount(id, body, ctx),
    })],
    [new RegExp(`^/api/accounts/${ID}/history$`), (id) => ({ GET: () => editorial.accountHistory(id) })],
    [new RegExp(`^/api/destinations/${ID}$`), (id) => ({
      GET: () => editorial.getDestination(id),
      PATCH: (body, ctx) => editorial.updateDestination(id, body, ctx),
    })],
    [new RegExp(`^/api/stories/${ID}$`), (id) => ({
      GET: () => editorial.getStory(id),
      PATCH: (body, ctx) => editorial.updateStory(id, body, ctx),
    })],
    [new RegExp(`^/api/stories/${ID}/editions$`), (id) => ({
      POST: (body, ctx) => editorial.createEdition(id, body, ctx),
    })],
    [new RegExp(`^/api/editions/${ID}$`), (id) => ({ GET: () => editorial.getEdition(id) })],
    [new RegExp(`^/api/editions/${ID}/variants$`), (id) => ({
      POST: (body, ctx) => editorial.createVariant(id, body, ctx),
    })],
    [new RegExp(`^/api/editorial/variants/${ID}$`), (id) => ({ GET: () => editorial.getVariant(id) })],
    [new RegExp(`^/api/website/releases/${ID}$`), (id) => ({ GET: () => editorial.getRelease(id) })],
    [new RegExp(`^/api/website/releases/${ID}/(approve|publish|verify|withdraw)$`), (id, action) => ({
      POST: (body, ctx) => editorial[`${action}Release`](id, body, ctx),
    })],
  ];
  let methods = fixed[path];
  if (!methods) {
    for (const [pattern, resolve] of patterns) {
      const matched = path.match(pattern);
      if (matched) { methods = resolve(...matched.slice(1)); break; }
    }
  }
  const transition = path.match(new RegExp(`^/api/content/${ID}/transition$`));
  if (transition && editorial.ownsVariant(transition[1])) {
    methods = { POST: (body, ctx) => editorial.transitionVariant(transition[1], body, ctx) };
  }
  if (methods) {
    const ctx = context(request, principal);
    query(url.searchParams, []);
    const handler = methods[request.method];
    if (!handler) { methodNotAllowed(response, Object.keys(methods)); return true; }
    const body = request.method === "GET" ? undefined : await readJsonBody(request);
    const payload = await handler(body, ctx);
    send(response, request.method === "POST" && !/\/(?:approve|publish|verify|withdraw|transition)$/.test(path) ? 201 : 200, payload, writeJson);
    return true;
  }

  if (path === "/api/media/assets" || path.startsWith("/api/media/assets/")) {
    const ctx = context(request, principal);
    query(url.searchParams, []);
    if (!mediaAssets) throw new ApiError(503, "MEDIA_ASSETS_UNAVAILABLE", "媒体素材服务尚未就绪。");
    if (path === "/api/media/assets") {
      if (request.method === "GET") {
        send(response, 200, mediaAssets.listAssets(), writeJson);
      } else if (request.method === "POST") {
        let name = request.headers["x-media-name"];
        if (name !== undefined) {
          try { name = decodeURIComponent(name); }
          catch { throw new ApiError(400, "MEDIA_INVALID_NAME", "媒体名称编码无效。"); }
        }
        const payload = await mediaAssets.upload(request, {
          contentType: request.headers["content-type"],
          contentLength: request.headers["content-length"],
          name,
          expectedSha256: request.headers["x-content-sha256"],
        }, ctx);
        send(response, 201, payload, writeJson);
      } else methodNotAllowed(response, ["GET", "POST"]);
      return true;
    }
    const bytes = path.match(new RegExp(`^/api/media/assets/${ID}/bytes$`));
    if (bytes) {
      if (!["GET", "HEAD"].includes(request.method)) methodNotAllowed(response, ["GET", "HEAD"]);
      else await serveMediaAsset(request, response, { mediaAssets, assetId: bytes[1], publicAccess: false });
      return true;
    }
    const action = path.match(new RegExp(`^/api/media/assets/${ID}/(approve|review|revoke)$`));
    if (action) {
      if (request.method !== "POST") methodNotAllowed(response, ["POST"]);
      else send(response, 200, await mediaAssets[action[2] === "revoke" ? "revoke" : "review"](
        action[1], await readJsonBody(request), ctx,
      ), writeJson);
      return true;
    }
    const asset = path.match(new RegExp(`^/api/media/assets/${ID}$`));
    if (asset) {
      if (request.method !== "GET") methodNotAllowed(response, ["GET"]);
      else send(response, 200, mediaAssets.getAsset(asset[1]), writeJson);
      return true;
    }
    throw new ApiError(404, "MEDIA_ASSET_ENDPOINT_NOT_FOUND", "媒体素材接口不存在。");
  }
  return false;
}

// Only these two exact content read routes are anonymous. The whole private
// /api/content namespace remains under the original authentication boundary.
export function routePublicContentApi({ request, response, url, editorial, writeJson, methodNotAllowed }) {
  if (!editorial) return false;
  const detail = url.pathname.match(/^\/public-api\/content\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (url.pathname !== "/public-api/content" && !detail) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    methodNotAllowed(response, ["GET", "HEAD"]); return true;
  }
  query(url.searchParams, detail ? [] : ["locale", "format", "limit", "cursor"]);
  let payload;
  if (detail) {
    const [locale, format, slug] = detail.slice(1).map(part => {
      try { return decodeURIComponent(part); }
      catch { throw new ApiError(400, "EDITORIAL_PATH_INVALID", "内容地址编码无效。"); }
    });
    payload = editorial.publicDetail({ locale, format, slug });
  } else {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, "EDITORIAL_QUERY_INVALID", "limit 必须是 1 到 100 的整数。");
    }
    payload = editorial.publicList({
      locale: url.searchParams.get("locale") || "zh-CN",
      format: url.searchParams.get("format") || undefined,
      limit, cursor: url.searchParams.get("cursor") || undefined,
    });
  }
  // Eligibility is checked above on every request, including requests with old
  // validators. No cached 304 can make a revoked document visible again.
  if (request.method === "HEAD") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      ...(payload?.etag ? { ETag: payload.etag } : {}) });
    response.end();
  } else send(response, 200, payload, writeJson);
  return true;
}

export async function routePublicMedia({ request, response, url, mediaAssets, methodNotAllowed }) {
  const matched = url.pathname.match(/^\/public-media\/([A-Za-z0-9_-]{1,100})\/([a-f0-9]{64})$/);
  if (!matched) return false;
  if (!["GET", "HEAD"].includes(request.method)) {
    methodNotAllowed(response, ["GET", "HEAD"]); return true;
  }
  query(url.searchParams, []);
  if (!mediaAssets) throw new ApiError(404, "MEDIA_ASSET_NOT_FOUND", "素材不存在。");
  await serveMediaAsset(request, response, { mediaAssets, assetId: matched[1], sha256: matched[2], publicAccess: true });
  return true;
}
