import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, writeFile, readFile, symlink, realpath, link, lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { JsonStore } from "../src/storage/json-store.mjs";
import { parseStrictJson } from "../src/domain/strict-json.mjs";
import { ProductionArtifacts, inspectProductionArtifact } from "../src/services/production-artifacts.mjs";
import { createEditorialBackup, verifyEditorialBackup, restoreEditorialBackupToIsolatedDirectory } from "../src/services/editorial-backup.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { editorialFixture, context } from "./editorial-fixtures.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pm-artifact-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(async () => ({ productionArtifacts: [], contentOpsRequests: [] }));
  t.after(() => store.close());
  const artifacts = new ProductionArtifacts({ store, maxArtifactBytes: 1_000_000, maxTotalBytes: 2_000_000 });
  await artifacts.initialize();
  return { directory, store, artifacts };
}
function upload(artifacts, bytes, extra = {}) {
  return artifacts.stage(Readable.from([bytes]), { artifactId: `ART-${"a".repeat(32)}`, mime: "text/markdown", size: bytes.length,
    sha256: sha(bytes), role: "text", name: "稿件.md", ...extra }, { taskId: "TASK-1", attemptId: "ATT-1", outputSpec: [{ role: "text", mime: "text/markdown", maxBytes: 100_000 }] });
}
test("strict JSON rejects ambiguous bytes and dangerous keys before hashing", () => {
  for (const [source, code] of [['{"x":1,"x":2}', "DUPLICATE_JSON_KEY"], ['{"\\u0078":1,"x":2}', "DUPLICATE_JSON_KEY"], ['{"__proto__":{}}', "UNSAFE_JSON_KEY"], ['{"x":1e999}', "INVALID_JSON_NUMBER"], ['{"x":"\\ud800"}', "INVALID_JSON_STRING"]]) {
    assert.throws(() => parseStrictJson(source), { code });
  }
  assert.deepEqual(parseStrictJson('{"中文":["🌿",null,true,-1.5e2]}'), { 中文: ["🌿", null, true, -150] });
  assert.throws(() => parseStrictJson(Buffer.from([0xff])), { code: "INVALID_JSON" });
  assert.throws(() => parseStrictJson('[[]]', { maxDepth: 0 }), { code: "JSON_TOO_DEEP" });
  assert.throws(() => parseStrictJson('"超限"', { maxBytes: 3 }), { code: "PLAN_TOO_LARGE" });
  assert.throws(() => parseStrictJson('[1,2]', { maxArray: 1 }), { code: "JSON_ARRAY_TOO_LARGE" });
});
test("native validators preserve static notebook code and reject active outputs", () => {
  const book = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", metadata: {}, source: ['print("hello")'], execution_count: null, outputs: [] }] };
  assert.deepEqual(inspectProductionArtifact(Buffer.from(JSON.stringify(book)), "application/x-ipynb+json"), { kind: "notebook", cells: 1, codeCells: 1, markdownCells: 0, executeCode: false, executionVerified: false });
  book.cells[0].outputs = [{ output_type: "display_data", data: { "text/html": "<script>throw 1</script>" } }];
  assert.throws(() => inspectProductionArtifact(Buffer.from(JSON.stringify(book)), "application/x-ipynb+json"), { code: "NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED" });
  assert.throws(() => inspectProductionArtifact(Buffer.from("%PDF-1.4\n/OpenAction 1\n%%EOF"), "application/pdf"), { code: "PDF_INVALID" });
  assert.throws(() => inspectProductionArtifact(Buffer.from("binary"), "application/octet-stream"), { code: "NATIVE_ARTIFACT_TYPE_UNSUPPORTED" });
});

