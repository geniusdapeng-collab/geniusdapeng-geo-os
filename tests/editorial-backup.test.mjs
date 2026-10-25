import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, chmod, lstat, symlink, unlink, writeFile, open, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGNgYPhLIhrVMKph2GoAAISu/QH+5zsIAAAAAElFTkSuQmCC", "base64");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const ctx = (key, etag) => ({ actor: "fixture-owner", method: "session", idempotencyKey: key, ...(etag ? { ifMatch: etag } : {}) });
const rejected = (promise, code, status = 503) => assert.rejects(promise, error => error.status === status && (!code || error.code === code));
async function fixture(t, { assets = 3 } = {}) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-backup-"));
  const directory = join(parent, "live"); await mkdir(directory, { mode: 0o700 });
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(async () => ({ accounts: [{ id: "ACC-private", note: "Synthetic private account note" }], claims: [],
    content: [{ id: "CNT-legacy", body: "Complete legacy article." }], stories: [{ id: "STY-001", workingTitle: "Draft retained." }],
    editions: [{ id: "EDN-zh", locale: "zh-CN", body: "中文全文" }, { id: "EDN-en", locale: "en-US", body: "Complete English text." }],
    websiteReleases: [{ id: "WRE-001", status: "approved", snapshotHash: "a".repeat(64), publicSnapshot: { body: "Approved exact public body." } }],
    websiteRoutes: [{ id: "RTE-previous", activeReleaseId: "WRE-old" }],
    publications: [{ id: "PUB-history", receipt: { method: "fixture", url: "https://example.org/history" } }] }));
  const media = new MediaAssets({ store }); await media.initialize();
  const uploaded = [];
  for (let index = 0; index < assets; index++) {
    let asset = await media.upload(Readable.from([PNG]), { contentType: "image/png", contentLength: PNG.length, name: `synthetic-${index}.png` }, ctx(`fixture-upload-${index}`));
    if (index < 2) asset = await media.review(asset.id, { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Own synthetic file, no personal data." }, ctx(`fixture-review-${index}`, asset.etag));
    if (index === 1) asset = await media.revoke(asset.id, { reason: "Retain historical withdrawn data." }, ctx("fixture-revoke-1", asset.etag));
    uploaded.push(asset);
  }
  const backup = createEditorialBackup({ store, mediaAssets: media });
  t.after(async () => { await store.close(); await rm(parent, { recursive: true, force: true }); });
  return { parent, directory, store, media, uploaded, backup };
}
const backupPath = (f, result) => join(f.directory, "backups", "editorial", result.backupId);

test("pre-activation gate actually writes complete private immutable state and every registered media status with verified manifest", async t => {
  const f = await fixture(t); const before = f.store.snapshot();
  const result = await f.backup(before.websiteReleases[0], before);
  assert.match(result.backupId, /^EDB-[a-f0-9]{32}$/); assert.equal(result.stage, "pre_activation"); assert.equal(result.releaseId, "WRE-001");
  assert.equal(result.assetCount, 3); assert.equal(result.sourceRevision, before.revision); assert.equal(JSON.stringify(result).includes(f.parent), false);
  const directory = backupPath(f, result);
  const manifestBytes = await readFile(join(directory, "manifest.json")); assert.equal(sha(manifestBytes), result.manifestSha256);
  const manifest = JSON.parse(manifestBytes); assert.equal(manifest.candidateSnapshotHash, "a".repeat(64));
  assert.deepEqual(JSON.parse(await readFile(join(directory, "state.json"), "utf8")), before);
  assert.equal(sha(await readFile(join(directory, "state.json"))), result.stateSha256);
  for (const asset of f.uploaded) {
    const path = join(directory, "media-assets", "objects", `${asset.id}.bin`);
    assert.deepEqual(await readFile(path), PNG); assert.equal((await lstat(path)).mode & 0o777, 0o400);
  }
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(join(directory, "state.json"))).mode & 0o777, 0o400);
  assert.equal((await lstat(join(directory, "manifest.json"))).mode & 0o777, 0o400);
  assert.equal((await verifyEditorialBackup({ store: f.store, backupId: result.backupId, expectedManifestSha256: result.manifestSha256 })).filesVerified, 4);
  assert.deepEqual(f.store.snapshot(), before);
});

test("captureCurrent records actual post-verification state separately and preserves earlier immutable pre-activation backup", async t => {
  const f = await fixture(t, { assets: 1 }); const before = f.store.snapshot();
  const pre = await f.backup(before.websiteReleases[0], before);
  await f.store.mutate({ type: "fixture.verified", actor: "test" }, state => {
    state.websiteReleases[0].status = "published";
    state.websiteReleases[0].receipt = { method: "server_readback", snapshotHash: "a".repeat(64), verifiedAt: "2026-10-25T08:00:00.000Z" };
    state.websiteRoutes[0].activeReleaseId = "WRE-001";
  });
  const current = await f.backup.captureCurrent();
  assert.equal(current.stage, "current"); assert.equal(current.releaseId, null); assert.notEqual(current.backupId, pre.backupId);
  assert.equal(JSON.parse(await readFile(join(backupPath(f, pre), "state.json"), "utf8")).websiteReleases[0].status, "approved");
  assert.deepEqual(JSON.parse(await readFile(join(backupPath(f, current), "state.json"), "utf8")), f.store.snapshot());
  assert.notEqual(current.stateSha256, pre.stateSha256);
});

