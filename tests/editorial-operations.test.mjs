import test from "node:test";
import assert from "node:assert/strict";
import { hashObject } from "../src/domain/hash.mjs";
import { EDITORIAL_SCHEMA, editorialEtag } from "../src/domain/editorial.mjs";
import { AccountOperationsService } from "../src/services/account-operations.mjs";
import { editorialFixture, createEditionVariant, scheduleVariant, context, FIXED_TIME } from "./editorial-fixtures.mjs";

// These imported receipts describe synthetic, isolated unit data only. No test
// contacts GitHub or proves a real external publication.
async function external(t, { assets = false, visibility = "public" } = {}) {
  const f = await editorialFixture(t);
  await f.geoService.approveClaim("C003", { approvedBy: "isolated reviewer", publicLevel: "private" });
  let account = f.service.getAccount("github");
  account = await f.service.updateAccount(account.id, { profileUrl: "https://github.com/isolated-editorial-owner",
    identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: FIXED_TIME.toISOString(), status: "active",
    reviewNote: "Synthetic unit account identity and rule confirmation." }, context(account));
  let destination = await f.service.createDestination({ platformId: "github", accountId: account.id, kind: "repository", name: "Isolated repository",
    locator: { url: "https://github.com/isolated-editorial-owner/isolated-unit-repository" }, visibility }, context());
  destination = await f.service.updateDestination(destination.id, { status: "active", identityConfirmed: true, policyStatus: "reviewed",
    policyCheckedAt: FIXED_TIME.toISOString(), reviewNote: "Synthetic unit repository rule confirmation." }, context(destination));
  const assetRefs = [];
  if (assets) {
    const sha256 = `a13800138000a${"b".repeat(51)}`;
    await f.store.mutate({ type: "unit.synthetic-external-image", actor: "test" }, state => state.mediaAssets.push({ id: "MA-external-image", sha256,
      mime: "image/png", kind: "image", size: 67, status: "reviewed", review: { rightsConfirmed: true, privacyConfirmed: true } }));
    assetRefs.push({ assetId: "MA-external-image", sha256, role: "image", alt: "Synthetic unit image", caption: "Synthetic unit caption" });
  }
  const created = await createEditionVariant(f, { destinationId: destination.id, format: assets ? "image_text" : "article", assetRefs });
  const variant = await scheduleVariant(f, created.variant);
  return { ...f, ...created, variant, account, destination };
}

async function begin(f) {
  let operation = await f.operations.create({ accountId: f.account.id, contentId: f.variant.id, type: "publish", executionMode: "browser", actor: "isolated operator" });
  operation = await f.operations.approve(operation.id, { approvedBy: "isolated reviewer", authorizationNote: "Authorize this exact synthetic unit snapshot once." });
  return f.operations.start(operation.id, { actor: "isolated operator" });
}

function receipt(operation, patch = {}) {
  return { url: "https://github.com/isolated-editorial-owner/isolated-unit-repository/issues/999999", publishedAt: FIXED_TIME.toISOString(),
    capturedBy: "isolated operator", dataMode: "imported", verificationMethod: "manual_readback", verifiedAt: FIXED_TIME.toISOString(), verifiedBy: "isolated reviewer",
    editorialSnapshotHash: operation.editorialSnapshotHash,
    assetHashes: [...new Map(operation.editorialSnapshot.assetRefs.map(row => [`${row.assetId}:${row.sha256}`, { assetId: row.assetId, sha256: row.sha256 }])).values()], ...patch };
}

function reconcileInput(operation, patch = {}) {
  return { approvedSnapshotHash: operation.editorialSnapshotHash ?? operation.contentHash, accountConfirmed: true, contentConfirmed: true,
    receipt: receipt(operation), reason: "Unit recovery after an external result was already produced; no new platform action.", ...patch };
}

function current(f, id) { return f.operations.list().find(row => row.id === id); }

test("v2 external completion binds full approved media snapshot and remains idempotent across service instances", async t => {
  const f = await external(t, { assets: true }), operation = await begin(f), original = structuredClone(operation);
  assert.equal(operation.snapshotSchema, EDITORIAL_SCHEMA);
  assert.equal(hashObject(operation.editorialSnapshot), f.variant.snapshotHash);
  assert.equal(operation.approval.editorialSnapshotHash, f.variant.snapshotHash);
  const other = new AccountOperationsService({ service: f.geoService, clock: () => new Date(FIXED_TIME) });
  const [a, b] = await Promise.all([f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation) }),
    other.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation) })]);
  assert.deepEqual(a, b); assert.equal(a.status, "completed"); assert.equal(a.receipt.assetHashes.length, 1);
  assert.equal(f.store.snapshot().publications.length, 1);
  assert.equal(f.store.snapshot().events.filter(row => row.type === "account.operation_completed").length, 1);
  assert.deepEqual(a.approval, original.approval); assert.deepEqual(a.editorialSnapshot, original.editorialSnapshot);
});

