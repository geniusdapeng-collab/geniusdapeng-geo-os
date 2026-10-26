import test from "node:test";
import assert from "node:assert/strict";
import { contentOpsFixture, createOpsJob, finishTextOpsJob, opsContext, pairOpsWorker, claimOpsTask, uploadOpsSource, OPS_EXPIRY } from "./content-ops-fixtures.mjs";
import { contentOpsRef } from "../src/domain/content-ops.mjs";
import { validateAdaptationPlan } from "../src/domain/content-ops-plan.mjs";
import { validateCandidateForReview } from "../src/domain/content-ops-quality.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { context } from "./editorial-fixtures.mjs";

test("closed plan, graph, source and typed reference checks reject malformed or falsely relabeled inputs", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), base = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: "official-site", locale: "zh-CN", nativeForm: "article" }], goal: "核对实际来源", budgetAuthorizationId: f.budget.id }, opsContext()).plan;
  const invalid = (mutate, code) => { const plan = structuredClone(base); mutate(plan); assert.throws(() => validateAdaptationPlan(f.store.snapshot(), plan, { now: f.clock() }), { code }); };
  invalid(plan => { plan.targets = []; }, "ADAPTATION_PLAN_INVALID");
  invalid(plan => { plan.targets = Array(29).fill(plan.targets[0]); }, "ADAPTATION_PLAN_INVALID");
  invalid(plan => { plan.targets.push(structuredClone(plan.targets[0])); }, "DUPLICATE_TARGET");
  invalid(plan => { plan.targets[0].languagePlan.argv = ["unsafe"]; }, "UNKNOWN_FIELD");
  invalid(plan => { plan.targets[0].knownGaps = {}; plan.targets[0].rulesRef = null; plan.targets[0].decision = "needs_input"; }, "ADAPTATION_PLAN_INVALID");
  invalid(plan => { plan.targets[0].outputs[0].derivedFromKeys = ["copy"]; }, "OUTPUT_DAG_CYCLE");
  invalid(plan => { plan.targets[0].outputs[0].derivedFromKeys = ["missing"]; }, "OUTPUT_DEPENDENCY_MISSING");
  invalid(plan => { plan.targets[0].settings.extra = {}; }, "UNKNOWN_FIELD");
  const notebook = await uploadOpsSource(f, { role: "notebook", mime: "application/x-ipynb+json", bytes: Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", metadata: {}, source: ["print('isolated')"], outputs: [], execution_count: null }] })) });
  const template = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: f.destinationIds.kaggle, locale: "zh-CN", nativeForm: "notebook" }], goal: "静态作品说明", budgetAuthorizationId: f.budget.id, sourceArtifactIds: [notebook.id] }, opsContext());
  template.plan.targets[0].settings.notebookRef = template.plan.storyRef;
  assert.throws(() => validateAdaptationPlan(f.store.snapshot(), template.plan, { now: f.clock() }), { code: "NATIVE_REFERENCE_TYPE_INVALID" });
  const code = await uploadOpsSource(f, { role: "code", mime: "text/javascript", bytes: Buffer.from("export const isolatedFixture = true;\n") });
  const video = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: f.destinationIds.bilibili, locale: "zh-CN", nativeForm: "video" }], goal: "实际视频不能由代码冒充", budgetAuthorizationId: f.budget.id, sourceArtifactIds: [code.id] }, opsContext()).plan;
  video.targets[0].inputFiles[0].role = "source_video";
  assert.throws(() => validateAdaptationPlan(f.store.snapshot(), video, { now: f.clock() }), { code: "NATIVE_REFERENCE_TYPE_INVALID" });
});

