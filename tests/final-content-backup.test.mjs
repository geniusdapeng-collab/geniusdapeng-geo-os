import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMacFinalContentBackup } from "../src/services/final-content-backup.mjs";
import { finalContentBackupMatches, prepareFinalContentBackup } from "../public/final-backup-format.js";
import { readFinalBackupInput, runFinalContentBackup } from "../scripts/backup-final-content.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";

const timestamp = "2026-10-25T00:00:00.000Z";
const content = { id: "CNT-021", title: "完整定稿", body: "  原文首行\r\n\r\n保留 **Markdown** 与中文🙂\t  \n", version: 3, status: "approved" };
const digest = value => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const homeDir = await realpath(await mkdtemp(join(tmpdir(), "pengmanager-final-backup-")));
  t.after(() => rm(homeDir, { recursive: true, force: true }));
  return { homeDir, writer: createMacFinalContentBackup({ platform: "darwin", homeDir, clock: () => new Date(timestamp) }),
    root: join(homeDir, "Downloads", "pengmanager 备份") };
}

test("shared format preserves exact Unicode/CRLF/whitespace bytes and whitelists metadata", async () => {
  const prepared = await prepareFinalContentBackup({ ...content, accounts: [{ password: "fixture-never-copy" }], cookie: "fixture-never-copy" }, { backedUpAt: timestamp });
  assert.equal(prepared.body, content.body);
  assert.equal(prepared.metadata.bodySha256, digest(Buffer.from(content.body)));
  assert.equal(prepared.metadata.contentHash, digest(JSON.stringify([content.id, content.title, content.body])));
  assert.deepEqual(Object.keys(prepared.metadata).sort(), ["schemaVersion", "contentId", "title", "version", "status", "contentHash", "bodySha256", "backedUpAt"].sort());
  assert.equal(finalContentBackupMatches(prepared, { ...prepared.metadata, contentHash: { toString() { throw Error("must-not-coerce"); } } }, content.body), false);
  await assert.rejects(prepareFinalContentBackup({ ...content, body: "bad\uD800" }), { code: "FINAL_BACKUP_INVALID_CONTENT" });
  await assert.rejects(prepareFinalContentBackup({ ...content, id: "../outside" }), { code: "FINAL_BACKUP_INVALID_CONTENT" });
});

test("native Mac writer creates private files, deduplicates state versions and keeps changed finals", async t => {
  const { writer, root } = await fixture(t);
  assert.equal((await writer.save({ ...content, status: "draft" })).status, "skipped_not_final");
  await assert.rejects(access(root), { code: "ENOENT" });
  const first = await writer.save(content);
  assert.equal(first.status, "saved");
  assert.deepEqual(await readFile(join(first.directory, "final.md")), Buffer.from(content.body));
  const metadataBefore = await readFile(join(first.directory, "metadata.json"));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  for (const name of ["final.md", "metadata.json"]) assert.equal((await stat(join(first.directory, name))).mode & 0o777, 0o600);
  assert.equal((await writer.save({ ...content, status: "published", version: 8 })).status, "already_saved");
  assert.deepEqual(await readFile(join(first.directory, "metadata.json")), metadataBefore);
  const changed = await writer.save({ ...content, body: `${content.body}新增定稿` });
  assert.equal(changed.status, "saved");
  assert.notEqual(changed.directory, first.directory);
  assert.equal((await readdir(root)).length, 2);
  assert.deepEqual(await readFile(join(first.directory, "final.md")), Buffer.from(content.body));
});

test("Linux reports pending Mac synchronization without creating a Linux Downloads folder", async t => {
  const { homeDir } = await fixture(t);
  const writer = createMacFinalContentBackup({ platform: "linux", homeDir });
  assert.deepEqual(await writer.prepare(), { status: "pending_local_sync" });
  assert.deepEqual(await writer.save(content), { status: "pending_local_sync" });
  assert.deepEqual(await readdir(homeDir), []);
});

