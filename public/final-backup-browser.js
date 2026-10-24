import { isFinalContent, prepareFinalContentBackup, finalContentBackupMatches } from "./final-backup-format.js";

const FOLDER_NAME = "pengmanager 备份";
const LOCK_NAME = "pengmanager-final-content-backup";

function backupError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function existingDirectory(parent, name) {
  try { return await parent.getDirectoryHandle(name); }
  catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

async function readBackup(directory) {
  const body = await (await directory.getFileHandle("final.md")).getFile();
  const metadata = await (await directory.getFileHandle("metadata.json")).getFile();
  if (body.size > 2_000_000 || metadata.size > 16_000) throw backupError("BACKUP_EXISTING_CONFLICT");
  // Blob.text() strips a leading UTF-8 BOM. Preserve any character that was
  // already present in the approved body, and reject invalid UTF-8 bytes.
  const exactBody = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await body.arrayBuffer());
  return { body: exactBody, metadata: JSON.parse(await metadata.text()) };
}

async function writeNewFile(directory, name, text) {
  try {
    await directory.getFileHandle(name);
    throw backupError("BACKUP_EXISTING_CONFLICT");
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
  const file = await directory.getFileHandle(name, { create: true });
  let writable;
  try {
    writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
  } catch {
    if (writable) {
      const [aborted] = await Promise.allSettled([writable.abort()]);
      if (aborted.status === "rejected") throw backupError("BACKUP_WRITE_ABORT_FAILED");
    }
    throw backupError("BACKUP_WRITE_FAILED");
  }
}

// Existing versions are read and verified, never opened for writing. A failed
// new version remains visible for inspection instead of overwriting old data.
export async function backupFinalRows(directory, rows) {
  if (!Array.isArray(rows)) throw backupError("BACKUP_RESPONSE_INVALID");
  let saved = 0;
  let existing = 0;
  for (const row of rows.filter(isFinalContent)) {
    const prepared = await prepareFinalContentBackup(row);
    let version = await existingDirectory(directory, prepared.directoryName);
    if (version) {
      let previous;
      try { previous = await readBackup(version); }
      catch { throw backupError("BACKUP_EXISTING_CONFLICT"); }
      if (!await finalContentBackupMatches(prepared, previous.metadata, previous.body)) {
        throw backupError("BACKUP_EXISTING_CONFLICT");
      }
      existing += 1;
      continue;
    }
    version = await directory.getDirectoryHandle(prepared.directoryName, { create: true });
    await writeNewFile(version, "final.md", prepared.body);
    await writeNewFile(version, "metadata.json", JSON.stringify(prepared.metadata, null, 2) + "\n");
    const written = await readBackup(version);
    if (!await finalContentBackupMatches(prepared, written.metadata, written.body)) {
      throw backupError("BACKUP_READBACK_FAILED");
    }
    saved += 1;
  }
  return { saved, existing, total: saved + existing };
}

function directoryStorage(indexedDB, value) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("pengmanager-final-content-backup", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("settings");
    open.onerror = () => reject(backupError("BACKUP_STORAGE_FAILED"));
    open.onblocked = () => reject(backupError("BACKUP_STORAGE_BLOCKED"));
    open.onsuccess = () => {
      const database = open.result;
      let request;
      let transaction;
      try {
        transaction = database.transaction("settings", value ? "readwrite" : "readonly");
        const store = transaction.objectStore("settings");
        request = value ? store.put(value, "directory") : store.get("directory");
      } catch {
        database.close();
        reject(backupError("BACKUP_STORAGE_FAILED"));
        return;
      }
      transaction.oncomplete = () => { database.close(); resolve(request.result); };
      transaction.onerror = transaction.onabort = () => {
        database.close();
        reject(backupError("BACKUP_STORAGE_FAILED"));
      };
    };
  });
}

