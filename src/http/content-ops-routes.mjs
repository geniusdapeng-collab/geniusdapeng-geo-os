import { ApiError } from "../domain/errors.mjs";
import { parseStrictJson } from "../domain/strict-json.mjs";
import { serveMediaAsset } from "./media-assets.mjs";

const ID = "([A-Za-z0-9_-]{1,100})";
function noQuery(url) {
  if ([...url.searchParams].length) throw new ApiError(400, "CONTENT_OPS_QUERY_INVALID", "内容岗位接口不接受额外查询参数。");
}
function adminContext(request, principal) {
  if (!["local", "session"].includes(principal?.method)) throw new ApiError(403, "AGENT_SCOPE_DENIED", "内容准备与审核管理仅允许管理员。");
  return { actor: principal.actor, method: principal.method, idempotencyKey: request.headers["idempotency-key"], ifMatch: request.headers["if-match"] };
}
export async function readContentOpsJson(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length; if (size > 1_000_000) throw new ApiError(413, "PLAN_TOO_LARGE", "请求体超过 1 MB。"); chunks.push(chunk);
  }
  const body = parseStrictJson(Buffer.concat(chunks));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "INVALID_INPUT", "请求必须是普通 JSON 对象。");
  return body;
}
function send(response, status, payload, writeJson) {
  writeJson(response, status, payload, payload?.etag ? { ETag: payload.etag } : {});
}
async function artifactBytes(request, response, artifacts, id) {
  const artifact = artifacts.getArtifact(id);
  const inline = /^(?:image\/(?:png|jpeg|webp)|video\/mp4|audio\/wav|text\/vtt)$/.test(artifact.mime);
  const encodedName = encodeURIComponent(artifact.name ?? `${artifact.id}.bin`).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  response.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${artifact.id}.bin"; filename*=UTF-8''${encodedName}`);
  await serveMediaAsset(request, response, { assetId: id, publicAccess: false, mediaAssets: {
    async openVerifiedAsset(assetId, options) { const opened = await artifacts.openVerifiedArtifact(assetId, options); return { asset: opened.artifact, handle: opened.handle }; },
  } });
}