test("full restore writes only a fresh isolated tree with exact state, byte hashes, working media readers and retry journal", async t => {
  const f = await fixture(t); const state = f.store.snapshot(); const result = await f.backup.captureCurrent();
  const targetDirectory = join(f.parent, "isolated-restore");
  const restored = await restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: result.backupId, expectedManifestSha256: result.manifestSha256, targetDirectory });
  assert.equal(restored.restored, true); assert.equal(restored.filesVerified, 4); assert.equal(restored.stateFile, "state.json");
  const store = new JsonStore({ filePath: join(targetDirectory, "state.json"), writerLock: true });
  await store.open(async () => { throw new Error("Restore must never reseed"); });
  assert.deepEqual(store.snapshot(), state); assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  const media = new MediaAssets({ store }); await media.initialize();
  for (const asset of f.uploaded) {
    assert.deepEqual(media.getAsset(asset.id), asset);
    const opened = await media.openVerifiedAsset(asset.id); await opened.handle.close();
    assert.equal((await lstat(join(targetDirectory, "media-assets", "objects", `${asset.id}.bin`))).mode & 0o777, 0o600);
  }
  const revision = store.snapshot().revision;
  const replayed = await media.upload(Readable.from([PNG]), { contentType: "image/png", contentLength: PNG.length, name: "synthetic-0.png" }, ctx("fixture-upload-0"));
  assert.equal(replayed.id, f.uploaded[0].id); assert.equal(store.snapshot().revision, revision);
  assert.deepEqual(f.store.snapshot(), state); await store.close();
});

test("pre-activation requires the exact approved candidate, valid event chain and registered media reader", async t => {
  const f = await fixture(t, { assets: 1 }); const state = f.store.snapshot();
  await rejected(f.backup({ ...state.websiteReleases[0], snapshotHash: "b".repeat(64) }, state), "EDITORIAL_BACKUP_CANDIDATE_MISMATCH");
  await rejected(f.backup({ id: "WRE-missing", snapshotHash: "a".repeat(64) }, state), "EDITORIAL_BACKUP_CANDIDATE_MISMATCH");
  const changed = structuredClone(state); changed.events[0].hash = "bad";
  await rejected(f.backup(changed.websiteReleases[0], changed), "EDITORIAL_BACKUP_INVALID_STATE");
  await rejected(createEditorialBackup({ store: f.store })(state.websiteReleases[0], state), "EDITORIAL_BACKUP_MEDIA_UNAVAILABLE");
  const unknown = structuredClone(state); unknown.mediaAssets.push({ ...unknown.mediaAssets[0], id: "../../secret" });
  await rejected(f.backup(unknown.websiteReleases[0], unknown), "EDITORIAL_BACKUP_INVALID_ASSET");
});

test("empty media state still gets a complete state backup and concurrent captures create separate complete snapshots without events", async t => {
  const f = await fixture(t, { assets: 0 }); const state = f.store.snapshot();
  const backup = createEditorialBackup({ store: f.store });
  const results = await Promise.all([backup(state.websiteReleases[0], state), backup.captureCurrent()]);
  assert.equal(new Set(results.map(row => row.backupId)).size, 2);
  for (const result of results) {
    assert.equal(result.assetCount, 0);
    assert.equal((await verifyEditorialBackup({ store: f.store, backupId: result.backupId, expectedManifestSha256: result.manifestSha256 })).filesVerified, 1);
  }
  assert.deepEqual(f.store.snapshot(), state);
});

test("missing, symlinked or altered source bytes block the gate and do not leave completed or unknown backup files", async t => {
  const f = await fixture(t, { assets: 1 }); const asset = f.uploaded[0]; const state = f.store.snapshot();
  const path = join(f.directory, "media-assets", "objects", `${asset.id}.bin`);
  await chmod(path, 0o600); await writeFile(path, Buffer.alloc(PNG.length));
  await rejected(f.backup(state.websiteReleases[0], state), "MEDIA_BYTES_UNAVAILABLE");
  assert.deepEqual(await readdir(join(f.directory, "backups", "editorial")), []);
  await unlink(path); await symlink(f.store.filePath, path);
  await rejected(f.backup(state.websiteReleases[0], state), "MEDIA_BYTES_UNAVAILABLE");
  assert.deepEqual(await readdir(join(f.directory, "backups", "editorial")), []);
  await unlink(path);
  await rejected(f.backup(state.websiteReleases[0], state), "MEDIA_BYTES_UNAVAILABLE");
  assert.deepEqual(await readdir(join(f.directory, "backups", "editorial")), []);
  assert.deepEqual(f.store.snapshot(), state);
});