function classicPdf(objects) {
  const pieces = [Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1")], offsets = [0]; let size = pieces[0].length;
  for (const [index, body] of objects.entries()) {
    offsets.push(size); const bytes = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from("\nendobj\n")]);
    pieces.push(bytes); size += bytes.length;
  }
  pieces.push(Buffer.from(`xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(pieces);
}
function rgbPdf({ pixels = Buffer.from("#ff"), rootExtra = "", lengthDelta = 0, duplicateLength = false, indirectLength = false, imageExtra = "" } = {}) {
  const encoded = deflateSync(pixels, { level: 0 }), paint = Buffer.from("q\n100 0 0 100 0 0 cm\n/Im0 Do\nQ\n");
  return classicPdf([
    `<< /Type /Catalog /Pages 2 0 R ${rootExtra} >>`,
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${indirectLength ? "6 0 R" : encoded.length + lengthDelta}${duplicateLength ? ` /Length ${encoded.length}` : ""} ${imageExtra} >>\nstream\n`), encoded, Buffer.from("\nendstream")]),
    Buffer.concat([Buffer.from(`<< /Length ${paint.length} >>\nstream\n`), paint, Buffer.from("\nendstream")]),
  ]);
}
test("passive PDF checks exact indexed objects while treating bounded image streams as binary bytes", () => {
  const binary = rgbPdf(); assert.ok(binary.includes(Buffer.from("#ff")));
  assert.deepEqual(inspectProductionArtifact(binary, "application/pdf"), { kind: "document", pages: 1, passiveSubset: true, previewMode: "attachment" });
  // These three characters are RGB pixel bytes, never a PDF action dictionary.
  assert.equal(inspectProductionArtifact(rgbPdf({ pixels: Buffer.from("/JS") }), "application/pdf").pages, 1);
  for (const options of [{ rootExtra: "/OpenAction null" }, { rootExtra: "/J#53 null" }, { imageExtra: "/F (external-file)" }]) {
    assert.throws(() => inspectProductionArtifact(rgbPdf(options), "application/pdf"), { code: "PDF_ACTIVE_CONTENT_UNSUPPORTED" });
  }
  // The separator EOL may itself be included in the declared stream extent.
  assert.equal(inspectProductionArtifact(rgbPdf({ lengthDelta: 1 }), "application/pdf").pages, 1);
  for (const options of [{ lengthDelta: 2 }, { lengthDelta: -1 }, { lengthDelta: 1000 }, { duplicateLength: true }, { indirectLength: true }]) {
    assert.throws(() => inspectProductionArtifact(rgbPdf(options), "application/pdf"), { code: "PDF_INVALID" });
  }
  const badXref = Buffer.from(binary), xref = badXref.indexOf(Buffer.from("xref\n"));
  const firstObject = badXref.indexOf(Buffer.from("00000 n"), xref) - 11;
  badXref.write("9999999999", firstObject, "ascii");
  assert.throws(() => inspectProductionArtifact(badXref, "application/pdf"), { code: "PDF_INVALID" });
});
test("actual artifact bytes remain private, exact, recoverable and independently reviewed", async t => {
  const { store, artifacts } = await fixture(t), bytes = Buffer.from("# 独立稿件\n\n完整正文，含 emoji 🌿。\n");
  const staged = await upload(artifacts, bytes);
  await assert.rejects(artifacts.openVerifiedArtifact(staged.id), { code: "ARTIFACT_NOT_FOUND" });
  const replay = await upload(artifacts, bytes);
  assert.equal(replay.sha256, staged.sha256);
  await store.mutate({ type: "test.artifact_commit", actor: "test" }, state => state.productionArtifacts.push({ ...staged, committed: true, commitStatus: "committed", status: "committed" }));
  const opened = await artifacts.openVerifiedArtifact(staged.id);
  assert.deepEqual(await opened.handle.readFile(), bytes); await opened.handle.close();
  assert.equal((await artifacts.preview(staged.id)).text, bytes.toString());
  const input = { sha256: staged.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true, note: "隔离测试自产文字，不包含客户资料。" };
  await assert.rejects(artifacts.review(staged.id, input, { actor: "worker", method: "worker", idempotencyKey: "review-001" }), { code: "ARTIFACT_ADMIN_REQUIRED" });
  await assert.rejects(artifacts.review(staged.id, input, { actor: "owner", method: "local", idempotencyKey: "review-001" }), { code: "PRECONDITION_REQUIRED" });
  const ctx = { actor: "owner", method: "local", idempotencyKey: "review-001", ifMatch: artifacts.getArtifact(staged.id).etag };
  const reviewed = await artifacts.review(staged.id, input, ctx);
  assert.equal(reviewed.status, "reviewed"); assert.match(reviewed.rightsReviewHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(await artifacts.review(staged.id, input, ctx), reviewed);
  await assert.rejects(artifacts.review(staged.id, { ...input, note: "不同说明" }, ctx), { code: "IDEMPOTENCY_CONFLICT" });
});
test("upload rejects changed content, size, scope, file tampering and symlink storage", async t => {
  const { directory, store, artifacts } = await fixture(t), bytes = Buffer.from("original content");
  await assert.rejects(upload(artifacts, bytes, { sha256: "0".repeat(64) }), { code: "ARTIFACT_HASH_MISMATCH" });
  await assert.rejects(upload(artifacts, bytes, { size: bytes.length - 1 }), { code: "ARTIFACT_TOO_LARGE" });
  await assert.rejects(upload(artifacts, bytes, { role: "video" }), { code: "ARTIFACT_OUTPUT_SCOPE_DENIED" });
  const staged = await upload(artifacts, bytes);
  await assert.rejects(upload(artifacts, Buffer.from("changed content!")), { code: "ARTIFACT_RECOVERY_CONFLICT" });
  await store.mutate({ type: "test.commit" }, state => state.productionArtifacts.push({ ...staged, committed: true, commitStatus: "committed" }));
  const path = join(artifacts.objects, `${staged.id}.bin`); await chmod(path, 0o600); await writeFile(path, "corrupt content");
  await assert.rejects(artifacts.openVerifiedArtifact(staged.id), { code: "ARTIFACT_BYTES_UNAVAILABLE" });
  await symlink(join(directory, "state.json"), join(artifacts.objects, "link.bin"));
  await assert.rejects(upload(artifacts, bytes, { artifactId: `ART-${"b".repeat(32)}` }), { code: "ARTIFACT_UNSAFE_STORAGE" });
});
test("full backup and isolated restore retain exact native files, quarantine and unknown reservations", async t => {
  const { directory, store, artifacts } = await fixture(t), bytes = Buffer.from("# Complete native source\n\nStatic artifact, never executed.\n");
  const staged = await upload(artifacts, bytes);
  await store.mutate({ type: "test.quarantined_artifact" }, state => {
    state.productionArtifacts.push({ ...staged, committed: false, commitStatus: "quarantined", status: "quarantined" });
    state.modelBudgetReservations = [{ id: "RES-test", attemptId: "ATT-1", status: "unknown_usage", actualCostMicros: null, reservedCostMicros: 7000 }];
  });
  const before = store.snapshot();
  await assert.rejects(createEditorialBackup({ store }).captureCurrent(), { code: "EDITORIAL_BACKUP_ARTIFACTS_UNAVAILABLE" });
  const receipt = await createEditorialBackup({ store, productionArtifacts: artifacts }).captureCurrent();
  assert.equal(receipt.schema, "pengmanager.editorial-backup/v2"); assert.equal(receipt.artifactCount, 1); assert.equal(receipt.assetCount, 0);
  assert.equal((await verifyEditorialBackup({ store, backupId: receipt.backupId, expectedManifestSha256: receipt.manifestSha256 })).filesVerified, 2);
  const isolated = `${directory}-isolated`; t.after(() => rm(isolated, { recursive: true, force: true }));
  await restoreEditorialBackupToIsolatedDirectory({ store, backupId: receipt.backupId, expectedManifestSha256: receipt.manifestSha256, targetDirectory: isolated });
  assert.deepEqual(JSON.parse(await readFile(join(isolated, "state.json"), "utf8")), before);
  assert.deepEqual(await readFile(join(isolated, "worker-artifacts", "objects", `${staged.id}.bin`)), bytes);
  assert.deepEqual(store.snapshot(), before);
});
test("the explicit media bridge uploads exact bytes once and never silently approves their rights", async t => {
  const { store, artifacts } = await fixture(t), mediaAssets = new MediaAssets({ store }); await mediaAssets.initialize();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGNgYPhLIhrVMKph2GoAAISu/QH+5zsIAAAAAElFTkSuQmCC", "base64");
  const staged = await artifacts.stage(Readable.from([bytes]), { mime: "image/png", size: bytes.length, sha256: sha(bytes), role: "image", name: "隔离测试图.png" },
    { taskId: "TASK-image", attemptId: "ATT-image", outputSpec: [{ role: "image", allowedMimes: ["image/png"], maxBytes: 1_000_000 }] });
  await store.mutate({ type: "fixture.image_committed" }, state => state.productionArtifacts.push({ ...staged, committed: true, commitStatus: "committed" }));
  const ctx = { actor: "isolated owner", method: "local", idempotencyKey: "bridge-media-001", ifMatch: artifacts.getArtifact(staged.id).etag };
  const imported = await artifacts.importMedia(staged.id, { sha256: staged.sha256 }, ctx, mediaAssets);
  assert.equal(imported.status, "staged"); assert.equal(imported.sha256, staged.sha256);
  assert.equal(mediaAssets.getAsset(imported.id).review, undefined); assert.equal(artifacts.getArtifact(staged.id).mediaAssetId, imported.id);
  const revision = store.snapshot().revision;
  assert.deepEqual(await artifacts.importMedia(staged.id, { sha256: staged.sha256 }, ctx, mediaAssets), imported);
  assert.equal(store.snapshot().revision, revision); assert.equal(store.snapshot().mediaAssets.length, 1);
  const opened = await mediaAssets.openVerifiedAsset(imported.id); assert.deepEqual(await opened.handle.readFile(), bytes); await opened.handle.close();
  const newKey = { ...ctx, idempotencyKey: "bridge-media-002", ifMatch: artifacts.getArtifact(staged.id).etag };
  assert.equal((await artifacts.importMedia(staged.id, { sha256: staged.sha256 }, newKey, mediaAssets)).id, imported.id);
  assert.equal(store.snapshot().mediaAssets.length, 1);
});
test("orphan recovery at full quota needs no duplicate staging allocation and incomplete bodies never commit", async t => {
  const { store, artifacts } = await fixture(t), bytes = Buffer.from("recoverable output");
  const tight = new ProductionArtifacts({ store, maxArtifactBytes: bytes.length, maxTotalBytes: bytes.length }); await tight.initialize();
  const original = await upload(tight, bytes); assert.equal((await upload(tight, bytes)).sha256, original.sha256);
  assert.equal(store.snapshot().productionArtifacts.length, 0);
  const broken = new ProductionArtifacts({ store, maxArtifactBytes: 1_000_000, maxTotalBytes: 2_000_000 }); await broken.initialize();
  await assert.rejects(broken.stage(Readable.from([Buffer.from("partial")]), { artifactId: `ART-${"c".repeat(32)}`, mime: "text/markdown", size: bytes.length,
    sha256: sha(bytes), role: "text", name: "partial.md" }, { taskId: "TASK-broken", attemptId: "ATT-broken", outputSpec: [{ role: "text", mime: "text/markdown", maxBytes: 1_000_000 }] }), { code: "ARTIFACT_HASH_MISMATCH" });
  assert.equal(store.snapshot().productionArtifacts.length, 0);
});

test("publication interrupted after the exclusive link recovers only its exact controlled staging duplicate", async t => {
  const { directory, artifacts } = await fixture(t), bytes = Buffer.from("recover a durable object without replacing bytes");
  const original = await upload(artifacts, bytes), target = join(artifacts.objects, `${original.id}.bin`);
  const duplicate = join(artifacts.staging, `${"f".repeat(32)}.upload`);
  await link(target, duplicate); assert.equal((await lstat(target)).nlink, 2);
  const replay = await upload(artifacts, bytes);
  assert.equal(replay.sha256, original.sha256); assert.equal((await lstat(target)).nlink, 1);
  assert.deepEqual(await readdir(artifacts.staging), []); assert.deepEqual(await readFile(target), bytes);
  await link(target, duplicate);
  await assert.rejects(upload(artifacts, Buffer.alloc(bytes.length, 65)), { code: "ARTIFACT_RECOVERY_CONFLICT" });
  assert.equal((await lstat(target)).nlink, 2); assert.deepEqual(await readFile(duplicate), bytes);
  // A third link or a link outside the controlled staging namespace is retained.
  await link(target, join(directory, "unknown-link"));
  await assert.rejects(upload(artifacts, bytes), { code: "ARTIFACT_RECOVERY_CONFLICT" });
  assert.equal((await lstat(target)).nlink, 3);
});

function tensorFile(header, data = Buffer.alloc(8), rawHeader) {
  const payload = Buffer.from(rawHeader ?? JSON.stringify(header)), length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(payload.length)); return Buffer.concat([length, payload, data]);
}
test("passive Safetensors validates exact nonempty tensor bytes without loading models", () => {
  const header = { __metadata__: { origin: "isolated tiny tensor fixture" }, weights: { dtype: "F32", shape: [2], data_offsets: [0, 8] } };
  const valid = inspectProductionArtifact(tensorFile(header), "application/x-safetensors");
  assert.equal(valid.tensorCount, 1); assert.equal(valid.elements, 2); assert.equal(valid.loaded, false);
  assert.equal(valid.inferenceVerified, false); assert.equal(valid.trainingVerified, false);
  for (const [mutate, code] of [
    [row => { row.weights.dtype = "BF16"; }, "SAFETENSORS_DTYPE_UNSUPPORTED"],
    [row => { row.weights.shape = [3]; }, "SAFETENSORS_INVALID"],
    [row => { row.weights.shape = [-1]; }, "SAFETENSORS_INVALID"],
    [row => { row.weights.data_offsets = [1, 9]; }, "SAFETENSORS_INVALID"],
    [row => { row.weights.data_offsets = [4, 12]; }, "SAFETENSORS_INVALID"],
    [row => { row.weights.extra = true; }, "SAFETENSORS_DTYPE_UNSUPPORTED"],
    [row => { row.__metadata__.origin = 1; }, "SAFETENSORS_INVALID"],
  ]) {
    const invalid = structuredClone(header); mutate(invalid);
    assert.throws(() => inspectProductionArtifact(tensorFile(invalid), "application/x-safetensors"), { code });
  }
  assert.throws(() => inspectProductionArtifact(tensorFile({}, Buffer.alloc(0)), "application/x-safetensors"), { code: "MODEL_WEIGHTS_EMPTY" });
  assert.throws(() => inspectProductionArtifact(tensorFile(header, Buffer.alloc(9)), "application/x-safetensors"), { code: "SAFETENSORS_INVALID" });
  assert.throws(() => inspectProductionArtifact(tensorFile(header, Buffer.alloc(8), '{"weights":{},"weights":{}}'), "application/x-safetensors"), { code: "DUPLICATE_JSON_KEY" });
  assert.throws(() => inspectProductionArtifact(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7b, 0x7d]), "application/x-safetensors"), { code: "SAFETENSORS_INVALID" });
  const overlap = { a: { dtype: "U8", shape: [4], data_offsets: [0, 4] }, b: { dtype: "U8", shape: [4], data_offsets: [2, 6] } };
  assert.throws(() => inspectProductionArtifact(tensorFile(overlap, Buffer.alloc(6)), "application/x-safetensors"), { code: "SAFETENSORS_INVALID" });
  const scalar = { a: { dtype: "U8", shape: [], data_offsets: [0, 1] } };
  assert.equal(inspectProductionArtifact(tensorFile(scalar, Buffer.alloc(1)), "application/x-safetensors").elements, 1);
  const invalidBook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", source: "print(1)", outputs: {} }] };
  assert.throws(() => inspectProductionArtifact(Buffer.from(JSON.stringify(invalidBook)), "application/x-ipynb+json"), { code: "NOTEBOOK_INVALID" });
});

