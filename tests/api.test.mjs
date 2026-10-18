import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const publicDir = join(rootDir, "public");
const now = () => new Date("2026-10-18T12:00:00.000Z");

async function request(baseUrl, path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const payload = await response.json();
  return { response, payload };
}

test("HTTP API completes a manual publish flow and keeps fixture receipts blocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-api-"));
  const filePath = join(directory, "state.json");
  const store = new JsonStore({ filePath, clock: now });
  await store.open(() => loadSeedState(dataDir));
  const service = new GeoOsService({ store, clock: now });
  const server = createGeoOsServer({ service, publicDir });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await request(baseUrl, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.payload.summary.accounts, 16);

    const bootstrap = await request(baseUrl, "/api/bootstrap");
    assert.equal(bootstrap.payload.accounts.length, 16);
    assert.equal(bootstrap.payload.contentBank.length, 120);

    const approvedClaim = await request(baseUrl, "/api/claims/C003/approve", {
      method: "POST",
      body: JSON.stringify({
        approvedBy: "Dapeng Li",
        publicLevel: "private",
      }),
    });
    assert.equal(approvedClaim.response.status, 200);
    assert.equal(approvedClaim.payload.state, "approved");

    const created = await request(baseUrl, "/api/content", {
      method: "POST",
      body: JSON.stringify({
        title: "API flow test",
        body: "A content draft backed by an approved public project claim.",
        contentType: "article",
        claimIds: ["C003"],
        platforms: ["GitHub"],
        owner: "Dapeng Li",
      }),
    });
    assert.equal(created.response.status, 201);
    const contentId = created.payload.id;

    for (const target of ["fact_check", "approved", "scheduled"]) {
      const transitioned = await request(baseUrl, `/api/content/${contentId}/transition`, {
        method: "POST",
        body: JSON.stringify({
          target,
          actor: "Dapeng Li",
          approvedBy: "Dapeng Li",
          note: "API integration test",
        }),
      });
      assert.equal(transitioned.response.status, 200);
      assert.equal(transitioned.payload.status, target);
    }

    const fixtureReceipt = await request(baseUrl, "/api/publications/manual", {
      method: "POST",
      body: JSON.stringify({
        contentId,
        accountId: "github",
        actor: "Dapeng Li",
        receipt: {
          url: "https://example.com/fixture",
          publishedAt: now().toISOString(),
          capturedBy: "Dapeng Li",
          dataMode: "fixture",
        },
      }),
    });
    assert.equal(fixtureReceipt.response.status, 409);
    assert.equal(fixtureReceipt.payload.error.code, "PUBLICATION_BLOCKED");

    await store.mutate({ type: "account.enabled", actor: "test" }, (state) => {
      const account = state.accounts.find((item) => item.id === "github");
      account.status = "active";
      account.policyStatus = "reviewed";
      return account;
    });

    const realReceipt = await request(baseUrl, "/api/publications/manual", {
      method: "POST",
      body: JSON.stringify({
        contentId,
        accountId: "github",
        actor: "Dapeng Li",
        receipt: {
          url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os",
          publishedAt: now().toISOString(),
          capturedBy: "Dapeng Li",
          dataMode: "imported",
        },
      }),
    });
    assert.equal(realReceipt.response.status, 201);
    assert.equal(realReceipt.payload.contentHash.length, 64);

    const latest = await request(baseUrl, "/api/content");
    const published = latest.payload.find((item) => item.id === contentId);
    assert.equal(published.status, "published");

    const events = await request(baseUrl, "/api/events");
    assert.equal(events.payload.verification.valid, true);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(directory, { recursive: true, force: true });
  }
});

test("public export never exposes private claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-public-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath, clock: now });
    await store.open(() => loadSeedState(dataDir));
    const service = new GeoOsService({ store, clock: now });
    const preview = service.publicPreview();
    assert.deepEqual(preview.claims, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("GEO metrics qualify only real and imported observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-geo-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath, clock: now });
    await store.open(() => loadSeedState(dataDir));
    const service = new GeoOsService({ store, clock: now });

    await service.recordObservation({
      queryId: "Q001",
      surface: "DeepSeek Search",
      answer: "李大鹏（鹏栈）是 AI 产品专家，公开项目见 https://github.com/geniusdapeng-collab。",
      citations: [
        {
          url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os",
        },
      ],
      dataMode: "fixture",
    });
    assert.equal(service.metrics().qualifiedSamples, 0);

    await service.recordObservation({
      queryId: "Q001",
      surface: "DeepSeek Search",
      answer: "李大鹏（鹏栈）是 AI 产品专家，公开项目见 https://github.com/geniusdapeng-collab。",
      citations: [
        {
          url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os",
        },
      ],
      dataMode: "real",
      collectedAt: now().toISOString(),
    });
    const metrics = service.metrics();
    assert.equal(metrics.qualifiedSamples, 1);
    assert.equal(metrics.mentionRate, 1);
    assert.equal(metrics.ownedCitationRate, 1);
    assert.equal(metrics.queryCoverage, Number((1 / 12).toFixed(4)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an approved public claim can move to the public export", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-export-"));
  const filePath = join(directory, "state.json");

  try {
    const store = new JsonStore({ filePath, clock: now });
    await store.open(() => loadSeedState(dataDir));
    const service = new GeoOsService({ store, clock: now });
    await service.approveClaim("C003", {
      approvedBy: "Dapeng Li",
      publicLevel: "approved_public",
    });
    const preview = service.publicPreview();
    assert.equal(preview.claims.length, 1);
    assert.equal(preview.claims[0].id, "C003");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
