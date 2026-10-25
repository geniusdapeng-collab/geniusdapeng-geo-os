import test from "node:test";
import assert from "node:assert/strict";
import {
  renderOperations, buildOperationReceipt, buildReconciliationInput,
  createOperationReconciler, operationMediaReferences,
} from "../public/operations.js";

// Isolated rendering/request fixtures: these are not platform or approval evidence.
const operation = (extra = {}) => ({
  id: "OP-TEST", type: "publish", status: "in_progress", executionMode: "browser",
  accountId: "original-account", platform: "Medium", contentId: "CNT-TEST",
  accountSnapshot: { id: "original-account", platform: "Medium", handle: "original-handle", profileUrl: "https://medium.com/@original-handle" },
  contentSnapshot: { title: "Original approved title", body: "Original complete body <script>not executable</script>", version: 2 },
  contentHash: "a".repeat(64),
  approval: { approvedBy: "Fixture reviewer", authorizationNote: "Fixture exact approval", approvedAt: "2026-10-25T00:00:00.000Z", contentHash: "a".repeat(64) },
  execution: { actor: "Fixture executor", startedAt: "2026-10-25T00:01:00.000Z" },
  createdAt: "2026-10-24T23:00:00.000Z", createdBy: "Fixture creator", etag: '"original-etag"', ...extra,
});
const fields = (extra = {}) => ({
  approvedSnapshotHash: "a".repeat(64), accountConfirmed: "on", contentConfirmed: "on",
  url: "https://medium.com/@original-handle/actual-result", publishedAt: "2026-10-25T08:02",
  capturedBy: "Fixture actual collector", dataMode: "imported", verificationMethod: "browser_readback",
  verifiedAt: "2026-10-25T08:03", verifiedBy: "Fixture actual verifier",
  reason: "Fixture: the old authorized result exists but current account identity changed.", ...extra,
});
const imageId = `MED-${"1".repeat(32)}`;
const subtitleId = `MED-${"2".repeat(32)}`;
const editorial = () => operation({
  snapshotSchema: "pengmanager.editorial-snapshot/v2", editorialSnapshotHash: "b".repeat(64),
  approval: { ...operation().approval, editorialSnapshotHash: "b".repeat(64) },
  editorialSnapshot: { locale: "en-US", format: "image_text", summary: "Full reviewed introduction", destinationId: "real-destination", destinationSnapshot: { accountId: "original-account", kind: "profile_feed", locator: { url: "https://medium.com/@original-handle" } },
    blocks: [{ type: "heading", text: "The original structure" }, { type: "image", assetId: imageId, alt: "Actual original diagram" }],
    assetRefs: [{ assetId: imageId, sha256: "c".repeat(64), role: "image", alt: "Actual original diagram", caption: "Exact original caption", locale: "en-US" }, { assetId: imageId, sha256: "c".repeat(64), role: "cover", alt: "Same bytes as cover" }, { assetId: subtitleId, sha256: "d".repeat(64), role: "subtitle", locale: "zh-CN", caption: "中文字幕" }],
  },
});

test("reconciliation form shows exact original account and text with no invented receipt values", () => {
  const output = renderOperations([operation()], { accounts: [{ id: "original-account", platform: "Medium", handle: "changed-now", profileUrl: "https://medium.com/@changed-now" }], content: [{ id: "CNT-TEST", title: "Changed current title", body: "Changed current text" }] });
  assert.match(output, /data-operation-form="reconcile"/);
  assert.match(output, /data-operation-etag="&quot;original-etag&quot;"/);
  assert.match(output, /Original approved title/);
  assert.match(output, /Original complete body &lt;script&gt;not executable&lt;\/script&gt;/);
  assert.match(output, /href="https:\/\/medium.com\/@original-handle"/);
  assert.match(output, /当前内容已不同于原获准快照/);
  assert.match(output, /不要再次发布/);
  assert.doesNotMatch(output, /Changed current title|Changed current text|<script>/);
  assert.doesNotMatch(output, /type="datetime-local"[^>]*value=/);
  assert.doesNotMatch(output, /name="(?:capturedBy|verifiedBy)"[^>]*value=/);
  assert.doesNotMatch(output, /name="(?:accountConfirmed|contentConfirmed|assetConfirmed-[^"]+)"[^>]*\bchecked\b/);
  assert.doesNotMatch(output, /data-operation-form="start"/);
});