test("administrator source files bootstrap real plans with exact bytes, explicit origin, rights review and strict replay", async t => {
  const f = await editorialFixture(t), artifacts = new ProductionArtifacts({ store: f.store }); await artifacts.initialize();
  const story = await f.service.createStory({ workingTitle: "真实源文件引导测试", claimIds: ["C003"] }, context());
  const bytes = Buffer.from("# 实际测试源材料\n完整原文保留。\n"), metadata = { storyId: story.id, role: "transcript", mime: "text/markdown", size: bytes.length, sha256: sha(bytes), name: "原始文稿.md" };
  const ctx = context(f.service.getStory(story.id), "source-upload-001");
  const send = (input = metadata, principal = ctx, body = bytes) => artifacts.uploadSource(Readable.from([body]), input, principal);
  await assert.rejects(send(metadata, { ...ctx, method: "worker" }), { code: "ARTIFACT_ADMIN_REQUIRED" });
  await assert.rejects(send(metadata, { ...ctx, ifMatch: undefined }), { code: "PRECONDITION_REQUIRED" });
  await assert.rejects(send({ ...metadata, role: "model_weights" }), { code: "SOURCE_ARTIFACT_ROLE_MISMATCH" });
  await assert.rejects(send({ ...metadata, role: "__proto__" }), { code: "SOURCE_ARTIFACT_ROLE_MISMATCH" });
  const uploaded = await send();
  assert.equal(uploaded.origin, "administrator_upload"); assert.equal(uploaded.storyId, story.id);
  assert.equal(uploaded.taskId, null); assert.equal(uploaded.attemptId, null); assert.equal(uploaded.review, null);
  assert.equal(uploaded.status, "committed"); assert.equal(artifacts.listSourceArtifacts().items.length, 1);
  const revision = f.store.snapshot().revision;
  assert.deepEqual(await send(metadata, { ...ctx, ifMatch: '"stale"' }), uploaded);
  assert.equal(f.store.snapshot().revision, revision);
  await assert.rejects(send(metadata, ctx, Buffer.alloc(bytes.length, 65)), { code: "ARTIFACT_HASH_MISMATCH" });
  await assert.rejects(send({ ...metadata, name: "changed.md" }), { code: "IDEMPOTENCY_CONFLICT" });
  const reviewed = await artifacts.review(uploaded.id, { sha256: uploaded.sha256, rightsConfirmed: true, privacyConfirmed: true,
    licenseConfirmed: true, note: "临时隔离测试原创资料，仅用于验证源文件与审核链。" }, context(artifacts.getArtifact(uploaded.id)));
  assert.equal(reviewed.status, "reviewed");
  await artifacts.verifyReferences([{ id: reviewed.id, sha256: reviewed.sha256, bytes: reviewed.size, mime: reviewed.mime,
    rightsReviewHash: reviewed.rightsReviewHash, privacyReviewHash: reviewed.privacyReviewHash }]);
  assert.equal((await artifacts.preview(uploaded.id)).text, bytes.toString());
});

