import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { JsonStore } from "../src/storage/json-store.mjs";

async function location(t) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-editorial-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, filePath: join(directory, "state.json") };
}

test("noChange discards clone edits and an identical transaction creates no event or disk write", async t => {
  const { filePath } = await location(t), store = new JsonStore({ filePath });
  await store.open(async () => ({ counter: 0 }));
  const bytes = await readFile(filePath, "utf8"), before = store.snapshot();
  const result = await store.mutate({ type: "unit.no-change", actor: "test" }, state => { state.counter = 99; return JsonStore.noChange({ original: true }); });
  assert.deepEqual(result.result, { original: true }); assert.deepEqual(store.snapshot(), before);
  assert.equal(await readFile(filePath, "utf8"), bytes); await store.close();
});

test("exclusive writer lock blocks a second owner; normal close permits a fresh writer", async t => {
  const { filePath } = await location(t), a = new JsonStore({ filePath, writerLock: true }), b = new JsonStore({ filePath, writerLock: true });
  await a.open(async () => ({ counter: 0 }));
  await assert.rejects(b.open(async () => ({})), { code: "STATE_WRITER_LOCKED" });
  await a.close(); await b.open(async () => { throw new Error("must not reseed"); });
  await b.mutate({ type: "unit.after-close", actor: "test" }, state => { state.counter += 1; });
  assert.equal(b.snapshot().counter, 1); await b.close();
  await assert.rejects(b.mutate({ type: "unit.closed" }, () => null), { code: "STATE_STORE_CLOSED" });
});

test("writer ownership also holds across a real independent Node process", async t => {
  const { filePath } = await location(t);
  const moduleUrl = new URL("../src/storage/json-store.mjs", import.meta.url).href;
  const code = `import {JsonStore} from ${JSON.stringify(moduleUrl)};const store=new JsonStore({filePath:process.argv[1],writerLock:true});await store.open(async()=>({counter:0}));process.stdout.write('READY\\n');process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));await store.close();`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", code, filePath], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  const [ready] = await once(child.stdout, "data"); assert.match(ready.toString(), /READY/);
  const other = new JsonStore({ filePath, writerLock: true });
  await assert.rejects(other.open(async () => ({})), { code: "STATE_WRITER_LOCKED" });
  child.stdin.end(); const [exit] = await once(child, "exit"); assert.equal(exit, 0, errors);
  await other.open(async () => ({})); await other.close();
});

test("persist failure leaves the in-memory revision unchanged, cleans its own temporary file and allows retry", async t => {
  const { directory, filePath } = await location(t), store = new JsonStore({ filePath });
  await store.open(async () => ({ counter: 0 })); const before = store.snapshot();
  await rename(filePath, `${filePath}.held`); await mkdir(filePath);
  await assert.rejects(store.mutate({ type: "unit.rename-failure", actor: "test" }, state => { state.counter += 1; }), error => ["EISDIR", "ENOTDIR", "EEXIST"].includes(error.code));
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith(".tmp")), []);
  await rm(filePath, { recursive: true }); await rename(`${filePath}.held`, filePath);
  await store.mutate({ type: "unit.retry", actor: "test" }, state => { state.counter += 1; }); assert.equal(store.snapshot().counter, 1); await store.close();
});

test("unknown or symlinked writer lock is never stolen or overwritten", async t => {
  const { filePath } = await location(t); await writeFile(`${filePath}.writer.lock`, "unknown-owner");
  const store = new JsonStore({ filePath, writerLock: true });
  await assert.rejects(store.open(async () => ({})), { code: "STATE_WRITER_LOCKED" });
  assert.equal(await readFile(`${filePath}.writer.lock`, "utf8"), "unknown-owner");
  await rm(`${filePath}.writer.lock`);
  await writeFile(`${filePath}.external-owner`, "external-target-must-remain");
  await symlink(`${filePath}.external-owner`, `${filePath}.writer.lock`);
  const symlinked = new JsonStore({ filePath, writerLock: true });
  await assert.rejects(symlinked.open(async () => ({})), { code: "STATE_WRITER_LOCKED" });
  assert.equal(await readFile(`${filePath}.external-owner`, "utf8"), "external-target-must-remain");
});
