import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JsonStore } from "../src/storage/json-store.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/editorial-data.mjs", import.meta.url));
const REPOSITORY = dirname(dirname(SCRIPT));

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-editorial-entry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = join(root, "live", "state.json");
  const store = new JsonStore({ filePath: stateFile, writerLock: true });
  try { await store.open(() => ({ accounts: [], claims: [], content: [], queries: [] })); }
  finally { await store.close(); }
  const current = join(root, "current 发布 # %");
  const scriptLink = join(root, "editorial entry # %.mjs");
  await symlink(REPOSITORY, current, "dir");
  await symlink(SCRIPT, scriptLink, "file");
  return { root, stateFile, current, entries: [SCRIPT, join(current, "scripts", "editorial-data.mjs"), scriptLink] };
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout.trim(), "", "a successful CLI must emit its actual result");
  return JSON.parse(result.stdout);
}

test("real CLI emits a read-only migration plan through normal, release-symlink and script-symlink paths", async t => {
  const f = await fixture(t);
  const before = await readFile(f.stateFile), info = await stat(f.stateFile);
  const names = await readdir(dirname(f.stateFile));
  let baseline;
  for (const entry of f.entries) {
    const output = success(run([relative(f.root, entry), "plan", "--state-file", f.stateFile,
      "--origin", "https://pengmanager.com"], f.root));
    assert.equal(output.ok, true); assert.equal(output.command, "plan"); assert.equal(output.mutated, false);
    assert.equal(output.fromSchema, 1); assert.equal(output.toSchema, 2);
    assert.equal(output.publicOrigin, "https://pengmanager.com");
    baseline ??= output; assert.deepEqual(output, baseline);
  }
  assert.deepEqual(success(run(["--preserve-symlinks-main", f.entries[1], "plan", "--state-file", f.stateFile,
    "--origin", "https://pengmanager.com"], f.root)), baseline);
  assert.deepEqual(await readFile(f.stateFile), before);
  assert.equal((await stat(f.stateFile)).mtimeMs, info.mtimeMs);
  assert.deepEqual(await readdir(dirname(f.stateFile)), names);
});

test("real CLI reports usage and input failures with nonzero exit through every entry path", async t => {
  const f = await fixture(t);
  const before = await readFile(f.stateFile);
  for (const entry of f.entries) {
    for (const [args, code] of [
      [[], "EDITORIAL_DATA_USAGE"],
      [["plan", "--state-file", join(f.root, "missing-state.json")], "ENOENT"],
      [["plan", "--state-file", f.stateFile, "--origin", "not-an-origin"], "INVALID_PUBLIC_ORIGIN"],
    ]) {
      const result = run([entry, ...args], f.root);
      assert.equal(result.status, 1); assert.equal(result.stdout, "");
      const error = JSON.parse(result.stderr);
      assert.equal(error.ok, false); assert.equal(error.code, code);
      assert.ok(!result.stderr.includes(f.root), "errors must not disclose local paths");
    }
  }
  assert.deepEqual(await readFile(f.stateFile), before);
});

test("release-symlink CLI actually captures, verifies and restores an isolated backup", async t => {
  const f = await fixture(t);
  const entry = f.entries[1], before = await readFile(f.stateFile);
  const captured = success(run([entry, "backup", "--state-file", f.stateFile], f.root));
  assert.equal(captured.ok, true); assert.equal(captured.command, "backup");
  assert.match(captured.receipt.backupId, /^EDB-[a-f0-9]{32}$/);
  const args = ["--state-file", f.stateFile, "--backup-id", captured.receipt.backupId,
    "--manifest-sha256", captured.receipt.manifestSha256];
  const verified = success(run([entry, "verify-backup", ...args], f.root));
  assert.equal(verified.command, "verify-backup"); assert.equal(verified.receipt.filesVerified, 1);
  const target = join(f.root, "isolated-restore");
  const restored = success(run([entry, "restore", ...args, "--target", target], f.root));
  assert.equal(restored.command, "restore"); assert.equal(restored.receipt.restored, true);
  assert.deepEqual(await readFile(join(target, "state.json")), before);
  assert.deepEqual(await readFile(f.stateFile), before);
  const repeated = run([entry, "restore", ...args, "--target", target], f.root);
  assert.equal(repeated.status, 1); assert.equal(repeated.stdout, "");
  assert.equal(JSON.parse(repeated.stderr).code, "EDITORIAL_RESTORE_TARGET_EXISTS");
  assert.deepEqual(await readFile(join(target, "state.json")), before);
});

test("ESM import and CommonJS require expose the function without executing CLI arguments", async t => {
  const f = await fixture(t);
  const before = await readFile(f.stateFile), names = await readdir(dirname(f.stateFile));
  for (const [index, entry] of f.entries.entries()) {
    const esm = join(f.root, `import-${index}.mjs`), cjs = join(f.root, `require-${index}.cjs`);
    await writeFile(esm, `const m = await import(${JSON.stringify(pathToFileURL(entry).href)});\nif (typeof m.runEditorialData !== "function") throw new Error("missing export");\nconsole.log("imported");\n`);
    await writeFile(cjs, `const m = require(${JSON.stringify(entry)});\nif (typeof m.runEditorialData !== "function") throw new Error("missing export");\nconsole.log("imported");\n`);
    for (const wrapper of [esm, cjs]) {
      const result = run([wrapper, "backup", "--state-file", f.stateFile], f.root);
      assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
      assert.equal(result.stdout, "imported\n");
    }
  }
  const importCode = `const m = await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});\nif (typeof m.runEditorialData !== "function") throw new Error("missing export");\nconsole.log("imported");`;
  for (const args of [[], [join(f.root, "not-a-script")], [join(f.stateFile, "not-a-script")]]) {
    const result = run(["--input-type=module", "-e", importCode, ...args], f.root);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.equal(result.stdout, "imported\n");
  }
  assert.deepEqual(await readFile(f.stateFile), before);
  assert.deepEqual(await readdir(dirname(f.stateFile)), names);
});