test("v2 receipt rejects omitted, extra, changed or duplicate media hashes and a mismatched full snapshot", async t => {
  const f = await external(t, { assets: true }), operation = await begin(f), before = f.store.snapshot();
  for (const patch of [{ assetHashes: [] }, { assetHashes: undefined }, { assetHashes: [{ assetId: "MA-external-image", sha256: "c".repeat(64) }] },
    { assetHashes: [...receipt(operation).assetHashes, ...receipt(operation).assetHashes] }, { assetHashes: [{ ...receipt(operation).assetHashes[0], extra: true }] }]) {
    await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation, patch) }), { code: "RECEIPT_EDITORIAL_ASSETS_MISMATCH" });
  }
  await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation, { editorialSnapshotHash: "c".repeat(64) }) }), { code: "RECEIPT_EDITORIAL_SNAPSHOT_MISMATCH" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("v2 cannot use a private community receipt contract or a manual JSON capability to bypass original operation approval", async t => {
  const f = await external(t, { visibility: "restricted" });
  await assert.rejects(f.operations.create({ accountId: f.account.id, contentId: f.variant.id, type: "publish", actor: "test" }), { code: "RESTRICTED_RECEIPT_WORKFLOW_REQUIRED" });
  await assert.rejects(f.geoService.recordPublication({ contentId: f.variant.id, accountId: f.account.id, actor: "test",
    EDITORIAL_PUBLICATION_AUTHORIZATION: { snapshotHash: f.variant.snapshotHash }, receipt: { url: "https://github.com/isolated/unit/issues/99999", dataMode: "imported" } }), { code: "EDITORIAL_OPERATION_REQUIRED" });
  assert.equal(f.store.snapshot().publications.length, 0);
});

test("v2 rechecks changed captions, destination identity and account identity before completing a started operation", async t => {
  for (const kind of ["caption", "destination", "account"]) {
    await t.test(kind, async child => {
      const f = await external(child, { assets: true }), operation = await begin(f);
      await f.store.mutate({ type: "unit.after-start-drift", actor: "test" }, state => {
        if (kind === "caption") state.content.find(row => row.id === f.variant.id).assetRefs[0].caption = "Changed after approval";
        if (kind === "destination") state.destinations.find(row => row.id === f.destination.id).locator.url = "https://github.com/other-owner/other-repository";
        if (kind === "account") state.accounts.find(row => row.id === f.account.id).handle = "changed-identity";
      });
      await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation) }),
        error => ["EDITORIAL_SNAPSHOT_CHANGED", "EDITORIAL_DESTINATION_CHANGED", "ACCOUNT_IDENTITY_CHANGED"].includes(error.code));
      assert.equal(current(f, operation.id).status, "in_progress"); assert.equal(f.store.snapshot().publications.length, 0);
    });
  }
});

