import test from "node:test";
import assert from "node:assert/strict";
import { contentOpsFixture, createOpsJob, finishTextOpsJob, opsContext, pairOpsWorker, claimOpsTask, completeOpsTask, isolatedTaskData, uploadOpsSource, OPS_EXPIRY } from "./content-ops-fixtures.mjs";
import { contentOpsRef, contentOpsReportHash, contentOpsReviewEnvelope, contentOpsClaimFingerprint, contentOpsSourceBundle } from "../src/domain/content-ops.mjs";
import { validateAdaptationPlan } from "../src/domain/content-ops-plan.mjs";
import { validateCandidateForReview, qualityTextKeys } from "../src/domain/content-ops-quality.mjs";
import { hashObject } from "../src/domain/hash.mjs";

async function importJob(f, plan) {
  const imported = await f.ops.validatePlanImport({ plan }, opsContext());
  const job = await f.ops.createJob({ validatedImportId: imported.id, planHash: imported.planHash, budgetAuthorizationHash: f.budget.authorizationHash, mode: "prepare" }, opsContext(f.store.snapshot().stories.find(row => row.id === f.storyId)));
  return { imported, job };
}
const englishTargets = f => [{ destinationId: "official-site", locale: "en-US", nativeForm: "article" }, { destinationId: f.destinationIds["wechat-official"], locale: "en-US", nativeForm: "article" }];

test("shared neutral transformation uses the strict common authority, exact common author material and every consumer scope", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), { job } = await createOpsJob(f, { targets: englishTargets(f) }), current = f.ops.getJob(job.id, opsContext());
  const transforms = current.tasks.filter(task => task.kind === "format.transform"); assert.equal(transforms.length, 1);
  const task = transforms[0]; assert.equal(task.neutralPolicy.requiresAuthorContribution, true); assert.equal(task.neutralPolicy.allowedAiActions.includes("draft"), false); assert.ok(task.neutralPolicy.allowedAiActions.includes("translate"));
  assert.equal(task.neutralAuthorContributionRefs.length, 1); assert.deepEqual(task.neutralTargetKeys, current.targets.map(run => run.targetKey)); assert.equal(task.inputRefs.effectivePolicyHash, hashObject(task.neutralPolicy));
  const partial = await pairOpsWorker(f, [job.id], { targetKeys: [task.targetKey] }); assert.equal(await claimOpsTask(f, partial), null);
  const worker = await pairOpsWorker(f, [job.id]), lease = await claimOpsTask(f, worker); assert.equal(lease.task.taskId, task.taskId);
  assert.deepEqual(lease.resolvedInputData.effectivePolicy, task.neutralPolicy); assert.deepEqual(lease.resolvedInputData.authorContributions.map(contentOpsRef), task.neutralAuthorContributionRefs);
  const profile = f.ops.profiles().profiles.find(row => row.platformId === "wechat-official");
  await f.ops.createRuleSnapshot({ platformId: profile.platformId, destinationId: f.destinationIds[profile.platformId], policy: profile.policy, sources: [{ url: "https://pengmanager.com/isolated-revised-rule", title: "Isolated revised policy", scope: "A changed consumer rule" }], checkedAt: f.clock().toISOString(), expiresAt: OPS_EXPIRY, reviewed: true, note: "Shared neutral work must stop when either consumer rule changes." }, opsContext());
  await assert.rejects(completeOpsTask(f, worker, lease, { data: isolatedTaskData(lease) }), { code: "RULES_CHANGED" }); assert.equal(f.ops.getJob(job.id, opsContext()).reservations.length, 0);
});

