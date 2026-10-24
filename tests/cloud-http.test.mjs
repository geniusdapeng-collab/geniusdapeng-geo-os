import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { createGeoOsServer } from "../src/http/server.mjs";
import { createAdminAuth, hashAdminPassword, hashAgentToken } from "../src/security/admin-auth.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { AccountOperationsService } from "../src/services/account-operations.mjs";

const root = resolve(import.meta.dirname, "..");
const password = randomBytes(24).toString("base64url");
const passwordHash = await hashAdminPassword(password);
const agentToken = randomBytes(32).toString("base64url");
const fixedDate = new Date("2026-10-24T12:00:00.000Z");

async function setup(t, { publicWebsite = true, mediaRenderEnabled = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-cloud-http-"));
  const store = new JsonStore({ filePath: join(directory, "state.json"), clock: () => fixedDate });
  await store.open(() => loadSeedState(join(root, "data/seed")));
  const service = new GeoOsService({ store, clock: () => fixedDate });
  const operations = new AccountOperationsService({ service, clock: () => fixedDate });
  const env = {
    NODE_ENV: "production", PUBLIC_ORIGIN: "https://site.test", ALLOWED_HOSTS: "site.test",
    ADMIN_PASSWORD_HASH: passwordHash, ADMIN_AGENT_TOKEN_HASH: hashAgentToken(agentToken),
  };
  const auth = createAdminAuth({ env, host: "0.0.0.0", allowedHosts: ["site.test"] });
  let liveCalls = 0;
  const livePipeline = {
    adapterHealth: async () => { liveCalls += 1; return { ok: true }; },
    renderMedia: async () => { liveCalls += 1; return { unexpected: true }; },
    publishContentToGitHub: async () => { liveCalls += 1; return { unexpected: true }; },
  };
  const server = createGeoOsServer({ service, accountOperations: operations, publicDir: join(root, "public"),
    allowedHosts: ["site.test"], auth, publicWebsite, mediaRenderEnabled, livePipeline });
  await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((accept) => server.close(accept));
    await rm(directory, { recursive: true, force: true });
  });
  const send = (path, options = {}) => new Promise((accept, reject) => {
    const outgoing = httpRequest(`${baseUrl}${path}`, { method: options.method || "GET",
      headers: { host: "site.test", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } }, (incoming) => {
      const chunks = [];
      incoming.on("error", reject);
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const response = { status: incoming.statusCode, headers: new Headers(incoming.headers) };
        try {
          accept({ response, text, payload: response.headers.get("content-type")?.includes("application/json") && text ? JSON.parse(text) : null });
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(options.body);
  });
  const login = async () => {
    const result = await send("/api/auth/login", { method: "POST", headers: { origin: "https://site.test" }, body: JSON.stringify({ password }) });
    assert.equal(result.response.status, 200);
    return result.response.headers.get("set-cookie").split(";")[0];
  };
  return { send, login, store, service, operations, auth, get liveCalls() { return liveCalls; } };
}

test("anonymous health is minimal and every operational API remains private", async (t) => {
  const app = await setup(t);
  const health = await app.send("/healthz");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.payload, { ok: true, service: "pengmanager-system" });
  const head = await app.send("/healthz", { method: "HEAD" });
  assert.equal(head.response.status, 200);
  assert.equal(head.text, "");
  const blocked = ["/api/health", "/api/bootstrap", "/api/summary", "/api/events", "/api/claims", "/api/content",
    "/api/interactions", "/api/geo/queries", "/api/geo/observations", "/api/geo/metrics", "/api/operations",
    "/api/adapters/health", "/api/media/jobs", "/api/exports/public-preview", "/api/geo/engine/samples"];
  for (const path of blocked) {
    const result = await app.send(path);
    assert.equal(result.response.status, 401, path);
    assert.equal(result.payload.error.code, "AUTH_REQUIRED", path);
    assert.equal(result.payload.summary, undefined);
    assert.equal(result.payload.accounts, undefined);
  }
  assert.equal(app.liveCalls, 0);
});

test("anonymous website and login shell work while every admin static entry stays protected", async (t) => {
  const { send } = await setup(t);
  for (const path of ["/", "/about", "/login", "/login.js", "/styles.css", "/operations.css", "/site.css", "/site.js", "/favicon.svg"]) {
    const result = await send(path);
    assert.equal(result.response.status, 200, path);
    assert.ok(result.response.headers.get("content-security-policy"));
    assert.equal(result.response.headers.get("x-frame-options"), "DENY");
  }
  for (const path of ["/admin", "/index.html"]) {
    const result = await send(path);
    assert.equal(result.response.status, 302, path);
    assert.equal(result.response.headers.get("location"), "/login");
  }
  for (const path of ["/app.js", "/operations.js", "/site.html", "/login.html", "/%2e%2e/src/server.mjs", "/var/state.json"]) {
    const result = await send(path);
    assert.equal(result.response.status, 401, path);
    assert.equal(result.text.includes("PRIVATE_WORKSPACE"), false);
  }
});

test("local-first root routing can stay private while personal website is disabled", async (t) => {
  const { send } = await setup(t, { publicWebsite: false });
  const result = await send("/");
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), "/login");
});