test("concurrent native writers publish identical complete bytes without replacing first metadata", async t => {
  const { homeDir, writer } = await fixture(t);
  const other = createMacFinalContentBackup({ platform: "darwin", homeDir, clock: () => new Date("2026-10-25T01:00:00.000Z") });
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? writer : other).save({ ...content, version: index + 1 })));
  assert.ok(results.every(row => ["saved", "already_saved"].includes(row.status)), JSON.stringify(results));
  const destination = results[0].directory;
  assert.deepEqual((await readdir(destination)).sort(), ["final.md", "metadata.json"]);
  assert.deepEqual(await readFile(join(destination, "final.md")), Buffer.from(content.body));
  assert.equal(finalContentBackupMatches(await prepareFinalContentBackup(content), JSON.parse(await readFile(join(destination, "metadata.json"))), content.body), true);
});

test("existing different bytes or malformed metadata are never overwritten", async t => {
  const { root, writer } = await fixture(t);
  await writer.prepare();
  const prepared = await prepareFinalContentBackup(content);
  const destination = join(root, prepared.directoryName);
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, "final.md"), "existing different text", { mode: 0o600 });
  assert.equal((await writer.save(content)).code, "FINAL_BACKUP_CONFLICT");
  assert.equal(await readFile(join(destination, "final.md"), "utf8"), "existing different text");
  await writeFile(join(destination, "final.md"), content.body, { mode: 0o600 });
  await writeFile(join(destination, "metadata.json"), "{", { mode: 0o600 });
  assert.equal((await writer.save(content)).code, "FINAL_BACKUP_CONFLICT");
  assert.equal(await readFile(join(destination, "metadata.json"), "utf8"), "{");
});

test("an interrupted matching final is completed without rewriting its body", async t => {
  const { root, writer } = await fixture(t);
  await writer.prepare();
  const prepared = await prepareFinalContentBackup(content);
  const destination = join(root, prepared.directoryName);
  await mkdir(destination, { mode: 0o700 });
  await writeFile(join(destination, "final.md"), content.body, { mode: 0o600 });
  const before = await stat(join(destination, "final.md"));
  assert.equal((await writer.save(content)).status, "saved");
  const after = await stat(join(destination, "final.md"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await writer.save(content)).status, "already_saved");
});

test("native reader accepts matching browser files under its private root and refuses a symlink file", async t => {
  const { root, homeDir, writer } = await fixture(t);
  await writer.prepare();
  const prepared = await prepareFinalContentBackup(content, { backedUpAt: timestamp });
  const destination = join(root, prepared.directoryName);
  await mkdir(destination, { mode: 0o755 }); await chmod(destination, 0o755);
  await writeFile(join(destination, "final.md"), content.body, { mode: 0o644 });
  await writeFile(join(destination, "metadata.json"), JSON.stringify(prepared.metadata), { mode: 0o644 });
  assert.equal((await writer.save(content)).status, "already_saved");
  const original = await readFile(join(destination, "final.md"));
  await rm(join(destination, "final.md"));
  const outside = join(homeDir, "outside-final.md"); await writeFile(outside, original);
  await symlink(outside, join(destination, "final.md"));
  assert.equal((await writer.save(content)).code, "FINAL_BACKUP_UNSAFE_PATH");
  assert.deepEqual(await readFile(outside), original);
});

test("symlink destinations and permissive backup roots fail visibly without touching their target", async t => {
  const { writer, homeDir, root } = await fixture(t);
  const outside = join(homeDir, "outside"); await mkdir(outside);
  await symlink(outside, join(homeDir, "Downloads"));
  assert.equal((await writer.save(content)).code, "FINAL_BACKUP_UNSAFE_PATH");
  assert.deepEqual(await readdir(outside), []);
  await rm(join(homeDir, "Downloads")); await mkdir(join(homeDir, "Downloads"));
  await mkdir(root, { mode: 0o755 }); await chmod(root, 0o755);
  assert.equal((await writer.save(content)).code, "FINAL_BACKUP_PRIVATE_DIRECTORY_REQUIRED");
  await chmod(root, 0o700);
  const prepared = await prepareFinalContentBackup(content);
  await symlink(outside, join(root, prepared.directoryName));
  assert.equal((await writer.save(content)).code, "FINAL_BACKUP_UNSAFE_PATH");
  assert.deepEqual(await readdir(outside), []);
});

