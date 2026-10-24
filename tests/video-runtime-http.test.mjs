import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { createGeoOsServer } from "../src/http/server.mjs";
import { publicVideoCapabilities, publicVideoStatus, publicWorkbenchUrl } from "../src/http/video-runtime.mjs";
import { filterCatalog } from "../public/video-workbench.js";

const rootDir = resolve(import.meta.dirname, "..");
const pin = "8a287fb0190425a0c90309bf48ecaf72966e7db9";
const status = state => ({ version: 1, state, ready: state === "ready", sourceMain: pin,
  workbenchUrl: "http://127.0.0.1:4321/", backendHealth: { ok: true }, dbHealth: { ok: true, owned: true } });

async function fixture(t, videoRuntime) {
  const service = { summary: () => ({ preserved: true }), bootstrap: () => ({ identity: "pengmanager-system" }) };
  const server = createGeoOsServer({ service, videoRuntime, publicDir: resolve(rootDir, "public") });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise(done => server.close(done)));
  return (path, options = {}) => new Promise((done, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port: server.address().port, path, ...options }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          done({ response: { status: response.statusCode, headers: new Headers(response.headers) },
            payload: options.method === "HEAD" ? null : JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

test("video status represents every runtime state without exposing private runtime fields", async t => {
  for (const state of ["not-installed", "stopped", "setting-up", "starting", "ready", "stopping", "error"]) {
    await t.test(state, async st => {
      const request = await fixture(st, { status: async () => ({ ...status(state), bootstrapKey: "test-only-private-bootstrap-value", token: "test-only-private-session-value", errorSafe: "private-path-and-provider-message", nativeSession: "test-only-private-session-value" }) });
      const result = await request("/api/video-runtime/status");
      assert.equal(result.response.status, 200);
      assert.equal(result.payload.state, state);
      assert.equal(result.payload.ready, state === "ready");
      assert.equal(result.payload.workbenchUrl, state === "ready" ? "http://127.0.0.1:4321/" : null);
      assert.doesNotMatch(JSON.stringify(result.payload), /private-|bootstrapKey|nativeSession|token/);
      assert.equal(result.response.headers.get("x-frame-options"), "DENY");
    });
  }
});

test("only a valid loopback root origin can be offered as the native workbench", () => {
  for (const value of ["https://127.0.0.1:4321/", "http://example.com:4321/", "http://127.0.0.1.evil.test:4321/", "javascript:alert(1)", "http://user:fake@localhost:4321/", "http://localhost:4321/video", "http://localhost:4321/?token=value", "http://localhost:4321/#key", "http://localhost/", null, "invalid"]) {
    assert.equal(publicWorkbenchUrl(value), null, String(value));
    assert.equal(publicVideoStatus({ ...status("ready"), workbenchUrl: value }).ready, false);
    assert.equal(publicVideoStatus({ ...status("ready"), workbenchUrl: value }).workbenchUrl, null);
  }
  assert.equal(publicWorkbenchUrl("http://[::1]:4321/"), "http://[::1]:4321/");
  assert.equal(publicVideoStatus({ ...status("ready"), state: "invented-state" }).state, "error");
  assert.equal(publicVideoStatus({ ...status("ready"), backendHealth: { ok: false } }).ready, false);
  assert.equal(publicVideoStatus({ ...status("ready"), dbHealth: { ok: false } }).workbenchUrl, null);
  assert.equal(publicVideoStatus({ ...status("ready"), dbHealth: { ok: true, owned: false } }).ready, false);
  assert.equal(publicVideoStatus({ ...status("ready"), ready: false }).state, "error");
});

test("headless CLI/MCP readiness requires owned healthy services and does not require a workbench URL", () => {
  const raw = { ...status("ready"), workbenchEnabled: false, workbenchUrl: null };
  assert.equal(publicVideoStatus(raw).ready, true);
  assert.equal(publicVideoStatus(raw).workbenchEnabled, false);
  assert.equal(publicVideoStatus(raw).workbenchUrl, null);
  assert.equal(publicVideoStatus({ ...raw, dbHealth: { ok: true, owned: false } }).ready, false);
  assert.equal(publicVideoStatus({ ...raw, backendHealth: { ok: false } }).ready, false);
});

test("complete catalog projects every actual role, skill, tool and capability including Compositor", async t => {
  const catalog = JSON.parse(await readFile(resolve(rootDir, "engines/video-edit/pengmanager-capabilities.json"), "utf8"));
  const currentPin = catalog.source.pin;
  let nativeSessions = 0;
  const request = await fixture(t, {
    status: async () => status("ready"), nativeSession: async () => { nativeSessions += 1; },
    capabilities: async () => ({ schemaVersion: catalog.schemaVersion, scope: "complete-edit", state: "ready", ready: true,
      sourceMain: currentPin, catalog, inventory: { fileCount: 3434 },
      categories: [{ id: "ai-generation", label: "AI生成", status: "dependency-missing", missing: [{ id: "provider", reasons: ["credentials unavailable"], token: "test-only-private-provider-value" }], entrypoints: ["/ai-video/assets?tab=studio"] }],
      tools: [{ id: "compositor", label: "Compositor", installed: true, ready: false, running: false, missing: ["runtime missing"], entrypoints: ["visualwrite.compose"], productionVerified: false, secret: "test-only-private-tool-value", environment: { TOKEN: "test-only-private-tool-value" } }],
      bootstrapKey: "test-only-private-bootstrap-value" }),
  });
  const result = await request("/api/video-runtime/capabilities");
  assert.equal(result.response.status, 200);
  for (const key of ["roles", "skills", "tools", "capabilities", "installers"]) {
    assert.deepEqual(result.payload.catalog[key].map(row => row.id), catalog[key].map(row => row.id));
    assert.ok(result.payload.catalog[key].every(row => ["unchecked", "ready", "missing", "blocked"].includes(row.status.dependencyState)));
  }
  assert.equal(result.payload.inventory.roleCount, catalog.roles.length);
  assert.equal(result.payload.inventory.toolCount, catalog.tools.length);
  for (const original of catalog.roles.filter(role => role.runtimePresetKey)) {
    const projected = result.payload.catalog.roles.find(role => role.id === original.id);
    assert.equal(projected.runtimePresetKey, original.runtimePresetKey);
    assert.deepEqual(projected.runtimeIdentity, {
      sourceBundleId: original.runtimeIdentity?.sourceBundleId ?? "",
      originalPresetKey: original.runtimeIdentity?.originalPresetKey ?? "",
      alias: original.runtimeIdentity?.alias === true,
    });
    assert.deepEqual(projected.fenceBindings, original.fenceBindings ?? []);
  }
  assert.ok(result.payload.catalog.installers.some(row => row.id === "compositor"));
  assert.equal(nativeSessions, 0);
  assert.equal(result.payload.tools[0].installed, true);
  assert.equal(result.payload.tools[0].ready, false);
  assert.equal(result.payload.tools[0].productionVerified, false);
  assert.deepEqual(result.payload.categories[0].missing, ["provider：credentials unavailable"]);
  assert.equal(result.payload.categories[0].entrypoints[0].path, "/ai-video/assets?tab=studio");
  assert.doesNotMatch(JSON.stringify(result.payload), /private-(?:bootstrap|tool|provider)-value|environment/);
  assert.throws(() => publicVideoCapabilities({ schemaVersion: catalog.schemaVersion, scope: "complete-edit", sourceMain: "f".repeat(40), catalog }), /完整视频能力目录/);
  assert.throws(() => publicVideoCapabilities({ schemaVersion: catalog.schemaVersion, scope: "complete-edit", sourceMain: currentPin, catalog: { ...catalog, tools: null } }), /完整视频能力目录/);
});

test("runtime status and catalog are GET-only, exact-path and parameter-free", async t => {
  let calls = 0;
  const request = await fixture(t, { status: async () => { calls += 1; return status("ready"); } });
  for (const method of ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"]) {
    const result = await request("/api/video-runtime/status", { method });
    assert.equal(result.response.status, 405);
    assert.equal(result.response.headers.get("allow"), "GET");
  }
  for (const path of ["/api/video-runtime/status?actor=x", "/api/video-runtime/status?token=x&token=y"]) assert.equal((await request(path)).response.status, 400);
  for (const path of ["/api/video-runtime/session", "/api/video-runtime/start", "/api/video-runtime/status/", "/api/video-runtime"]) assert.equal((await request(path)).response.status, 404);
  assert.equal(calls, 0);
});

test("station license keeps scope and commercial gates while discarding private fields", () => {
  const catalog = { schemaVersion: "pengmanager.video-capabilities/v1", source: { pin },
    roles: [], skills: [], tools: [], capabilities: [], installers: [] };
  const projected = publicVideoCapabilities({ schemaVersion: catalog.schemaVersion, scope: "complete-edit", sourceMain: pin, catalog,
    tools: [
      { id: "talkcraft", installed: true, ready: true, license: {
        scope: "authorized", commercialGrantPresent: true, commercialReady: false,
        condition: "fixture license still requires verification", token: "test-only-private-license-value", grantContents: "test-only-private-grant-value",
      } },
      { id: "contradictory-scope", license: { scope: "noncommercial", commercialGrantPresent: true, commercialReady: true } },
      { id: "missing-grant", license: { scope: "authorized", commercialGrantPresent: false, commercialReady: true } },
      { id: "legacy", license: "仅限内部测试" },
    ],
  }).tools;
  assert.equal(projected[0].installed, true);
  assert.equal(projected[0].ready, true);
  assert.deepEqual(projected[0].license, {
    scope: "authorized", commercialGrantPresent: true, commercialReady: false,
    condition: "fixture license still requires verification",
  });
  assert.equal(projected[1].license.commercialReady, false);
  assert.equal(projected[2].license.commercialReady, false);
  assert.equal(projected[3].license, "仅限内部测试");
  assert.doesNotMatch(JSON.stringify(projected), /private-(?:license|grant)-value|grantContents|token/);
});

test("Host, Origin and cross-site protections execute before runtime reads", async t => {
  let calls = 0;
  const request = await fixture(t, { status: async () => { calls += 1; return status("ready"); } });
  for (const headers of [{ Host: "evil.example" }, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await request("/api/video-runtime/status", { headers })).response.status, 403);
  }
  assert.equal(calls, 0);
});

test("missing, broken and malformed runtime cannot break the existing control plane or leak errors", async t => {
  for (const runtime of [undefined, { status: async () => { throw new Error("private-provider-response"); }, capabilities: async () => ({ bootstrapKey: "test-only-private-bootstrap-value" }) }]) {
    await t.test(runtime ? "broken" : "missing", async st => {
      const request = await fixture(st, runtime);
      const health = await request("/api/health");
      assert.equal(health.response.status, 200);
      assert.equal(health.payload.summary.preserved, true);
      assert.equal((await request("/api/bootstrap")).payload.identity, "pengmanager-system");
      const current = await request("/api/video-runtime/status");
      assert.equal(current.response.status, runtime ? 503 : 200);
      const catalog = await request("/api/video-runtime/capabilities");
      assert.equal(catalog.response.status, 503);
      assert.doesNotMatch(JSON.stringify([current.payload, catalog.payload]), /private-/);
    });
  }
});

test("catalog filtering reaches all rows and handles special characters and empty results", () => {
  const rows = Array.from({ length: 45 }, (_, index) => ({ id: `tool-${index}`, name: index === 44 ? "Compositor <中文> & \"layer\"" : "tool", status: { dependencyState: index === 44 ? "missing" : "ready" } }));
  assert.equal(filterCatalog(rows, "", "all").length, 45);
  assert.equal(filterCatalog(rows, "compositor <中文>", "all")[0].id, "tool-44");
  assert.equal(filterCatalog(rows, "", "missing").length, 1);
  assert.equal(filterCatalog(rows, "does-not-exist", "all").length, 0);
  assert.equal(filterCatalog([], "", "all").length, 0);
});
