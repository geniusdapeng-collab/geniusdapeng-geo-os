import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { planEditorialMigration } from "../src/services/bootstrap.mjs";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { ProductionArtifacts } from "../src/services/production-artifacts.mjs";
import { planContentOpsMigration, migrateContentOpsState } from "../src/services/content-ops-migration.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";

export async function runEditorialData(args, write = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const [command, ...rest] = args;
  if (!["plan", "plan-content-ops", "migrate-content-ops", "backup", "verify-backup", "restore"].includes(command)) throw new Error("EDITORIAL_DATA_USAGE");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!["--state-file", "--origin", "--backup-id", "--manifest-sha256", "--target"].includes(key) ||
        value === undefined || value.startsWith("--") || options[key] !== undefined) throw new Error("EDITORIAL_DATA_USAGE");
    options[key] = value;
  }
  const allowed = command === "plan" ? ["--state-file", "--origin"] : ["backup", "plan-content-ops", "migrate-content-ops"].includes(command) ? ["--state-file"] :
    command === "verify-backup" ? ["--state-file", "--backup-id", "--manifest-sha256"] : ["--state-file", "--backup-id", "--manifest-sha256", "--target"];
  if (!options["--state-file"] || Object.keys(options).some(key => !allowed.includes(key)) ||
      (["verify-backup", "restore"].includes(command) && !options["--backup-id"]) || (command === "restore" && !options["--target"])) throw new Error("EDITORIAL_DATA_USAGE");
  const stateFile = resolve(options["--state-file"]);
  const handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let state;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("EDITORIAL_DATA_INVALID_STATE");
    state = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!Array.isArray(state.events) || !verifyEventChain(state.events).valid) throw new Error("EDITORIAL_DATA_INVALID_EVENT_CHAIN");
  if (["plan", "plan-content-ops"].includes(command)) {
    const plan = command === "plan" ? planEditorialMigration(state, { publicOrigin: options["--origin"] }) : planContentOpsMigration(state);
    const result = { ok: true, command, mutated: false, ...plan };
    write(result); return result;
  }
  // Management operations require the service to be stopped: an active writer
  // lock is rejected, and this process owns the lock until its work has ended.
  const store = new JsonStore({ filePath: stateFile, writerLock: true });
  try {
    await store.open(() => { throw new Error("EDITORIAL_DATA_STATE_REQUIRED"); });
    let receipt;
    if (["backup", "migrate-content-ops"].includes(command)) {
      const mediaAssets = new MediaAssets({ store }); await mediaAssets.initialize();
      let productionArtifacts;
      const current = store.snapshot();
      if (current.schemaVersion === 3 || current.productionArtifacts?.length) {
        productionArtifacts = new ProductionArtifacts({ store }); await productionArtifacts.initialize();
      }
      const backup = createEditorialBackup({ store, mediaAssets, productionArtifacts });
      receipt = command === "backup" ? await backup.captureCurrent() : await migrateContentOpsState(store, { beforeMigration: () => backup.captureCurrent() });
    } else {
      const input = { store, backupId: options["--backup-id"], expectedManifestSha256: options["--manifest-sha256"] };
      receipt = command === "verify-backup" ? await verifyEditorialBackup(input) : await restoreEditorialBackupToIsolatedDirectory({
        ...input, targetDirectory: resolve(options["--target"]),
      });
    }
    const result = { ok: true, command, receipt }; write(result); return result;
  } finally { await store.close(); }
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  if (!process.argv[1]) return false;
  // Node 24.0/24.1 have no import.meta.main. Both paths must resolve the
  // release symlink rather than compare argv's spelling to the module URL.
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(import.meta.filename); }
  catch (error) {
    // An eval/import host can put an argument, rather than a file, in argv[1].
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

if (isMainModule()) {
  runEditorialData(process.argv.slice(2)).catch(error => {
    const known = /^[A-Z][A-Z0-9_]+$/.test(error?.code || "") ? error.code : /^EDITORIAL_DATA_[A-Z_]+$/.test(error?.message || "") ? error.message : "EDITORIAL_DATA_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code: known, message: "编辑数据管理未完成；核对命令参数、停服状态、文件权限与备份摘要。" })}\n`);
    process.exitCode = 1;
  });
}