test("administrator reconciliation preserves original approval and records historical result despite current account/Claim drift", async t => {
  const f = await external(t, { assets: true }), operation = await begin(f), original = structuredClone(operation);
  await f.store.mutate({ type: "unit.current-policy-drift", actor: "test" }, state => {
    const account = state.accounts.find(row => row.id === f.account.id); account.status = "paused"; account.policyStatus = "manual_review_required";
    state.claims.find(row => row.id === "C003").expiresAt = "2026-10-24T00:00:00Z";
  });
  await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation) }));
  const input = reconcileInput(operation), ctx = context(current(f, operation.id), "reconcile-once-12345");
  const done = await f.operations.reconcile(operation.id, input, ctx), after = f.store.snapshot();
  assert.equal(done.status, "completed"); assert.deepEqual(done.approval, original.approval); assert.deepEqual(done.execution, original.execution);
  assert.deepEqual(done.editorialSnapshot, original.editorialSnapshot);
  assert.equal(after.publications[0].origin, "historical_result_reconciliation");
  assert.ok(after.externalResultReconciliations[0].incidentCodes.includes("ACCOUNT_NOT_ACTIVE"));
  assert.ok(after.externalResultReconciliations[0].incidentCodes.includes("CURRENT_CLAIM_NOT_VALID"));
  assert.deepEqual(current(f, operation.id).reconciliation.incidentCodes, after.externalResultReconciliations[0].incidentCodes);
  assert.equal(current(f, operation.id).reconciliation.originalAccountSnapshot, undefined);
  assert.equal(current(f, operation.id).reconciliation.receipt, undefined);
  assert.deepEqual(await f.operations.reconcile(operation.id, input, ctx), done); assert.deepEqual(f.store.snapshot(), after);
  await assert.rejects(f.operations.reconcile(operation.id, { ...input, reason: "Different semantic request" }, ctx), { code: "IDEMPOTENCY_CONFLICT" });
  const archived = await f.service.updateAccount(f.account.id, { status: "archived", reason: "The old result is now reconciled." }, context(f.service.getAccount(f.account.id)));
  assert.equal(archived.status, "archived"); assert.equal(f.store.snapshot().accountOperations[0].id, operation.id);
});

test("reconciliation of an old approved body never marks a changed current body published", async t => {
  const f = await external(t), operation = await begin(f), originalBody = operation.contentSnapshot.body;
  await f.store.mutate({ type: "unit.unauthorized-current-text-change", actor: "test" }, state => { state.content.find(row => row.id === f.variant.id).body = "A different current body."; });
  const done = await f.operations.reconcile(operation.id, reconcileInput(operation), context(current(f, operation.id)));
  assert.equal(done.status, "completed"); assert.equal(f.service.getVariant(f.variant.id).status, "scheduled");
  assert.equal(f.store.snapshot().publications[0].originalContentSnapshot.body, originalBody);
  assert.ok(f.store.snapshot().externalResultReconciliations[0].incidentCodes.includes("CURRENT_CONTENT_CHANGED_OR_MISSING"));
});

test("reconciliation requires administrator, fresh ETag, original hash, actual readback confirmations and authorization time", async t => {
  const f = await external(t), operation = await begin(f), input = reconcileInput(operation), row = current(f, operation.id), before = f.store.snapshot();
  for (const method of ["agent", "unknown", undefined]) await assert.rejects(f.operations.reconcile(operation.id, input, { ...context(row), method }), { status: 403 });
  await assert.rejects(f.operations.reconcile(operation.id, input, context()), { status: 428 });
  await assert.rejects(f.operations.reconcile(operation.id, input, { ...context(row), ifMatch: '"stale"' }), { status: 412 });
  await assert.rejects(f.operations.reconcile(operation.id, { ...input, accountConfirmed: false }, context(row)), { code: "RECONCILIATION_READBACK_REQUIRED" });
  await assert.rejects(f.operations.reconcile(operation.id, { ...input, approvedSnapshotHash: "a".repeat(64) }, context(row)), { code: "RECONCILIATION_SNAPSHOT_MISMATCH" });
  await assert.rejects(f.operations.reconcile(operation.id, { ...input, receipt: receipt(operation, { publishedAt: "2026-10-24T00:00:00Z" }) }, context(row)), { code: "RECONCILIATION_BEFORE_AUTHORIZATION" });
  assert.deepEqual(f.store.snapshot(), before);
  await f.store.mutate({ type: "unit.invalid-original-date", actor: "test" }, state => { state.accountOperations[0].execution.startedAt = "invalid"; });
  await assert.rejects(f.operations.reconcile(operation.id, input, context(current(f, operation.id))), { code: "ORIGINAL_APPROVAL_REQUIRED" });
});

test("reconciliation fails closed when original approval or immutable snapshot was altered", async t => {
  for (const kind of ["approval", "snapshot", "text", "schema"]) await t.test(kind, async child => {
    const f = await external(child), operation = await begin(f), input = reconcileInput(operation);
    await f.store.mutate({ type: "unit.tampered-original", actor: "test" }, state => {
      const row = state.accountOperations[0];
      if (kind === "approval") row.approval.editorialSnapshotHash = "a".repeat(64);
      if (kind === "snapshot") row.editorialSnapshot.summary = "Not approved";
      if (kind === "text") row.contentSnapshot.body = "Not approved";
      if (kind === "schema") row.snapshotSchema = "unsupported/v99";
    });
    await assert.rejects(f.operations.reconcile(operation.id, input, context(current(f, operation.id))),
      error => ["ORIGINAL_APPROVAL_REQUIRED", "RECONCILIATION_SNAPSHOT_MISMATCH"].includes(error.code));
    assert.equal(f.store.snapshot().publications.length, 0);
  });
});

