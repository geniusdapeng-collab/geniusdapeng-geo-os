import { randomUUID, randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { editorialFixture, readyWebsite, createEditionVariant, context, FIXED_TIME } from "./editorial-fixtures.mjs";
import { createEditorialBackup } from "../src/services/editorial-backup.mjs";
import { migrateContentOpsState } from "../src/services/content-ops-migration.mjs";
import { ProductionArtifacts } from "../src/services/production-artifacts.mjs";
import { ContentOpsService } from "../src/services/content-ops-service.mjs";
import { contentOpsAdapterBindings } from "../src/content-ops-worker/adapters.mjs";
import { contentOpsRef, contentOpsEtag } from "../src/domain/content-ops.mjs";
import { hashObject, hashText } from "../src/domain/hash.mjs";
import { qualityTextKeys } from "../src/domain/content-ops-quality.mjs";

export const opsContext = (row, actor = "isolated content administrator", key = randomUUID()) => ({ method: "local", actor, idempotencyKey: key, ...(row ? { ifMatch: row.etag ?? contentOpsEtag(row) } : {}) });
export const OPS_NOW = FIXED_TIME;
export const OPS_EXPIRY = "2026-10-25T12:00:00.000Z";
export const FIXTURE_PRICING = Object.freeze({ provider: "isolated_fixture", model: "isolated_no_paid_model", currency: "USD", unit: "million_tokens", inputCostMicrosPerMillion: 1_000_000, outputCostMicrosPerMillion: 1_000_000, requestCostMicros: 0, coveredBillingDimensions: ["inputTokens", "outputTokens", "reasoningIncludedInOutput", "cacheChargedAtInputUpperBound"], verifiedAt: FIXED_TIME.toISOString(), expiresAt: OPS_EXPIRY, sourceUrl: "https://pengmanager.com/isolated-test-only-price", reviewed: true });

// These fixtures create real private state files, real full backups and the
// actual additive migration. Model results remain explicitly isolated test
// doubles. They neither contact a supplier nor establish a live price/output.
export async function contentOpsFixture(t, { allDestinations = false } = {}) {
  const f = await editorialFixture(t); let now = new Date(OPS_NOW);
  await readyWebsite(f); const { story, edition } = await createEditionVariant(f);
  const artifacts = new ProductionArtifacts({ store: f.store }); await artifacts.initialize();
  const backup = createEditorialBackup({ store: f.store, productionArtifacts: artifacts, clock: () => new Date(now) });
  await migrateContentOpsState(f.store, { clock: () => new Date(now), beforeMigration: () => backup.captureCurrent() });
  const bindings = await contentOpsAdapterBindings(), ops = new ContentOpsService({ store: f.store, artifactStore: artifacts, clock: () => new Date(now), adapterBindings: bindings });
  Object.assign(f, { ops, artifacts, bindings, backup, storyId: story.id, editionId: edition.id, clock: () => new Date(now), advance: milliseconds => { now = new Date(now.getTime() + milliseconds); } });
  const budget = await ops.createBudget({ name: "Isolated no paid calls test budget", maxCalls: 500, maxInputTokens: 1_000_000, maxOutputTokens: 500_000, maxPerCallInputTokens: 131_072, maxPerCallOutputTokens: 500, maxInFlight: 2, currency: "USD", maxCostMicros: 2_000_000, deadlineAt: OPS_EXPIRY, maxRenderSeconds: 10_000, maxTempBytes: 1_000_000_000, maxNativeProcesses: 2, pricingSnapshot: FIXTURE_PRICING }, opsContext());
  f.budget = budget;
  await ops.createAuthorContribution({ storyRef: contentOpsRef(f.store.snapshot().stories.find(row => row.id === story.id)), title: "真实隔离作者测试原稿", body: "我在这份隔离测试中亲自记录了实现、限制与核对过程。它是测试作者输入，不是线上客户经历。", locale: "zh-CN", sourceNote: "Human authored isolated test material; no business assertion.", authoredBy: "isolated fixture author" }, opsContext());
  f.destinationIds = { "official-site": "official-site" };
  if (allDestinations) for (const profile of ops.profiles().profiles.filter(row => row.platformId !== "official-site")) {
    const platformId = profile.platformId;
    let account = await f.service.createAccount({ platformId, handle: `isolated-${platformId}`, profileUrl: `https://pengmanager.com/isolated-account/${platformId}`, language: "zh-CN", displayName: "Isolated fictional test account" }, context());
    account = await f.service.updateAccount(account.id, { status: "active", identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: OPS_NOW.toISOString(), reviewNote: "Isolated test identity only, never a live platform verification." }, context(account));
    const kind = ["github", "huggingface", "modelscope", "kaggle"].includes(platformId) ? "repository" : platformId === "discord" ? "community_channel" : platformId === "reddit" ? "community" : "profile_feed";
    const locator = kind === "repository" ? { url: `https://pengmanager.com/isolated-repository/${platformId}` } : kind === "community_channel" ? { serverId: "123456789", channelId: "987654321" } : kind === "community" ? { url: "https://reddit.com/r/isolated_fixture" } : { url: account.profileUrl };
    let destination = await f.service.createDestination({ platformId, accountId: account.id, kind, name: `Isolated ${platformId} destination`, locator, visibility: "public" }, context());
    destination = await f.service.updateDestination(destination.id, { status: "active", identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: OPS_NOW.toISOString(), reviewNote: "Synthetic destination isolated from all live platforms." }, context(destination));
    f.destinationIds[platformId] = destination.id;
  }
  for (const [platformId, destinationId] of Object.entries(f.destinationIds)) {
    const profile = ops.profiles().profiles.find(row => row.platformId === platformId);
    await ops.createRuleSnapshot({ platformId, destinationId, policy: profile.policy, sources: [{ url: "https://pengmanager.com/isolated-fixture-policy", title: "Isolated policy fixture", scope: "Test-only rules, not live account permission or platform policy evidence." }], checkedAt: OPS_NOW.toISOString(), expiresAt: OPS_EXPIRY, reviewed: true, note: "Isolated explicit administrator rule snapshot." }, opsContext());
  }
  return f;
}
export async function createOpsJob(f, { targets = [{ destinationId: f.destinationIds["official-site"], locale: "zh-CN", nativeForm: "article" }], sourceArtifactIds = [], nativeInputs = [], budgetId = f.budget.id, goal = "核对真实原稿、事实与独立审核流程" } = {}) {
  const template = f.ops.planTemplate({ storyId: f.storyId, motherEditionIds: [f.editionId], targets, goal, budgetAuthorizationId: budgetId, sourceArtifactIds, nativeInputs }, opsContext());
  const imported = await f.ops.validatePlanImport({ rawPlanJson: JSON.stringify(template.plan) }, opsContext());
  const job = await f.ops.createJob({ validatedImportId: imported.id, planHash: imported.planHash, budgetAuthorizationHash: imported.normalizedPlan.budgetAuthorizationRef?.sha256 ?? null, mode: "prepare" }, opsContext(f.store.snapshot().stories.find(row => row.id === f.storyId)));
  return { template, imported, job };
}
export async function pairOpsWorker(f, jobIds, { checker = false, targetKeys = [], workerId = `fixture-${checker ? "checker" : "writer"}-${randomBytes(4).toString("hex")}` } = {}) {
  const pairing = await f.ops.createPairing({ workerId, origin: "https://pengmanager.com", workspaceId: "isolated-fixture", projectIds: ["isolated-fixture"], jobIds, targetKeys, adapterIds: f.bindings.map(binding => binding.adapterId), expiresAt: OPS_EXPIRY, maxTempBytes: 1_000_000_000, maxRenderSeconds: 10_000, maxNativeProcesses: 2, checker }, opsContext());
  const credential = randomBytes(32).toString("base64url"), confirmed = await f.ops.confirmPairing({ challengeId: pairing.challengeId, challenge: pairing.challenge, scopeHash: pairing.scopeHash, localGrantHash: hashObject({ ownerConfirmed: true, scope: pairing.scope, fixtureOnly: true }), credentialHash: hashText(credential) }, { method: "pairing", actor: "one-time pairing", idempotencyKey: randomUUID() });
  const identity = f.ops.authenticateWorker(credential), readiness = f.bindings.map(binding => ({ ...binding, ready: true, checkedAt: f.clock().toISOString(), expiresAt: OPS_EXPIRY, proofHash: hashObject({ isolatedReadiness: binding }) }));
  return { ctx: key => ({ ...identity, idempotencyKey: key ?? randomUUID() }), identity, workerId, confirmed, credential, readiness };
}
export function leaseIdentity(lease) { return Object.fromEntries(["attemptId", "epoch", "taskHash", "resolvedInputHash"].map(key => [key, lease[key]])); }
export async function claimOpsTask(f, worker) { return f.ops.claimTask({ workerId: worker.workerId, adapterReadinessRefs: worker.readiness, maxTasks: 1 }, worker.ctx()); }
export async function completeOpsTask(f, worker, lease, { data, artifacts = [] } = {}) {
  const paid = lease.task.costClass === "model", requestHash = hashObject({ isolatedFixtureAttempt: lease.attemptId, data }), identity = leaseIdentity(lease);
  const permit = await f.ops.dispatchTask(lease.task.taskId, { ...identity, callKey: "fixture.1", requestHash, provider: paid ? FIXTURE_PRICING.provider : null, model: paid ? FIXTURE_PRICING.model : null, pricingSnapshotHash: paid ? f.budget.pricingSnapshotHash : null, upperBound: { inputTokens: paid ? 100 : 0, outputTokens: paid ? 100 : 0, renderSeconds: 0, tempBytes: artifacts.reduce((sum, artifact) => sum + artifact.bytes.length, 0), nativeProcesses: 0 } }, worker.ctx());
  if (!permit.execute) throw new Error("Fixture unexpectedly received a replay permit.");
  const providerRequestId = paid ? `isolated-request-${lease.attemptId}` : null;
  await f.ops.settleCall(permit.reservationId, { attemptId: lease.attemptId, providerRequestId, usage: { inputTokens: paid ? 10 : 0, outputTokens: paid ? 10 : 0, costMicros: paid ? null : 0, currency: "USD" }, usageReceipt: { kind: paid ? "provider_response_usage" : "local_execution_receipt", providerRequestId, sha256: hashObject({ fixtureOnly: true, requestHash, data }) } }, worker.ctx());
  const refs = [];
  for (const output of artifacts) { const hash = createHash("sha256").update(output.bytes).digest("hex"), result = await f.ops.uploadArtifact(lease.task.taskId, Readable.from([output.bytes]), { ...identity, mime: output.mime, size: output.bytes.length, sha256: hash, role: output.role, name: output.name ?? output.outputKey, outputKey: output.outputKey }, worker.ctx()); refs.push({ artifactId: result.id, sha256: result.sha256, outputKey: output.outputKey }); }
  return f.ops.completeTask(lease.task.taskId, { ...identity, resultManifest: { schema: "pengmanager.task-result/v1", executed: true, dryRun: false, data, artifacts: refs, outputHash: hashObject({ data, artifacts: refs }) }, executionReceipts: [{ kind: "isolated_fixture_execution", executed: true, dryRun: false, sha256: requestHash }] }, worker.ctx());
}
export function isolatedTaskData(lease) {
  if (lease.task.kind === "strategy.plan") return { decision: "prepare", rationale: "Isolated source is suitable.", outline: ["Evidence", "Limitations"], requiredInputs: [], skipReason: null };
  if (["quality.check", "quality.final"].includes(lease.task.kind)) return { checkedPackageHash: lease.resolvedInputData.packageHash, checkerVersion: "pengmanager.independent-checker/v1", checkContextHash: lease.resolvedInputData.checkContextHash ?? null, semanticFindings: [], coverage: { textKeys: lease.task.kind === "quality.final" ? qualityTextKeys(lease.resolvedInputData.package) : ["title", "summary", "body"], artifactHashes: [...new Set((lease.resolvedInputData.package?.artifactRefs ?? []).map(row => row.sha256))] }, dimensions: { deterministic: "passed", semantic: "passed", media: (lease.resolvedInputData.package?.artifactRefs?.length ?? 0) ? "unverified" : "passed", artistic: "passed" }, mediaEvidence: [], assessment: "Isolated independent test checker; no supplier request was made." };
  const locale = lease.task.transformSpec?.targetLocale ?? lease.resolvedInputData.target.locale, format = lease.task.transformSpec?.targetFormat ?? "article";
  return { title: "隔离测试中的完整成品", summary: "Isolated complete candidate.", body: "这是一份隔离测试中的完整正文。\n\n它保留真实母版、限定条件与独立检查，不代表线上发布或商业效果。", blocks: [{ type: "paragraph", text: "这是一份隔离测试中的完整正文。" }, { type: "paragraph", text: "它保留真实母版、限定条件与独立检查，不代表线上发布或商业效果。" }], claimMappings: [], disclosure: { aiUse: "generated_text" }, ...(lease.task.kind === "format.transform" ? { locale, format } : {}) };
}
export async function finishTextOpsJob(f, jobId) {
  const writer = await pairOpsWorker(f, [jobId]), checker = await pairOpsWorker(f, [jobId], { checker: true });
  for (let round = 0; round < 100; round++) {
    let progress = false;
    for (const worker of [writer, checker]) { const lease = await claimOpsTask(f, worker); if (lease) { await completeOpsTask(f, worker, lease, { data: isolatedTaskData(lease) }); progress = true; } }
    if (!progress) break;
  }
  return { job: f.ops.getJob(jobId, opsContext()), writer, checker };
}
export async function uploadOpsSource(f, { role, mime, bytes, name = `isolated-${role}` }) {
  const source = await f.artifacts.uploadSource(Readable.from([bytes]), { storyId: f.storyId, role, mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), name }, opsContext(f.store.snapshot().stories.find(row => row.id === f.storyId)));
  return f.artifacts.review(source.id, { sha256: source.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true, note: "Isolated generated fixture bytes; not customer or platform production evidence." }, opsContext(f.artifacts.getArtifact(source.id)));
}
