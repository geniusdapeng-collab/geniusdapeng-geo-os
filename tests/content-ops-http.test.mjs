import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { resolve } from "node:path";
import { createGeoOsServer } from "../src/http/server.mjs";
import { ApiError } from "../src/domain/errors.mjs";
import { ProductionArtifacts } from "../src/services/production-artifacts.mjs";
import { editorialFixture, context } from "./editorial-fixtures.mjs";

async function fixture(t, overrides = {}, dependencies = {}) {
  const credential = randomBytes(32).toString("base64url"), calls = [];
  const principal = { method: "worker", actor: "isolated worker", workerId: "worker-fixture", grantId: "GRANT-fixture", scopeHash: "a".repeat(64) };
  const contentOps = {
    authenticateWorker(value) { return value === credential ? principal : null; },
    profiles() { return { fixtureOnly: true, profiles: [] }; },
    validatePlanImport(body, ctx) { calls.push({ method: "validate", body, ctx }); return { fixtureOnly: true, validatedImportId: "IMPORT-fixture" }; },
    confirmPairing(body, ctx) { calls.push({ method: "pair", body, ctx }); return { fixtureOnly: true, workerId: "worker-fixture" }; },
    claimTask(body, ctx) { calls.push({ method: "claim", body, ctx }); return null; },
    dispatchTask(id, body, ctx) { calls.push({ method: "dispatch", id, body, ctx }); return { fixtureOnly: true, execute: false }; },
    async uploadArtifact(id, readable, metadata, ctx) { const chunks = []; for await (const chunk of readable) chunks.push(chunk); calls.push({ method: "upload", id, metadata, ctx, bytes: Buffer.concat(chunks) }); return { fixtureOnly: true }; },
    ...overrides,
  };
  const auth = { validateRequestSource() {}, requireAccess(request) {
    if (request.headers.authorization) return { actor: "restricted fixture agent", method: "agent" };
    if (request.headers["x-fixture-admin"] === "yes") return { actor: "isolated owner", method: "session" };
    throw new ApiError(401, "AUTH_REQUIRED", "Fixture authentication required.");
  } };
  const server = createGeoOsServer({ service: {}, contentOps, publicDir: resolve(import.meta.dirname, "../public"), auth, ...dependencies });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => { server.close(done); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body, headers = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "isolated-request-001", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { calls, origin, send, credential };
}
test("worker credential routes stay separate from administrator cookies and restricted agent scope", async t => {
  const f = await fixture(t);
  let response = await f.send("/api/content-ops/worker/tasks/claim", { workerId: "worker-fixture", maxTasks: 1 }, { "x-fixture-admin": "yes" });
  assert.equal(response.status, 401); assert.equal((await response.json()).error.code, "WORKER_AUTH_REQUIRED");
  response = await f.send("/api/content-ops/worker/tasks/claim", { workerId: "worker-fixture", maxTasks: 1 }, { Authorization: `Bearer ${f.credential}` });
  assert.equal(response.status, 204); assert.equal(f.calls[0].ctx.method, "worker");
  response = await fetch(`${f.origin}/api/content-ops/profiles`, { headers: { Authorization: `Bearer ${f.credential}`, "x-fixture-admin": "yes" } });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, "AGENT_SCOPE_DENIED");
  response = await fetch(`${f.origin}/api/content-ops/profiles`); assert.equal(response.status, 401);
  response = await fetch(`${f.origin}/api/content-ops/profiles`, { headers: { "x-fixture-admin": "yes" } }); assert.equal(response.status, 200);
});
test("plan import rejects duplicate keys and oversized bytes before any service call; raw inner plan is preserved", async t => {
  const f = await fixture(t);
  let response = await f.send("/api/content-ops/plan-imports/validate", '{"plan":{},"plan":{}}', { "x-fixture-admin": "yes" });
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "DUPLICATE_JSON_KEY"); assert.equal(f.calls.length, 0);
  response = await f.send("/api/content-ops/plan-imports/validate", JSON.stringify({ rawPlanJson: "x".repeat(1_000_000) }), { "x-fixture-admin": "yes" });
  assert.equal(response.status, 413); assert.equal(f.calls.length, 0);
  response = await f.send("/api/content-ops/plan-imports/validate", { rawPlanJson: '{"x":1,"x":2}' }, { "x-fixture-admin": "yes" });
  assert.equal(response.status, 200); assert.equal(f.calls[0].body.rawPlanJson, '{"x":1,"x":2}');
  response = await fetch(`${f.origin}/api/content-ops/profiles?unlisted=1`, { headers: { "x-fixture-admin": "yes" } }); assert.equal(response.status, 400);
});
test("pair confirmation is an explicit one-time principal, and raw artifact headers bind an exact scoped attempt", async t => {
  const f = await fixture(t);
  let response = await f.send("/api/content-ops/worker/pairing/confirm", { challengeId: "PAIR-fixture", challenge: "synthetic one-time test value" });
  assert.equal(response.status, 200); assert.equal(f.calls[0].ctx.method, "pairing");
  const bytes = Buffer.from("isolated upload bytes"), hash = "b".repeat(64);
  response = await fetch(`${f.origin}/api/content-ops/worker/tasks/TASK-fixture/artifacts`, { method: "POST", headers: {
    Authorization: `Bearer ${f.credential}`, "Content-Type": "text/markdown", "X-Content-Size": String(bytes.length),
    "X-Attempt-Id": "ATT-fixture", "X-Task-Epoch": "2", "X-Task-Hash": hash, "X-Resolved-Input-Hash": "c".repeat(64),
    "X-Output-Key": "body", "X-Artifact-Role": "text", "X-Content-Sha256": "d".repeat(64), "X-Artifact-Name": encodeURIComponent("中文稿.md"), "Idempotency-Key": "isolated-upload-001",
  }, body: bytes });
  assert.equal(response.status, 201); const uploaded = f.calls.find(call => call.method === "upload");
  assert.deepEqual(uploaded.bytes, bytes); assert.equal(uploaded.metadata.epoch, 2); assert.equal(uploaded.metadata.taskHash, hash); assert.equal(uploaded.metadata.name, "中文稿.md");
  response = await f.send("/api/content-ops/worker/tasks/TASK-fixture/dispatch", {}, { Authorization: `Bearer ${f.credential}` });
  assert.equal(response.status, 200); assert.equal((await response.json()).execute, false);
});