test("concurrent reconciliations have one immutable receipt and a failed persist can be retried safely", async t => {
  const f = await external(t), operation = await begin(f), input = reconcileInput(operation), row = current(f, operation.id), ctx = context(row, "recover-persist-12345");
  const originalMutate = f.store.mutate.bind(f.store); let fail = true;
  f.store.mutate = async (event, mutator) => {
    if (event.type === "account.operation_reconciled" && fail) { fail = false; throw Object.assign(new Error("Synthetic isolated write failure"), { code: "EIO" }); }
    return originalMutate(event, mutator);
  };
  await assert.rejects(f.operations.reconcile(operation.id, input, ctx), { code: "EIO" });
  assert.equal(f.store.snapshot().publications.length, 0);
  const [a, b] = await Promise.all([f.operations.reconcile(operation.id, input, ctx), f.operations.reconcile(operation.id, input, ctx)]);
  assert.deepEqual(a, b); assert.equal(f.store.snapshot().publications.length, 1); assert.equal(f.store.snapshot().externalResultReconciliations.length, 1);
  await assert.rejects(f.operations.reconcile(operation.id, { ...input, receipt: receipt(operation, { url: "https://github.com/isolated/unit/issues/999998" }) }, context(current(f, operation.id))), { code: "RECEIPT_CONFLICT" });
  assert.equal(editorialEtag(f.store.snapshot().accountOperations[0]), a.etag);
});

test("a pending destination cannot change locator, visibility or lifecycle before its original result is reconciled", async t => {
  const f = await external(t), operation = await begin(f), destination = f.service.getDestination(f.destination.id), before = f.store.snapshot();
  for (const input of [{ locator: { url: "https://github.com/other-owner/other-repository" } }, { visibility: "private" },
    { status: "paused", reason: "Pause after result recovery" }, { status: "archived", reason: "Archive after result recovery" }]) {
    await assert.rejects(f.service.updateDestination(destination.id, input, context(destination)), { code: "DESTINATION_RECONCILIATION_REQUIRED" });
    assert.deepEqual(f.store.snapshot(), before);
  }
  await f.operations.reconcile(operation.id, reconcileInput(operation), context(current(f, operation.id)));
  const paused = await f.service.updateDestination(destination.id, { status: "paused", reason: "Recovered the original result." }, context(destination));
  assert.equal(paused.status, "paused");
});

test("a result URL already in a different manual ledger cannot be used for completion or reconciliation", async t => {
  const f = await external(t), operation = await begin(f);
  await f.store.mutate({ type: "unit.previous-manual-publication", actor: "test" }, state => state.publications.push({ id: "PUB-999", accountId: f.account.id,
    contentId: "different-historical-content", url: receipt(operation).url }));
  await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation) }), { code: "DUPLICATE_PLATFORM_RECEIPT" });
  await assert.rejects(f.operations.reconcile(operation.id, reconcileInput(operation), context(current(f, operation.id))), { code: "DUPLICATE_PLATFORM_RECEIPT" });
  assert.equal(current(f, operation.id).status, "in_progress");
});

test("legacy text-only actions also reconcile exact old approval without manufacturing v2 metadata or changing hashes", async t => {
  const f = await editorialFixture(t);
  await f.geoService.approveClaim("C003", { approvedBy: "isolated reviewer", publicLevel: "private" });
  const content = await f.geoService.createContent({ title: "Legacy isolated article", body: "Complete legacy isolated body.", claimIds: ["C003"], platforms: ["GitHub"], owner: "isolated reviewer" });
  for (const target of ["fact_check", "approved", "scheduled"]) await f.geoService.transitionContent(content.id, { target, actor: "isolated reviewer" });
  let operation = await f.operations.create({ accountId: "github", contentId: content.id, type: "publish", actor: "isolated operator" });
  operation = await f.operations.approve(operation.id, { approvedBy: "isolated reviewer", authorizationNote: "Synthetic legacy authorization." });
  operation = await f.operations.start(operation.id, { actor: "isolated operator" });
  const original = structuredClone(operation), legacyReceipt = { url: "https://github.com/isolated/unit/issues/999997", publishedAt: FIXED_TIME.toISOString(),
    capturedBy: "isolated operator", verifiedBy: "isolated reviewer", verifiedAt: FIXED_TIME.toISOString(), verificationMethod: "manual_readback", dataMode: "imported" };
  const done = await f.operations.reconcile(operation.id, { approvedSnapshotHash: operation.contentHash, accountConfirmed: true, contentConfirmed: true,
    receipt: legacyReceipt, reason: "Recover only the approved legacy result." }, context(current(f, operation.id)));
  assert.equal(done.status, "completed"); assert.equal(done.snapshotSchema, undefined); assert.equal(done.contentHash, original.contentHash);
  assert.deepEqual(done.approval, original.approval); assert.equal(done.receipt.editorialSnapshotHash, undefined);
  assert.equal(f.store.snapshot().publications[0].snapshotSchema, undefined);
});