test("public profile excludes private, expired, unapproved, and sensitive source metadata", async (t) => {
  const { store, send } = await setup(t);
  await store.mutate({ type: "test.public-filter", actor: "test" }, (state) => {
    const base = { type: "project", state: "approved", publicLevel: "approved_public", sensitivity: "low", expiresAt: null,
      source: { label: "Public reference", visibility: "public", url: "https://github.com/geniusdapeng-collab" } };
    state.claims = [
      { ...base, id: "PUBLIC", text: "PUBLIC_VISIBLE" },
      { ...base, id: "PUBLIC-ANCHOR", text: "PUBLIC_ANCHOR_VISIBLE", source: { ...base.source, url: `${base.source.url}#issuecomment-123` } },
      { ...base, id: "PRIVATE", text: "PRIVATE_CLAIM_MARKER", publicLevel: "private" },
      { ...base, id: "EXPIRED", text: "EXPIRED_CLAIM_MARKER", expiresAt: "2026-01-01" },
      { ...base, id: "DRAFT", text: "DRAFT_CLAIM_MARKER", state: "draft" },
      { ...base, id: "PRIVATE-SOURCE", text: "PRIVATE_SOURCE_CLAIM_MARKER", source: { ...base.source, visibility: "private" } },
      { ...base, id: "HIGH-SENSITIVITY", text: "HIGH_SENSITIVITY_CLAIM_MARKER", sensitivity: "high" },
      { ...base, id: "EXTRA-SOURCE", text: "Source with internal metadata", source: { ...base.source, internalNote: "PRIVATE_SOURCE_NOTE_MARKER" } },
      { ...base, id: "SOURCE-QUERY", text: "Source with unsafe query", source: { ...base.source, url: "https://github.com/geniusdapeng-collab?token=placeholder" } },
      { ...base, id: "SOURCE-USERINFO", text: "Source with unsafe userinfo", source: { ...base.source, url: "https://person:placeholder@github.com/geniusdapeng-collab" } },
      { ...base, id: "SOURCE-FRAGMENT", text: "UNSAFE_FRAGMENT_CLAIM_MARKER", source: { ...base.source, url: `${base.source.url}#access_token=placeholder` } },
      { ...base, id: "SOURCE-ENCODED-FRAGMENT", text: "ENCODED_FRAGMENT_CLAIM_MARKER", source: { ...base.source, url: `${base.source.url}#access%5Ftoken%3Dplaceholder` } },
      { ...base, id: "SOURCE-COLON-FRAGMENT", text: "COLON_FRAGMENT_CLAIM_MARKER", source: { ...base.source, url: `${base.source.url}#id_token:placeholder` } },
      { ...base, id: "SOURCE-LOCAL-TRAILING-DOT", text: "LOCAL_TRAILING_DOT_CLAIM_MARKER", source: { ...base.source, url: "https://localhost./private" } },
      { ...base, id: "SOURCE-EXAMPLE", text: "EXAMPLE_SOURCE_CLAIM_MARKER", source: { ...base.source, url: "https://example.com/placeholder" } },
      { ...base, id: "SOURCE-PRIVATE-PORT", text: "PRIVATE_PORT_CLAIM_MARKER", source: { ...base.source, url: "https://github.com:8443/private" } },
    ];
    state.entity.privateInternalNote = "PRIVATE_ENTITY_MARKER";
    return true;
  });
  const result = await send("/public-api/profile");
  assert.equal(result.response.status, 200);
  assert.ok(result.payload.claims.some((claim) => claim.id === "PUBLIC"));
  assert.ok(result.payload.claims.some((claim) => claim.id === "PUBLIC-ANCHOR"));
  for (const marker of ["PRIVATE_CLAIM_MARKER", "EXPIRED_CLAIM_MARKER", "DRAFT_CLAIM_MARKER", "PRIVATE_SOURCE_CLAIM_MARKER",
    "HIGH_SENSITIVITY_CLAIM_MARKER", "PRIVATE_SOURCE_NOTE_MARKER", "PRIVATE_ENTITY_MARKER", "token=placeholder", "person:placeholder@",
    "UNSAFE_FRAGMENT_CLAIM_MARKER", "ENCODED_FRAGMENT_CLAIM_MARKER", "COLON_FRAGMENT_CLAIM_MARKER",
    "LOCAL_TRAILING_DOT_CLAIM_MARKER", "EXAMPLE_SOURCE_CLAIM_MARKER", "PRIVATE_PORT_CLAIM_MARKER"] ) {
    assert.equal(result.text.includes(marker), false, `Public profile leaked ${marker}`);
  }
  for (const key of ["accounts", "content", "publications", "interactions", "accountOperations", "events", "queries"]) {
    assert.equal(result.payload[key], undefined, key);
  }
  assert.equal(result.payload.entity.aliases, undefined);
  assert.equal(result.payload.entity.ownedUrlPrefixes, undefined);
});

