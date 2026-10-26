import test from "node:test";
import assert from "node:assert/strict";
import { buildOperationReceipt, buildReconciliationInput, buildOperationApproval, operationArtifactReferences, operationMediaReferences, renderOperations } from "../public/operations.js";
import { buildEditorialVariantTransition, mountEditorialWorkbench } from "../public/editorial-workbench.js";
import { EDITORIAL_NATIVE_SCHEMA, loadNativePackageReview, renderNativePackageReview, nativeReviewConfirmationFields, createContentOpsRequester, renderBudgetLedger, renderNativeCandidate, renderHumanQualityReview, buildHumanQualityReview, buildUsageReconciliation, nativeTextReviewKeys, buildWorkerLocalTemplates, buildArtifactMediaImport, renderArtifactPreview } from "../public/content-ops.js";
import { contentOpsFixture, createOpsJob, finishTextOpsJob, uploadOpsSource, opsContext, OPS_NOW } from "./content-ops-fixtures.mjs";
import { context } from "./editorial-fixtures.mjs";
import { AccountOperationsService } from "../src/services/account-operations.mjs";
import { localGrantHash, validateLocalGrant } from "../src/content-ops-worker/worker.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { qualityTextKeys } from "../src/domain/content-ops-coverage.mjs";

// Isolated contract/UI fixtures. They are not a rights approval or platform receipt.
const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64), d = "d".repeat(64);
const image = `ART-${"1".repeat(32)}`, notebook = `ART-${"2".repeat(32)}`, media = `MED-${"3".repeat(32)}`;
const source = { id: "ED-fixture", editorialRevision: 1, snapshotHash: d, title: "准确母版", body: "母版第一行\n母版完整尾部" };
const artifacts = [
  { id: image, role: "image", mime: "image/png", bytes: 50, size: 50, sha256: a, status: "reviewed", rightsReviewHash: b, privacyReviewHash: c, etag: '"image"' },
  { id: notebook, role: "notebook", mime: "application/x-ipynb+json", bytes: 100, size: 100, sha256: b, status: "reviewed", rightsReviewHash: b, privacyReviewHash: c, etag: '"notebook"', inspection: { preview: "cell source <script>literal</script>", executeCode: false } },
];
const pkg = { schema: "pengmanager.publication-package/v3", candidateId: "CAND-fixture", targetKey: "fixture-target", storyId: "STY-fixture", platformId: "kaggle", locale: "en-US", editorialFormat: "article", nativeForm: "notebook", title: "Exact native title", summary: "Exact introduction", body: "Complete original native text\nThe actual final tail <img onerror=bad>", orderedBlocks: [{ type: "paragraph", text: "Exact structured text" }], orderedMediaRefs: [{ assetId: media, sha256: c, role: "image", alt: "Actual ordered media", caption: "An actual caption" }], nativeManifest: { kind: "notebook", settings: { executeCode: false, inputDatasetRefs: [] }, files: [{ artifactId: notebook, sha256: b }, { artifactId: image, sha256: a }], note: "<script>cannot execute</script>" }, sourceEditionRefs: [{ id: source.id, revision: 1, sha256: d }], artifactRefs: artifacts.map(({ id, role, mime, bytes, sha256, rightsReviewHash, privacyReviewHash }) => ({ id, role, mime, bytes, sha256, rightsReviewHash, privacyReviewHash })), packageHash: a };
const quality = { id: "QC-fixture", candidateId: "CAND-fixture", status: "passed", checkedPackageHash: a, reportHash: c, checkerVersion: "pengmanager.independent-checker/v1", checkContextHash: d, dimensions: { deterministic: "passed", semantic: "passed", media: "passed", artistic: "passed" }, coverage: { textKeys: ["title", "summary", "body", "block:0"], artifactHashes: [a, b] }, semanticFindings: [], mediaEvidence: [{ artifactId: notebook, sha256: b, method: "human_full_read", coverage: "full", note: "Fixture inspected all cells" }] };
const candidate = { id: "CAND-fixture", etag: '"candidate"', package: pkg, packageHash: a, status: "ready_for_review", qualityReportHashes: [c], reviewEnvelope: { schema: "pengmanager.review-envelope/v1", packageHash: a, qualityReportHashes: [c], checkContextHash: d }, reviewSnapshotHash: b, reports: [quality] };
const variant = (extra = {}) => ({ id: "CNT-fixture", storyId: "STY-fixture", editionId: source.id, status: "fact_check", snapshotSchema: EDITORIAL_NATIVE_SCHEMA, snapshotHash: c, candidateId: candidate.id, publicationPackage: pkg, packageHash: a, qualityReportHashes: [c], reviewEnvelope: candidate.reviewEnvelope, reviewSnapshotHash: b, ...extra });
const operation = (extra = {}) => ({ id: "OP-fixture", type: "publish", status: "in_progress", accountId: "actual-account", platform: "Kaggle", executionMode: "browser", snapshotSchema: EDITORIAL_NATIVE_SCHEMA, editorialSnapshotHash: c, contentHash: d, packageHash: a, reviewSnapshotHash: b, editorialSnapshot: { ...variant(), assetRefs: pkg.orderedMediaRefs }, contentSnapshot: { title: pkg.title, body: pkg.body }, accountSnapshot: { id: "actual-account", platform: "Kaggle", handle: "actual-original", profileUrl: "https://www.kaggle.com/actual-original" }, approval: { authorizationNote: "Fixture exact authorization", editorialSnapshotHash: c, packageHash: a, reviewSnapshotHash: b }, execution: { actor: "Fixture executor", startedAt: "2026-10-26T00:00:00.000Z" }, etag: '"operation"', ...extra });
const fields = (extra = {}) => ({ contentConfirmed: "on", nativePackageConfirmed: "on", [`assetConfirmed-${media}`]: c, [`artifactConfirmed-${image}`]: a, [`artifactConfirmed-${notebook}`]: b, url: "https://www.kaggle.com/code/actual-original/actual-result", publishedAt: "2026-10-26T08:00", verifiedAt: "2026-10-26T08:01", capturedBy: "Fixture actual collector", verifiedBy: "Fixture actual verifier", dataMode: "imported", verificationMethod: "browser_readback", ...extra });

