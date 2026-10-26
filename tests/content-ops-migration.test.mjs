import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { planContentOpsMigration, migrateContentOpsState } from "../src/services/content-ops-migration.mjs";
import { CONTENT_OPS_COLLECTIONS } from "../src/domain/content-ops.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";
import { runEditorialData } from "../scripts/editorial-data.mjs";

async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-ops-migration-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(() => loadSeedState(resolve(import.meta.dirname, "../data/seed")));
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com" });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const backup = createEditorialBackup({ store });
  return { directory, store, backup, beforeMigration: () => backup.captureCurrent() };
}
test("v3 dry-run leaves bytes untouched; real complete backup and additive migration preserve every old object and event", async t => {
  const f = await fixture(t), before = f.store.snapshot(), bytes = await readFile(f.store.filePath);
  const plan = planContentOpsMigration(before); assert.equal(plan.toSchema, 3); assert.equal(plan.fromSchema, 2);
  assert.deepEqual(await migrateContentOpsState(f.store, { dryRun: true }), { ...plan, changed: false });
  assert.deepEqual(await readFile(f.store.filePath), bytes);
  const cliPlan = await runEditorialData(["plan-content-ops", "--state-file", f.store.filePath], () => {});
  assert.equal(cliPlan.mutated, false); assert.equal(cliPlan.toSchema, 3); assert.deepEqual(await readFile(f.store.filePath), bytes);
  const result = await migrateContentOpsState(f.store, { beforeMigration: f.beforeMigration });
  assert.equal(result.changed, true); assert.equal((await verifyEditorialBackup({ store: f.store, backupId: result.backup.backupId,
    expectedManifestSha256: result.backup.manifestSha256 })).filesVerified, 1);
  const after = f.store.snapshot(); assert.equal(after.schemaVersion, 3); assert.equal(after.revision, before.revision + 1);
  for (const [key, value] of Object.entries(before)) if (!["schemaVersion", "revision", "updatedAt", "events", "migrations"].includes(key)) assert.deepEqual(after[key], value);
  assert.deepEqual(after.events.slice(0, -1), before.events); assert.deepEqual(after.migrations.slice(0, -1), before.migrations);
  assert.equal(after.events.at(-1).type, "content_ops.schema_migrated"); assert.equal(verifyEventChain(after.events).valid, true);
  assert.equal(after.operatorProfiles.length, 28); for (const key of CONTENT_OPS_COLLECTIONS) assert.ok(Array.isArray(after[key]));
  assert.equal((await migrateContentOpsState(f.store, { beforeMigration: () => { throw new Error("must not repeat backup"); } })).changed, false);
  await f.store.close(); const reopened = new JsonStore({ filePath: f.store.filePath, writerLock: true });
  await reopened.open(() => { throw new Error("must not reseed"); }); assert.deepEqual(reopened.snapshot(), after); await reopened.close();
});
test("missing or mismatched backup stops migration; raced source writes require a new exact backup", async t => {
  const f = await fixture(t), before = f.store.snapshot();
  await assert.rejects(migrateContentOpsState(f.store), { code: "CONTENT_OPS_BACKUP_REQUIRED" });
  await assert.rejects(migrateContentOpsState(f.store, { beforeMigration: async () => ({ backupId: `EDB-${"a".repeat(32)}`,
    manifestSha256: "b".repeat(64), stateSha256: "c".repeat(64), sourceRevision: before.revision, stage: "current" }) }), { code: "CONTENT_OPS_BACKUP_MISMATCH" });
  assert.deepEqual(f.store.snapshot(), before);
  await assert.rejects(migrateContentOpsState(f.store, { beforeMigration: async () => {
    const backup = await f.backup.captureCurrent(); await f.store.mutate({ type: "fixture.concurrent_owner_write" }, state => { state.entity.syntheticRace = true; }); return backup;
  } }), { code: "MIGRATION_STATE_CHANGED" });
  assert.equal(f.store.snapshot().schemaVersion, 2); assert.equal(f.store.snapshot().operatorProfiles, undefined);
  assert.equal(f.store.snapshot().entity.syntheticRace, true);
});
test("concurrent requests migrate once and v3 complete native-compatible backup restores into a new isolated state", async t => {
  const f = await fixture(t);
  const results = await Promise.all([migrateContentOpsState(f.store, { beforeMigration: f.beforeMigration }), migrateContentOpsState(f.store, { beforeMigration: f.beforeMigration })]);
  assert.equal(results.filter(row => row.changed).length, 1);
  assert.equal(f.store.snapshot().events.filter(row => row.type === "content_ops.schema_migrated").length, 1);
  const backup = await f.backup.captureCurrent(); assert.equal(backup.schema, "pengmanager.editorial-backup/v2"); assert.equal(backup.artifactCount, 0);
  const targetDirectory = `${f.directory}-restore`; t.after(() => rm(targetDirectory, { recursive: true, force: true }));
  await restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: backup.backupId, expectedManifestSha256: backup.manifestSha256, targetDirectory });
  const restored = new JsonStore({ filePath: join(targetDirectory, "state.json"), writerLock: true });
  await restored.open(() => { throw new Error("must not initialize restored state"); });
  assert.deepEqual(restored.snapshot(), f.store.snapshot()); await restored.close();
});
