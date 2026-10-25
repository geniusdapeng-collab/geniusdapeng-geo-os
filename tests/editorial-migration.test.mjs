import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSeedState, migrateEditorialState, planEditorialMigration } from "../src/services/bootstrap.mjs";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { ROOT, clock } from "./editorial-fixtures.mjs";

async function isolatedStore(t, transform = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-editorial-migration-"));
  const filePath = join(directory, "state.json"), store = new JsonStore({ filePath, clock });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const seed = await loadSeedState(join(ROOT, "data/seed")); transform(seed);
  await store.open(async () => seed); return { store, directory, filePath };
}

test("schema1 dry-run is read-only; additive migration preserves every old ID, custom value and protected receipt", async t => {
  const { store, filePath } = await isolatedStore(t, seed => {
    seed.accounts[0].handle = "owner-custom-handle";
    seed.accounts[0].bio = "A customized owner profile that must remain intact.";
    seed.accounts[0].customField = { retained: ["one", "two"] };
    seed.accounts.push({ id: "custom-profile", platform: "Owner custom platform", handle: "custom", status: "paused", customField: 42 });
    seed.content[0].status = "published"; seed.content[0].publicationId = "PUB-001";
    seed.publications.push({ id: "PUB-001", contentId: seed.content[0].id, accountId: "github", contentHash: "old-hash", receiptHash: "old-receipt" });
    seed.accountOperations = [{ id: "OP-0001", contentHash: "old-operation-hash", status: "completed" }];
  });
  const before = store.snapshot(), bytes = await readFile(filePath, "utf8");
  const plan = await migrateEditorialState(store, { dryRun: true, publicOrigin: "https://pengmanager.com", clock });
  assert.equal(plan.fromSchema, 1); assert.equal(plan.toSchema, 2);
  assert.equal(await readFile(filePath, "utf8"), bytes);
  assert.deepEqual(store.snapshot(), before);
  const result = await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com", clock });
  assert.equal(result.changed, true);
  const after = store.snapshot();
  assert.equal(after.schemaVersion, 2); assert.equal(after.entity.profileVersion, 2);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.events.slice(0, -1), before.events);
  assert.equal(verifyEventChain(after.events).valid, true);
  for (const key of ["claims", "content", "contentBank", "publications", "accountOperations", "observations", "queries"]) assert.deepEqual(after[key], before[key]);
  for (const original of before.accounts) {
    const current = after.accounts.find(row => row.id === original.id);
    for (const key of Object.keys(original)) assert.deepEqual(current[key], original[key]);
  }
  assert.equal(after.accounts[0].platformId, "wechat-official");
  assert.equal(after.accounts.at(-1).platformId, null);
  assert.equal(after.accounts[0].identityReview.status, "unverified");
  assert.equal(after.destinations.length, 1); assert.equal(after.destinations[0].status, "draft");
  const revision = after.revision;
  assert.equal((await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com", clock })).changed, false);
  assert.equal(store.snapshot().revision, revision);
  const catalog = new EditorialService({ store, clock }).catalog();
  assert.equal(catalog.platforms.length, 28);
  assert.equal(catalog.platforms.find(row => row.id === "tiktok").configuredAccountCount, 0);
  assert.equal(catalog.platforms.find(row => row.id === "github").identityVerifiedCount, 0);
});

test("migration rejects duplicate IDs, malformed collections and a schema2 state without its own migration marker", async t => {
  const { store } = await isolatedStore(t);
  const before = store.snapshot();
  const duplicate = structuredClone(before); duplicate.accounts.push(structuredClone(duplicate.accounts[0]));
  assert.throws(() => planEditorialMigration(duplicate), { code: "DUPLICATE_ACCOUNT_ID" });
  const malformed = structuredClone(before); malformed.editions = {};
  assert.throws(() => planEditorialMigration(malformed), { code: "EDITORIAL_MIGRATION_INVALID_STATE" });
  await store.mutate({ type: "unit.schema-marker-missing", actor: "test" }, state => { state.schemaVersion = 2; });
  await assert.rejects(migrateEditorialState(store), { code: "EDITORIAL_MIGRATION_MARKER_MISSING" });
});

test("concurrent migration attempts append one event and unknown state versions fail closed before writer startup", async t => {
  const { store, directory } = await isolatedStore(t);
  const results = await Promise.all([migrateEditorialState(store, { clock }), migrateEditorialState(store, { clock })]);
  assert.equal(results.filter(row => row.changed).length, 1);
  assert.equal(store.snapshot().events.filter(row => row.type === "editorial.schema_migrated").length, 1);
  const unsupported = store.snapshot(); unsupported.schemaVersion = 99;
  const path = join(directory, "unsupported.json"); await writeFile(path, JSON.stringify(unsupported));
  const unopened = new JsonStore({ filePath: path, writerLock: true });
  await assert.rejects(unopened.open(async () => { throw new Error("must not reseed"); }), { code: "STATE_SCHEMA_UNSUPPORTED" });
  assert.equal(hashObject(JSON.parse(await readFile(path, "utf8"))), hashObject(unsupported));
  await assert.rejects(readFile(`${path}.writer.lock`), { code: "ENOENT" });
});