test("cloud login authorizes admin pages and APIs, then logout revokes the same session", async (t) => {
  const { send, login } = await setup(t);
  const anonymous = await send("/api/auth/status");
  assert.deepEqual(anonymous.payload, { enabled: true, authenticated: false });
  const cookie = await login();
  const admin = await send("/admin", { headers: { cookie } });
  assert.equal(admin.response.status, 200);
  assert.match(admin.text, /operations\.js|app\.js/);
  const bootstrap = await send("/api/bootstrap", { headers: { cookie } });
  assert.equal(bootstrap.response.status, 200);
  assert.equal(bootstrap.payload.accounts.length, 16);
  const logout = await send("/api/auth/logout", { method: "POST", headers: { cookie, origin: "https://site.test" } });
  assert.equal(logout.response.status, 200);
  assert.match(logout.response.headers.get("set-cookie"), /Max-Age=0; Secure/);
  const revoked = await send("/api/bootstrap", { headers: { cookie } });
  assert.equal(revoked.response.status, 401);
});

test("auth HTTP endpoints validate body shape and method without internal errors", async (t) => {
  const { send } = await setup(t);
  const wrongMethod = await send("/api/auth/login");
  assert.equal(wrongMethod.response.status, 405);
  assert.equal(wrongMethod.response.headers.get("allow"), "POST");
  const malformed = await send("/api/auth/login", { method: "POST", body: "{" });
  assert.equal(malformed.response.status, 400);
  const nullBody = await send("/api/auth/login", { method: "POST", body: "null" });
  assert.equal(nullBody.response.status, 400);
  const wrongPassword = await send("/api/auth/login", { method: "POST", body: JSON.stringify({ password: randomBytes(18).toString("base64url") }) });
  assert.equal(wrongPassword.response.status, 401);
});