export function mountFinalBackup({ api, window: browser = window, document: page = document } = {}) {
  const panel = page.querySelector("#final-backup");
  const button = page.querySelector("#final-backup-enable");
  const status = page.querySelector("#final-backup-status");
  const supported = browser.isSecureContext && typeof browser.showDirectoryPicker === "function" &&
    browser.indexedDB && browser.crypto?.subtle && browser.navigator?.locks?.request;
  let directory = null;
  let busy = false;
  let selecting = false;
  let disposed = false;
  let pending = false;
  let timer = null;
  let selectionVersion = 0;

  function show(kind, message) {
    panel.dataset.state = kind;
    panel.setAttribute("aria-busy", String(kind === "working"));
    status.textContent = message;
    button.disabled = !supported || busy || selecting;
    button.textContent = selecting ? "正在选择文件夹…" : directory ? "重新选择备份文件夹" : "启用本机终稿备份";
  }

  function showFailure(error) {
    if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
      show("permission", "文件夹写入权限已失效。请点击按钮重新授权，终稿会在授权后补齐。");
    } else if (error?.code === "BACKUP_EXISTING_CONFLICT") {
      show("error", "现有备份目录内容不完整或与终稿不符，已停止本轮备份并保留原文件。请核对文件夹后重试。");
    } else if (["BACKUP_STORAGE_FAILED", "BACKUP_STORAGE_BLOCKED"].includes(error?.code)) {
      show("error", "浏览器未能保存文件夹授权。请允许本站使用本地存储，再重新选择文件夹。");
    } else {
      show("error", "本轮备份未完成。请检查网络、登录状态、文件夹权限和磁盘空间；下次会重新检查，已有版本会保留。");
    }
  }

  async function sync() {
    if (!supported || !directory || disposed || selecting) return;
    if (busy) { pending = true; return; }
    busy = true;
    show("working", "正在读取并备份终稿…");
    try {
      const target = directory;
      if (await target.queryPermission({ mode: "readwrite" }) !== "granted") {
        show("permission", "需要重新授权备份文件夹。点击按钮选择后，会补齐已批准、已排期和已发布的终稿。");
        return;
      }
      const result = await browser.navigator.locks.request(LOCK_NAME, async () => {
        const rows = await api("/api/content");
        if (disposed) throw backupError("BACKUP_PAGE_CLOSED");
        return backupFinalRows(target, rows);
      });
      if (!disposed) show("saved", result.total
        ? `已核对 ${result.total} 条终稿，本次新增 ${result.saved} 条。最近检查 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}。`
        : "已启用，当前暂无已批准、已排期或已发布的终稿。新终稿会自动备份。");
    } catch (error) { if (!disposed) showFailure(error); }
    finally {
      busy = false;
      button.disabled = !supported || selecting;
      if (pending && !disposed) { pending = false; void sync(); }
    }
  }

  async function choose() {
    if (!supported || busy || selecting || disposed) return;
    selectionVersion += 1;
    selecting = true;
    show("working", "请选择下载文件夹里的“pengmanager 备份”，并允许写入。");
    try {
      // The picker is called directly from a button gesture, never by a timer.
      const selected = await browser.showDirectoryPicker({ id: "pengmanager-final-backup", mode: "readwrite", startIn: "downloads" });
      if (selected.name !== FOLDER_NAME) {
        show("permission", "请选择下载文件夹里的“pengmanager 备份”文件夹。尚未向所选文件夹写入终稿。");
        return;
      }
      if (await selected.queryPermission({ mode: "readwrite" }) !== "granted") {
        show("permission", "尚未取得写入权限，未启用备份。请重新选择文件夹并允许写入。");
        return;
      }
      await directoryStorage(browser.indexedDB, selected);
      directory = selected;
      show("working", "文件夹已授权，正在补齐已有终稿…");
    } catch (error) {
      if (error?.name === "AbortError") show("permission", directory
        ? "已取消重新选择；原备份文件夹仍按已有权限使用。"
        : "尚未选择文件夹，备份未启用。点击按钮完成授权后才会保存终稿。");
      else showFailure(error);
      return;
    } finally {
      selecting = false;
      button.disabled = !supported || busy;
      button.textContent = directory ? "重新选择备份文件夹" : "启用本机终稿备份";
    }
    await sync();
  }

  button.addEventListener("click", choose);
  if (!supported) {
    show("unsupported", "当前浏览器不支持文件夹自动备份。请在这台 Mac 的 Chrome 中打开 HTTPS 管理后台并登录后启用。");
  } else {
    show("permission", "尚未启用。请选择下载文件夹里的“pengmanager 备份”，允许本站自动保存终稿。");
    void (async () => {
      const version = selectionVersion;
      try {
        const stored = await directoryStorage(browser.indexedDB);
        if (disposed || !stored || selectionVersion !== version) return;
        if (stored.kind !== "directory" || stored.name !== FOLDER_NAME) throw backupError("BACKUP_STORAGE_FAILED");
        directory = stored;
        // Permission queries do not prompt. Reauthorization always needs a click.
        const permission = await stored.queryPermission({ mode: "readwrite" });
        if (disposed || selectionVersion !== version) return;
        if (permission === "granted") await sync();
        else show("permission", "已记住备份文件夹，需要点击按钮重新授权。授权后会补齐遗漏的终稿。");
      } catch (error) { if (!disposed) showFailure(error); }
    })();
    timer = browser.setInterval(() => { void sync(); }, 30_000);
  }
  browser.addEventListener("pagehide", () => { disposed = true; browser.clearInterval(timer); }, { once: true });
  return { sync };
}
