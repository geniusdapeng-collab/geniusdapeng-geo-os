import test from "node:test";
import assert from "node:assert/strict";
import { contentOpsFixture, createOpsJob, finishTextOpsJob, opsContext, pairOpsWorker, claimOpsTask, completeOpsTask, isolatedTaskData, leaseIdentity, FIXTURE_PRICING, OPS_EXPIRY, uploadOpsSource } from "./content-ops-fixtures.mjs";
import { PNG, MP4 } from "./fixtures/synthetic-media.mjs";
import { validateCandidateForReview } from "../src/domain/content-ops-quality.mjs";
import { contentOpsEtag, contentOpsRef, hashPlan, hashBlueprint, assertContentOpsStateIntegrity } from "../src/domain/content-ops.mjs";
import { validateAdaptationPlan } from "../src/domain/content-ops-plan.mjs";
import { budgetTotals } from "../src/domain/content-ops-budget.mjs";
import { hashObject } from "../src/domain/hash.mjs";

test("real seed+backup+migration text pipeline freezes an immutable package, independent report and review envelope", async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), before = f.ops.getJob(job.id, opsContext());
  const completed = await finishTextOpsJob(f, job.id);
  assert.equal(completed.job.status, "ready_for_review"); assert.equal(completed.job.candidates.length, 1);
  const candidate = completed.job.candidates[0], review = validateCandidateForReview(f.store.snapshot(), candidate.id, { now: f.clock() });
  assert.equal(review.packageHash, candidate.packageHash); assert.equal(review.envelope.packageHash, candidate.packageHash); assert.equal(review.reports[0].status, "passed");
  assert.deepEqual(completed.job.tasks.map(row => ({ taskId: row.taskId, taskHash: row.taskHash })), before.tasks.map(row => ({ taskId: row.taskId, taskHash: row.taskHash })));
  assert.equal(hashBlueprint(f.store.snapshot().productionTaskBlueprints.filter(task => task.jobId === job.id)), before.blueprintHash);
  assert.equal(completed.job.budgetTotals.calls, 5); assert.equal(completed.job.budgetTotals.unknown.count, 5); assert.equal(completed.job.budgetTotals.used.costMicros, 0); assert.ok(completed.job.budgetTotals.reserved.costMicros > 0);
  assertContentOpsStateIntegrity(f.store.snapshot());
});

test("strict plan import preserves original bytes, rejects ambiguous fields and never performs model work", async t => {
  const f = await contentOpsFixture(t), template = f.ops.planTemplate({ storyId: f.storyId, editionId: f.editionId, targets: [{ destinationId: "official-site", locale: "zh-CN", nativeForm: "article" }], goal: "完整来源核对", budgetAuthorizationId: null }, opsContext());
  assert.throws(() => f.ops.validatePlanImport({ rawPlanJson: '{"schema":"a","schema":"b"}' }, opsContext()), { code: "DUPLICATE_JSON_KEY" });
  await assert.rejects(f.ops.validatePlanImport({ plan: { ...template.plan, argv: ["unsafe"] } }, opsContext()), { code: "UNKNOWN_FIELD" });
  const raw = `\n${JSON.stringify(template.plan, null, 2)}\n`, imported = await f.ops.validatePlanImport({ rawPlanJson: raw }, opsContext());
  assert.equal(imported.rawSha256.length, 64); assert.equal(imported.planHash, hashPlan(template.plan)); assert.equal(f.store.snapshot().productionTaskAttempts.length, 0);
  const job = await f.ops.createJob({ validatedImportId: imported.id, planHash: imported.planHash, budgetAuthorizationHash: null, mode: "prepare" }, opsContext(f.store.snapshot().stories.find(row => row.id === f.storyId)));
  assert.equal(job.status, "blocked_budget");
  const worker = await pairOpsWorker(f, [job.id]); assert.equal(await claimOpsTask(f, worker), null);
  await assert.rejects(f.ops.createJob({ validatedImportId: imported.id, planHash: imported.planHash, budgetAuthorizationHash: f.budget.authorizationHash, mode: "prepare" }, opsContext(f.store.snapshot().stories.find(row => row.id === f.storyId))), { code: "BUDGET_CHANGED" });
});

test("all 28 distinct profiles compile their native form with real typed sources and retain missing prerequisites per target", async t => {
  const f = await contentOpsFixture(t, { allDestinations: true });
  const weightsHeader = Buffer.from(JSON.stringify({ tensor: { dtype: "F32", shape: [1], data_offsets: [0, 4] } })), prefix = Buffer.alloc(8); prefix.writeBigUInt64LE(BigInt(weightsHeader.length));
  const sources = [];
  for (const source of [
    { role: "source_image", mime: "image/png", bytes: PNG }, { role: "source_video", mime: "video/mp4", bytes: MP4 },
    { role: "rights_evidence", mime: "text/markdown", bytes: Buffer.from("# Isolated fixture license\n\nCC0 test bytes, no customer rights asserted.\n") },
    { role: "code", mime: "text/x-diff", bytes: Buffer.from("diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-console.log(1);\n+console.log(2);\n") },
    { role: "code", mime: "text/javascript", bytes: Buffer.from("export function isolatedDemo(value) { return String(value); }\n") },
    { role: "dataset", mime: "text/csv", bytes: Buffer.from("id,label\n1,fixture\n") },
    { role: "notebook", mime: "application/x-ipynb+json", bytes: Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", metadata: {}, source: ["print('isolated fixture')"], outputs: [], execution_count: null }] })) },
    { role: "run_log", mime: "text/plain", bytes: Buffer.from("Isolated fixture log; no actual ML evaluation claimed.\n") },
    { role: "model_weights", mime: "application/x-safetensors", bytes: Buffer.concat([prefix, weightsHeader, Buffer.alloc(4)]) },
  ]) sources.push(await uploadOpsSource(f, source));
  const profiles = f.ops.profiles().profiles; assert.equal(profiles.length, 28); assert.equal(new Set(profiles.map(profile => profile.strategy)).size, 28);
  const targets = profiles.map(profile => ({ destinationId: f.destinationIds[profile.platformId], locale: "zh-CN", nativeForm: profile.supportedNativeForms[0] }));
  const valid = await createOpsJob(f, { targets, sourceArtifactIds: sources.map(source => source.id), nativeInputs: [{ destinationId: f.destinationIds.github, baseCommit: "a".repeat(40), operation: "prepare_diff", tag: null }] });
  assert.equal(valid.imported.targets.length, 28); assert.deepEqual(valid.imported.targets.map(target => target.decision), Array(28).fill("prepare"));
  assert.equal(valid.job.targets.length, 28); assert.ok(f.ops.getJob(valid.job.id, opsContext()).tasks.some(task => task.kind === "format.transform"));
  const imageTransforms = f.ops.getJob(valid.job.id, opsContext()).tasks.filter(task => task.kind === "format.transform" && task.transformSpec.targetFormat === "image_text"); assert.equal(imageTransforms.length, 1);
  const missing = await createOpsJob(f, { targets, goal: "另一次缺真实作品的隔离计划" });
  assert.equal(missing.imported.targets.length, 28);
  const byPlatform = new Map(missing.imported.normalizedPlan.targets.map((target, index) => [target.platformId, missing.imported.targets[index]]));
  for (const platform of ["xiaohongshu", "bilibili", "youtube", "tiktok", "instagram", "douyin", "wechat-channels", "github", "huggingface", "modelscope", "kaggle", "toutiao"]) assert.equal(byPlatform.get(platform).decision, "needs_input", platform);
  assert.equal(f.store.snapshot().productionTaskAttempts.length, 0);
});
