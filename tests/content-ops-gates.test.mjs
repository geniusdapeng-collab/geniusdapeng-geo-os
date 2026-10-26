import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { contentOpsFixture, createOpsJob, opsContext, pairOpsWorker, claimOpsTask, completeOpsTask, isolatedTaskData, leaseIdentity, FIXTURE_PRICING, OPS_EXPIRY } from "./content-ops-fixtures.mjs";
import { budgetTotals, normalizePricing, normalizeBudget } from "../src/domain/content-ops-budget.mjs";
import { contentOpsRef, hashBlueprint } from "../src/domain/content-ops.mjs";
import { hashObject } from "../src/domain/hash.mjs";

function boundedBudget(overrides = {}) { return { name: "Isolated last-slot budget", maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 100, maxPerCallInputTokens: 100, maxPerCallOutputTokens: 100, maxInFlight: 1, currency: "USD", maxCostMicros: 200, deadlineAt: OPS_EXPIRY, maxRenderSeconds: 100, maxTempBytes: 1_000_000, maxNativeProcesses: 1, pricingSnapshot: FIXTURE_PRICING, ...overrides }; }
function dispatchInput(f, lease, key = "isolated.1") { return { ...leaseIdentity(lease), callKey: key, requestHash: hashObject({ fixtureOnly: true, attemptId: lease.attemptId, key }), provider: FIXTURE_PRICING.provider, model: FIXTURE_PRICING.model, pricingSnapshotHash: f.budget.pricingSnapshotHash, upperBound: { inputTokens: 100, outputTokens: 100, renderSeconds: 0, tempBytes: 0, nativeProcesses: 0 } }; }

test("last budget slot is atomic, permit replay cannot execute, and unknown reservations survive cancel/restart until itemized audit", async t => {
  const f = await contentOpsFixture(t); f.budget = await f.ops.createBudget(boundedBudget(), opsContext());
  const { job } = await createOpsJob(f, { targets: [{ destinationId: "official-site", locale: "zh-CN", nativeForm: "article" }, { destinationId: "official-site", locale: "en-US", nativeForm: "article" }] });
  const workers = await Promise.all([pairOpsWorker(f, [job.id]), pairOpsWorker(f, [job.id])]);
  const leases = await Promise.all(workers.map(worker => claimOpsTask(f, worker))); assert.ok(leases.every(Boolean)); assert.notEqual(leases[0].task.taskId, leases[1].task.taskId);
  const contexts = workers.map(worker => worker.ctx()), inputs = leases.map(lease => dispatchInput(f, lease));
  const outcomes = await Promise.allSettled(leases.map((lease, index) => f.ops.dispatchTask(lease.task.taskId, inputs[index], contexts[index])));
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1); assert.equal(outcomes.filter(result => result.status === "rejected")[0].reason.code, "JOB_BUDGET_EXCEEDED");
  const index = outcomes.findIndex(result => result.status === "fulfilled"), permit = outcomes[index].value, lease = leases[index], worker = workers[index]; assert.equal(permit.execute, true);
  assert.equal((await f.ops.dispatchTask(lease.task.taskId, inputs[index], contexts[index])).execute, false);
  assert.equal((await f.ops.dispatchTask(lease.task.taskId, inputs[index], worker.ctx())).execute, false); assert.equal(f.store.snapshot().modelBudgetReservations.length, 1);
  await f.ops.unknownCall(permit.reservationId, { attemptId: lease.attemptId, reason: "Isolated response-loss simulation", providerRequestId: null }, worker.ctx());
  let totals = budgetTotals(f.store.snapshot(), f.budget.id); assert.equal(totals.inFlight, 1); assert.equal(totals.unknown.count, 1); assert.equal(totals.reserved.costMicros, 200);
  await f.ops.cancelJob(job.id, { reason: "Isolated cancellation after dispatch" }, opsContext(f.ops.getJob(job.id, opsContext())));
  await f.ops.recover(opsContext()); totals = budgetTotals(f.store.snapshot(), f.budget.id); assert.equal(totals.unknown.count, 1); assert.equal(totals.reserved.costMicros, 200);
  await assert.rejects(f.ops.dispatchTask(lease.task.taskId, { ...inputs[index], callKey: "another.1" }, worker.ctx()), { code: "TASK_EPOCH_STALE" });
  const current = f.ops.getJob(job.id, opsContext()), reconcile = { attemptId: lease.attemptId, providerRequestId: "isolated-billed-request", usage: { inputTokens: 20, outputTokens: 20, costMicros: 40, currency: "USD" }, evidence: { kind: "administrator_itemized_audit", sha256: hashObject({ isolatedAudit: lease.attemptId }), providerRequestId: "isolated-billed-request", reservationId: permit.reservationId, dimensions: ["inputTokens", "outputTokens", "costMicros", "currency"], description: "Isolated per-request bill audit, not a live supplier invoice." }, reason: "Explicitly account for each measured dimension", reviewed: true };
  await assert.rejects(f.ops.reconcileUsage(job.id, permit.reservationId, { ...reconcile, evidence: { ...reconcile.evidence, dimensions: [] } }, opsContext(current)), { code: "USAGE_RECONCILIATION_REQUIRED" });
  const settled = await f.ops.reconcileUsage(job.id, permit.reservationId, reconcile, opsContext(current)); assert.equal(settled.budgetTotals.unknown.count, 0); assert.equal(settled.budgetTotals.used.costMicros, 40); assert.equal(settled.job.status, "cancelled");
});