test("v3 receipt carries exact editorial, package, review, MED and all native ART hashes", () => {
  const receipt = buildOperationReceipt(operation(), fields());
  assert.equal(receipt.editorialSnapshotHash, c);
  assert.equal(receipt.packageHash, a);
  assert.equal(receipt.reviewSnapshotHash, b);
  assert.deepEqual(receipt.assetHashes, [{ assetId: media, sha256: c }]);
  assert.deepEqual(receipt.artifactHashes, [{ artifactId: image, sha256: a }, { artifactId: notebook, sha256: b }]);
  assert.equal(operationMediaReferences(operation()).length, 1);
  assert.equal(operationArtifactReferences(operation()).length, 2);
  assert.equal(receipt.snapshotSchema, undefined);
  assert.equal(receipt.nativePackageConfirmed, undefined);
  assert.equal(receipt.publishedAt, "2026-10-26T00:00:00.000Z");
});

test("v3 receipt rejects missing exact attachment confirmation and mixed package/review versions", () => {
  for (const missing of ["nativePackageConfirmed", `artifactConfirmed-${image}`, `artifactConfirmed-${notebook}`, `assetConfirmed-${media}`]) assert.throws(() => buildOperationReceipt(operation(), fields({ [missing]: "" })));
  assert.throws(() => buildOperationReceipt(operation(), fields({ [`artifactConfirmed-${notebook}`]: a })), /准确原生附件/);
  assert.throws(() => buildOperationReceipt(operation({ packageHash: c }), fields()), /原完整原生包/);
  assert.throws(() => buildOperationReceipt(operation({ reviewSnapshotHash: c }), fields()), /原完整原生包/);
  assert.throws(() => buildOperationReceipt(operation({ snapshotSchema: "future-unknown" }), fields()), /原完整编辑快照/);
});

test("v3 reconciliation binds the original editorial hash and never changes the original result fields", () => {
  const input = buildReconciliationInput(operation(), fields({ approvedSnapshotHash: c, accountConfirmed: "on", reason: "The original account changed after the actual result, so reconcile its original approval." }));
  assert.equal(input.approvedSnapshotHash, c);
  assert.equal(input.receipt.packageHash, a);
  assert.equal(input.receipt.reviewSnapshotHash, b);
  assert.equal(input.receipt.verifiedAt, "2026-10-26T00:01:00.000Z");
  assert.throws(() => buildReconciliationInput(operation(), fields({ approvedSnapshotHash: d, accountConfirmed: "on", reason: "Actual reason" })), /原获准快照/);
});

