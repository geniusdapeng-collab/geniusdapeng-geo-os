import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { runEditorialData } from "../scripts/editorial-data.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-editorial-cli-"));
  const filePath = join(root, "live", "state.json");
  const store = new JsonStore({ filePath, writerLock: true });
  await store.open(() => ({ accounts: [], claims: [], content: [], queries: [] }));
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, filePath, store };
}

test("migration plan is read-only including state bytes, mtime, directory inventory and live writer ownership", async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.filePath), info = await stat(f.filePath), names = await readdir(join(f.root, "live"));
  let output;
  const result = await runEditorialData(["plan", "--state-file", f.filePath, "--origin", "https://pengmanager.com"], value => { output = value; });
  assert.equal(result, output); assert.equal(result.mutated, false); assert.equal(result.toSchema, 2);
  assert.deepEqual(await readFile(f.filePath), bytes); assert.equal((await stat(f.filePath)).mtimeMs, info.mtimeMs);
  assert.deepEqual(await readdir(join(f.root, "live")), names);
  assert.doesNotMatch(JSON.stringify(result), /state\.json|password|cookie/i);
  await assert.rejects(runEditorialData(["backup", "--state-file", f.filePath], () => {}), error => error.code === "STATE_WRITER_LOCKED");
  assert.deepEqual(await readFile(f.filePath), bytes);
});

test("management CLI backs up and verifies actual state, restores outside live data, and never overwrites an existing target", async t => {
  const f = await fixture(t); const original = f.store.snapshot(); await f.store.close();
  const backup = await runEditorialData(["backup", "--state-file", f.filePath], () => {});
  const args = ["--state-file", f.filePath, "--backup-id", backup.receipt.backupId, "--manifest-sha256", backup.receipt.manifestSha256];
  const verified = await runEditorialData(["verify-backup", ...args], () => {});
  assert.equal(verified.receipt.filesVerified, 1);
  const target = join(f.root, "isolated");
  const restored = await runEditorialData(["restore", ...args, "--target", target], () => {});
  assert.equal(restored.receipt.restored, true);
  const state = JSON.parse(await readFile(join(target, "state.json"), "utf8"));
  assert.deepEqual(state, original); assert.equal(verifyEventChain(state.events).valid, true);
  await assert.rejects(runEditorialData(["restore", ...args, "--target", target], () => {}), error => error.code === "EDITORIAL_RESTORE_TARGET_EXISTS");
  assert.deepEqual(JSON.parse(await readFile(f.filePath, "utf8")), original);
  assert.deepEqual(JSON.parse(await readFile(join(target, "state.json"), "utf8")), original);
});

test("CLI rejects unsupported/duplicate options and explicit live restore destinations", async t => {
  const f = await fixture(t); await f.store.close();
  for (const args of [[], ["plan"], ["plan", "--state-file", f.filePath, "--state-file", f.filePath],
    ["plan", "--state-file", f.filePath, "--target", f.root], ["backup", "--state-file", f.filePath, "--origin", "https://pengmanager.com"]]) {
    await assert.rejects(runEditorialData(args, () => {}), /EDITORIAL_DATA_USAGE/);
  }
  const backup = await runEditorialData(["backup", "--state-file", f.filePath], () => {});
  await assert.rejects(runEditorialData(["restore", "--state-file", f.filePath, "--backup-id", backup.receipt.backupId,
    "--manifest-sha256", backup.receipt.manifestSha256, "--target", join(f.root, "live")], () => {}), error => error.code === "EDITORIAL_RESTORE_LIVE_TARGET");
});