test("missing home and invalid input return safe retryable errors without content or raw filesystem details", async t => {
  const { homeDir } = await fixture(t);
  const writer = createMacFinalContentBackup({ platform: "darwin", homeDir: join(homeDir, "missing-private-home") });
  const result = await writer.save(content);
  assert.equal(result.status, "error"); assert.equal(result.code, "FINAL_BACKUP_IO_ERROR");
  assert.doesNotMatch(JSON.stringify(result), /ENOENT|原文首行/);
  assert.equal((await writer.save({ ...content, version: 0 })).code, "FINAL_BACKUP_INVALID_CONTENT");
});

test("approval/publication trigger exact final backup, drafts do not, and backup errors preserve ledger success", async t => {
  const { homeDir } = await fixture(t);
  const rows = [];
  const store = new JsonStore({ filePath: join(homeDir, "state.json") });
  await store.open(() => ({ entity: {}, accounts: [{ id: "github", platform: "GitHub", status: "active", policyStatus: "reviewed" }], claims: [],
    content: [{ ...content, status: "draft", opinion: true, platforms: ["GitHub"], claimIds: [] }], contentBank: [], queries: [], observations: [], publications: [], interactions: [] }));
  const service = new GeoOsService({ store, clock: () => new Date(timestamp), finalContentBackup: {
    status() { return { status: "ready" }; }, async save(row) { rows.push(structuredClone(row)); throw Error("private-provider-error"); },
  } });
  const factCheck = await service.transitionContent(content.id, { target: "fact_check", actor: "fixture" });
  assert.equal(rows.length, 0); assert.equal(factCheck.finalBackup, undefined);
  const approved = await service.transitionContent(content.id, { target: "approved", actor: "fixture" });
  assert.equal(approved.status, "approved"); assert.equal(approved.finalBackup.code, "FINAL_BACKUP_IO_ERROR");
  await service.transitionContent(content.id, { target: "scheduled", actor: "fixture" });
  const publication = await service.recordPublication({ contentId: content.id, accountId: "github", actor: "fixture", receipt: {
    url: "https://github.com/geniusdapeng-collab/pengmanager/issues/1", publishedAt: timestamp, capturedBy: "fixture", dataMode: "imported",
  } });
  assert.equal(publication.finalBackup.status, "error");
  assert.deepEqual(rows.map(row => row.status), ["approved", "scheduled", "published"]);
  assert.ok(rows.every(row => row.body === content.body));
  assert.equal(store.snapshot().content[0].status, "published");
  assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  assert.equal(store.snapshot().events.length, 5);
  assert.doesNotMatch(await readFile(join(homeDir, "state.json"), "utf8"), /finalBackup|private-provider-error/);
});

test("CLI reads state without modifying it, excludes arbitrary fields and reports pending/errors honestly", async t => {
  const { homeDir, writer } = await fixture(t);
  const input = join(homeDir, "state.json");
  const raw = JSON.stringify({ content: [content, { ...content, id: "CNT-022", status: "draft" }], accounts: [{ password: "fixture-only-not-copy" }] });
  await writeFile(input, raw);
  const parsed = await readFinalBackupInput(input);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["id", "title", "body", "version", "status"].sort());
  const outputs = [];
  assert.equal(await runFinalContentBackup(["--state-file", input], { writer, output: value => outputs.push(value) }), 0);
  assert.equal(outputs[0].results[0].status, "saved");
  assert.equal(outputs[0].results[1].status, "skipped_not_final");
  assert.equal(await readFile(input, "utf8"), raw);
  assert.doesNotMatch(JSON.stringify(outputs), /fixture-only-not-copy|原文首行/);
  assert.equal(await runFinalContentBackup(["--input-file", input], { writer: createMacFinalContentBackup({ platform: "linux", homeDir }), output() {} }), 2);
  assert.equal(await runFinalContentBackup([], { writer: createMacFinalContentBackup({ platform: "linux", homeDir }), readInput: async () => [], output() {} }), 2);
  assert.equal(await runFinalContentBackup(["--input-file", "relative.json"], { writer, output() {} }), 1);
  assert.equal(await runFinalContentBackup(["--state-file", join(homeDir, "absent.json")], { writer, output() {} }), 1);
  const link = join(homeDir, "input-link.json"); await symlink(input, link);
  await assert.rejects(readFinalBackupInput(link));
});
