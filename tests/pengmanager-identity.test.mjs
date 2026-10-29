import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSeedState, migratePengManagerIdentity } from "../src/services/bootstrap.mjs";
import { MAIN_PROFILE, SYSTEM_IDENTITY } from "../src/domain/identity.mjs";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const legacy = JSON.parse(await readFile(join(dataDir, "..", "migrations", "identity-v1.json"), "utf8"));

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-identity-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  try { await run(store, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function oldSeed() {
  const seed = await loadSeedState(dataDir);
  delete seed.system;
  seed.entity = { id: MAIN_PROFILE.id, publicName: "李大鹏", brandName: "鹏栈", englishName: "Dapeng Li", englishBrandName: "PengStack", aliases: ["自定义别名", "鹏栈"], ownedUrlPrefixes: ["https://example.com/owned"] };
  seed.queries = structuredClone(legacy.queries);
  seed.claims = structuredClone(legacy.claims);
  seed.contentBank = structuredClone(legacy.contentBank);
  for (const row of seed.accounts) { row.displayName = "李大鹏｜鹏栈"; row.handle = "existing-handle"; }
  return seed;
}

test("new state supplies exact bilingual identity to every platform and public preview", async () => {
  await withStore(async (store) => {
    await store.open(() => loadSeedState(dataDir));
    const service = new GeoOsService({ store });
    const payload = service.bootstrap();
    assert.deepEqual(payload.system, SYSTEM_IDENTITY);
    assert.equal(payload.accounts.length, 16);
    assert.equal(payload.entity.bioZh, MAIN_PROFILE.bioZh);
    assert.equal(payload.entity.bioEn, MAIN_PROFILE.bioEn);
    for (const account of payload.accounts) {
      const english = account.language.startsWith("en");
      assert.equal(account.name, english ? "PengManager" : "李大鹏");
      assert.equal(account.displayName, english ? MAIN_PROFILE.displayNameEn : MAIN_PROFILE.displayNameZh);
      assert.equal(account.bio, english ? MAIN_PROFILE.bioEn : MAIN_PROFILE.bioZh);
    }
    assert.equal(service.publicPreview().entity.bioEn, MAIN_PROFILE.bioEn);
    assert.deepEqual(service.publicPreview().claims, []);
    assert.equal(await migratePengManagerIdentity(store, dataDir), false);
    assert.equal(store.snapshot().events.length, 1);
  });
});

test("existing state migrates once, preserving custom queries, approvals, receipts and ledger", async () => {
  await withStore(async (store) => {
    const seed = await oldSeed();
    seed.queries.find((q) => q.id === "Q011").text = "My custom identity question <AI> & 中文";
    seed.accounts[0].status = "active";
    seed.accounts[0].policyStatus = "reviewed";
    seed.content[0].status = "published";
    seed.content[0].owner = "PengStack";
    seed.content[1].owner = "PengStack";
    seed.claims[0].state = "approved";
    seed.claims[0].approvedBy = "prior-reviewer";
    seed.publications.push({ id: "PUB-001", contentId: seed.content[0].id, contentHash: "unaltered", url: "https://example.com/receipt" });
    seed.observations.push({ id: "OBS-001", answer: "历史答案：鹏栈", answerHash: "unchanged" });
    seed.contentBank[0].hook = "custom hook";
    await store.open(async () => seed);
    const before = store.snapshot();
    assert.equal(await migratePengManagerIdentity(store, dataDir), true);
    const after = store.snapshot();
    assert.deepEqual(after.events.slice(0, -1), before.events);
    assert.equal(after.events.at(-1).type, "identity.updated");
    assert.equal(verifyEventChain(after.events).valid, true);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.entity.englishName, "PengManager");
    assert.ok(after.entity.aliases.includes("自定义别名"));
    assert.ok(after.entity.aliases.includes("鹏栈"));
    assert.deepEqual(after.entity.ownedUrlPrefixes, before.entity.ownedUrlPrefixes);
    assert.equal(after.accounts[0].handle, "existing-handle");
    assert.equal(after.accounts[0].status, "active");
    assert.equal(after.accounts[0].policyStatus, "reviewed");
    assert.equal(after.queries.find((q) => q.id === "Q001").text, (await loadSeedState(dataDir)).queries[0].text);
    assert.equal(after.queries.find((q) => q.id === "Q011").text, seed.queries.find((q) => q.id === "Q011").text);
    assert.deepEqual(after.claims[0], before.claims[0]);
    assert.deepEqual(after.content[0], before.content[0]);
    assert.equal(after.content[1].owner, "PengManager");
    assert.equal(after.contentBank[0].hook, "custom hook");
    assert.deepEqual(after.publications, before.publications);
    assert.deepEqual(after.observations, before.observations);
    const reopened = new JsonStore({ filePath: store.filePath });
    await reopened.open(() => { throw new Error("must not reseed"); });
    assert.equal(await migratePengManagerIdentity(reopened, dataDir), false);
    assert.deepEqual(reopened.snapshot(), after);
  });
});

test("migration failure leaves persisted state intact; tampered event chain cannot open", async () => {
  await withStore(async (store, directory) => {
    await store.open(oldSeed);
    const before = await readFile(store.filePath, "utf8");
    await assert.rejects(migratePengManagerIdentity(store, join(directory, "missing")), { code: "ENOENT" });
    assert.equal(await readFile(store.filePath, "utf8"), before);
    const invalid = JSON.parse(before);
    invalid.events[0].actor = "tampered";
    await writeFile(store.filePath, JSON.stringify(invalid));
    await assert.rejects(new JsonStore({ filePath: store.filePath }).open(oldSeed), /Event chain is invalid/);
  });
});

test("health and bootstrap expose current system and bilingual profile", async () => {
  await withStore(async (store) => {
    await store.open(() => loadSeedState(dataDir));
    const server = createGeoOsServer({ service: new GeoOsService({ store }), publicDir: join(rootDir, "public") });
    try {
      await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const url = `http://127.0.0.1:${server.address().port}`;
      const health = await (await fetch(`${url}/api/health`)).json();
      const bootstrap = await (await fetch(`${url}/api/bootstrap`)).json();
      assert.equal(health.service, "pengmanager-system");
      assert.deepEqual(health.system, SYSTEM_IDENTITY);
      assert.equal(bootstrap.entity.displayNameEn, "Dapeng Li · PengManager");
      const blocked = await fetch(`${url}/api/content`, { method: "POST", headers: { Origin: "https://example.com" } });
      assert.equal(blocked.status, 403);
    } finally { await new Promise((resolveClose) => server.close(resolveClose)); }
  });
});

test("content generation uses bilingual PengManager profile in the provider prompt", async () => {
  let prompt;
  const adapter = new DeepSeekAdapter({ apiKey: "test-only", fetchImpl: async (_url, init) => {
    prompt = JSON.parse(init.body).messages[1].content;
    return new Response(JSON.stringify({
      id: "response-fixture",
      model: "deepseek-flash",
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({ title: "可审核草稿", body: "依据给定事实生成的内容。" }) },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 },
    }));
  } });
  await adapter.generateContent({ brief: "测试", claims: [{ id: "C001", text: MAIN_PROFILE.headline }], platform: "GitHub" });
  assert.ok(prompt.includes(MAIN_PROFILE.displayNameZh));
  assert.ok(prompt.includes(MAIN_PROFILE.bioEn));
  assert.ok(prompt.includes("鹏经理系统 / PengManager System"));
  assert.ok(!prompt.includes("PengStack"));
});