test("source upload checks the story again after file IO and recovers the original bytes without inventing a task", async t => {
  const f = await editorialFixture(t), artifacts = new ProductionArtifacts({ store: f.store }); await artifacts.initialize();
  const story = await f.service.createStory({ workingTitle: "上传时变化的真实选题", claimIds: ["C003"] }, context());
  const bytes = Buffer.from("source bytes during a parent update"), metadata = { storyId: story.id, role: "transcript", mime: "text/plain", size: bytes.length, sha256: sha(bytes), name: "source.txt" };
  const ctx = context(f.service.getStory(story.id), "source-upload-race-001");
  const stream = Readable.from((async function* () {
    await f.store.mutate({ type: "fixture.story_changed" }, state => { state.stories.find(row => row.id === story.id).workingTitle = "上传期间已经修改"; });
    yield bytes;
  })());
  await assert.rejects(artifacts.uploadSource(stream, metadata, ctx), { code: "PRECONDITION_FAILED" });
  assert.equal(artifacts.listSourceArtifacts().items.length, 0);
  const recovered = await artifacts.uploadSource(Readable.from([bytes]), metadata, { ...ctx, ifMatch: f.service.getStory(story.id).etag });
  assert.equal(recovered.storyId, story.id); assert.equal(recovered.taskId, null);
  assert.equal(artifacts.listSourceArtifacts().items.length, 1);
  assert.equal((await readdir(artifacts.objects)).length, 1);
});