test("cross-origin writes and forged Host remain blocked with an otherwise valid cookie", async (t) => {
  const { send, login } = await setup(t);
  const cookie = await login();
  for (const headers of [{ origin: "https://attacker.test" }, { "sec-fetch-site": "cross-site" }, { origin: "http://site.test", "x-forwarded-proto": "https" }]) {
    const result = await send("/api/interactions", { method: "POST", headers: { cookie, ...headers }, body: JSON.stringify({ text: "Agent product question" }) });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error.code, "CROSS_ORIGIN_REQUEST_BLOCKED");
  }
  const host = await send("/api/bootstrap", { headers: { cookie, host: "attacker.test", "x-forwarded-host": "site.test" } });
  assert.equal(host.response.status, 403);
  const crossNavigation = await send("/login", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossNavigation.response.status, 200);
});

test("process agent cannot approve or create actions and can read only its scoped APIs", async (t) => {
  const app = await setup(t);
  const headers = { authorization: `Bearer ${agentToken}` };
  for (const path of ["/api/operations", "/api/bootstrap", "/api/content", "/api/interactions"]) {
    const result = await app.send(path, { headers });
    assert.equal(result.response.status, 200, path);
  }
  for (const path of ["/api/operations", "/api/operations/OP-0001/approve", "/api/claims/C003/approve", "/api/live/github/publish", "/api/content"]) {
    const result = await app.send(path, { method: "POST", headers, body: JSON.stringify({ confirm: true, actor: "Impersonated owner" }) });
    assert.equal(result.response.status, 403, path);
    assert.equal(result.payload.error.code, "AGENT_SCOPE_DENIED");
  }
  assert.equal(app.liveCalls, 0);
});

test("agent writes preserve authenticated actor and cannot bypass publication approval", async (t) => {
  const { send, store, login } = await setup(t);
  const headers = { authorization: `Bearer ${agentToken}` };
  const interaction = await send("/api/interactions", { method: "POST", headers,
    body: JSON.stringify({ text: "Agent product question", actor: "Impersonated owner" }) });
  assert.equal(interaction.response.status, 201);
  assert.equal(store.snapshot().events.at(-1).actor, "PengManager Agent");
  await store.mutate({ type: "test.prepare-publication", actor: "test" }, (state) => {
    const account = state.accounts.find((row) => row.id === "github");
    account.status = "active";
    account.policyStatus = "reviewed";
    const content = state.content[0];
    content.status = "scheduled";
    content.platforms = ["GitHub"];
    for (const id of content.claimIds) state.claims.find((row) => row.id === id).state = "approved";
    return true;
  });
  const body = JSON.stringify({ contentId: "CNT-001", accountId: "github", actor: "Impersonated owner", receipt: {
      url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os", publishedAt: fixedDate.toISOString(), capturedBy: "test", dataMode: "imported",
    } });
  const denied = await send("/api/publications/manual", { method: "POST", headers, body });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.payload.error.code, "AGENT_SCOPE_DENIED");
  assert.equal(store.snapshot().publications.length, 0);
  const cookie = await login();
  const publication = await send("/api/publications/manual", { method: "POST", headers: { cookie }, body });
  assert.equal(publication.response.status, 201);
  assert.equal(publication.payload.recordedBy, "PengManager");
});

test("low-cost cloud configuration blocks render before a media job can start", async (t) => {
  const app = await setup(t);
  const cookie = await app.login();
  const result = await app.send("/api/live/media/render", { method: "POST", headers: { cookie }, body: JSON.stringify({ confirm: true }) });
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.error.code, "MEDIA_RENDER_DISABLED");
  assert.equal(app.liveCalls, 0);
});