test("reconciliation is unavailable without the existing approval and execution record", () => {
  for (const row of [operation({ status: "draft" }), operation({ status: "approved" }), operation({ approval: null }), operation({ execution: null }), operation({ accountSnapshot: null })]) {
    assert.doesNotMatch(renderOperations([row]), /data-operation-form="reconcile"/);
  }
  const noEtag = renderOperations([operation({ etag: undefined })]);
  assert.match(noEtag, /当前动作缺少版本校验值/);
  assert.match(noEtag, /type="submit" disabled>登记原真实结果/);
});

test("recovered results display actual reconciliation details and never offer a second reconciliation", () => {
  const row = operation({ status: "completed", reconciliationId: "REC-TEST", reconciliation: { id: "REC-TEST", reason: "Actual recorded reason <b>", incidentCodes: ["ACCOUNT_IDENTITY_CHANGED", "CURRENT_CLAIM_NOT_VALID"], recordedBy: "Actual administrator", recordedAt: "2026-10-25T01:00:00.000Z" } });
  const output = renderOperations([row]);
  assert.match(output, /原结果已调和 · REC-TEST/);
  assert.match(output, /当前账号身份与原授权不同/);
  assert.match(output, /当前事实依据已失效或不再获准/);
  assert.match(output, /Actual recorded reason &lt;b&gt;/);
  assert.doesNotMatch(output, /data-operation-form="reconcile"|data-operation-form="start"/);
});

test("v2 operation displays complete original structure, media order and separate actual-readback confirmations", () => {
  const output = renderOperations([editorial()]);
  assert.match(output, /The original structure/);
  assert.match(output, /Exact original caption/);
  assert.match(output, /中文字幕/);
  assert.match(output, /完整编辑快照 SHA-256/);
  assert.match(output, new RegExp(`name="assetConfirmed-${imageId}" value="c{64}" required`));
  assert.match(output, new RegExp(`href="/api/media/assets/${subtitleId}/bytes"`));
  assert.doesNotMatch(output, /name="assetConfirmed-[^"]+"[^>]*\bchecked\b/);
  assert.equal(operationMediaReferences(editorial()).length, 2);
});

test("v1 receipt builder preserves actual times/persons and sends only the receipt whitelist", () => {
  const receipt = buildOperationReceipt(operation(), fields({ actor: "not part of receipt", extraneous: "not sent" }));
  assert.deepEqual(receipt, {
    url: "https://medium.com/@original-handle/actual-result", publishedAt: "2026-10-25T00:02:00.000Z",
    capturedBy: "Fixture actual collector", dataMode: "imported", verificationMethod: "browser_readback",
    verifiedAt: "2026-10-25T00:03:00.000Z", verifiedBy: "Fixture actual verifier", contentHash: "a".repeat(64),
  });
  assert.equal(receipt.editorialSnapshotHash, undefined);
  assert.equal(receipt.actor, undefined);
});

test("reconciliation builder binds the original approval and administrator confirmations", () => {
  const input = buildReconciliationInput(operation(), fields());
  assert.equal(input.approvedSnapshotHash, "a".repeat(64));
  assert.equal(input.accountConfirmed, true);
  assert.equal(input.contentConfirmed, true);
  assert.equal(input.receipt.contentHash, "a".repeat(64));
  assert.equal(input.actor, undefined);
  for (const changed of [{ accountConfirmed: "" }, { contentConfirmed: "" }, { reason: " " }, { approvedSnapshotHash: "e".repeat(64) }]) assert.throws(() => buildReconciliationInput(operation(), fields(changed)));
  assert.throws(() => buildReconciliationInput(operation({ execution: null }), fields()));
});