test("v3 editorial approval requires real native preview and exact per-file confirmations; v2 stays unchanged", () => {
  const confirmations = { target: "approved", note: "Fixture full actual review", reviewed: "on", nativePackageConfirmed: "on", [`nativeArtifactConfirmed-${image}`]: a, [`nativeArtifactConfirmed-${notebook}`]: b };
  assert.throws(() => buildEditorialVariantTransition(variant(), confirmations), /先读取并核对/);
  const input = buildEditorialVariantTransition(variant(), confirmations, { nativeReviewReady: true });
  assert.deepEqual(input, { target: "approved", note: confirmations.note, reviewed: true, snapshotHash: c, reviewSnapshotHash: b });
  assert.throws(() => buildEditorialVariantTransition(variant(), { ...confirmations, [`nativeArtifactConfirmed-${notebook}`]: "" }, { nativeReviewReady: true }), /准确原生附件/);
  const v2 = buildEditorialVariantTransition(variant({ snapshotSchema: "pengmanager.editorial-snapshot/v2" }), { target: "approved", note: "Exact v2", reviewed: "on" });
  assert.deepEqual(v2, { target: "approved", note: "Exact v2", reviewed: true, snapshotHash: c });
});

test("v3 one-time operation authorization requires original whole-package reading without leaking confirmations", () => {
  const input = { approvedBy: "Fixture actual approver", authorizationNote: "Actual one-time scope", nativePackageConfirmed: "on", [`nativeArtifactConfirmed-${image}`]: a, [`nativeArtifactConfirmed-${notebook}`]: b };
  assert.throws(() => buildOperationApproval(operation(), input), /先读取原完整原生包/);
  assert.deepEqual(buildOperationApproval(operation(), input, { nativeReviewReady: true }), { approvedBy: input.approvedBy, authorizationNote: input.authorizationNote });
});

test("v3 operation displays original ordered native files, actual media and final report coverage", () => {
  const review = { candidate, artifacts, reports: [quality], source, ready: true };
  const output = renderOperations([operation()], { nativeReviews: new Map([[`OP-fixture:${c}`, review]]) });
  assert.match(output, /完整原生包、有序附件、设置与独立终检/);
  assert.match(output, /The actual final tail &lt;img onerror=bad&gt;/);
  assert.match(output, /executeCode/);
  assert.match(output, /human_full_read/);
  for (const name of ["确定性合同", "语义与事实", "实际媒体内容", "表达与艺术"]) assert.ok(output.includes(name));
  assert.match(output, new RegExp(`src="/api/content-ops/artifacts/${image}/bytes"`));
  assert.match(output, new RegExp(`name="artifactConfirmed-${notebook}" value="b{64}" required`));
  assert.match(output, /cell source &lt;script&gt;literal&lt;\/script&gt;/);
  assert.doesNotMatch(output, /<script>|<iframe|checkbox[^>]*checked/);
  const untouched = nativeReviewConfirmationFields(variant());
  assert.doesNotMatch(untouched, /\bchecked\b/);
});

test("native review loader reads only exact referenced candidate/files/source and refuses changed bytes", async () => {
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path.includes("/candidates/")) return candidate;
    if (path === `/api/editions/${source.id}`) return source;
    return artifacts.find(row => path.endsWith(row.id));
  };
  const review = await loadNativePackageReview(api, variant());
  assert.equal(review.ready, true);
  assert.equal(calls.length, 4);
  assert.equal(review.artifacts.length, 2);
  const changed = await loadNativePackageReview(async path => path.endsWith(notebook) ? { ...artifacts[1], sha256: d } : api(path), variant());
  assert.equal(changed.ready, false);
  assert.match(changed.artifacts[1].previewError, /与原获准引用不同/);
  await assert.rejects(loadNativePackageReview(async () => ({ ...candidate, packageHash: c }), variant()), /不能替换原授权/);
  const sourceChanged = await loadNativePackageReview(async path => path.includes("/editions/") ? { ...source, snapshotHash: a } : api(path), variant());
  assert.equal(sourceChanged.ready, false);
  assert.match(sourceChanged.sourceError, /母版引用不同/);
});