test("administrator source API commits and reviews real private bytes while refusing bearer escalation and changed uploads", async t => {
  const editorial = await editorialFixture(t), artifacts = new ProductionArtifacts({ store: editorial.store }); await artifacts.initialize();
  const story = await editorial.service.createStory({ workingTitle: "HTTP真实源文件", claimIds: ["C003"] }, context());
  const f = await fixture(t, {}, { service: editorial.geoService, editorial: editorial.service, productionArtifacts: artifacts });
  const bytes = Buffer.from("# 原始代码\nconsole.log('只保存，不执行');\n"), sha256 = createHash("sha256").update(bytes).digest("hex");
  const headers = { "x-fixture-admin": "yes", "Content-Type": "text/javascript", "X-Story-Id": story.id,
    "If-Match": editorial.service.getStory(story.id).etag, "Idempotency-Key": "http-source-upload-001", "X-Artifact-Role": "code",
    "X-Content-Sha256": sha256, "X-Content-Size": String(bytes.length), "X-Artifact-Name": encodeURIComponent("演示源码.js") };
  const upload = extra => fetch(`${f.origin}/api/content-ops/source-artifacts`, { method: "POST", headers: { ...headers, ...extra }, body: bytes });
  let response = await upload({ Authorization: `Bearer ${f.credential}` });
  assert.equal(response.status, 403); assert.equal(artifacts.listSourceArtifacts().items.length, 0);
  response = await upload({ "X-Content-Sha256": "0".repeat(64) }); assert.equal(response.status, 400);
  response = await upload({ "If-Match": '"wrong-story"' }); assert.equal(response.status, 412);
  response = await upload(); assert.equal(response.status, 201);
  const source = await response.json(); assert.equal(response.headers.get("etag"), source.etag);
  assert.equal(source.origin, "administrator_upload"); assert.equal(source.review, null); assert.equal(source.taskId, null);
  response = await fetch(`${f.origin}/api/content-ops/source-artifacts`, { headers: { "x-fixture-admin": "yes" } });
  assert.equal(response.status, 200); assert.equal((await response.json()).items[0].id, source.id);
  response = await f.send(`/api/content-ops/artifacts/${source.id}/review`, { sha256, rightsConfirmed: true, privacyConfirmed: true,
    licenseConfirmed: true, note: "隔离测试自产源码，不读取外部来源或执行源码。" }, { "x-fixture-admin": "yes", "If-Match": source.etag });
  assert.equal(response.status, 200); assert.equal((await response.json()).status, "reviewed");
  response = await fetch(`${f.origin}/api/content-ops/artifacts/${source.id}/bytes`); assert.equal(response.status, 401);
  response = await fetch(`${f.origin}/api/content-ops/artifacts/${source.id}/bytes`, { headers: { "x-fixture-admin": "yes" } });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  response = await upload({ "If-Match": '"old-parent"' }); assert.equal(response.status, 201); assert.equal((await response.json()).id, source.id);
  assert.equal(artifacts.listSourceArtifacts().items.length, 1);
});