test("actual receipt validation rejects empty records, missing source, and reversed chronology", () => {
  for (const name of ["url", "publishedAt", "capturedBy", "verifiedAt", "verifiedBy", "dataMode", "verificationMethod"]) assert.throws(() => buildOperationReceipt(operation(), fields({ [name]: "" })));
  assert.throws(() => buildOperationReceipt(operation(), fields({ verifiedAt: "2026-10-25T08:01" })), /不能早于/);
  assert.throws(() => buildOperationReceipt(operation(), fields({ dataMode: "fixture" })), /真实来源/);
  assert.throws(() => buildOperationReceipt(operation(), fields({ publishedAt: "not-a-date" })), /北京时间/);
});

test("v2 receipt and reconciliation require every original asset to be actually confirmed", () => {
  const row = editorial();
  const incomplete = fields({ approvedSnapshotHash: "b".repeat(64), [`assetConfirmed-${imageId}`]: "c".repeat(64) });
  assert.throws(() => buildOperationReceipt(row, incomplete), new RegExp(subtitleId));
  assert.throws(() => buildReconciliationInput(row, incomplete), new RegExp(subtitleId));
  const complete = { ...incomplete, [`assetConfirmed-${subtitleId}`]: "d".repeat(64) };
  const receipt = buildOperationReceipt(row, complete);
  assert.equal(receipt.editorialSnapshotHash, "b".repeat(64));
  assert.deepEqual(receipt.assetHashes, [{ assetId: imageId, sha256: "c".repeat(64) }, { assetId: subtitleId, sha256: "d".repeat(64) }]);
  assert.equal(buildReconciliationInput(row, complete).approvedSnapshotHash, "b".repeat(64));
  assert.throws(() => buildOperationReceipt(row, { ...complete, [`assetConfirmed-${imageId}`]: "e".repeat(64) }), /原素材/);
  assert.throws(() => buildOperationReceipt({ ...row, snapshotSchema: "unknown" }, complete), /不完整/);
});

test("unknown reconciliation network result retains exact body, idempotency key and original ETag on retry", async () => {
  const calls = [];
  let sequence = 0;
  const send = createOperationReconciler({ createKey: () => `fixture-key-${++sequence}`, api: async (path, options) => {
    calls.push({ path, options });
    if (calls.length === 1) throw new TypeError("Network interrupted after the server may have committed.");
    return { status: "completed", reconciliationId: "REC-TEST" };
  } });
  const input = buildReconciliationInput(operation(), fields());
  await assert.rejects(send(operation(), input), /Network interrupted/);
  const result = await send(operation({ etag: '"new-current-etag"' }), input);
  assert.equal(result.reconciliationId, "REC-TEST");
  assert.equal(calls[0].path, "/api/operations/OP-TEST/reconcile");
  assert.equal(calls[0].options.headers["If-Match"], '"original-etag"');
  assert.deepEqual(calls[1].options, calls[0].options);
  assert.equal(sequence, 1);
});

test("definite precondition errors require a fresh attempt and changed requests never reuse an old key", async () => {
  const calls = [];
  let sequence = 0;
  const send = createOperationReconciler({ createKey: () => `fixture-key-${++sequence}`, api: async (path, options) => {
    calls.push(options);
    if (calls.length === 1) throw Object.assign(new Error("Refresh the changed operation."), { status: 412 });
    return { status: "completed" };
  } });
  const input = buildReconciliationInput(operation(), fields());
  await assert.rejects(send(operation(), input), { status: 412 });
  await send(operation({ etag: '"fresh-etag"' }), input);
  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[1].headers["If-Match"], '"fresh-etag"');
  await send(operation(), { ...input, reason: "A separately reviewed reason." });
  assert.notEqual(calls[1].headers["Idempotency-Key"], calls[2].headers["Idempotency-Key"]);
  await assert.rejects(send(operation({ etag: null }), input), /缺少版本校验值/);
});