test("binary source retry preserves the actual bytes, MIME, Story ETag and original idempotency key", async () => {
  const calls = [];
  let keys = 0;
  const send = createContentOpsRequester({ createKey: () => `fixture-key-${++keys}`, api: async (path, options) => { calls.push({ path, options }); if (calls.length === 1) throw new TypeError("lost upload response"); return { id: image }; } });
  const body = new Blob(["actual fixture source bytes"], { type: "text/plain" });
  const headers = { "Content-Type": "text/plain", "X-Story-Id": "STY-fixture", "X-Artifact-Role": "transcript", "X-Content-Size": String(body.size), "X-Content-SHA256": a };
  await assert.rejects(send("/api/content-ops/source-artifacts", body, { bytes: true, headers, needsEtag: true, etag: '"original-story"' }));
  await send("/api/content-ops/source-artifacts", body, { bytes: true, headers, needsEtag: true, etag: '"new-story"' });
  assert.equal(calls[0].options.body, body);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[1].options.headers["Content-Type"], "text/plain");
  assert.equal(calls[1].options.headers["If-Match"], '"original-story"');
  assert.equal(keys, 1);
});

test("actual backend nested budget fields retain monetary unknowns and known token settlements", () => {
  const output = renderBudgetLedger({ budgetAuthorization: { currency: "CNY", maxCostMicros: 1_000_000 }, budgetTotals: { used: { costMicros: 0 }, reserved: { costMicros: 250_000 }, unknown: { count: 1, costMicros: 250_000 } }, reservations: [{ id: "RES-fixture", status: "partially_settled", currency: "CNY", reserved: { inputTokens: 200, outputTokens: 100, costMicros: 250_000 }, actual: { inputTokens: 123, outputTokens: 45, costMicros: null } }] });
  assert.match(output, /123 \/ 45/);
  assert.match(output, /0\.25 CNY/);
  assert.match(output, /未知 \/ 未配置/);
});

test("v3 editorial renderer keeps whole native package visible and disables approval until independent data loaded", async () => {
  const events = new Map();
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, addEventListener(name, listener) { events.set(name, listener); } };
  const previous = globalThis.document;
  globalThis.document = { querySelector: () => root };
  try {
    const data = { catalog: { platforms: [] }, stories: [{ id: "STY-fixture", workingTitle: "Fixture source", status: "active", etag: '"story"' }], editions: [{ ...source, storyId: "STY-fixture", locale: "en-US", format: "article", etag: '"edition"' }], variants: [{ ...variant(), title: pkg.title, body: pkg.body, locale: "en-US", format: "article", destinationId: "destination", etag: '"variant"', assetRefs: [] }], destinations: [{ id: "destination", name: "Fixture real destination" }], claims: [], accounts: [], releases: [], routes: [] };
    const ui = mountEditorialWorkbench({ api: async path => path === "/api/editorial/bootstrap" ? data : { items: [] }, getData: () => ({ claims: [] }) });
    assert.equal(await ui.load(), true);
    assert.match(root.innerHTML, /The actual final tail/);
    assert.match(root.innerHTML, /data-editorial-native="CNT-fixture"/);
    assert.match(root.innerHTML, /type="submit" disabled>批准这个精确渠道版本/);
    assert.match(root.innerHTML, /nativeArtifactConfirmed-/);
    assert.doesNotMatch(root.innerHTML, /name="(?:reviewed|nativePackageConfirmed|nativeArtifactConfirmed-[^"]+)"[^>]*\bchecked\b/);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test("whole-package materialization and independent review stay disabled for missing or changed artifact metadata", () => {
  for (const rows of [[], [artifacts[0]], [artifacts[0], { ...artifacts[1], status: "staged" }], [artifacts[0], { ...artifacts[1], bytes: 999 }], [artifacts[0], { ...artifacts[1], rightsReviewHash: d }]]) {
    assert.match(renderNativeCandidate(candidate, { artifacts: rows, reports: [quality], source }), /type="submit" disabled>转为编辑出版待核草稿/);
    assert.match(renderHumanQualityReview(candidate, rows, { sources: [source] }), /type="submit" disabled>保存真实独立终检记录/);
  }
  assert.doesNotMatch(renderNativeCandidate(candidate, { artifacts, reports: [quality], source }), /type="submit" disabled>转为编辑出版待核草稿/);
  assert.doesNotMatch(renderHumanQualityReview(candidate, artifacts, { sources: [source] }), /type="submit" disabled>保存真实独立终检记录/);
  assert.match(renderNativeCandidate(candidate, { artifacts, reports: [quality] }), /type="submit" disabled>转为编辑出版待核草稿/);
  assert.match(renderHumanQualityReview(candidate, artifacts), /type="submit" disabled>保存真实独立终检记录/);
});