test("new completion receipts cannot predate original authorization for v2, legacy publish or reply actions", async t => {
  for (const kind of ["v2", "legacy", "reply"]) await t.test(kind, async child => {
    let f, operation, source;
    if (kind === "v2") {
      f = await external(child); operation = await begin(f); source = receipt(operation, { publishedAt: "2025-01-01T00:00:00.000Z" });
    } else {
      f = await editorialFixture(child);
      if (kind === "legacy") {
        await f.geoService.approveClaim("C003", { approvedBy: "isolated reviewer", publicLevel: "private" });
        const content = await f.geoService.createContent({ title: "Chronology legacy unit", body: "Complete isolated chronology unit body.", claimIds: ["C003"], platforms: ["GitHub"] });
        for (const target of ["fact_check", "approved", "scheduled"]) await f.geoService.transitionContent(content.id, { target, actor: "isolated reviewer" });
        operation = await f.operations.create({ accountId: "github", contentId: content.id, type: "publish", actor: "isolated operator" });
      } else operation = await f.operations.create({ accountId: "github", type: "reply", replyText: "A complete isolated unit reply.",
        targetUrl: "https://github.com/isolated/unit/issues/99999", actor: "isolated operator" });
      operation = await f.operations.approve(operation.id, { approvedBy: "isolated reviewer", authorizationNote: "Explicit synthetic chronology authorization." });
      operation = await f.operations.start(operation.id, { actor: "isolated operator" });
      source = { url: "https://github.com/isolated/unit/issues/99999#issuecomment-99999", publishedAt: "2025-01-01T00:00:00.000Z",
        capturedBy: "isolated operator", dataMode: "imported", verifiedAt: FIXED_TIME.toISOString(), verificationMethod: "manual_readback", verifiedBy: "isolated reviewer" };
    }
    const before = f.store.snapshot();
    await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: source }), { code: "RECEIPT_BEFORE_AUTHORIZATION" });
    assert.deepEqual(f.store.snapshot(), before);
    await f.store.mutate({ type: "unit.invalid-original-start", actor: "test" }, state => { state.accountOperations[0].execution.startedAt = "invalid"; });
    await assert.rejects(f.operations.complete(operation.id, { actor: "isolated operator", receipt: { ...source, publishedAt: FIXED_TIME.toISOString() } }), { code: "OPERATION_AUTHORIZATION_INVALID" });
  });
});

test("the exact receipt of an already-completed historical record remains an idempotent read without rewriting its past", async t => {
  const f = await external(t), operation = await begin(f);
  const done = await f.operations.complete(operation.id, { actor: "isolated operator", receipt: receipt(operation) });
  const oldSource = receipt(operation, { publishedAt: "2025-01-01T00:00:00.000Z" });
  const normalized = { ...oldSource, contentHash: operation.contentHash }, receiptHash = hashObject(normalized);
  await f.store.mutate({ type: "unit.preexisting-legacy-chronology-record", actor: "test" }, state => {
    state.accountOperations[0].receipt = { ...normalized, receiptHash, recordedAt: done.receipt.recordedAt, recordedBy: done.receipt.recordedBy };
    state.publications[0].receiptHash = receiptHash; state.publications[0].publishedAt = normalized.publishedAt;
  });
  const before = f.store.snapshot(), repeated = await f.operations.complete(operation.id, { actor: "isolated operator", receipt: oldSource });
  assert.equal(repeated.status, "completed"); assert.equal(repeated.receipt.publishedAt, oldSource.publishedAt);
  assert.deepEqual(f.store.snapshot(), before);
});
