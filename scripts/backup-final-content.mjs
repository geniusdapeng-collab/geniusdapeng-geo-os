import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createMacFinalContentBackup } from "../src/services/final-content-backup.mjs";

const defaultState = resolve(import.meta.dirname, "../var/state.json");
const HELP = "用法：node scripts/backup-final-content.mjs [--state-file /绝对路径/state.json | --input-file /绝对路径/content.json | --prepare]。只读取输入；定稿备份到当前 Mac 用户的 Downloads/pengmanager 备份。";

export async function readFinalBackupInput(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("FINAL_BACKUP_INPUT_INVALID");
    const input = JSON.parse(await handle.readFile("utf8"));
    const rows = Array.isArray(input) ? input : Array.isArray(input?.content) ? input.content : input?.id ? [input] : null;
    if (!rows || rows.length > 100_000 || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error("FINAL_BACKUP_INPUT_INVALID");
    }
    // Pass only the exact final text and necessary identity/version fields.
    // Accounts, authentication state, receipts and arbitrary extra fields stay out.
    return rows.map(({ id, title, body, version, status }) => ({ id, title, body, version, status }));
  } finally { if (handle) await handle.close(); }
}

export async function runFinalContentBackup(args = process.argv.slice(2), {
  writer = createMacFinalContentBackup(), readInput = readFinalBackupInput,
  output = value => process.stdout.write(`${JSON.stringify(value)}\n`),
} = {}) {
  if (args.length === 1 && args[0] === "--help") { output({ help: HELP }); return 0; }
  const prepareOnly = args.length === 1 && args[0] === "--prepare";
  let path = defaultState;
  if (!prepareOnly && args.length) {
    if (args.length !== 2 || !["--state-file", "--input-file"].includes(args[0]) || !args[1].startsWith("/")) {
      output({ ok: false, code: "FINAL_BACKUP_ARGUMENTS_INVALID", help: HELP }); return 1;
    }
    path = args[1];
  }
  try {
    const readiness = await writer.prepare();
    if (prepareOnly) { output(readiness); return readiness.status === "ready" ? 0 : 2; }
    const rows = await readInput(path);
    const results = [];
    for (const row of rows) results.push(await writer.save(row));
    const ok = readiness.status === "ready" && results.every(row => ["saved", "already_saved", "skipped_not_final"].includes(row.status));
    output({ ok, results, target: writer.status() });
    return ok ? 0 : 2;
  } catch {
    output({ ok: false, code: "FINAL_BACKUP_INPUT_OR_IO_ERROR" }); return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runFinalContentBackup();
}
