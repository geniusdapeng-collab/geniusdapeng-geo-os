import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ApiError } from "../domain/errors.mjs";
import { SYSTEM_IDENTITY } from "../domain/identity.mjs";
import { readVideoRuntime } from "./video-runtime.mjs";
import { routeEditorialApi, routePublicContentApi, routePublicMedia } from "./editorial-routes.mjs";
import { createPublicWebsite } from "./public-website.mjs";

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
  ".svg": "image/svg+xml",
});

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy":
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; " +
      "script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function parseLimit(raw, fallback, maximum, field) {
  if (raw === null || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ApiError(
      400,
      "INVALID_LIMIT",
      `${field} 必须是 1 到 ${maximum} 之间的整数。`,
    );
  }
  return value;
}

function validateRequestSource(request, allowedHosts) {
  const hostHeader = request.headers.host;
  if (!hostHeader) {
    throw new ApiError(400, "HOST_REQUIRED", "请求缺少 Host 头。");
  }

  let requestUrl;
  try {
    requestUrl = new URL(`http://${hostHeader}`);
  } catch {
    throw new ApiError(400, "HOST_INVALID", "请求 Host 头无效。");
  }

  const hostname = requestUrl.hostname.toLowerCase();
  const allowed = new Set(allowedHosts.map((value) => String(value).toLowerCase()));
  if (!allowed.has(hostname)) {
    throw new ApiError(403, "HOST_NOT_ALLOWED", "服务只接受显式允许的本地 Host。");
  }

  const fetchSite = String(request.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (fetchSite === "cross-site") {
    throw new ApiError(
      403,
      "CROSS_ORIGIN_REQUEST_BLOCKED",
      "拒绝跨站浏览器写入请求。",
    );
  }

  const origin = request.headers.origin;
  if (origin) {
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      throw new ApiError(403, "CROSS_ORIGIN_REQUEST_BLOCKED", "请求 Origin 无效。");
    }
    if (
      !["http:", "https:"].includes(originUrl.protocol) ||
      originUrl.host.toLowerCase() !== requestUrl.host.toLowerCase()
    ) {
      throw new ApiError(
        403,
        "CROSS_ORIGIN_REQUEST_BLOCKED",
        "拒绝跨站浏览器写入请求。",
      );
    }
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new ApiError(413, "BODY_TOO_LARGE", "请求体超过 1 MB。");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "INVALID_JSON", "请求体不是有效 JSON。");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_INPUT", "请求体必须是 JSON 对象。");
  }
  return body;
}

function writeJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function methodNotAllowed(response, allow) {
  response.writeHead(405, {
    ...securityHeaders(),
    Allow: allow.join(", "),
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "方法不允许。" } }));
}

async function serveStatic(request, response, publicDir, pathname) {
  if (!["GET", "HEAD"].includes(request.method)) {
    methodNotAllowed(response, ["GET", "HEAD"]);
    return;
  }

  const requested = pathname === "/" ? "/index.html" : pathname;
  const relative = requested.replace(/^\/+/, "");
  const filePath = resolve(publicDir, normalize(relative));
  const root = resolve(publicDir);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    throw new ApiError(404, "NOT_FOUND", "资源不存在。");
  }

  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ApiError(404, "NOT_FOUND", "资源不存在。");
    }
    throw error;
  }

  if (!info.isFile()) {
    throw new ApiError(404, "NOT_FOUND", "资源不存在。");
  }

  const headers = {
    ...securityHeaders(),
    "Content-Type": MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
    "Content-Length": info.size,
    "Cache-Control": "no-cache",
  };
  response.writeHead(200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => response.destroy());
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}