// These exact routes run after Host/Origin validation but before administrator
// authentication. Their only identities are one-time pairing and scoped worker
// credentials; a browser cookie never supplies a worker capability.
export async function routeContentOpsWorker({ request, response, url, contentOps, productionArtifacts, mediaAssets, writeJson, methodNotAllowed }) {
  const path = url.pathname;
  if (!path.startsWith("/api/content-ops/worker/")) return false;
  if (!contentOps) throw new ApiError(503, "CONTENT_OPS_UNAVAILABLE", "内容生产服务尚未配置。");
  noQuery(url);
  if (path === "/api/content-ops/worker/pairing/confirm") {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    const result = await contentOps.confirmPairing(await readContentOpsJson(request), { method: "pairing", actor: "local-owner-confirmation", idempotencyKey: request.headers["idempotency-key"] });
    send(response, 200, result, writeJson); return true;
  }
  const header = request.headers.authorization;
  if (typeof header !== "string" || !/^Bearer [A-Za-z0-9_-]{43,128}$/.test(header)) throw new ApiError(401, "WORKER_AUTH_REQUIRED", "需要独立的内容 worker 凭据。");
  const principal = await contentOps.authenticateWorker(header.slice(7));
  if (!principal || !["worker", "checker"].includes(principal.method)) throw new ApiError(401, "WORKER_AUTH_REQUIRED", "内容 worker 凭据无效、过期或已撤销。");
  const ctx = { ...principal, idempotencyKey: request.headers["idempotency-key"], ifMatch: request.headers["if-match"] };
  if (path === "/api/content-ops/worker/tasks/claim") {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    const lease = await contentOps.claimTask(await readContentOpsJson(request), ctx);
    if (!lease) { response.writeHead(204, { "Cache-Control": "no-store" }); response.end(); }
    else send(response, 200, lease, writeJson); return true;
  }
  const task = path.match(new RegExp(`^/api/content-ops/worker/tasks/${ID}$`));
  if (task) {
    if (request.method !== "GET") methodNotAllowed(response, ["GET"]);
    else send(response, 200, await contentOps.getWorkerTask(task[1], ctx), writeJson);
    return true;
  }
  const action = path.match(new RegExp(`^/api/content-ops/worker/tasks/${ID}/(heartbeat|dispatch|complete|fail)$`));
  if (action) {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    const methods = { heartbeat: "heartbeatTask", dispatch: "dispatchTask", complete: "completeTask", fail: "failTask" };
    send(response, 200, await contentOps[methods[action[2]]](action[1], await readContentOpsJson(request), ctx), writeJson); return true;
  }
  const upload = path.match(new RegExp(`^/api/content-ops/worker/tasks/${ID}/artifacts$`));
  if (upload) {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    let name = request.headers["x-artifact-name"];
    if (name !== undefined) { try { name = decodeURIComponent(name); } catch { throw new ApiError(400, "ARTIFACT_INVALID_NAME", "附件名称编码无效。"); } }
    const size = Number(request.headers["x-content-size"]), epoch = Number(request.headers["x-task-epoch"]);
    if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(epoch) || epoch < 1 ||
        request.headers["content-length"] !== undefined && Number(request.headers["content-length"]) !== size) throw new ApiError(400, "ARTIFACT_INVALID_METADATA", "附件大小、长度或租约 epoch 无效。");
    const payload = await contentOps.uploadArtifact(upload[1], request, {
      attemptId: request.headers["x-attempt-id"], epoch, taskHash: request.headers["x-task-hash"],
      resolvedInputHash: request.headers["x-resolved-input-hash"], artifactId: request.headers["x-artifact-id"],
      outputKey: request.headers["x-output-key"], role: request.headers["x-artifact-role"],
      sha256: request.headers["x-content-sha256"], size, mime: request.headers["content-type"], ...(name === undefined ? {} : { name }),
    }, ctx);
    send(response, 201, payload, writeJson); return true;
  }
  const reservation = path.match(new RegExp(`^/api/content-ops/worker/reservations/${ID}/(settle|unknown)$`));
  if (reservation) {
    if (request.method !== "POST") { methodNotAllowed(response, ["POST"]); return true; }
    send(response, 200, await contentOps[reservation[2] === "settle" ? "settleCall" : "unknownCall"](reservation[1], await readContentOpsJson(request), ctx), writeJson); return true;
  }
  const file = path.match(new RegExp(`^/api/content-ops/worker/(artifacts|media)/${ID}/bytes$`));
  if (file) {
    if (!["GET", "HEAD"].includes(request.method)) { methodNotAllowed(response, ["GET", "HEAD"]); return true; }
    if (file[1] === "artifacts") {
      await contentOps.authorizeWorkerArtifact(file[2], ctx); await artifactBytes(request, response, productionArtifacts, file[2]);
    } else {
      await contentOps.authorizeWorkerMedia(file[2], ctx); await serveMediaAsset(request, response, { mediaAssets, assetId: file[2], publicAccess: false });
    }
    return true;
  }
  throw new ApiError(404, "WORKER_ENDPOINT_NOT_FOUND", "内容 worker 接口不存在。");
}