test("real author contribution and action intersections gate author-led and community platforms before generation", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true });
  const template = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: f.destinationIds["wechat-official"], locale: "zh-CN", nativeForm: "article" }, { destinationId: f.destinationIds.maimai, locale: "zh-CN", nativeForm: "article" }, { destinationId: f.destinationIds.devto, locale: "zh-CN", nativeForm: "community_message" }], goal: "单篇真实原文编辑", budgetAuthorizationId: f.budget.id }, opsContext());
  const valid = validateAdaptationPlan(f.store.snapshot(), template.plan, { now: f.clock() });
  assert.equal(valid.targets[0].effectivePolicy.allowedAiActions.includes("draft"), false); assert.equal(valid.targets[1].effectivePolicy.deliveryMode, "manual_only"); assert.deepEqual(valid.targets[2].effectivePolicy.allowedAiActions, ["copyedit", "translate"]);
  template.plan.targets[0].authorContributionRefs = []; const noAuthor = validateAdaptationPlan(f.store.snapshot(), template.plan, { now: f.clock() }); assert.equal(noAuthor.targets[0].decision, "needs_input"); assert.ok(noAuthor.targets[0].gaps.some(gap => gap.code === "AUTHOR_INPUT_REQUIRED"));
  template.plan.goal = "marketing SEO 内容分发"; const marketing = validateAdaptationPlan(f.store.snapshot(), template.plan, { now: f.clock() }); assert.equal(marketing.targets[2].decision, "needs_input"); assert.ok(marketing.targets[2].gaps.some(gap => gap.code === "PLATFORM_POLICY_BLOCKED"));
  assert.equal(f.store.snapshot().productionTaskAttempts.length, 0);
});

test("one destination's newer rule blocks that target while another target keeps its exact allowed source scope", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), { job, imported } = await createOpsJob(f, { targets: [{ destinationId: "official-site", locale: "zh-CN", nativeForm: "article" }, { destinationId: f.destinationIds.linkedin, locale: "zh-CN", nativeForm: "article" }] });
  const linkedProfile = f.ops.profiles().profiles.find(profile => profile.platformId === "linkedin");
  await f.ops.createRuleSnapshot({ platformId: "linkedin", destinationId: f.destinationIds.linkedin, policy: linkedProfile.policy, sources: [{ url: "https://pengmanager.com/isolated-updated-policy", title: "Isolated update", scope: "Changed test rule" }], checkedAt: f.clock().toISOString(), expiresAt: OPS_EXPIRY, reviewed: true, note: "A newer test-specific destination rule." }, opsContext());
  assert.throws(() => validateAdaptationPlan(f.store.snapshot(), imported.normalizedPlan, { now: f.clock() }), { code: "RULES_CHANGED" });
  assert.doesNotThrow(() => validateAdaptationPlan(f.store.snapshot(), imported.normalizedPlan, { now: f.clock(), targetKeys: [imported.normalizedPlan.targets[0].targetKey], expectedBindings: imported.sourceBindings }));
  const worker = await pairOpsWorker(f, [job.id]), lease = await claimOpsTask(f, worker); assert.equal(lease.task.targetKey, imported.normalizedPlan.targets[0].targetKey); assert.equal(lease.resolvedInputData.plan.targets.length, 1); assert.equal(lease.resolvedInputData.plan.targets[0].platformId, "official-site");
});

test("typed model-file rights are frozen separately from byte SHA and re-review invalidates the prior import", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true }), header = Buffer.from(JSON.stringify({ tensor: { dtype: "F32", shape: [1], data_offsets: [0, 4] } })), prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(header.length));
  const model = await uploadOpsSource(f, { role: "model_weights", mime: "application/x-safetensors", bytes: Buffer.concat([prefix, header, Buffer.alloc(4)]) });
  const license = await uploadOpsSource(f, { role: "rights_evidence", mime: "text/plain", bytes: Buffer.from("Isolated fixture permission, not a live model license.\n") });
  const template = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: f.destinationIds.huggingface, locale: "zh-CN", nativeForm: "model_card" }], goal: "真实小模型文件说明", budgetAuthorizationId: f.budget.id, sourceArtifactIds: [model.id, license.id] }, opsContext());
  const imported = await f.ops.validatePlanImport({ plan: template.plan }, opsContext()); assert.equal(imported.sourceBindings.targets[0].typedArtifactBindings.some(binding => binding.artifactId === model.id), true);
  await f.artifacts.review(model.id, { sha256: model.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true, note: "Different isolated rights review must stale the prior binding." }, opsContext(f.artifacts.getArtifact(model.id)));
  await assert.rejects(f.ops.createJob({ validatedImportId: imported.id, planHash: imported.planHash, budgetAuthorizationHash: f.budget.authorizationHash, mode: "prepare" }, opsContext(f.store.snapshot().stories.find(row => row.id === f.storyId))), { code: "RIGHTS_CHANGED" });
});

