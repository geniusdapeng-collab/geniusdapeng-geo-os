import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { isClaimPubliclyExportable } from "../src/domain/policy.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import { VideoMediaEngine } from "../src/engines/video-media.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const publicDir = join(rootDir, "public");
const clock = () => new Date("2026-10-18T12:30:00.000Z");

async function withStore(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-audit-"));
  const store = new JsonStore({
    filePath: join(directory, "state.json"),
    clock,
  });
  await store.open(() => loadSeedState(dataDir));
  try {
    return await callback({ directory, store });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function createScheduledContent(service, store, platform = "GitHub") {
  await service.approveClaim("C003", {
    approvedBy: "Dapeng Li",
    publicLevel: "private",
  });
  const content = await service.createContent({
    title: "审计回归：证据事实",
    body: "这段内容只用于验证发布前的证据和平台闸门。",
    contentType: "article",
    claimIds: ["C003"],
    platforms: [platform],
    owner: "Dapeng Li",
  });
  for (const target of ["fact_check", "approved", "scheduled"]) {
    await service.transitionContent(content.id, {
      target,
      actor: "Dapeng Li",
      approvedBy: "Dapeng Li",
    });
  }
  return store.snapshot().content.find((item) => item.id === content.id);
}

async function listen(server) {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  return server.address();
}

test("invalid claim expiry fails closed instead of remaining exportable", () => {
  assert.equal(
    isClaimPubliclyExportable(
      {
        state: "approved",
        publicLevel: "approved_public",
        expiresAt: "not-a-date",
        text: "Public claim with malformed expiry.",
      },
      { now: clock() },
    ),
    false,
  );
});

test("publication rechecks claim expiry after scheduling", async () => {
  await withStore(async ({ store }) => {
    const service = new GeoOsService({ store, clock });
    const content = await createScheduledContent(service, store);
    await store.mutate({ type: "claim.expired", actor: "test" }, (state) => {
      state.claims.find((claim) => claim.id === "C003").expiresAt =
        "2026-10-18T00:00:00.000Z";
    });

    await assert.rejects(
      service.recordPublication({
        contentId: content.id,
        accountId: "github",
        actor: "Dapeng Li",
        receipt: {
          url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1",
          publishedAt: clock().toISOString(),
          capturedBy: "Dapeng Li",
          dataMode: "real",
        },
      }),
      (error) =>
        error.code === "PUBLICATION_BLOCKED" &&
        error.details.findings.some((finding) => finding.code === "CLAIM_EXPIRED"),
    );
  });
});

test("publication rejects a mismatched target platform", async () => {
  await withStore(async ({ store }) => {
    const service = new GeoOsService({ store, clock });
    const content = await createScheduledContent(service, store, "GitHub");
    await store.mutate({ type: "account.activated", actor: "test" }, (state) => {
      const account = state.accounts.find((item) => item.id === "xiaohongshu");
      account.status = "active";
      account.policyStatus = "reviewed";
    });

    await assert.rejects(
      service.recordPublication({
        contentId: content.id,
        accountId: "xiaohongshu",
        actor: "Dapeng Li",
        receipt: {
          url: "https://www.xiaohongshu.com/explore/audit",
          publishedAt: clock().toISOString(),
          capturedBy: "Dapeng Li",
          dataMode: "real",
        },
      }),
      (error) =>
        error.code === "PUBLICATION_BLOCKED" &&
        error.details.findings.some((finding) => finding.code === "TARGET_PLATFORM_MISMATCH"),
    );
  });
});

test("live GitHub publication performs account and evidence preflight before creating an issue", async () => {
  await withStore(async ({ store }) => {
    const service = new GeoOsService({ store, clock });
    const content = await createScheduledContent(service, store);
    await store.mutate({ type: "account.disabled", actor: "test" }, (state) => {
      state.accounts.find((account) => account.id === "github").status = "paused";
    });
    let issueCalls = 0;
    const live = new LivePipelineService({
      service,
      deepSeek: { async health() { return { ok: true }; } },
      github: {
        async health() { return { ok: true }; },
        async createIssue() {
          issueCalls += 1;
          throw new Error("must not be called");
        },
      },
      geoEvidence: { async health() { return { ok: true }; } },
      videoEdit: { async health() { return { ok: true }; } },
      clock,
    });

    await assert.rejects(
      live.publishContentToGitHub({ contentId: content.id }),
      (error) => error.code === "PUBLICATION_BLOCKED",
    );
    assert.equal(issueCalls, 0);
  });
});

test("concurrent live publication of the same content performs one external write", async () => {
  await withStore(async ({ store }) => {
    const service = new GeoOsService({ store, clock });
    const content = await createScheduledContent(service, store);
    let issueCalls = 0;
    let releaseIssue;
    const issueGate = new Promise((resolveIssue) => {
      releaseIssue = resolveIssue;
    });
    const live = new LivePipelineService({
      service,
      deepSeek: { async health() { return { ok: true }; } },
      github: {
        async health() { return { ok: true }; },
        async createIssue() {
          issueCalls += 1;
          await issueGate;
          return {
            id: 2,
            number: 2,
            url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/2",
            createdAt: clock().toISOString(),
            receiptHash: "c".repeat(64),
          };
        },
      },
      geoEvidence: { async health() { return { ok: true }; } },
      videoEdit: { async health() { return { ok: true }; } },
      clock,
    });

    const first = live.publishContentToGitHub({ contentId: content.id });
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    await assert.rejects(
      live.publishContentToGitHub({ contentId: content.id }),
      (error) => error.code === "PUBLICATION_IN_PROGRESS",
    );
    releaseIssue();
    await first;
    assert.equal(issueCalls, 1);
  });
});

test("state-changing API rejects cross-origin browser requests and serves a CSP", async () => {
  await withStore(async ({ store }) => {
    const service = new GeoOsService({ store, clock });
    const server = createGeoOsServer({ service, publicDir });
    const address = await listen(server);
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const page = await fetch(`${baseUrl}/`);
      assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);

      const response = await fetch(`${baseUrl}/api/content`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.example",
        },
        body: JSON.stringify({
          title: "Cross-origin write",
          body: "This request must be rejected.",
          contentType: "article",
          claimIds: ["C003"],
          platforms: ["GitHub"],
        }),
      });
      assert.equal(response.status, 403);
      const payload = await response.json();
      assert.equal(payload.error.code, "CROSS_ORIGIN_REQUEST_BLOCKED");

      const hostError = await new Promise((resolveHost, rejectHost) => {
        const request = httpRequest(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/health",
            headers: { Host: "evil.example" },
          },
          (hostResponse) => {
            const chunks = [];
            hostResponse.on("data", (chunk) => chunks.push(chunk));
            hostResponse.on("end", () => {
              resolveHost({
                status: hostResponse.statusCode,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            });
          },
        );
        request.on("error", rejectHost);
        request.end();
      });
      assert.equal(hostError.status, 403);
      assert.equal(hostError.body.error.code, "HOST_NOT_ALLOWED");
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

test("GEO list endpoints fail closed with a clear client error for invalid limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-limit-"));
  const store = new JsonStore({ filePath: join(directory, "state.json"), clock });
  await store.open(() => loadSeedState(dataDir));
  const service = new GeoOsService({ store, clock });
  const geoEngine = new PersonalGeoEngine({
    rootDir: directory,
    databasePath: join(directory, "geo.sqlite"),
    controlQueries: store.snapshot().queries,
  });
  const server = createGeoOsServer({ service, geoEngine, publicDir });
  const address = await listen(server);
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${baseUrl}/api/geo/engine/queries?limit=not-a-number`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_LIMIT");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    geoEngine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("video media health reports the installed tsx runtime truthfully", async () => {
  const engine = new VideoMediaEngine({ rootDir });
  const health = await engine.health();
  assert.equal(health.ok, true);
  assert.equal(health.tsx, true);
});

test("integrated GEO summary excludes fixture samples and records the actual prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-geo-summary-"));
  const controlQueries = JSON.parse(
    await readFile(join(dataDir, "queries.json"), "utf8"),
  );
  const engine = new PersonalGeoEngine({
    rootDir: directory,
    databasePath: join(directory, "geo.sqlite"),
    controlQueries,
  });
  try {
    const fixture = await engine.runVisibility({ provider: "fixture", limit: 10 });
    const [sample] = engine.listSamples({ runId: fixture.runId, limit: 1 });
    const evidence = JSON.parse(
      await readFile(new URL(sample.screenshotUri), "utf8"),
    );
    assert.doesNotMatch(evidence.prompt, /酒店采购方/);
    assert.match(
      evidence.prompt,
      new RegExp(sample.query_text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );

    const importedRun = await engine.service.ingestAnswer({
      queryId: controlQueries[0].id,
      answer: "李大鹏（鹏栈）是 AI 产品构建者。",
      dataMode: "imported",
      platform: "manual",
      citations: [
        { title: "unsafe", url: "javascript:alert(1)" },
        { title: "safe", url: "https://example.com/source" },
      ],
    });
    const summary = engine.summary();
    assert.equal(summary.metrics.totalSamples, 1);
    assert.equal(summary.metrics.successfulSamples, 1);
    const imported = engine.listSamples({ runId: importedRun.runId, limit: 1 })[0];
    assert.deepEqual(
      imported.citations.map((citation) => citation.url),
      ["https://example.com/source"],
    );
  } finally {
    engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("GEO webhook publication rejects loopback targets before making a request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-webhook-"));
  const store = new JsonStore({ filePath: join(directory, "state.json"), clock });
  await store.open(() => loadSeedState(dataDir));
  const service = new (await import("../engines/geo-evidence/lib/service.mjs")).GeoEvidenceService(
    new (await import("../engines/geo-evidence/lib/store.mjs")).GeoStore(
      join(directory, "geo.sqlite"),
    ),
    { rootDir: directory },
  );
  let requests = 0;
  const target = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ url: "http://127.0.0.1/unexpected" }));
  });
  const address = await listen(target);
  try {
    await assert.rejects(
      service.fetchCitation("http://[::ffff:7f00:1]/"),
      /拒绝抓取/,
    );
    await assert.rejects(
      service.fetchCitation("http://169.254.169.254/latest/meta-data/"),
      /拒绝抓取/,
    );
    const article = service.generateArticles({
      topicIds: ["agent-product-system"],
    }).created[0];
    await assert.rejects(
      service.publishArticle({
        articleId: article.id,
        channel: "webhook",
        webhookUrl: `http://127.0.0.1:${address.port}/publish`,
        approvedBy: "Dapeng Li",
      }),
      /拒绝抓取|公开 HTTP/,
    );
    assert.equal(requests, 0);
  } finally {
    service.store.close();
    await new Promise((resolveClose) => target.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test("GEO tool receipts do not label drafts or unimplemented archive writes as real", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-receipts-"));
  const { GeoStore } = await import("../engines/geo-evidence/lib/store.mjs");
  const { GeoEvidenceService } = await import("../engines/geo-evidence/lib/service.mjs");
  const service = new GeoEvidenceService(
    new GeoStore(join(directory, "geo.sqlite")),
    { rootDir: directory },
  );
  try {
    const generated = await service.handleTool("geo.rewrite", {
      dataMode: "draft",
      topicIds: ["agent-product-system"],
    });
    assert.notEqual(generated.receipt.mode, "real");

    const archived = await service.handleTool("archive.write_back", {});
    assert.equal(archived.receipt.synced, false);
  } finally {
    service.store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
