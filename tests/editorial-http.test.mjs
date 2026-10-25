import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";
import { createWebsiteReadback } from "../src/services/website-readback.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { createAdminAuth, hashAdminPassword, hashAgentToken } from "../src/security/admin-auth.mjs";
import { PNG, MP4 } from "./fixtures/synthetic-media.mjs";

const root = resolve(import.meta.dirname, "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-editorial-http-"));
  const store = new JsonStore({ filePath: join(directory, "live", "state.json"), writerLock: true });
  await store.open(async () => {
    const seed = await loadSeedState(join(root, "data/seed"));
    seed.claims = [{ id: "C-T1", type: "project", text: "Synthetic isolated HTTP acceptance fixture.",
      state: "approved", publicLevel: "approved_public", sensitivity: "low", evidenceLevel: "A", expiresAt: null,
      source: { visibility: "public", label: "Synthetic fixture", url: "https://nodejs.org/" } }];
    return seed;
  });
  const service = new GeoOsService({ store });
  const password = "synthetic-test-password-only";
  const agentToken = randomBytes(32).toString("base64url");
  const auth = createAdminAuth({ env: { ADMIN_PASSWORD_HASH: await hashAdminPassword(password), ADMIN_AGENT_TOKEN_HASH: hashAgentToken(agentToken) } });
  let editorial;
  const mediaAssets = new MediaAssets({ store, publicAssetAuthorizer: (id, sha) => editorial.isAssetPublic(id, sha) });
  await mediaAssets.initialize();
  const backup = createEditorialBackup({ store, mediaAssets });
  editorial = new EditorialService({ store, geoService: service, mediaAssets, beforeActivation: backup });
  const server = createGeoOsServer({ service, editorial, mediaAssets, auth, publicDir: join(root, "public"), publicWebsite: true });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  editorial.publicOrigin = origin;
  editorial.verifyReadback = createWebsiteReadback({ origin, allowLoopback: true });
  await migrateEditorialState(store, { publicOrigin: origin });
  t.after(async () => {
    await new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeIdleConnections(); });
    await store.close(); await rm(directory, { force: true, recursive: true });
  });
  const login = await fetch(`${origin}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  let counter = 0;
  async function call(path, { method = "GET", body, etag, key, anonymous = false, headers = {} } = {}) {
    const response = await fetch(`${origin}${path}`, { method, redirect: "manual", headers: {
      ...(anonymous ? {} : { Cookie: cookie }), ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(!["GET", "HEAD"].includes(method) ? { "Idempotency-Key": key || `http-fixture-${++counter}` } : {}),
      ...(etag ? { "If-Match": etag } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let payload;
    if (response.headers.get("content-type")?.includes("application/json") && text) payload = JSON.parse(text);
    return { response, payload, text };
  }
  async function ok(path, options, expected = 200) {
    const result = await call(path, options);
    assert.equal(result.response.status, expected, JSON.stringify(result.payload)); return result.payload;
  }
  return { directory, store, service, editorial, mediaAssets, backup, server, origin, cookie, agentToken, call, ok };
}

async function readyDestination(f) {
  const destination = await f.ok("/api/destinations/official-site");
  return f.ok("/api/destinations/official-site", { method: "PATCH", etag: destination.etag,
    body: { visibility: "public", status: "active", identityConfirmed: true, policyStatus: "reviewed",
      policyCheckedAt: new Date().toISOString(), reviewNote: "Synthetic local host reviewed for isolated acceptance." } });
}

async function upload(f, bytes, mime, index) {
  const response = await fetch(`${f.origin}/api/media/assets`, { method: "POST", headers: { Cookie: f.cookie,
    "Content-Type": mime, "Idempotency-Key": `synthetic-upload-${index}`, "X-Content-Sha256": hash(bytes) }, body: bytes });
  const asset = await response.json(); assert.equal(response.status, 201, JSON.stringify(asset));
  return f.ok(`/api/media/assets/${asset.id}/approve`, { method: "POST", etag: asset.etag,
    body: { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Synthetic owner-created acceptance fixture." } });
}

async function release(f, { locale = "zh-CN", format = "article", assetRefs = [], story: existingStory } = {}) {
  const story = existingStory ? await f.ok(`/api/stories/${existingStory.id}`) : await f.ok("/api/stories", {
    method: "POST", body: { workingTitle: "Synthetic acceptance only", claimIds: ["C-T1"] },
  }, 201);
  const title = locale === "en-US" ? "A complete synthetic edition" : "完整的隔离验收稿";
  const body = 'First complete paragraph <script>window.injected=1</script> & exact text.\n\n第二段，不得摘要替换。';
  const blocks = [{ type: "heading", level: 2, text: "00:00 A real section" }, { type: "paragraph", text: body },
    ...assetRefs.filter(row => row.role === "image").map(row => ({ type: "image", assetId: row.assetId, alt: row.alt }))];
  const edition = await f.ok(`/api/stories/${story.id}/editions`, { method: "POST", etag: story.etag,
    body: { locale, format, title, body, blocks, claimIds: ["C-T1"], assetRefs } }, 201);
  let variant = await f.ok(`/api/editions/${edition.id}/variants`, { method: "POST", etag: edition.etag, body: { destinationId: "official-site" } }, 201);
  for (const target of ["fact_check", "approved", "scheduled"]) variant = await f.ok(`/api/content/${variant.id}/transition`, {
    method: "POST", etag: variant.etag, body: { target, ...(target === "approved" ? { reviewed: true, snapshotHash: variant.snapshotHash } : {}) },
  });
  const candidate = await f.ok("/api/website/releases", { method: "POST", etag: variant.etag,
    body: { contentId: variant.id, slug: `${locale === "zh-CN" ? "zh" : "en"}-${format.replaceAll("_", "-")}` } }, 201);
  return { story, edition, variant, candidate, body, title };
}

test("new HTTP APIs preserve admin/Agent/CSRF boundaries, ETags, query checks and retry idempotency", async t => {
  const f = await fixture(t);
  for (const path of ["/api/editorial/bootstrap", "/api/platforms", "/api/accounts", "/api/media/assets", "/api/stories", "/admin/preview/REL-00001"]) {
    assert.equal((await f.call(path, { anonymous: true })).response.status, 401);
    assert.equal((await f.call(path, { headers: { Authorization: `Bearer ${f.agentToken}` } })).response.status, 403);
  }
  assert.equal((await f.call("/api/stories", { method: "POST", body: { workingTitle: "Blocked cross site" }, headers: { Origin: "https://attacker.invalid" } })).response.status, 403);
  assert.equal((await f.call("/api/stories", { method: "POST", body: { workingTitle: "Missing key" }, headers: { "Idempotency-Key": "" } })).response.status, 400);
  const key = "same-create-story-key";
  const first = await f.ok("/api/stories", { method: "POST", key, body: { workingTitle: "Exact retry <>&" } }, 201);
  const revision = f.store.snapshot().revision;
  assert.deepEqual(await f.ok("/api/stories", { method: "POST", key, body: { workingTitle: "Exact retry <>&" } }, 201), first);
  assert.equal(f.store.snapshot().revision, revision);
  assert.equal((await f.call("/api/stories", { method: "POST", key, body: { workingTitle: "Changed retry" } })).response.status, 409);
  assert.equal((await f.call(`/api/stories/${first.id}`, { method: "PATCH", body: { workingTitle: "Missing precondition" } })).response.status, 428);
  assert.equal((await f.call(`/api/stories/${first.id}`, { method: "PATCH", etag: '"stale"', body: { workingTitle: "Stale" } })).response.status, 412);
  assert.equal((await f.call("/public-api/content?limit=0", { anonymous: true })).response.status, 400);
  assert.equal((await f.call("/public-api/content?locale=zh-CN&locale=en-US", { anonymous: true })).response.status, 400);
  assert.equal((await f.call("/public-api/content?private=true", { anonymous: true })).response.status, 400);
  assert.equal((await f.call("/public-api/content", { method: "POST", anonymous: true, body: {} })).response.status, 405);
  assert.equal(verifyEventChain(f.store.snapshot().events).valid, true);
});

test("complete bilingual article/visual/video releases use actual SSR, bytes/readback, full backup and isolated restore", async t => {
  const f = await fixture(t); await readyDestination(f);
  const image = await upload(f, PNG, "image/png", "image");
  const video = await upload(f, MP4, "video/mp4", "video");
  const refs = asset => ({ assetId: asset.id, sha256: asset.sha256, role: asset.kind === "video" ? "video" : "image", alt: "Synthetic blue fixture", caption: "Acceptance fixture" });
  assert.equal((await fetch(`${f.origin}/public-media/${image.id}/${image.sha256}`)).status, 404);
  let articleStory;
  const created = [];
  for (const spec of [{ format: "article" }, { format: "article", locale: "en-US" },
    { format: "image_text", assetRefs: [refs(image)] }, { format: "video", assetRefs: [refs(video)] }]) {
    const row = await release(f, { ...spec, ...(spec.locale === "en-US" ? { story: articleStory } : {}) });
    if (!articleStory) articleStory = row.story;
    const preview = await f.call(`/admin/preview/${row.candidate.id}`);
    assert.equal(preview.response.status, 200); assert.equal(preview.response.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.match(preview.text, /"preview":true/); assert.ok(preview.text.includes(row.title));
    assert.equal((await f.call(row.candidate.canonicalPath, { anonymous: true })).response.status, 404);
    const approved = await f.ok(`/api/website/releases/${row.candidate.id}/approve`, { method: "POST", etag: row.candidate.etag,
      body: { reviewed: true, snapshotHash: row.candidate.snapshotHash, authorizationNote: "Isolated synthetic acceptance publication only." } });
    const activated = await f.ok(`/api/website/releases/${approved.id}/publish`, { method: "POST", etag: approved.etag,
      body: { confirm: true, expectedPreviousReleaseId: null } });
    assert.equal(activated.status, "live_unverified");
    const verified = await f.ok(`/api/website/releases/${activated.id}/verify`, { method: "POST", etag: activated.etag, body: { confirm: true } });
    assert.equal(verified.status, "published"); assert.equal(verified.receipt.verificationMethod, "server_readback");
    const page = await f.call(verified.canonicalPath, { anonymous: true });
    assert.equal(page.response.status, 200); assert.match(page.text, /&lt;script&gt;window.injected=1&lt;\/script&gt;/);
    assert.doesNotMatch(page.text, /<script>window.injected=1<\/script>/);
    assert.equal((page.text.match(/data-public-release=/g) || []).length, 1);
    assert.ok(page.text.includes(`<link rel="canonical" href="${f.origin}${verified.canonicalPath}"`));
    if (spec.format === "video") assert.match(page.text, /<video controls playsinline preload="metadata"/);
    if (spec.format === "image_text") assert.match(page.text, /data-enlarge-image/);
    created.push(verified);
  }
  const detail = await f.ok("/public-api/content/zh-CN/article/zh-article", { anonymous: true });
  assert.equal(detail.alternates["en-US"], `${f.origin}/en/articles/en-article`);
  assert.equal(detail.body, 'First complete paragraph <script>window.injected=1</script> & exact text.\n\n第二段，不得摘要替换。');
  assert.doesNotMatch(JSON.stringify(detail), /claimBindings|accountSnapshot|identityReview|rightsNote|filePath|fixture-admin/);
  const range = await fetch(`${f.origin}/public-media/${video.id}/${video.sha256}`, { headers: { Range: "bytes=0-31" } });
  assert.equal(range.status, 206); assert.deepEqual(Buffer.from(await range.arrayBuffer()), MP4.subarray(0, 32));
  const current = await f.backup.captureCurrent();
  const verifiedBackup = await verifyEditorialBackup({ store: f.store, backupId: current.backupId, expectedManifestSha256: current.manifestSha256 });
  assert.ok(verifiedBackup);
  const target = join(f.directory, "isolated-restore");
  await restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: current.backupId, expectedManifestSha256: current.manifestSha256, targetDirectory: target });
  const restored = JSON.parse(await readFile(join(target, "state.json"), "utf8"));
  assert.deepEqual(restored, f.store.snapshot()); assert.equal(verifyEventChain(restored.events).valid, true);
  assert.deepEqual(await readFile(join(target, "media-assets/objects", `${video.id}.bin`)), MP4);
  const row = created.at(-1);
  await f.ok(`/api/website/releases/${row.id}/withdraw`, { method: "POST", etag: row.etag, body: { reason: "Isolated acceptance withdrawal." } });
  assert.equal((await f.call(row.canonicalPath, { anonymous: true })).response.status, 410);
  assert.equal((await fetch(`${f.origin}/public-media/${video.id}/${video.sha256}`, { headers: { "If-None-Match": `"${video.sha256}"` } })).status, 404);
  assert.equal((await f.ok("/public-api/content?locale=zh-CN&format=video", { anonymous: true })).total, 0);
});

test("real network readback rejects modified DTO, SSR and actual asset bytes while preserving unverified status", async t => {
  const f = await fixture(t); await readyDestination(f);
  const image = await upload(f, PNG, "image/png", "negative-image");
  const row = await release(f, { format: "image_text", assetRefs: [{ assetId: image.id, sha256: image.sha256, role: "image", alt: "Synthetic", caption: "" }] });
  let candidate = await f.ok(`/api/website/releases/${row.candidate.id}/approve`, { method: "POST", etag: row.candidate.etag,
    body: { reviewed: true, snapshotHash: row.candidate.snapshotHash, authorizationNote: "Isolated negative acceptance." } });
  candidate = await f.ok(`/api/website/releases/${candidate.id}/publish`, { method: "POST", etag: candidate.etag, body: { confirm: true, expectedPreviousReleaseId: null } });
  const expected = f.editorial.publicDetail({ locale: "zh-CN", format: "image_text", slug: "zh-image-text" });
  for (const mode of ["json", "html", "comment", "template", "hidden", "seed", "asset", "redirect", "private-url"]) {
    const fetchImpl = async (url, options) => {
      assert.equal(options.redirect, "error"); assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.Authorization, undefined);
      const result = await fetch(url, options);
      if (mode === "json" && url.includes("/public-api/")) return new Response(JSON.stringify({ ...expected, body: "Changed after approval" }), { headers: { "Content-Type": "application/json" } });
      if (mode === "html" && url.includes("/zh/")) return new Response("<html>200 without approved content</html>", { headers: { "Content-Type": "text/html" } });
      if (["comment", "template", "hidden"].includes(mode) && url.includes("/zh/")) {
        const html = await result.text();
        const changed = mode === "comment" ? `<!--${html}--><p>Unavailable</p>` : mode === "template" ? `<template>${html}</template>` : html.replace('<main id="site-main"', '<main hidden id="site-main"');
        return new Response(changed, { headers: { "Content-Type": "text/html" } });
      }
      if (mode === "seed" && url.includes("/zh/")) {
        const html = await result.text();
        return new Response(html.replace(/<script id="site-data" type="application\/json">([\s\S]*?)<\/script>/, (_all, json) => {
          const seed = JSON.parse(json); seed.preview = true; seed.detail.body = "Changed hydrated content";
          return `<script id="site-data" type="application/json">${JSON.stringify(seed)}</script>`;
        }), { headers: { "Content-Type": "text/html" } });
      }
      if (mode === "asset" && url.includes("/public-media/")) return new Response(Buffer.alloc(PNG.length), { headers: { "Content-Type": "image/png" } });
      if (mode === "redirect") return new Response("", { status: 302, headers: { Location: "/admin" } });
      return result;
    };
    const verify = createWebsiteReadback({ origin: f.origin, allowLoopback: true, fetchImpl });
    await assert.rejects(verify(mode === "private-url" ? { ...expected, canonicalUrl: "http://127.0.0.1/private" } : expected), error => error.status === 502);
  }
  f.editorial.verifyReadback = async () => { throw new Error("synthetic verification outage"); };
  assert.equal((await f.call(`/api/website/releases/${candidate.id}/verify`, { method: "POST", etag: candidate.etag, body: { confirm: true } })).response.status, 500);
  assert.equal(f.editorial.getRelease(candidate.id).status, "live_unverified");
  assert.equal((await f.call(`/api/website/releases/${candidate.id}/verify`, { method: "POST", etag: candidate.etag,
    body: { confirm: true, proof: { method: "server_readback" } } })).response.status, 400);
});