test("incompatible author snapshots split neutral transforms and each candidate keeps the transform actually in its run", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), second = await f.ops.createAuthorContribution({ storyRef: contentOpsRef(f.store.snapshot().stories.find(row => row.id === f.storyId)), title: "Second isolated author input", body: "这是另外一份实际录入的作者原稿，两个目的地没有相同的作者输入授权。", locale: "zh-CN", sourceNote: "Distinct test-only author snapshot.", authoredBy: "second isolated author" }, opsContext());
  const plan = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: englishTargets(f), goal: "保留各自作者授权的隔离准备", budgetAuthorizationId: f.budget.id }, opsContext()).plan;
  const first = f.store.snapshot().authorContributions.find(row => row.id !== second.id); plan.targets[0].authorContributionRefs = [contentOpsRef(first)]; plan.targets[1].authorContributionRefs = [second.ref];
  const { job } = await importJob(f, plan), completed = await finishTextOpsJob(f, job.id), transforms = completed.job.tasks.filter(task => task.kind === "format.transform");
  assert.equal(transforms.length, 2); assert.equal(new Set(transforms.map(task => task.formatTransformKey)).size, 2); assert.equal(completed.job.candidates.length, 2);
  for (const candidate of completed.job.candidates) { const run = completed.job.targets.find(row => row.targetKey === candidate.targetKey), actual = transforms.find(task => run.taskIds.includes(task.taskId)); assert.equal(candidate.neutralTransformRef.taskId, actual.taskId); assert.equal(candidate.neutralTransformRef.formatTransformKey, actual.formatTransformKey); }
});

test("three native thread segments retain independent content and exact order, and a newer incomplete report revokes old review proof", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), plan = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: f.destinationIds.x, locale: "zh-CN", nativeForm: "thread" }], goal: "逐段保留原生内容", budgetAuthorizationId: f.budget.id }, opsContext()).plan, target = plan.targets[0];
  target.outputs.push(...["evidence", "limit"].map(outputKey => ({ outputKey, kind: "text", locale: "zh-CN", required: true, derivedFromKeys: ["copy"] }))); target.settings.orderedSegmentKeys = ["evidence", "copy", "limit"];
  const { job } = await importJob(f, plan), writer = await pairOpsWorker(f, [job.id]), checker = await pairOpsWorker(f, [job.id], { checker: true });
  const copy = [{ outputKey: "copy", title: "实际主张", body: "第一段说明作者的实际主张。", alt: "", caption: "" }, { outputKey: "evidence", title: "实际依据", body: "第二段逐条说明原稿可核对的依据。", alt: "", caption: "" }, { outputKey: "limit", title: "实际限定", body: "第三段保留限制和不确定性。", alt: "", caption: "" }];
  for (let round = 0; round < 30; round++) { let progress = false; for (const worker of [writer, checker]) { const lease = await claimOpsTask(f, worker); if (!lease) continue; const data = isolatedTaskData(lease); if (["text.adapt", "text.revise", "text.polish"].includes(lease.task.kind)) data.nativeContent = copy; await completeOpsTask(f, worker, lease, { data }); progress = true; } if (!progress) break; }
  const candidate = f.ops.getCandidate(f.ops.getJob(job.id, opsContext()).candidates[0].id, opsContext()), oldProof = { packageHash: candidate.packageHash, qualityReportHashes: candidate.qualityReportHashes, reviewSnapshotHash: candidate.reviewSnapshotHash, now: f.clock() };
  assert.deepEqual(candidate.package.nativeManifest.segments.map(row => row.key), ["evidence", "copy", "limit"]); assert.deepEqual(candidate.package.nativeManifest.segments.map(row => row.text), [copy[1].body, copy[0].body, copy[2].body]);
  for (const key of ["segment:0", "segment:1", "segment:2", "output:0", "output:1", "output:2", "native:settings", "native:disclosures"]) assert.ok(candidate.requiredCoverage.textKeys.includes(key));
  validateCandidateForReview(f.store.snapshot(), candidate.id, oldProof);
  const incomplete = await f.ops.submitQualityReport(candidate.id, { checkedPackageHash: candidate.packageHash, checkContextHash: candidate.checkContextHash, coverage: { textKeys: qualityTextKeys(candidate.package).filter(key => key !== "segment:2"), artifactHashes: [], semantic: "checked", artistic: "checked" }, mediaEvidence: [], reviewed: true, assessment: "Isolated negative case: the last native segment was not actually checked." }, opsContext(candidate, "independent isolated human"));
  assert.equal(incomplete.status, "needs_input"); const current = f.ops.getCandidate(candidate.id, opsContext()); assert.equal(current.reviewEnvelope, null); assert.deepEqual(current.qualityReportHashes, []);
  assert.throws(() => validateCandidateForReview(f.store.snapshot(), candidate.id, oldProof), { code: "QUALITY_REPORT_STALE" });
});