test("every frozen mother edition is read and compared; a missing or changed second source blocks whole-package review", async () => {
  const second = { id: "ED-second", editorialRevision: 2, snapshotHash: a, title: "第二份准确母版", body: "第二份母版全部正文\n第二份母版真实末尾" };
  const multiPackage = { ...pkg, sourceEditionRefs: [...pkg.sourceEditionRefs, { id: second.id, revision: 2, sha256: a }] };
  const multiCandidate = { ...candidate, package: multiPackage }, multiVariant = variant({ publicationPackage: multiPackage });
  const api = async path => path.includes("/candidates/") ? multiCandidate : path.includes("/artifacts/") ? artifacts.find(row => path.endsWith(row.id)) : path.endsWith(second.id) ? second : source;
  const review = await loadNativePackageReview(api, multiVariant);
  assert.equal(review.ready, true);
  assert.deepEqual(review.sources.map(row => row.id), [source.id, second.id]);
  const output = renderNativePackageReview(multiVariant, review);
  assert.match(output, /母版完整尾部/);
  assert.match(output, /第二份母版真实末尾/);
  const missing = await loadNativePackageReview(async path => { if (path.endsWith(second.id)) throw new Error("isolated second source unavailable"); return api(path); }, multiVariant);
  assert.equal(missing.ready, false);
  assert.equal(missing.sourceErrors[0].id, second.id);
  assert.match(renderNativePackageReview(multiVariant, missing), /未读取到准确母版/);
  const changed = await loadNativePackageReview(async path => path.endsWith(second.id) ? { ...second, editorialRevision: 3 } : api(path), multiVariant);
  assert.equal(changed.ready, false);
  assert.match(changed.sourceError, /ED-second/);
  assert.match(renderNativeCandidate(multiCandidate, { artifacts, reports: [quality], sources: [source] }), /type="submit" disabled>转为编辑出版待核草稿/);
});

test("independent quality builder requires exact full text, every real file, explicit methods and unresolved findings", () => {
  const base = { independent: "on", fullText: "on", semantic: "on", artistic: "on", reviewed: "on", findings: "[]", assessment: "Read the complete isolated fixture package and checked its limitations." };
  for (const ref of artifacts) Object.assign(base, { [`qualityArtifact-${ref.id}`]: ref.sha256, [`qualityMethod-${ref.id}`]: "human_full_read", [`qualityNote-${ref.id}`]: "Actually read all isolated source cells and metadata." });
  const row = { ...candidate, checkContextHash: d };
  const input = buildHumanQualityReview(row, base);
  assert.deepEqual(input.coverage.textKeys, nativeTextReviewKeys(pkg));
  assert.deepEqual(input.coverage.artifactHashes, [a, b]);
  assert.equal(input.dimensions, undefined);
  assert.equal(input.mediaEvidence.length, 2);
  for (const name of ["independent", "fullText", "semantic", "artistic", "reviewed", `qualityArtifact-${notebook}`]) assert.throws(() => buildHumanQualityReview(row, { ...base, [name]: "" }));
  for (const patch of [{ findings: "{" }, { findings: "{}" }, { [`qualityMethod-${notebook}`]: "file_exists" }, { [`qualityNote-${notebook}`]: "seen" }, { assessment: "ok" }]) assert.throws(() => buildHumanQualityReview(row, { ...base, ...patch }));
  const findings = [{ severity: "major", dimension: "facts", code: "FIXTURE_NOT_COVERED", message: "A fixture statement remains unresolved.", location: "body" }];
  assert.deepEqual(buildHumanQualityReview(row, { ...base, findings: JSON.stringify(findings) }).findings, findings);
  const allNativeFields = { ...pkg, nativeManifest: { settings: {}, disclosures: {}, segments: [{}], chapters: [{}], outputs: [{ text: "Exact output" }], pages: [{}], images: [{}], files: [{}] } };
  assert.deepEqual(nativeTextReviewKeys(allNativeFields), qualityTextKeys(allNativeFields));
  const extended = buildHumanQualityReview({ ...row, package: allNativeFields, requiredCoverage: { textKeys: [...qualityTextKeys(allNativeFields), "future:server-required"] } }, base);
  assert.ok(extended.coverage.textKeys.includes("future:server-required"));
  const duplicateBytes = buildHumanQualityReview({ ...row, package: { ...pkg, artifactRefs: [pkg.artifactRefs[0], { ...pkg.artifactRefs[1], sha256: a }] } }, { ...base, [`qualityArtifact-${notebook}`]: a });
  assert.deepEqual(duplicateBytes.coverage.artifactHashes, [a]);
  assert.equal(duplicateBytes.mediaEvidence.length, 2);
});