test("independent copy hashing rejects a reader that supplies bytes differing from registered metadata", async t => {
  const f = await fixture(t, { assets: 1 }); const state = f.store.snapshot();
  const wrong = join(f.parent, "wrong.bin"); await writeFile(wrong, Buffer.alloc(PNG.length), { mode: 0o600 });
  const backup = createEditorialBackup({ store: f.store, mediaAssets: { async openVerifiedAsset() {
    return { asset: f.uploaded[0], handle: await open(wrong, "r") };
  } } });
  await rejected(backup(state.websiteReleases[0], state), "EDITORIAL_BACKUP_HASH_MISMATCH");
  assert.deepEqual(await readdir(join(f.directory, "backups", "editorial")), []);
});

test("manifest/byte tampering, unknown files and symlinks fail verification and cannot restore", async t => {
  const f = await fixture(t, { assets: 1 });
  let result = await f.backup.captureCurrent(); let directory = backupPath(f, result);
  const assetPath = join(directory, "media-assets", "objects", `${f.uploaded[0].id}.bin`);
  await chmod(assetPath, 0o600); await writeFile(assetPath, Buffer.alloc(PNG.length));
  await rejected(verifyEditorialBackup({ store: f.store, backupId: result.backupId, expectedManifestSha256: result.manifestSha256 }), "EDITORIAL_BACKUP_HASH_MISMATCH");
  await rejected(restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: result.backupId, targetDirectory: join(f.parent, "invalid-restore") }), "EDITORIAL_BACKUP_HASH_MISMATCH");
  await assert.rejects(lstat(join(f.parent, "invalid-restore")), { code: "ENOENT" });
  result = await f.backup.captureCurrent(); directory = backupPath(f, result);
  await writeFile(join(directory, "media-assets", "extra.bin"), "unknown", { mode: 0o600 });
  await rejected(verifyEditorialBackup({ store: f.store, backupId: result.backupId }), "EDITORIAL_BACKUP_UNKNOWN_FILE");
  result = await f.backup.captureCurrent(); directory = backupPath(f, result);
  const manifest = join(directory, "manifest.json"); await chmod(manifest, 0o600); await writeFile(manifest, "{}\n");
  await rejected(verifyEditorialBackup({ store: f.store, backupId: result.backupId, expectedManifestSha256: result.manifestSha256 }), "EDITORIAL_BACKUP_HASH_MISMATCH");
  result = await f.backup.captureCurrent(); directory = backupPath(f, result);
  await unlink(join(directory, "manifest.json")); await symlink(f.store.filePath, join(directory, "manifest.json"));
  await rejected(verifyEditorialBackup({ store: f.store, backupId: result.backupId }), "EDITORIAL_BACKUP_VERIFY_FAILED");
});

test("restore refuses live/subtree/ancestor/existing/symlink targets and preserves existing content", async t => {
  const f = await fixture(t, { assets: 0 }); const result = await f.backup.captureCurrent();
  const restore = targetDirectory => restoreEditorialBackupToIsolatedDirectory({ store: f.store, backupId: result.backupId, expectedManifestSha256: result.manifestSha256, targetDirectory });
  for (const target of [f.directory, join(f.directory, "restore"), f.parent]) await rejected(restore(target), "EDITORIAL_RESTORE_LIVE_TARGET");
  const existing = join(f.parent, "existing"); await mkdir(existing, { mode: 0o700 }); await writeFile(join(existing, "keep.txt"), "preserve");
  await rejected(restore(existing), "EDITORIAL_RESTORE_TARGET_EXISTS", 409); assert.equal(await readFile(join(existing, "keep.txt"), "utf8"), "preserve");
  const linked = join(f.parent, "linked-parent"); await symlink(existing, linked);
  await rejected(restore(join(linked, "new-child")), "EDITORIAL_BACKUP_UNSAFE_PATH");
  assert.deepEqual(await readdir(existing), ["keep.txt"]);
});

test("backups refuse unsafe base directories and forged manifest paths rather than reading arbitrary files", async t => {
  const f = await fixture(t, { assets: 0 }); const result = await f.backup.captureCurrent(); const directory = backupPath(f, result);
  const manifestPath = join(directory, "manifest.json"); const manifest = JSON.parse(await readFile(manifestPath));
  manifest.files[0].path = "../../state.json"; await chmod(manifestPath, 0o600); await writeFile(manifestPath, JSON.stringify(manifest));
  await rejected(verifyEditorialBackup({ store: f.store, backupId: result.backupId }), "EDITORIAL_BACKUP_INVALID_MANIFEST");
  await rejected(verifyEditorialBackup({ store: f.store, backupId: "../../private" }), "EDITORIAL_BACKUP_INVALID_ID");
  await chmod(join(f.directory, "backups"), 0o755);
  await rejected(f.backup.captureCurrent(), "EDITORIAL_BACKUP_UNSAFE_PATH");
});