test("native output mapping rejects missing, duplicate, repeated and wrongly typed segments, cards and documents", async t => {
  const f = await contentOpsFixture(t), base = { title: "Actual complete title", body: "Complete nonempty source body.", summary: "" }, row = outputKey => ({ outputKey, title: `Actual ${outputKey}`, body: `Independent body for ${outputKey}.`, alt: "Actual authorized image description", caption: "" });
  for (const kind of ["text", "image", "document"]) {
    const target = { outputs: ["first", "second"].map(outputKey => ({ outputKey, kind, required: true })) };
    assert.throws(() => f.ops.nativeContent(target, base), { code: "NATIVE_OUTPUT_CONTENT_REQUIRED" });
    assert.throws(() => f.ops.nativeContent(target, { ...base, nativeContent: [row("first"), row("first")] }), { code: "NATIVE_OUTPUT_CONTENT_INVALID" });
    assert.throws(() => f.ops.nativeContent(target, { ...base, nativeContent: [row("first"), { ...row("second"), body: row("first").body }] }), { code: "NATIVE_OUTPUT_CONTENT_INVALID" });
    assert.deepEqual(f.ops.nativeContent(target, { ...base, nativeContent: [row("first"), row("second")] }).map(value => value.body), [row("first").body, row("second").body]);
  }
  const plan = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: "official-site", locale: "zh-CN", nativeForm: "image_text" }], goal: "校验原生输出类型", budgetAuthorizationId: f.budget.id }, opsContext()).plan; plan.targets[0].settings.coverOutputKey = "copy";
  assert.throws(() => validateAdaptationPlan(f.store.snapshot(), plan, { now: f.clock() }), { code: "NATIVE_PACKAGE_INVALID" });
});

test("separate notebook artifacts may share bytes while coverage hashes deduplicate and human evidence still names every artifact", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), bytes = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "markdown", metadata: {}, source: ["Isolated actual notebook source; not an executed evaluation."] }] })), source = await uploadOpsSource(f, { role: "notebook", mime: "application/x-ipynb+json", bytes });
  const { job } = await createOpsJob(f, { targets: [{ destinationId: f.destinationIds.kaggle, locale: "zh-CN", nativeForm: "notebook" }], sourceArtifactIds: [source.id] }), writer = await pairOpsWorker(f, [job.id]), checker = await pairOpsWorker(f, [job.id], { checker: true });
  for (let round = 0; round < 30; round++) { let progress = false; for (const worker of [writer, checker]) { const lease = await claimOpsTask(f, worker); if (!lease) continue; const native = lease.task.kind === "native.prepare"; await completeOpsTask(f, worker, lease, { data: native ? { staticPreview: true, executedCode: false } : isolatedTaskData(lease), artifacts: native ? [{ outputKey: "notebook", role: "notebook", mime: "application/x-ipynb+json", bytes }] : [] }); if (native) { const artifact = f.ops.getJob(job.id, opsContext()).artifacts.find(row => row.attemptId === lease.attemptId); await f.artifacts.review(artifact.id, { sha256: artifact.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true, note: "Actual isolated notebook bytes preserved without executing cells." }, opsContext(artifact)); } progress = true; } if (!progress) break; }
  const candidate = f.ops.getCandidate(f.ops.getJob(job.id, opsContext()).candidates[0].id, opsContext()); assert.equal(candidate.package.artifactRefs.length, 2); assert.equal(candidate.requiredCoverage.artifactHashes.length, 1); assert.equal(candidate.reports[0].coverage.artifactHashes.length, 1);
  const artifact = candidate.package.artifactRefs[0]; await assert.rejects(f.ops.submitQualityReport(candidate.id, { checkedPackageHash: candidate.packageHash, coverage: { textKeys: candidate.requiredCoverage.textKeys, artifactHashes: candidate.requiredCoverage.artifactHashes, semantic: "checked", artistic: "checked" }, mediaEvidence: [{ artifactId: artifact.id, sha256: artifact.sha256, method: "human_full_read", coverage: "full", note: "Only one artifact was read in this deliberate negative case." }], assessment: "The matching second byte hash cannot replace its own artifact coverage evidence.", reviewed: true }, opsContext(candidate, "independent isolated human")), { code: "QUALITY_RECHECK_REQUIRED" });
});