test("media bridge UI sends exact reviewed bytes once, preserves unknown-response identity and leaves media use unapproved", async t => {
  const f = await contentOpsFixture(t), mediaAssets = new MediaAssets({ store: f.store });
  await mediaAssets.initialize();
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGNgYPhLIhrVMKph2GoAAISu/QH+5zsIAAAAAElFTkSuQmCC", "base64");
  const sourceArtifact = await uploadOpsSource(f, { role: "source_image", mime: "image/png", bytes, name: "isolated-ui-image.png" });
  const input = buildArtifactMediaImport(sourceArtifact, { confirmed: "on" });
  assert.deepEqual(input, { sha256: sourceArtifact.sha256 });
  assert.throws(() => buildArtifactMediaImport(sourceArtifact, { confirmed: "" }));
  assert.throws(() => buildArtifactMediaImport({ ...sourceArtifact, status: "committed" }, { confirmed: "on" }));
  const output = renderArtifactPreview({ ...sourceArtifact, taskId: "TASK-ui-media", origin: "worker_upload" }, { review: true });
  assert.match(output, /data-co-form="artifact-import-media"/);
  assert.doesNotMatch(output, /checkbox[^>]*checked/);
  const calls = [];
  const send = createContentOpsRequester({ createKey: () => "isolated-ui-media-import-001", api: async (path, options) => {
    calls.push({ path, options });
    const result = await f.artifacts.importMedia(sourceArtifact.id, JSON.parse(options.body), { actor: "isolated UI media owner", method: "local", idempotencyKey: options.headers["Idempotency-Key"], ifMatch: options.headers["If-Match"] }, mediaAssets);
    if (calls.length === 1) throw new TypeError("isolated response lost after exact media import");
    return result;
  } });
  const route = `/api/content-ops/artifacts/${sourceArtifact.id}/import-media`;
  await assert.rejects(send(route, input, { etag: sourceArtifact.etag, needsEtag: true }));
  const media = await send(route, input, { etag: f.artifacts.getArtifact(sourceArtifact.id).etag, needsEtag: true });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(media.status, "staged");
  assert.equal(media.sha256, sourceArtifact.sha256);
  assert.equal(mediaAssets.getAsset(media.id).review, undefined);
  assert.equal(f.store.snapshot().mediaAssets.length, 1);
  const opened = await mediaAssets.openVerifiedAsset(media.id);
  try { assert.deepEqual(await opened.handle.readFile(), bytes); } finally { await opened.handle.close(); }
  const linked = renderArtifactPreview({ ...f.artifacts.getArtifact(sourceArtifact.id), taskId: "TASK-ui-media", origin: "worker_upload" }, { review: true });
  assert.match(linked, new RegExp(`data-co-media-review="${media.id}"`));
  assert.doesNotMatch(linked, /data-co-form="artifact-import-media"/);
});

test("usage builder refuses unknown amounts and changed provider IDs while preserving exact original evidence units", () => {
  const reservation = { id: "RES-original", attemptId: "ATT-original", providerRequestId: "provider-original", currency: "USD" };
  const values = { reviewed: "on", providerRequestId: "provider-original", inputTokens: "10", outputTokens: "0", costMicros: "12", evidenceKind: "provider_billing_receipt", evidenceSha256: a, description: "Actual isolated itemized billing dimensions.", reason: "Reconcile only the original isolated reservation." };
  const input = buildUsageReconciliation(reservation, values);
  assert.equal(input.attemptId, reservation.attemptId);
  assert.deepEqual(input.usage, { inputTokens: 10, outputTokens: 0, costMicros: 12, currency: "USD" });
  assert.deepEqual(input.evidence.dimensions, ["inputTokens", "outputTokens", "costMicros", "currency"]);
  for (const patch of [{ reviewed: "" }, { providerRequestId: "other" }, { costMicros: "" }, { costMicros: "-1" }, { inputTokens: "1.5" }, { outputTokens: "9007199254740992" }, { evidenceSha256: "missing" }, { evidenceKind: "self_declared_zero" }]) assert.throws(() => buildUsageReconciliation(reservation, { ...values, ...patch }));
});