async function prepareReply(operations, { manual = false } = {}) {
  await operations.updateAccount("github", { actor: "PengManager", status: "active", policyStatus: "reviewed", policyCheckedAt: fixedDate.toISOString() });
  return operations.create({ actor: "PengManager", accountId: "github", type: "reply",
    executionMode: manual ? "manual" : "browser", targetUrl: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1",
    replyText: manual ? "客户合同问题由本人处理。" : "谢谢阅读这篇产品文章。" });
}

test("agent cannot fail a draft operation before the owner has approved it", async (t) => {
  const { send, operations } = await setup(t);
  const operation = await prepareReply(operations);
  const result = await send(`/api/operations/${operation.id}/fail`, { method: "POST",
    headers: { authorization: `Bearer ${agentToken}` }, body: JSON.stringify({ reason: "Not approved yet" }) });
  assert.ok([403, 409].includes(result.response.status), "Draft operation must remain under owner control");
  assert.equal(operations.list()[0].status, "draft");
});

test("agent cannot execute a human-only manual reply even after owner approval", async (t) => {
  const { send, operations } = await setup(t);
  const operation = await prepareReply(operations, { manual: true });
  await operations.approve(operation.id, { approvedBy: "PengManager", authorizationNote: "本人手工处理高风险互动" });
  const result = await send(`/api/operations/${operation.id}/start`, { method: "POST",
    headers: { authorization: `Bearer ${agentToken}` }, body: JSON.stringify({}) });
  assert.equal(result.response.status, 403);
  assert.equal(operations.list()[0].status, "approved");
});

test("agent cannot complete a human-only manual reply started by the owner", async (t) => {
  const { send, operations } = await setup(t);
  const operation = await prepareReply(operations, { manual: true });
  await operations.approve(operation.id, { approvedBy: "PengManager", authorizationNote: "本人手工处理高风险互动" });
  await operations.start(operation.id, { actor: "PengManager" });
  const result = await send(`/api/operations/${operation.id}/complete`, { method: "POST", headers: { authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({ receipt: { url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1#issuecomment-1",
      dataMode: "imported", verificationMethod: "manual_readback", publishedAt: fixedDate.toISOString(), verifiedAt: fixedDate.toISOString(),
      capturedBy: "test", verifiedBy: "test" } }) });
  assert.equal(result.response.status, 403);
  assert.equal(operations.list()[0].status, "in_progress");
});

test("agent completion records browser verification under the authenticated agent identity", async (t) => {
  const { send, operations } = await setup(t);
  const operation = await prepareReply(operations);
  await operations.approve(operation.id, { approvedBy: "PengManager", authorizationNote: "授权浏览器执行此条普通回复" });
  const headers = { authorization: `Bearer ${agentToken}` };
  const start = await send(`/api/operations/${operation.id}/start`, { method: "POST", headers, body: "{}" });
  assert.equal(start.response.status, 200);
  const malformed = await send(`/api/operations/${operation.id}/complete`, { method: "POST", headers, body: JSON.stringify({ receipt: null }) });
  assert.equal(malformed.response.status, 400);
  const result = await send(`/api/operations/${operation.id}/complete`, { method: "POST", headers,
    body: JSON.stringify({ actor: "李大鹏", receipt: {
      url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1#issuecomment-2",
      publishedAt: fixedDate.toISOString(), verifiedAt: fixedDate.toISOString(), dataMode: "imported",
      verificationMethod: "manual_readback", capturedBy: "李大鹏", verifiedBy: "李大鹏",
    } }) });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.status, "completed");
  assert.equal(result.payload.receipt.verificationMethod, "browser_readback");
  assert.equal(result.payload.receipt.capturedBy, "PengManager Agent");
  assert.equal(result.payload.receipt.verifiedBy, "PengManager Agent");
  assert.equal(result.payload.receipt.recordedBy, "PengManager Agent");
});