test("rehashing a forged checker report cannot replace its exact independent final-task provenance", async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), completed = await finishTextOpsJob(f, job.id), state = f.store.snapshot(), candidate = state.nativeCandidatePackages.find(row => row.id === completed.job.candidates[0].id), report = state.contentQualityReports.find(row => row.candidateId === candidate.id);
  report.execution.attemptId = state.productionTaskAttempts.find(row => row.jobId === job.id && row.status === "succeeded" && row.id !== report.execution.attemptId).id; report.reportHash = contentOpsReportHash(report); candidate.qualityReportHashes = [report.reportHash]; candidate.reviewEnvelope = contentOpsReviewEnvelope(candidate.packageHash, candidate.qualityReportHashes, candidate.checkContextHash); candidate.reviewSnapshotHash = hashObject(candidate.reviewEnvelope);
  assert.throws(() => validateCandidateForReview(state, candidate.id, { now: f.clock() }), { code: "QUALITY_REPORT_STALE" });
});

test("private or unapproved claims, contradictory translation and nested credential-shaped results cannot enter candidate preparation", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), base = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: "official-site", locale: "en-US", nativeForm: "article" }], goal: "验证公开事实与语言授权", budgetAuthorizationId: f.budget.id }, opsContext()).plan;
  for (const change of [claim => { claim.source.visibility = "private"; }, claim => { claim.publicLevel = "private"; }]) { const state = f.store.snapshot(), plan = structuredClone(base); for (const binding of plan.claimBindings) { const claim = state.claims.find(row => row.id === binding.claimId); change(claim); binding.fingerprint = contentOpsClaimFingerprint(claim); } plan.sourceBundleHash = contentOpsSourceBundle(plan); assert.throws(() => validateAdaptationPlan(state, plan, { now: f.clock() }), { code: "CLAIM_CHANGED" }); }
  const contradictory = structuredClone(base); contradictory.targets[0].languagePlan.translateBody = false; assert.throws(() => validateAdaptationPlan(f.store.snapshot(), contradictory, { now: f.clock() }), { code: "ADAPTATION_PLAN_INVALID" });
  const restricted = await createOpsJob(f, { targets: [{ destinationId: f.destinationIds.maimai, locale: "en-US", nativeForm: "article" }], goal: "不越过翻译授权" }); assert.equal(restricted.job.targets[0].status, "needs_input"); assert.equal(f.ops.getJob(restricted.job.id, opsContext()).tasks.length, 0);
  const { job } = await createOpsJob(f), worker = await pairOpsWorker(f, [job.id]), lease = await claimOpsTask(f, worker), data = isolatedTaskData(lease); data.untrustedNested = { body: "api_key=isolated_fake_not_a_real_credential" };
  await assert.rejects(completeOpsTask(f, worker, lease, { data }), { code: "CREDENTIALS_NOT_ALLOWED" }); const attempt = f.ops.getJob(job.id, opsContext()).attempts.find(row => row.id === lease.attemptId); assert.equal(attempt.status, "dispatch_recorded"); assert.equal(attempt.resultManifest, undefined);
});

test("target revisions require exact parent review, preserve the old package and budget, and enforce a two-child limit", async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), completed = await finishTextOpsJob(f, job.id), candidate = completed.job.candidates[0], input = { candidateId: candidate.id, packageHash: candidate.packageHash, instructions: "保留事实与限定，并把论点放在第一段。" };
  await assert.rejects(f.ops.reviseTarget(job.id, candidate.targetKey, input, opsContext()), { code: "PRECONDITION_REQUIRED" });
  await assert.rejects(f.ops.reviseTarget(job.id, candidate.targetKey, { ...input, packageHash: "0".repeat(64) }, opsContext(f.ops.getJob(job.id, opsContext()))), { code: "NATIVE_PACKAGE_CHANGED" });
  for (let index = 0; index < 2; index++) { const child = await f.ops.reviseTarget(job.id, candidate.targetKey, input, opsContext(f.ops.getJob(job.id, opsContext()))); assert.equal(child.parentJobId, job.id); assert.equal(child.parentCandidateId, candidate.id); assert.equal(child.budgetAuthorizationId, f.budget.id); assert.equal(child.requiresWorkerAuthorization, true); }
  await assert.rejects(f.ops.reviseTarget(job.id, candidate.targetKey, input, opsContext(f.ops.getJob(job.id, opsContext()))), { code: "REVISION_LIMIT_REACHED" }); assert.equal(f.ops.getCandidate(candidate.id, opsContext()).packageHash, candidate.packageHash);
});
