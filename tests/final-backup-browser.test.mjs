import test from "node:test";
import assert from "node:assert/strict";
import { backupFinalRows, mountFinalBackup } from "../public/final-backup-browser.js";
import { prepareFinalContentBackup } from "../public/final-backup-format.js";

function memoryDirectory(name = "pengmanager 备份", state = { writes: [], fail: false }) {
  const entries = new Map();
  return {
    name, kind: "directory", entries, state,
    async queryPermission() { return "granted"; },
    async getDirectoryHandle(child, { create = false } = {}) {
      if (!entries.has(child)) {
        if (!create) throw new DOMException("Absent", "NotFoundError");
        entries.set(child, memoryDirectory(child, state));
      }
      return entries.get(child);
    },
    async getFileHandle(child, { create = false } = {}) {
      if (!entries.has(child)) {
        if (!create) throw new DOMException("Absent", "NotFoundError");
        const file = { text: "", async getFile() { return { size: new TextEncoder().encode(file.text).length,
          text: async () => file.text, arrayBuffer: async () => new TextEncoder().encode(file.text).buffer }; },
          async createWritable() {
            state.writes.push(child);
            let pending;
            return {
              async write(text) { if (state.fail) throw new DOMException("Full", "QuotaExceededError"); pending = text; },
              async close() { file.text = pending; },
              async abort() { pending = undefined; },
            };
          } };
        entries.set(child, file);
      }
      return entries.get(child);
    },
  };
}

const finalRow = { id: "CNT-1001", title: "中文与 emoji 🐼", body: "\uFEFF  原样正文\r\n第二行 🐼\n", version: 3, status: "approved", privateNote: "not exported" };

test("browser backup preserves exact final body, allowlists metadata and skips unchanged versions", async () => {
  const directory = memoryDirectory();
  assert.deepEqual(await backupFinalRows(directory, [finalRow]), { saved: 1, existing: 0, total: 1 });
  const prepared = await prepareFinalContentBackup(finalRow);
  const version = directory.entries.get(prepared.directoryName);
  assert.equal(version.entries.get("final.md").text, finalRow.body);
  const metadata = JSON.parse(version.entries.get("metadata.json").text);
  assert.equal(metadata.privateNote, undefined);
  assert.equal(Object.keys(metadata).length, 8);
  const before = version.entries.get("metadata.json").text;
  assert.deepEqual(await backupFinalRows(directory, [{ ...finalRow, status: "published", version: 4 }]), { saved: 0, existing: 1, total: 1 });
  assert.equal(version.entries.get("metadata.json").text, before);
  assert.equal(directory.state.writes.length, 2);
  await backupFinalRows(directory, [{ ...finalRow, body: finalRow.body + "修订" }]);
  assert.equal(directory.entries.size, 2);
  assert.equal(version.entries.get("final.md").text, finalRow.body);
});

test("drafts are excluded and malformed server responses fail before filesystem writes", async () => {
  const directory = memoryDirectory();
  assert.deepEqual(await backupFinalRows(directory, [{ ...finalRow, status: "draft" }]), { saved: 0, existing: 0, total: 0 });
  await assert.rejects(backupFinalRows(directory, {}), { code: "BACKUP_RESPONSE_INVALID" });
  assert.equal(directory.entries.size, 0);
});

test("existing modified or partial versions raise a conflict without overwriting", async () => {
  const directory = memoryDirectory();
  await backupFinalRows(directory, [finalRow]);
  const prepared = await prepareFinalContentBackup(finalRow);
  const version = directory.entries.get(prepared.directoryName);
  version.entries.get("final.md").text = "locally changed";
  await assert.rejects(backupFinalRows(directory, [finalRow]), { code: "BACKUP_EXISTING_CONFLICT" });
  assert.equal(version.entries.get("final.md").text, "locally changed");
  assert.equal(directory.state.writes.length, 2);
  version.entries.delete("metadata.json");
  await assert.rejects(backupFinalRows(directory, [finalRow]), { code: "BACKUP_EXISTING_CONFLICT" });
  assert.equal(directory.state.writes.length, 2);
});

test("filesystem write failures reject and cannot report a saved backup", async () => {
  const directory = memoryDirectory();
  directory.state.fail = true;
  await assert.rejects(backupFinalRows(directory, [finalRow]), { code: "BACKUP_WRITE_FAILED" });
  const version = [...directory.entries.values()][0];
  assert.equal(version.entries.has("metadata.json"), false);
  assert.equal(version.entries.get("final.md").text, "");
});

function fakePage(stored, permission = "prompt", supported = true) {
  const elements = Object.fromEntries(["#final-backup", "#final-backup-enable", "#final-backup-status"].map(id => [id, {
    dataset: {}, textContent: "", disabled: false, events: {}, setAttribute() {},
    addEventListener(type, callback) { this.events[type] = callback; },
  }]));
  const counts = { picks: 0, requests: 0, api: 0 };
  if (stored) {
    stored.queryPermission = async () => permission;
    stored.requestPermission = async () => { counts.requests += 1; return "granted"; };
  }
  const browser = {
    isSecureContext: supported, crypto: globalThis.crypto,
    navigator: { locks: { request: async (_name, callback) => callback() } },
    indexedDB: { open() {
      const open = {};
      queueMicrotask(() => {
        open.result = { close() {}, transaction() {
          const transaction = { objectStore: () => ({ get() { queueMicrotask(() => transaction.oncomplete()); return { result: stored }; } }) };
          return transaction;
        } };
        open.onsuccess();
      });
      return open;
    } },
    showDirectoryPicker: async () => { counts.picks += 1; throw new DOMException("Cancelled", "AbortError"); },
    setInterval: () => 1, clearInterval() {}, addEventListener() {},
  };
  const backup = mountFinalBackup({ api: async () => { counts.api += 1; return [finalRow]; }, window: browser, document: { querySelector: id => elements[id] } });
  return { elements, counts, backup };
}

test("stored directory needing permission does not silently prompt or fetch private content", async () => {
  const page = fakePage(memoryDirectory());
  await new Promise(resolve => setImmediate(resolve));
  await page.backup.sync();
  assert.equal(page.elements["#final-backup"].dataset.state, "permission");
  assert.equal(page.counts.picks, 0);
  assert.equal(page.counts.requests, 0);
  assert.equal(page.counts.api, 0);
  await page.elements["#final-backup-enable"].events.click();
  assert.equal(page.counts.picks, 1);
  assert.equal(page.counts.api, 0);
});

test("unsupported browsers show an explicit inactive state", () => {
  const page = fakePage(null, "prompt", false);
  assert.equal(page.elements["#final-backup"].dataset.state, "unsupported");
  assert.equal(page.elements["#final-backup-enable"].disabled, true);
  assert.equal(page.counts.api, 0);
});

test("already granted stored directory backfills current final content on reopen", async () => {
  const directory = memoryDirectory();
  const page = fakePage(directory, "granted");
  for (let attempt = 0; attempt < 100 && page.elements["#final-backup"].dataset.state !== "saved"; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(page.elements["#final-backup"].dataset.state, "saved");
  assert.equal(directory.entries.size, 1);
  assert.equal(page.counts.picks, 0);
  assert.equal(page.counts.requests, 0);
  assert.equal(page.counts.api, 1);
});