test("real isolated backend consumes UI quality, approval and receipt payloads without substituting package or file hashes", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true });
  f.service.productionArtifacts = f.artifacts;
  f.operations = new AccountOperationsService({ service: f.geoService, clock: f.clock, productionArtifacts: f.artifacts });
  const destination = f.service.getDestination(f.destinationIds.linkedin), account = f.service.getAccount(destination.accountId);
  const bytes = Buffer.from("# Exact UI source fixture\nAll source bytes were read inside the isolated test.\n");
  const sourceArtifact = await uploadOpsSource(f, { role: "transcript", mime: "text/markdown", bytes, name: "ui-source.md" });
  const { job } = await createOpsJob(f, { targets: [{ destinationId: destination.id, locale: "zh-CN", nativeForm: "article" }], sourceArtifactIds: [sourceArtifact.id] });
  const pairing = await f.ops.createPairing({ workerId: "ui-local-template", origin: "https://pengmanager.com", workspaceId: "isolated-ui", projectIds: ["isolated-ui"], jobIds: [job.id], targetKeys: [], adapterIds: f.bindings.map(binding => binding.adapterId), expiresAt: f.budget.deadlineAt, maxTempBytes: 100_000_000, maxRenderSeconds: 600, maxNativeProcesses: 1, checker: false }, opsContext());
  const exactJob = f.ops.getJob(job.id, opsContext());
  const templates = buildWorkerLocalTemplates(pairing, { jobs: [exactJob], budgets: [f.budget] });
  assert.equal(templates.grant.ownerConfirmed, false);
  assert.equal(templates.grant.localGrantHash, undefined);
  assert.equal(templates.config.grantFile, "/absolute/private/content-ops/ui-local-template/local-grant.json");
  assert.equal(templates.config.currency, f.budget.currency);
  assert.doesNotMatch(JSON.stringify(templates), /challenge|credential|apiKey|cookie|token/i);
  assert.equal(templates.grant.budgetAuthorizationHash, exactJob.budgetAuthorizationHash);
  assert.ok(templates.grant.targetKeys.length);
  assert.ok(templates.grant.adapterBindings.every(binding => exactJob.tasks.some(task => task.permissionRequirements?.independentChecker === false && JSON.stringify(task.adapterBinding) === JSON.stringify(binding))));
  const validationOptions = { origin: templates.config.origin, workerId: templates.config.workerId, pendingPairing: true, clock: () => f.clock().getTime() };
  assert.throws(() => validateLocalGrant(templates.grant, validationOptions), { code: "LOCAL_APPROVAL_REQUIRED" });
  const actualOwnerReviewedFixture = { ...templates.grant, ownerConfirmed: true };
  actualOwnerReviewedFixture.localGrantHash = localGrantHash(actualOwnerReviewedFixture);
  assert.doesNotThrow(() => validateLocalGrant(actualOwnerReviewedFixture, validationOptions));
  for (const partial of [{ ...exactJob, tasks: undefined }, { ...exactJob, budgetAuthorizationHash: null }, { ...exactJob, tasks: exactJob.tasks.filter(task => task.permissionRequirements?.independentChecker) }]) assert.throws(() => buildWorkerLocalTemplates(pairing, { jobs: [partial], budgets: [f.budget] }));
  await finishTextOpsJob(f, job.id);
  let row = f.ops.getCandidate(f.ops.getJob(job.id, opsContext()).candidates[0].id, opsContext());
  assert.ok(row.package.artifactRefs.some(ref => ref.id === sourceArtifact.id && ref.sha256 === sourceArtifact.sha256));
  const qcFields = { independent: "on", fullText: "on", semantic: "on", artistic: "on", reviewed: "on", findings: "[]", assessment: "Independent isolated reviewer read the exact full source bytes and final package.", [`qualityArtifact-${sourceArtifact.id}`]: sourceArtifact.sha256, [`qualityMethod-${sourceArtifact.id}`]: "human_full_read", [`qualityNote-${sourceArtifact.id}`]: bytes.toString("utf8") };
  const input = buildHumanQualityReview(row, qcFields);
  const report = await f.ops.submitQualityReport(row.id, input, opsContext(row, "independent UI fixture reviewer"));
  assert.equal(report.status, "passed");
  row = f.ops.getCandidate(row.id, opsContext());
  const variantDraft = await f.service.materializeCandidate(row.id, { packageHash: row.packageHash, qualityReportHashes: row.qualityReportHashes, reviewSnapshotHash: row.reviewSnapshotHash }, context(row));
  const api = async path => {
    if (path.startsWith("/api/content-ops/candidates/")) return f.ops.getCandidate(decodeURIComponent(path.split("/").at(-1)), opsContext());
    if (path.startsWith("/api/content-ops/artifacts/")) return f.artifacts.getArtifact(decodeURIComponent(path.split("/").at(-1)));
    if (path.startsWith("/api/editions/")) return f.service.getEdition(decodeURIComponent(path.split("/").at(-1)));
    throw new Error(`Unexpected isolated UI read: ${path}`);
  };
  const review = await loadNativePackageReview(api, variantDraft);
  assert.equal(review.ready, true);
  let current = await f.service.transitionVariant(variantDraft.id, buildEditorialVariantTransition(variantDraft, { target: "fact_check", note: "Isolated full review" }), context(variantDraft));
  const confirmations = { nativePackageConfirmed: "on", [`nativeArtifactConfirmed-${sourceArtifact.id}`]: sourceArtifact.sha256 };
  current = await f.service.transitionVariant(current.id, buildEditorialVariantTransition(current, { ...confirmations, target: "approved", reviewed: "on", note: "Isolated exact full package approval." }, { nativeReviewReady: review.ready }), context(current));
  current = await f.service.transitionVariant(current.id, buildEditorialVariantTransition(current, { target: "scheduled", note: "Isolated scheduling only" }), context(current));
  let operation = await f.operations.create({ accountId: account.id, contentId: current.id, type: "publish", executionMode: "browser", actor: "isolated UI executor" });
  operation = await f.operations.approve(operation.id, buildOperationApproval(operation, { ...confirmations, approvedBy: "isolated owner", authorizationNote: "Only this isolated native package, with no live platform request." }, { nativeReviewReady: true }));
  operation = await f.operations.start(operation.id, { actor: "isolated UI executor" });
  const receipt = buildOperationReceipt(operation, { contentConfirmed: "on", nativePackageConfirmed: "on", [`artifactConfirmed-${sourceArtifact.id}`]: sourceArtifact.sha256, url: `https://www.linkedin.com/posts/${account.handle}_987654321`, publishedAt: "2026-10-25T18:00", verifiedAt: "2026-10-25T18:00", capturedBy: "isolated fixture collector", verifiedBy: "isolated fixture reviewer", dataMode: "imported", verificationMethod: "manual_readback" });
  assert.equal(receipt.publishedAt, OPS_NOW.toISOString());
  assert.equal(receipt.packageHash, row.packageHash);
  assert.deepEqual(receipt.artifactHashes, [{ artifactId: sourceArtifact.id, sha256: sourceArtifact.sha256 }]);
  const done = await f.operations.complete(operation.id, { actor: "isolated UI executor", receipt });
  assert.equal(done.status, "completed");
  assert.equal(f.store.snapshot().publications.length, 1);
  assert.equal((await f.operations.complete(operation.id, { actor: "isolated UI executor", receipt })).id, done.id);
  const unknown = f.ops.getJob(job.id, opsContext()).reservations.find(value => value.status === "partially_settled");
  assert.ok(unknown);
  const usageInput = buildUsageReconciliation(unknown, { reviewed: "on", providerRequestId: unknown.providerRequestId, inputTokens: String(unknown.actual.inputTokens), outputTokens: String(unknown.actual.outputTokens), costMicros: "20", evidenceKind: "administrator_itemized_audit", evidenceSha256: a, description: "Isolated synthetic billing audit; no supplier was contacted.", reason: "Confirm UI payload contract against the original isolated reservation." });
  const reconciled = await f.ops.reconcileUsage(job.id, unknown.id, usageInput, opsContext(f.ops.getJob(job.id, opsContext())));
  assert.equal(reconciled.reservation.status, "settled");
  assert.equal(reconciled.reservation.actual.costMicros, 20);
  assert.equal(reconciled.reservation.attemptId, unknown.attemptId);
});