test("real immutable human revisions create scoped style candidates, promotion and rollback without changing facts or old packages", async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), completed = await finishTextOpsJob(f, job.id), candidate = f.ops.getCandidate(completed.job.candidates[0].id, opsContext());
  const original = await f.service.materializeCandidate(candidate.id, { packageHash: candidate.packageHash, qualityReportHashes: candidate.qualityReportHashes, reviewSnapshotHash: candidate.reviewSnapshotHash }, opsContext(candidate));
  const beforeState = f.store.snapshot(), before = "这是一份隔离测试中的完整正文。", after = "这是我为这个账号保留的简明正文。";
  const revision = await f.service.createVariant(f.editionId, { destinationId: "official-site", body: candidate.package.body.replace(before, after), title: candidate.package.title, summary: candidate.package.summary, supersedesContentId: original.id }, context(f.service.getEdition(f.editionId)));
  const scope = { accountId: null, destinationId: "official-site", locale: "zh-CN" }, evidence = { candidateId: candidate.id, packageHash: candidate.packageHash, contentId: revision.id, humanEditNote: "Actual administrator-created immutable manual revision in an isolated test." };
  const memory = await f.ops.createStyleMemoryCandidate({ scope, before, after, reason: "Use the actual author's first-person voice in this one destination.", evidence }, opsContext());
  assert.equal(memory.permissionsGranted, false); assert.equal(memory.factsApproved, false);
  await assert.rejects(f.ops.promoteStyleMemory(memory.id, { scope: { ...scope, locale: "en-US" }, reason: "Invalid cross-locale promotion", reviewed: true }, opsContext(memory)), { code: "STYLE_SCOPE_CHANGED" });
  const first = await f.ops.promoteStyleMemory(memory.id, { scope, reason: "Reviewed real manual edit within this exact scope", reviewed: true }, opsContext(memory));
  const after2 = "这个账号保留作者明确的简短表达。", revision2 = await f.service.createVariant(f.editionId, { destinationId: "official-site", body: candidate.package.body.replace(before, after2), title: candidate.package.title, summary: candidate.package.summary, supersedesContentId: revision.id }, context(f.service.getEdition(f.editionId)));
  const secondMemory = await f.ops.createStyleMemoryCandidate({ scope, before, after: after2, reason: "A second actual manual editorial correction.", evidence: { ...evidence, contentId: revision2.id } }, opsContext());
  const second = await f.ops.promoteStyleMemory(secondMemory.id, { scope, reason: "Second exact scoped human edit", reviewed: true }, opsContext(secondMemory));
  const rollback = await f.ops.rollbackStyleMemory(first.id, { reason: "Restore the prior reviewed style version", reviewed: true }, opsContext(second)); assert.equal(rollback.rollbackToVersionId, first.id); assert.deepEqual(rollback.constraints, first.constraints);
  const newTemplate = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: "official-site", locale: "zh-CN", nativeForm: "article" }, { destinationId: "official-site", locale: "en-US", nativeForm: "article" }], goal: "精确记忆scope", budgetAuthorizationId: f.budget.id }, opsContext()); assert.equal(newTemplate.plan.targets[0].styleRef.id, rollback.id); assert.equal(newTemplate.plan.targets[1].styleRef, null);
  assert.deepEqual(f.store.snapshot().claims, beforeState.claims); assert.equal(f.ops.getCandidate(candidate.id, opsContext()).packageHash, candidate.packageHash); assert.equal(validateCandidateForReview(f.store.snapshot(), candidate.id, { now: f.clock() }).packageHash, candidate.packageHash);
});