export async function routeContentOpsAdmin({ request, response, url, principal, contentOps, editorial, productionArtifacts, mediaAssets, writeJson, methodNotAllowed }) {
  const path = url.pathname;
  if (!path.startsWith("/api/content-ops/")) return false;
  const ctx = adminContext(request, principal); noQuery(url);
  if (!contentOps) throw new ApiError(503, "CONTENT_OPS_UNAVAILABLE", "内容生产服务尚未配置。");
  if (path === "/api/content-ops/source-artifacts") {
    if (request.method === "GET") send(response, 200, productionArtifacts.listSourceArtifacts(), writeJson);
    else if (request.method === "POST") {
      let name = request.headers["x-artifact-name"];
      if (name !== undefined) { try { name = decodeURIComponent(name); } catch { throw new ApiError(400, "ARTIFACT_INVALID_NAME", "源文件名称编码无效。"); } }
      const size = Number(request.headers["x-content-size"]);
      if (!Number.isSafeInteger(size) || size < 1 || request.headers["content-length"] !== undefined && Number(request.headers["content-length"]) !== size) throw new ApiError(400, "ARTIFACT_INVALID_METADATA", "源文件大小和实际请求长度不符。");
      send(response, 201, await productionArtifacts.uploadSource(request, {
        storyId: request.headers["x-story-id"], role: request.headers["x-artifact-role"], mime: request.headers["content-type"],
        size, sha256: request.headers["x-content-sha256"], ...(name === undefined ? {} : { name }),
      }, ctx), writeJson);
    } else methodNotAllowed(response, ["GET", "POST"]);
    return true;
  }
  const fixed = {
    "/api/content-ops/bootstrap": { GET: () => contentOps.bootstrap(ctx) },
    "/api/content-ops/profiles": { GET: () => contentOps.profiles() },
    "/api/content-ops/plan-template": { POST: body => contentOps.planTemplate(body, ctx) },
    "/api/content-ops/plan-imports/validate": { POST: body => contentOps.validatePlanImport(body, ctx) },
    "/api/content-ops/jobs": { GET: () => contentOps.listJobs(ctx), POST: body => contentOps.createJob(body, ctx) },
    "/api/content-ops/budget-authorizations": { GET: () => contentOps.listBudgets(ctx), POST: body => contentOps.createBudget(body, ctx) },
    "/api/content-ops/workers": { GET: () => contentOps.listWorkers(ctx) },
    "/api/content-ops/workers/pair": { POST: body => contentOps.createPairing(body, ctx) },
    "/api/content-ops/author-contributions": { POST: body => contentOps.createAuthorContribution(body, ctx) },
    "/api/content-ops/rule-snapshots": { POST: body => contentOps.createRuleSnapshot(body, ctx) },
    "/api/content-ops/style-memory-candidates": { POST: body => contentOps.createStyleMemoryCandidate(body, ctx) },
  };
  const patterns = [
    [new RegExp(`^/api/content-ops/jobs/${ID}$`), id => ({ GET: () => contentOps.getJob(id, ctx) })],
    [new RegExp(`^/api/content-ops/jobs/${ID}/cancel$`), id => ({ POST: body => contentOps.cancelJob(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/jobs/${ID}/targets/${ID}/revise$`), (id, key) => ({ POST: body => contentOps.reviseTarget(id, key, body, ctx) })],
    [new RegExp(`^/api/content-ops/jobs/${ID}/usage/${ID}/reconcile$`), (id, reservation) => ({ POST: body => contentOps.reconcileUsage(id, reservation, body, ctx) })],
    [new RegExp(`^/api/content-ops/workers/${ID}/revoke$`), id => ({ POST: body => contentOps.revokeWorker(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/candidates/${ID}$`), id => ({ GET: () => contentOps.getCandidate(id, ctx) })],
    [new RegExp(`^/api/content-ops/candidates/${ID}/materialize$`), id => ({ POST: body => editorial.materializeCandidate(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/candidates/${ID}/quality-reports$`), id => ({ POST: body => contentOps.submitQualityReport(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/style-memory-candidates/${ID}/promote$`), id => ({ POST: body => contentOps.promoteStyleMemory(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/style-versions/${ID}/rollback$`), id => ({ POST: body => contentOps.rollbackStyleMemory(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/artifacts/${ID}$`), id => ({ GET: () => productionArtifacts.getArtifact(id) })],
    [new RegExp(`^/api/content-ops/artifacts/${ID}/preview$`), id => ({ GET: () => productionArtifacts.preview(id) })],
    [new RegExp(`^/api/content-ops/artifacts/${ID}/review$`), id => ({ POST: body => productionArtifacts.review(id, body, ctx) })],
    [new RegExp(`^/api/content-ops/artifacts/${ID}/import-media$`), id => ({ POST: body => productionArtifacts.importMedia(id, body, ctx, mediaAssets) })],
  ];
  let methods = fixed[path];
  if (!methods) for (const [pattern, resolve] of patterns) { const found = path.match(pattern); if (found) { methods = resolve(...found.slice(1)); break; } }
  const bytes = path.match(new RegExp(`^/api/content-ops/artifacts/${ID}/bytes$`));
  if (bytes) {
    if (!["GET", "HEAD"].includes(request.method)) methodNotAllowed(response, ["GET", "HEAD"]);
    else await artifactBytes(request, response, productionArtifacts, bytes[1]);
    return true;
  }
  if (!methods) throw new ApiError(404, "CONTENT_OPS_ENDPOINT_NOT_FOUND", "内容岗位接口不存在。");
  const handler = methods[request.method];
  if (!handler) { methodNotAllowed(response, Object.keys(methods)); return true; }
  const payload = await handler(request.method === "GET" ? undefined : await readContentOpsJson(request));
  const status = request.method === "POST" && path === "/api/content-ops/jobs" ? 202 :
    request.method === "POST" && /\/(?:budget-authorizations|author-contributions|rule-snapshots|style-memory-candidates|materialize)$/.test(path) ? 201 : 200;
  send(response, status, payload, writeJson); return true;
}