test("lease fencing admits one owner, keeps resolved inputs across pre-dispatch retry and quarantines old epoch completion", async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), first = await pairOpsWorker(f, [job.id]), second = await pairOpsWorker(f, [job.id]);
  const old = await claimOpsTask(f, first); assert.ok(old); assert.equal(await claimOpsTask(f, second), null);
  f.advance(61_000); const next = await claimOpsTask(f, second); assert.ok(next); assert.equal(next.taskHash, old.taskHash); assert.equal(next.resolvedInputHash, old.resolvedInputHash); assert.equal(next.epoch, old.epoch + 1);
  await assert.rejects(f.ops.dispatchTask(old.task.taskId, dispatchInput(f, old), first.ctx()), { code: "TASK_EPOCH_STALE" });
  const late = await f.ops.completeTask(old.task.taskId, { ...leaseIdentity(old), resultManifest: { schema: "pengmanager.task-result/v1", executed: true, dryRun: false, data: isolatedTaskData(old), artifacts: [] }, executionReceipts: [{ executed: true }] }, first.ctx());
  assert.equal(late.status, "quarantined"); assert.equal(f.store.snapshot().productionTaskAttempts.find(attempt => attempt.id === next.attemptId).status, "claimed");
});

test("a dispatched unknown is never automatically reclaimed or recharged after lease expiry and recovery", async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), worker = await pairOpsWorker(f, [job.id]);
  const lease = await claimOpsTask(f, worker), permit = await f.ops.dispatchTask(lease.task.taskId, dispatchInput(f, lease), worker.ctx());
  f.advance(61_000); await f.ops.recover(opsContext()); assert.equal(await claimOpsTask(f, worker), null);
  const state = f.store.snapshot(); assert.equal(state.productionTaskAttempts.find(attempt => attempt.id === lease.attemptId).status, "unknown"); assert.equal(state.modelBudgetReservations.find(row => row.id === permit.reservationId).status, "unknown_usage"); assert.equal(state.modelBudgetReservations.length, 1);
});

test("strategy needs-input blocks all downstream work; two initial repair rounds are real bounded calls, never a silent pass", async t => {
  const f = await contentOpsFixture(t), first = await createOpsJob(f), writer = await pairOpsWorker(f, [first.job.id]);
  const strategy = await claimOpsTask(f, writer); await completeOpsTask(f, writer, strategy, { data: { decision: "needs_input", rationale: "Missing real author input in isolated test", outline: [], requiredInputs: ["author input"], skipReason: null } });
  assert.equal(await claimOpsTask(f, writer), null); assert.equal(f.ops.getJob(first.job.id, opsContext()).status, "needs_input");
  const second = await createOpsJob(f, { goal: "隔离有待纠正的事实验证" }), repairWriter = await pairOpsWorker(f, [second.job.id]), checker = await pairOpsWorker(f, [second.job.id], { checker: true });
  for (let round = 0; round < 30; round++) {
    let progressed = false;
    for (const worker of [repairWriter, checker]) { const lease = await claimOpsTask(f, worker); if (!lease) continue; const data = isolatedTaskData(lease); if (lease.task.kind === "quality.check") data.findings = [{ severity: "major", dimension: "facts", code: "ISOLATED_MISSING_QUALIFIER", message: "Isolated test keeps this issue unresolved through both repairs.", location: "body" }]; await completeOpsTask(f, worker, lease, { data }); progressed = true; }
    if (!progressed) break;
  }
  const result = f.ops.getJob(second.job.id, opsContext()); assert.equal(result.status, "needs_input"); assert.equal(result.candidates.length, 0);
  assert.equal(result.attempts.filter(attempt => result.tasks.find(task => task.taskId === attempt.taskId)?.kind === "text.revise" && attempt.status === "succeeded").length, 2);
  assert.equal(result.tasks.filter(task => task.kind === "text.polish")[0].status, "queued"); assert.equal(result.reservations.length, 7);
});

test("invalid dates, currencies, unknown billable dimensions and immutable budget replacement all fail before dispatch", async t => {
  const f = await contentOpsFixture(t), initial = f.store.snapshot().modelBudgetAuthorizations.length;
  for (const expiry of ["not-a-date", "", "2020-01-01T00:00:00.000Z"]) await assert.rejects(f.ops.createBudget(boundedBudget({ pricingSnapshot: { ...FIXTURE_PRICING, expiresAt: expiry } }), opsContext()), { code: "PRICING_REQUIRED" });
  await assert.rejects(f.ops.createBudget(boundedBudget({ deadlineAt: "invalid" }), opsContext()), { code: "BUDGET_CONFIG_REQUIRED" });
  await assert.rejects(f.ops.createBudget(boundedBudget({ currency: "CNY" }), opsContext()), { code: "CURRENCY_MISMATCH" });
  await assert.rejects(f.ops.createBudget(boundedBudget({ pricingSnapshot: { ...FIXTURE_PRICING, coveredBillingDimensions: ["inputTokens", "outputTokens", "unbounded_tool_fee"] } }), opsContext()), { code: "PRICING_REQUIRED" });
  assert.equal(f.store.snapshot().modelBudgetAuthorizations.length, initial);
  const profile = f.ops.profiles().profiles.find(row => row.platformId === "official-site");
  await assert.rejects(f.ops.createRuleSnapshot({ platformId: "official-site", destinationId: "official-site", policy: profile.policy, sources: [{ url: "https://pengmanager.com/isolated", title: "fixture", scope: "test" }], checkedAt: f.clock().toISOString(), expiresAt: "invalid", reviewed: true, note: "Invalid expiry test" }, opsContext()), { code: "RULES_CHANGED" });
});