export function createGeoOsServer({
  service,
  livePipeline,
  geoEngine,
  videoRuntime,
  publicDir,
  allowedHosts = ["127.0.0.1", "localhost", "::1"],
  auth,
  accountOperations,
  editorial,
  mediaAssets,
  publicWebsite = false,
  mediaRenderEnabled = true,
}) {
  const routeWebsite = createPublicWebsite({ publicDir, editorial, service, securityHeaders });
  let shuttingDown = false;
  const server = createServer(async (request, response) => {
    try {
      // Byte helpers write their own protocol headers while retaining these
      // defaults, including an error after a stream has started.
      for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
      if (shuttingDown) {
        writeJson(response, 503, { error: { code: "APPLICATION_STOPPING", message: "服务正在受控重启，请稍后重试。" } }, { Connection: "close" });
        return;
      }
      if (auth) auth.validateRequestSource(request, allowedHosts);
      else validateRequestSource(request, allowedHosts);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const path = url.pathname;

      if (path === "/healthz") {
        if (!["GET", "HEAD"].includes(request.method)) {
          methodNotAllowed(response, ["GET", "HEAD"]);
          return;
        }
        writeJson(response, 200, { ok: true, service: SYSTEM_IDENTITY.id });
        return;
      }

      if (path === "/public-api/profile") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.publicPreview());
        return;
      }
      if (routePublicContentApi({ request, response, url, editorial, writeJson, methodNotAllowed })) return;
      if (await routePublicMedia({ request, response, url, mediaAssets, methodNotAllowed })) return;

      if (path === "/api/auth/status") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, auth?.status(request) ?? { enabled: false, authenticated: true, actor: "PengManager", method: "local" });
        return;
      }
      if (path === "/api/auth/login") {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        if (!auth?.enabled) throw new ApiError(409, "AUTH_NOT_ENABLED", "本地模式未启用管理员登录。");
        const body = await readJsonBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.password !== "string") {
          throw new ApiError(400, "INVALID_INPUT", "登录请求必须包含密码文本。");
        }
        const result = await auth.login(request, body.password);
        writeJson(response, 200, { authenticated: true, expiresAt: result.expiresAt }, { "Set-Cookie": result.cookie });
        return;
      }
      if (path === "/api/auth/logout") {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        const cookie = auth?.logout(request);
        writeJson(response, 200, { authenticated: !auth?.enabled }, cookie ? { "Set-Cookie": cookie } : {});
        return;
      }

      const publicAssets = {
        "/login": "/login.html", "/login.js": "/login.js", "/styles.css": "/styles.css",
        "/operations.css": "/operations.css", "/site.css": "/site.css", "/site.js": "/site.js",
        "/publication-view.js": "/publication-view.js",
        "/favicon.svg": "/favicon.svg",
      };
      if (Object.hasOwn(publicAssets, path)) {
        await serveStatic(request, response, publicDir, publicAssets[path]);
        return;
      }
      if ((publicWebsite || /^\/(?:zh|en)(?:\/|$)/.test(path)) && await routeWebsite({ request, response, url })) return;
      if (editorial && path === "/about") {
        if (!["GET", "HEAD"].includes(request.method)) { methodNotAllowed(response, ["GET", "HEAD"]); return; }
        response.writeHead(308, { ...securityHeaders(), Location: "/zh/about", "Cache-Control": "no-store" }); response.end(); return;
      }
      if ((publicWebsite && path === "/") || path === "/about") {
        await serveStatic(request, response, publicDir, "/site.html");
        return;
      }

      if (path === "/robots.txt") {
        if (!["GET", "HEAD"].includes(request.method)) {
          methodNotAllowed(response, ["GET", "HEAD"]);
          return;
        }
        response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/plain; charset=utf-8" });
        response.end("User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /login\nDisallow: /api/\nDisallow: /index.html\n");
        return;
      }

      let principal = { actor: "PengManager", method: "local" };
      if (auth) {
        try {
          principal = auth.requireAccess(request, path);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401 && ["GET", "HEAD"].includes(request.method) && ["/", "/admin", "/index.html"].includes(path)) {
            response.writeHead(302, { ...securityHeaders(), Location: "/login", "Cache-Control": "no-store" });
            response.end();
            return;
          }
          throw error;
        }
      }

      const privatePreview = path.match(/^\/admin\/preview\/([A-Za-z0-9_-]{1,100})$/);
      if (privatePreview && editorial) {
        if (principal.method === "agent") throw new ApiError(403, "AGENT_SCOPE_DENIED", "私有预览仅允许管理员。");
        await routeWebsite({ request, response, url, previewId: privatePreview[1] }); return;
      }
      if (await routeEditorialApi({ request, response, url, principal, editorial, mediaAssets,
        readJsonBody, writeJson, methodNotAllowed })) return;
      const reconcile = path.match(/^\/api\/operations\/([A-Za-z0-9_-]+)\/reconcile$/);
      if (reconcile && accountOperations?.reconcile) {
        if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return; }
        if (principal.method === "agent") throw new ApiError(403, "AGENT_SCOPE_DENIED", "历史结果核对仅允许管理员。");
        writeJson(response, 200, await accountOperations.reconcile(reconcile[1], await readJsonBody(request), {
          actor: principal.actor, method: principal.method, idempotencyKey: request.headers["idempotency-key"], ifMatch: request.headers["if-match"],
        })); return;
      }

      if (path === "/api/video-runtime" || path.startsWith("/api/video-runtime/")) {
        if (!["/api/video-runtime/status", "/api/video-runtime/capabilities"].includes(path)) {
          throw new ApiError(404, "VIDEO_RUNTIME_ENDPOINT_NOT_FOUND", "视频运行环境接口不存在。");
        }
        if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
        if ([...url.searchParams].length) {
          throw new ApiError(400, "VIDEO_RUNTIME_REQUEST_INVALID", "视频状态与能力目录不接受查询参数。");
        }
        writeJson(response, 200, await readVideoRuntime(videoRuntime, path.endsWith("/status") ? "status" : "capabilities"));
        return;
      }

      if (path === "/api/operations") {
        if (!accountOperations) throw new ApiError(503, "OPERATIONS_UNAVAILABLE", "运营动作服务未启用。");
        if (request.method === "GET") {
          writeJson(response, 200, accountOperations.list());
          return;
        }
        if (request.method === "POST") {
          writeJson(response, 201, await accountOperations.create({ ...(await readJsonBody(request)), actor: principal.actor }));
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }
      const accountUpdate = path.match(/^\/api\/accounts\/([A-Za-z0-9_-]+)$/);
      if (accountUpdate) {
        if (request.method !== "PATCH") {
          methodNotAllowed(response, ["PATCH"]);
          return;
        }
        if (!accountOperations) throw new ApiError(503, "OPERATIONS_UNAVAILABLE", "运营动作服务未启用。");
        writeJson(response, 200, await accountOperations.updateAccount(accountUpdate[1], { ...(await readJsonBody(request)), actor: principal.actor }));
        return;
      }
      const operationAction = path.match(/^\/api\/operations\/([A-Za-z0-9_-]+)\/(approve|start|complete|fail)$/);
      if (operationAction) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        if (!accountOperations) throw new ApiError(503, "OPERATIONS_UNAVAILABLE", "运营动作服务未启用。");
        if (principal.method === "agent") {
          const operation = accountOperations.list().find((row) => row.id === operationAction[1]);
          if (!operation) throw new ApiError(404, "OPERATION_NOT_FOUND", "找不到运营动作。");
          if (!operation.approval || operation.executionMode !== "browser" ||
              ["L0", "L3"].includes(operation.classification?.level)) {
            throw new ApiError(403, "AGENT_OPERATION_SCOPE_DENIED", "Agent 只能更新已授权的普通浏览器动作；本人手工处理的动作需管理员操作。");
          }
        }
        const input = { ...(await readJsonBody(request)), actor: principal.actor };
        if (operationAction[2] === "approve") input.approvedBy = principal.actor;
        if (principal.method === "agent" && operationAction[2] === "complete") {
          if (!input.receipt || typeof input.receipt !== "object" || Array.isArray(input.receipt)) {
            throw new ApiError(400, "INVALID_INPUT", "完成动作必须提供回执对象。");
          }
          input.receipt = {
            ...input.receipt,
            verificationMethod: "browser_readback",
            verifiedBy: principal.actor,
            capturedBy: principal.actor,
          };
        }
        writeJson(response, 200, await accountOperations[operationAction[2]](operationAction[1], input));
        return;
      }

      if (path === "/api/health") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, {
          ok: true,
          service: SYSTEM_IDENTITY.id,
          system: { ...SYSTEM_IDENTITY },
          summary: service.summary(),
        });
        return;
      }

      if (path === "/api/bootstrap") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.bootstrap());
        return;
      }

      if (path === "/api/summary") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.summary());
        return;
      }

      if (path === "/api/events") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.events(url.searchParams.get("limit")));
        return;
      }

      if (path === "/api/adapters/health") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        if (!livePipeline) {
          throw new ApiError(503, "ADAPTERS_UNAVAILABLE", "实时适配器未启用。");
        }
        writeJson(response, 200, await livePipeline.adapterHealth());
        return;
      }

      if (path === "/api/media/jobs") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        if (!livePipeline?.mediaEngine) {
          throw new ApiError(503, "MEDIA_ENGINE_UNAVAILABLE", "内置媒体引擎未启用。");
        }
        writeJson(response, 200, await livePipeline.mediaEngine.listJobs());
        return;
      }

      if (path.startsWith("/api/video-edit/")) {
        if (!livePipeline?.videoEdit) throw new ApiError(503, "VIDEO_LIBRARY_UNAVAILABLE", "内置视频资产适配器未启用。");
        if (path === "/api/video-edit/library") {
          if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
          if ([...url.searchParams.keys()].some(key => key !== "kind") || url.searchParams.getAll("kind").length > 1) throw new ApiError(400, "VIDEO_LIBRARY_REQUEST_INVALID", "库查询只接受一个kind参数。");
          writeJson(response, 200, await livePipeline.videoEdit.libraryCatalog({ kind: url.searchParams.get("kind") ?? "all" }));
          return;
        }
        if (path === "/api/video-edit/characters/resolve") {
          if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return; }
          writeJson(response, 200, await livePipeline.videoEdit.resolveCharacters(await readJsonBody(request)));
          return;
        }
        if (path === "/api/video-edit/products/resolve") {
          if (request.method !== "GET") { methodNotAllowed(response, ["GET"]); return; }
          if ([...url.searchParams.keys()].some(key => key !== "selector") || url.searchParams.getAll("selector").length !== 1) throw new ApiError(400, "VIDEO_PRODUCT_REQUEST_INVALID", "商品查询只接受一个selector参数。");
          writeJson(response, 200, await livePipeline.videoEdit.selectProduct({ selector: url.searchParams.get("selector") }));
          return;
        }
        throw new ApiError(404, "VIDEO_LIBRARY_ENDPOINT_NOT_FOUND", "视频资产接口不存在。");
      }

      if (path.startsWith("/api/geo/engine/")) {
        if (!geoEngine) {
          throw new ApiError(503, "GEO_ENGINE_UNAVAILABLE", "内置 GEO 引擎未启用。");
        }
        if (path === "/api/geo/engine/summary" && request.method === "GET") {
          writeJson(response, 200, geoEngine.summary());
          return;
        }
        if (path === "/api/geo/engine/queries" && request.method === "GET") {
          writeJson(response, 200, geoEngine.listQueries({
            category: url.searchParams.get("category") || undefined,
            risk: url.searchParams.has("risk")
              ? url.searchParams.get("risk") === "true"
              : undefined,
            limit: parseLimit(url.searchParams.get("limit"), 1000, 2000, "limit"),
          }));
          return;
        }
        if (path === "/api/geo/engine/samples" && request.method === "GET") {
          writeJson(response, 200, geoEngine.listSamples({
            runId: url.searchParams.get("runId") || undefined,
            queryId: url.searchParams.get("queryId") || undefined,
            limit: parseLimit(url.searchParams.get("limit"), 500, 5000, "limit"),
          }));
          return;
        }
        if (path === "/api/geo/engine/incidents" && request.method === "GET") {
          writeJson(response, 200, geoEngine.listIncidents({
            status: url.searchParams.get("status") || "open",
            limit: parseLimit(url.searchParams.get("limit"), 200, 1000, "limit"),
          }));
          return;
        }
        if (path === "/api/geo/engine/articles" && request.method === "GET") {
          writeJson(response, 200, geoEngine.listArticles(1000));
          return;
        }
        if (path === "/api/geo/engine/articles/generate" && request.method === "POST") {
          const body = await readJsonBody(request);
          if (body.confirm !== true) {
            throw new ApiError(
              400,
              "LIVE_RUN_CONFIRMATION_REQUIRED",
              "文章生成会写入数据库，请求体必须显式设置 confirm=true。",
            );
          }
          writeJson(response, 201, geoEngine.generateArticles(body));
          return;
        }
        throw new ApiError(404, "GEO_ENGINE_ENDPOINT_NOT_FOUND", "GEO 引擎接口不存在。");
      }

      if (path.startsWith("/api/live/")) {
        if (!livePipeline) {
          throw new ApiError(503, "ADAPTERS_UNAVAILABLE", "实时适配器未启用。");
        }
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        const body = await readJsonBody(request);
        if (body.confirm !== true) {
          throw new ApiError(
            400,
            "LIVE_RUN_CONFIRMATION_REQUIRED",
            "实时运行会产生模型或平台调用，请求体必须显式设置 confirm=true。",
          );
        }

        if (path === "/api/live/generate-content") {
          writeJson(response, 200, await livePipeline.generateContent(body));
          return;
        }
        if (path === "/api/live/deepseek/collect") {
          writeJson(response, 200, await livePipeline.collectDeepSeek(body));
          return;
        }
        if (path === "/api/live/geoevidence/run") {
          writeJson(response, 200, await livePipeline.runGeoEvidence(body));
          return;
        }
        if (path === "/api/live/video-edit/cover") {
          writeJson(response, 200, await livePipeline.enrichCover(body));
          return;
        }
        if (path === "/api/live/media/render") {
          if (!mediaRenderEnabled) throw new ApiError(503, "MEDIA_RENDER_DISABLED", "当前云端仅保存运营资料和回执。视频后期请在本机运行。");
          writeJson(response, 201, await livePipeline.renderMedia(body));
          return;
        }
        if (path === "/api/live/github/publish") {
          writeJson(response, 201, await livePipeline.publishContentToGitHub(body));
          return;
        }
        throw new ApiError(404, "LIVE_ENDPOINT_NOT_FOUND", "实时接口不存在。");
      }

      if (path === "/api/exports/public-preview") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.publicPreview());
        return;
      }

      if (path === "/api/claims" && request.method === "GET") {
        writeJson(response, 200, service.bootstrap().claims);
        return;
      }

      const claimApprovalMatch = path.match(/^\/api\/claims\/([^/]+)\/approve$/);
      if (claimApprovalMatch) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        const result = await service.approveClaim(
          decodeURIComponent(claimApprovalMatch[1]),
          await readJsonBody(request),
        );
        writeJson(response, 200, result);
        return;
      }

      if (path === "/api/content" && request.method === "GET") {
        writeJson(response, 200, service.bootstrap().content);
        return;
      }

      if (path === "/api/content" && request.method === "POST") {
        writeJson(response, 201, await service.createContent(await readJsonBody(request)));
        return;
      }

      const transitionMatch = path.match(/^\/api\/content\/([^/]+)\/transition$/);
      if (transitionMatch) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        const result = await service.transitionContent(
          decodeURIComponent(transitionMatch[1]),
          await readJsonBody(request),
        );
        writeJson(response, 200, result);
        return;
      }

      if (path === "/api/publications/manual") {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        writeJson(response, 201, await service.recordPublication({ ...(await readJsonBody(request)), actor: principal.actor }));
        return;
      }

      if (path === "/api/interactions/classify") {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return;
        }
        writeJson(response, 200, service.classifyInteraction(await readJsonBody(request)));
        return;
      }

      if (path === "/api/interactions") {
        if (request.method === "POST") {
          writeJson(response, 201, await service.createInteraction({ ...(await readJsonBody(request)), actor: principal.actor }));
          return;
        }
        if (request.method === "GET") {
          writeJson(response, 200, service.bootstrap().interactions);
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (path === "/api/geo/queries") {
        if (request.method === "GET") {
          writeJson(response, 200, service.bootstrap().queries);
          return;
        }
        if (request.method === "POST") {
          const created = await service.createQuery(await readJsonBody(request));
          geoEngine?.upsertControlQueries([created]);
          writeJson(response, 201, created);
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (path === "/api/geo/observations") {
        if (request.method === "GET") {
          writeJson(response, 200, service.bootstrap().observations);
          return;
        }
        if (request.method === "POST") {
          writeJson(response, 201, await service.recordObservation(await readJsonBody(request)));
          return;
        }
        methodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (path === "/api/geo/metrics") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return;
        }
        writeJson(response, 200, service.metrics());
        return;
      }

      if (path.startsWith("/api/")) {
        throw new ApiError(404, "API_NOT_FOUND", "接口不存在。");
      }

      await serveStatic(request, response, publicDir, path === "/admin" ? "/index.html" : path);
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const payload =
        error instanceof ApiError
          ? {
              error: {
                code: error.code,
                message: error.message,
                details: error.details,
              },
            }
          : { error: { code: "INTERNAL_ERROR", message: "服务处理失败。" } };

      if (!(error instanceof ApiError)) {
        const path = (() => {
          try {
            return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
          } catch {
            return request.url ?? "/";
          }
        })();
        console.error(
          `request failed: ${request.method} ${path} ${error?.name || "Error"} ${error?.code || ""}`,
        );
      }
      if (response.headersSent) response.destroy();
      else writeJson(response, status, payload);
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 30_000;
  server.timeout = 120_000;
  server.beginShutdown = () => { shuttingDown = true; };
  return server;
}
