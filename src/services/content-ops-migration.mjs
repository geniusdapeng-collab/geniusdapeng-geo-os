import { createHash } from "node:crypto";
import { ApiError } from "../domain/errors.mjs";
import { hashObject } from "../domain/hash.mjs";
import { assertEditorialStateIntegrity } from "../domain/editorial.mjs";
import { CONTENT_OPS_COLLECTIONS, initializeContentOpsState, assertContentOpsStateIntegrity } from "../domain/content-ops.mjs";
import { JsonStore } from "../storage/json-store.mjs";

const MIGRATION = "content-operators-v1";
const SHA = /^[a-f0-9]{64}$/;
const stateBytesHash = state => createHash("sha256").update(`${JSON.stringify(state, null, 2)}\n`).digest("hex");
function fail(code, message) { throw new ApiError(503, code, message); }

export function planContentOpsMigration(state) {
  if (![2, 3].includes(state?.schemaVersion)) fail("CONTENT_OPS_EDITORIAL_MIGRATION_REQUIRED", "先完成既有编辑域迁移，再执行内容岗位迁移。");
  assertEditorialStateIntegrity(state);
  const alreadyApplied = state.schemaVersion === 3 && state.migrations?.some(row => row.id === MIGRATION);
  if (state.schemaVersion === 3 && !alreadyApplied) fail("CONTENT_OPS_MIGRATION_MARKER_MISSING", "v3 状态缺少对应迁移标记，停止写入。");
  if (alreadyApplied) assertContentOpsStateIntegrity(state);
  else for (const key of CONTENT_OPS_COLLECTIONS) if (state[key] !== undefined && (!Array.isArray(state[key]) || state[key].length)) {
    fail("CONTENT_OPS_MIGRATION_CONFLICT", "旧状态含不明确的内容岗位集合；保留原状态并先核对来源。");
  }
  const excluded = new Set(["schemaVersion", "revision", "updatedAt", "events", "migrations", ...CONTENT_OPS_COLLECTIONS]);
  const protectedHashes = Object.fromEntries(Object.entries(state).filter(([key]) => !excluded.has(key)).map(([key, value]) => [key, hashObject(value)]));
  return { migrationId: MIGRATION, fromSchema: state.schemaVersion, toSchema: 3, alreadyApplied,
    expectedRevision: state.revision, inputHash: hashObject(state), stateSha256: stateBytesHash(state),
    protectedHashes, eventHead: state.events.at(-1)?.hash ?? null, migrationPrefixHash: hashObject(state.migrations ?? []),
    addedCollections: [...CONTENT_OPS_COLLECTIONS],
    rollback: "Before accepting v3 writes, use the verified complete pre-migration backup. After accepting v3 writes, use a forward corrective migration; older binaries must refuse schema 3." };
}

export async function migrateContentOpsState(store, { dryRun = false, beforeMigration, clock = () => new Date() } = {}) {
  const initial = planContentOpsMigration(store.snapshot());
  if (dryRun || initial.alreadyApplied) return { ...initial, changed: false };
  if (typeof beforeMigration !== "function") fail("CONTENT_OPS_BACKUP_REQUIRED", "v3 迁移前必须实际完成既有状态与媒体的完整备份。");
  // Disk and media hashing happen outside the state mutation queue. The exact
  // source snapshot is checked again atomically before adding any v3 objects.
  const backup = await beforeMigration();
  if (!backup || !/^EDB-[a-f0-9]{32}$/.test(backup.backupId ?? "") || !SHA.test(backup.manifestSha256 ?? "") ||
      backup.stateSha256 !== initial.stateSha256 || backup.sourceRevision !== initial.expectedRevision || backup.stage !== "current") {
    fail("CONTENT_OPS_BACKUP_MISMATCH", "迁移备份与准确的旧状态版本不一致。");
  }
  const payload = { migrationId: MIGRATION, fromSchema: 2, toSchema: 3, previousEventHead: initial.eventHead,
    protectedHashes: initial.protectedHashes, backup: structuredClone(backup) };
  return (await store.mutate({ type: "content_ops.schema_migrated", actor: "system", payload }, state => {
    const current = planContentOpsMigration(state);
    if (current.alreadyApplied) return JsonStore.noChange({ ...current, changed: false });
    if (current.inputHash !== initial.inputHash || current.expectedRevision !== initial.expectedRevision) throw new ApiError(409, "MIGRATION_STATE_CHANGED", "备份期间状态已变化；请重新核对、备份并迁移。");
    initializeContentOpsState(state);
    for (const [key, hash] of Object.entries(initial.protectedHashes)) if (hashObject(state[key]) !== hash) fail("MIGRATION_PROTECTED_DATA_CHANGED", "内容岗位迁移不得改写既有数据。");
    if (hashObject(state.migrations) !== initial.migrationPrefixHash) fail("MIGRATION_PROTECTED_DATA_CHANGED", "迁移记录前缀已变化。");
    state.migrations.push({ id: MIGRATION, at: clock().toISOString(), fromSchema: 2, toSchema: 3,
      previousEventHead: initial.eventHead, protectedHashes: initial.protectedHashes, backup: structuredClone(backup) });
    state.schemaVersion = 3; assertEditorialStateIntegrity(state); assertContentOpsStateIntegrity(state);
    return { ...initial, changed: true, backup: structuredClone(backup) };
  })).result;
}
