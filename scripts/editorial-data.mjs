import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { planEditorialMigration } from "../src/services/bootstrap.mjs";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";

export async function runEditorialData(args, write = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const [command, ...rest] = args;
  if (!["plan", "backup", "verify-backup", "restore"].includes(command)) throw new Error("EDITORIAL_DATA_USAGE");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!["--state-file", "--origin", "--backup-id", "--manifest-sha256", "--target"].includes(key) ||
        value === undefined || value.startsWith("--") || options[key] !== undefined) throw new Error("EDITORIAL_DATA_USAGE");
    options[key] = value;
  }
  const allowed = command === "plan" ? ["--state-file", "--origin"] : command === "backup" ? ["--state-file"] :
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
  if (command === "plan") {
    const plan = planEditorialMigration(state, { publicOrigin: options["--origin"] });
    const result = { ok: true, command, mutated: false, ...plan };
    write(result); return result;
  }
  // Management operations require the service to be stopped: an active writer
  // lock is rejected, and this process owns the lock until its work has ended.
  const store = new JsonStore({ filePath: stateFile, writerLock: true });
  try {
    await store.open(() => { throw new Error("EDITORIAL_DATA_STATE_REQUIRED"); });
    let receipt;
    if (command === "backup") {
      const mediaAssets = new MediaAssets({ store }); await mediaAssets.initialize();
      receipt = await createEditorialBackup({ store, mediaAssets }).captureCurrent();
    } else {
      const input = { store, backupId: options["--backup-id"], expectedManifestSha256: options["--manifest-sha256"] };
      receipt = command === "verify-backup" ? await verifyEditorialBackup(input) : await restoreEditorialBackupToIsolatedDirectory({
        ...input, targetDirectory: resolve(options["--target"]),
      });
    }
    const result = { ok: true, command, receipt }; write(result); return result;
  } finally { await store.close(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runEditorialData(process.argv.slice(2)).catch(error => {
    const known = /^[A-Z][A-Z0-9_]+$/.test(error?.code || "") ? error.code : /^EDITORIAL_DATA_[A-Z_]+$/.test(error?.message || "") ? error.message : "EDITORIAL_DATA_FAILED";
    process.stderr.write(`${JSON.stringify({ ok: false, code: known, message: "编辑数据管理未完成；核对命令参数、停服状态、文件权限与备份摘要。" })}\n`);
    process.exitCode = 1;
  });
}
