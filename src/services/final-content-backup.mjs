import { constants } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { FinalBackupFormatError, finalContentBackupMatches, isFinalContent,
  prepareFinalContentBackup } from "../../public/final-backup-format.js";

function failure(code) { return Object.assign(new Error(code), { code }); }

async function ordinaryDirectory(path, { create = false, privateDirectory = false, owned = false } = {}) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("FINAL_BACKUP_UNSAFE_PATH");
  if ((privateDirectory && (info.mode & 0o077)) ||
      ((privateDirectory || owned) && typeof process.getuid === "function" && info.uid !== process.getuid())) {
    throw failure("FINAL_BACKUP_PRIVATE_DIRECTORY_REQUIRED");
  }
}

async function safeHome(path) {
  if (typeof path !== "string" || !isAbsolute(path) || path !== resolve(path)) {
    throw failure("FINAL_BACKUP_UNSAFE_PATH");
  }
  let current = parse(path).root;
  await ordinaryDirectory(current);
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    await ordinaryDirectory(current);
  }
}

async function readOrdinaryFile(path, maximum) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw failure("FINAL_BACKUP_CONFLICT");
    return await handle.readFile();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (["ELOOP", "EMLINK"].includes(error.code)) throw failure("FINAL_BACKUP_UNSAFE_PATH");
    throw error;
  } finally { if (handle) await handle.close(); }
}

// Publish a fully written file exclusively. Unlike rename(), link() never
// replaces an existing final. Competing identical writers verify the winner.
async function publishExclusive(directory, name, bytes) {
  const temporary = join(directory, `.${randomUUID()}.pending`);
  let handle;
  let created = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await ordinaryDirectory(directory, { owned: true });
    try { await link(temporary, join(directory, name)); return true; }
    catch (error) { if (error.code === "EEXIST") return false; throw error; }
  } finally {
    if (handle) await handle.close();
    if (created) await unlink(temporary);
  }
}

function safeCode(error) {
  if (error instanceof FinalBackupFormatError || String(error?.code).startsWith("FINAL_BACKUP_")) return error.code;
  if (["EACCES", "EPERM"].includes(error?.code)) return "FINAL_BACKUP_PERMISSION_DENIED";
  if (["ENOSPC", "EDQUOT"].includes(error?.code)) return "FINAL_BACKUP_DISK_FULL";
  return "FINAL_BACKUP_IO_ERROR";
}

export function createMacFinalContentBackup({ platform = process.platform, homeDir = homedir(),
  clock = () => new Date() } = {}) {
  const directory = platform === "darwin" ? join(homeDir, "Downloads", "pengmanager 备份") : null;
  let current = platform === "darwin" ? { status: "not_prepared", directory } : { status: "pending_local_sync" };
  async function prepare() {
    if (platform !== "darwin") return { ...current };
    try {
      await safeHome(homeDir);
      await ordinaryDirectory(join(homeDir, "Downloads"), { create: true });
      await ordinaryDirectory(directory, { create: true, privateDirectory: true });
      current = { status: "ready", directory };
    } catch (error) { current = { status: "error", code: safeCode(error), directory }; }
    return { ...current };
  }
  return Object.freeze({
    prepare,
    status() { return { ...current }; },
    async save(content) {
      if (!isFinalContent(content)) return { status: "skipped_not_final" };
      if (platform !== "darwin") return { status: "pending_local_sync" };
      try {
        const prepared = await prepareFinalContentBackup(content, { backedUpAt: clock().toISOString() });
        const ready = await prepare();
        if (ready.status !== "ready") return ready;
        const destination = join(directory, prepared.directoryName);
        // The owner-only root also protects browser-created children, whose
        // platform-default modes may be 0755. Preserve those matching copies.
        await ordinaryDirectory(destination, { create: true, owned: true });
        const bodyFile = join(destination, "final.md"), metadataFile = join(destination, "metadata.json");
        const expectedBody = Buffer.from(prepared.body, "utf8");
        let existingBody = await readOrdinaryFile(bodyFile, 200_000);
        let existingMetadata = await readOrdinaryFile(metadataFile, 4096);
        const metadataMatches = bytes => {
          try { return finalContentBackupMatches(prepared, JSON.parse(bytes.toString("utf8")), prepared.body); }
          catch (error) { if (error instanceof SyntaxError) return false; throw error; }
        };
        if ((existingBody && !existingBody.equals(expectedBody)) ||
            (existingMetadata && !metadataMatches(existingMetadata))) throw failure("FINAL_BACKUP_CONFLICT");
        let written = false;
        if (!existingBody) written = await publishExclusive(destination, "final.md", expectedBody) || written;
        // Metadata commits last; partial own writes can be retried without ever
        // overwriting different text, including after an interrupted process.
        if (!existingMetadata) written = await publishExclusive(destination, "metadata.json",
          Buffer.from(`${JSON.stringify(prepared.metadata, null, 2)}\n`, "utf8")) || written;
        existingBody = await readOrdinaryFile(bodyFile, 200_000);
        existingMetadata = await readOrdinaryFile(metadataFile, 4096);
        if (!existingBody?.equals(expectedBody) || !existingMetadata || !metadataMatches(existingMetadata)) {
          throw failure("FINAL_BACKUP_CONFLICT");
        }
        current = { status: "ready", directory };
        return { status: written ? "saved" : "already_saved", contentId: prepared.metadata.contentId,
          contentHash: prepared.metadata.contentHash, directory: destination };
      } catch (error) {
        const result = { status: "error", code: safeCode(error), directory };
        current = result;
        return { ...result };
      }
    },
  });
}
