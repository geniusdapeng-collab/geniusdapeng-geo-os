import bundled from "../../data/content-operators.json" with { type: "json" };
import { hashObject } from "./hash.mjs";
import { ApiError } from "./errors.mjs";
import { platformCatalog } from "./platform-catalog.mjs";

export const CONTENT_OPS_COLLECTIONS = Object.freeze(["operatorProfiles", "ruleSnapshots", "styleVersions", "styleMemoryCandidates", "authorContributions", "adaptationPlanImports", "adaptationPlans", "contentOpsJobs", "contentOpsTargetRuns", "productionTaskBlueprints", "productionTaskAttempts", "productionWorkers", "workerGrants", "workerPairings", "productionArtifacts", "nativeCandidatePackages", "contentQualityReports", "modelBudgetAuthorizations", "modelBudgetReservations", "modelUsageReconciliations", "formatLineage", "draftMaterializations", "contentResultObservations", "contentOpsRequests", "modelPricingSnapshots"]);
export const AI_ACTIONS = Object.freeze(["research", "outline", "copyedit", "translate", "draft", "generate_media"]);
export const NATIVE_FORMS = Object.freeze(["article", "image_text", "video", "thread", "document", "repository_change", "model_card", "dataset_card", "notebook", "demo_bundle", "community_message"]);
export const SHA256 = /^[a-f0-9]{64}$/;
export const OPS_VERSION = "pengmanager.content-ops/v1";
export const fail = (status, code, message, details) => { throw new ApiError(status, code, message, details); };
export function closed(value, fields, required = fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(400, "ADAPTATION_PLAN_INVALID", "必须提供普通 JSON 对象。");
  if (Object.keys(value).some(key => !fields.includes(key))) fail(400, "UNKNOWN_FIELD", "对象包含不支持的字段。");
  if (required.some(key => !Object.hasOwn(value, key))) fail(400, "ADAPTATION_PLAN_INVALID", "对象缺少必需字段。", { required });
  return value;
}
export function text(value, name, max = 2000, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail(400, "ADAPTATION_PLAN_INVALID", `${name} 文本无效或超限。`);
  if (/\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b|\b(?:cookie|set-cookie|sessionid|session_id)\s*[:=]\s*\S+|\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?\S{8,}/i.test(value)) fail(400, "CREDENTIALS_NOT_ALLOWED", "凭据或会话不能写入内容准备资料。");
  return value;
}
export function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, "ADAPTATION_PLAN_INVALID", `${name} 必须是范围内的安全整数。`);
  return value;
}
export function oneOf(value, values, name) { if (!values.includes(value)) fail(400, "ADAPTATION_PLAN_INVALID", `${name} 不在允许范围内。`); return value; }
export function list(value, name, max = 256, min = 0) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(400, "ADAPTATION_PLAN_INVALID", `${name} 项数无效。`); return value; }
export function id(value) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) fail(400, "ADAPTATION_PLAN_INVALID", "业务标识符无效。"); return value; }
export function sha(value) { if (!SHA256.test(value ?? "")) fail(400, "ADAPTATION_PLAN_INVALID", "必须提供准确 SHA256。"); return value; }
export function validDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function record(rows, value, code = "SOURCE_NOT_FOUND") { const row = (rows ?? []).find(item => item.id === value); if (!row) fail(404, code, "准确来源对象不存在。"); return row; }
export function without(row, keys) { return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))); }
export function contentOpsEtag(row) { return `"${hashObject(without(row, ["etag"]))}"`; }
export function contentOpsRef(row) { return { id: row.id, revision: row.revision ?? row.editorialRevision ?? row.identityVersion ?? 1, sha256: row.snapshotHash ?? row.authorizationHash ?? row.hash ?? row.sha256 ?? hashObject(without(row, ["etag"])) }; }
export function checkRef(ref, row, code = "SOURCE_OUTDATED") { closed(ref, ["id", "revision", "sha256"]); id(ref.id); integer(ref.revision, "revision", 1); sha(ref.sha256); if (hashObject(ref) !== hashObject(contentOpsRef(row))) fail(409, code, "引用的准确版本或摘要已改变。", { id: ref.id }); return row; }
export function assertMatch(row, etag) { if (!etag) fail(428, "PRECONDITION_REQUIRED", "需要准确 If-Match。"); if (etag !== contentOpsEtag(row)) fail(412, "PRECONDITION_FAILED", "对象版本已经改变。", { etag: contentOpsEtag(row) }); }
export function contentOpsTargetKey(target) { return hashObject({ platformId: target.platformId, destinationId: target.destinationRef?.id ?? target.destinationId, accountId: target.accountRef?.id ?? target.accountId ?? null, locale: target.locale, nativeForm: target.nativeForm }); }
export function contentOpsClaimFingerprint(claim) { return hashObject({ id: claim.id, type: claim.type ?? null, text: claim.text, source: claim.source ?? null, evidenceLevel: claim.evidenceLevel ?? null, sensitivity: claim.sensitivity ?? null, expiresAt: claim.expiresAt ?? null }); }
export function hashPlan(plan) { return hashObject(without(plan, ["containsCommands", "planHash"])); }
export function hashTask(task) { return hashObject(without(task, ["taskHash", "etag", "status", "attemptId", "epoch", "resolvedInputRefs", "resolvedInputHash", "resolvedInputData", "createdAt"])); }
export function hashBlueprint(tasks) { return hashObject(tasks.map(task => ({ taskId: task.taskId, taskHash: task.taskHash }))); }
export function contentOpsPackageHash(value) { return hashObject(without(value, ["packageHash"])); }
export function contentOpsReportHash(value) { return hashObject(without(value, ["reportHash"])); }
export function contentOpsReviewEnvelope(packageHash, qualityReportHashes, checkContextHash) { return { schema: "pengmanager.review-envelope/v1", packageHash, qualityReportHashes, checkContextHash }; }
export function contentOpsSourceBundle(plan) { return hashObject({ storyRef: plan.storyRef, motherEditionRefs: plan.motherEditionRefs, claimBindings: plan.claimBindings }); }
export function accountIdentity(row) { return { id: row.id, platform: row.platform, platformId: row.platformId ?? null, handle: row.handle, profileUrl: row.profileUrl ?? "", identityVersion: row.identityVersion ?? 1 }; }
export function destinationIdentity(row) { return { id: row.id, platformId: row.platformId, accountId: row.accountId ?? null, kind: row.kind, locator: row.locator, visibility: row.visibility, identityVersion: row.identityVersion }; }
export function initializeContentOpsState(state) {
  for (const key of CONTENT_OPS_COLLECTIONS) { if (state[key] === undefined) state[key] = []; else if (!Array.isArray(state[key])) fail(500, "CONTENT_OPS_STATE_INVALID", "内容运营集合结构无效。"); }
  if (!state.operatorProfiles.length) for (const profile of bundled.profiles) { const row = structuredClone(profile); row.hash = hashObject(row); state.operatorProfiles.push(row); }
  return state;
}
export function assertContentOpsStateIntegrity(state) {
  if (state.schemaVersion !== 3) return;
  const invalid = () => fail(500, "CONTENT_OPS_STATE_INVALID", "内容运营持久状态完整性校验失败。");
  if (!Array.isArray(state.migrations) || !state.migrations.some(row => row.id === "content-operators-v1")) invalid();
  for (const key of CONTENT_OPS_COLLECTIONS) {
    if (!Array.isArray(state[key])) invalid();
    if (state[key].some(row => !row || typeof row !== "object" || Array.isArray(row))) invalid();
    const ids = state[key].filter(row => row.id !== undefined).map(row => row.id);
    if (new Set(ids).size !== ids.length) invalid();
  }
  const catalog = platformCatalog().platforms;
  if (state.operatorProfiles.length < 28 || catalog.some(row => !state.operatorProfiles.some(profile => profile.platformId === row.id))) invalid();
  for (const row of state.operatorProfiles) if (hashObject(without(row, ["hash"])) !== row.hash) invalid();
  for (const row of [...state.adaptationPlanImports, ...state.adaptationPlans]) if (!row.normalizedPlan || row.normalizedPlan.schema !== "pengmanager.adaptation-plan/v1" || row.normalizedPlan.mode !== "prepare" || row.normalizedPlan.containsCommands !== false || hashPlan(row.normalizedPlan) !== row.planHash || !state.stories.some(story => story.id === row.normalizedPlan.storyRef?.id)) invalid();
  for (const row of state.adaptationPlanImports) if (!validDate(row.expiresAt) || !SHA256.test(row.rawSha256) || !row.sourceBindings) invalid();
  const taskIds = state.productionTaskBlueprints.map(task => task.taskId); if (new Set(taskIds).size !== taskIds.length) invalid();
  for (const task of state.productionTaskBlueprints) if (hashTask(task) !== task.taskHash || !state.contentOpsJobs.some(row => row.id === task.jobId)) invalid();
  for (const job of state.contentOpsJobs) {
    const tasks = state.productionTaskBlueprints.filter(task => task.jobId === job.id);
    const plan = state.adaptationPlans.find(plan => plan.id === job.planId), budget = state.modelBudgetAuthorizations.find(row => row.id === job.budgetAuthorizationId);
    if (hashBlueprint(tasks) !== job.blueprintHash || !plan || plan.planHash !== job.planHash || plan.normalizedPlan.storyRef.id !== job.storyId || !plan.inputBindings || (plan.normalizedPlan.budgetAuthorizationRef === null ? job.budgetAuthorizationId !== null || job.budgetAuthorizationHash !== null : !budget || plan.normalizedPlan.budgetAuthorizationRef.id !== budget.id || job.budgetAuthorizationHash !== budget.authorizationHash) || tasks.some(task => task.budgetAuthorizationHash !== job.budgetAuthorizationHash)) invalid();
    const done = new Set(), visiting = new Set();
    const visit = task => { if (visiting.has(task.taskId)) invalid(); if (done.has(task.taskId)) return; visiting.add(task.taskId); for (const dep of task.dependsOn) { const parent = tasks.find(row => row.taskId === dep); if (!parent) invalid(); visit(parent); } visiting.delete(task.taskId); done.add(task.taskId); };
    tasks.forEach(visit);
  }
  for (const attempt of state.productionTaskAttempts) {
    const task = state.productionTaskBlueprints.find(task => task.taskId === attempt.taskId && task.taskHash === attempt.taskHash);
    if (!task || task.jobId !== attempt.jobId || task.targetKey !== attempt.targetKey || !Number.isSafeInteger(attempt.epoch) || attempt.epoch < 1 || !Array.isArray(attempt.reservationIds) || hashObject({ taskHash: attempt.taskHash, resolvedInputRefs: attempt.resolvedInputRefs }) !== attempt.resolvedInputHash) invalid();
    if (attempt.workerId !== "server" && (!state.productionWorkers.some(worker => worker.id === attempt.workerId) || !state.workerGrants.some(grant => grant.id === attempt.grantId && grant.workerId === attempt.workerId && grant.scopeHash === attempt.scopeHash) || !validDate(attempt.leaseExpiresAt))) invalid();
    if (attempt.workerId === "server" && (attempt.reservationIds.length || !["skipped", "succeeded"].includes(attempt.status) || task.kind !== "package.freeze" && !task.conditionalRepair && !task.conditionalCheck)) invalid();
    if (attempt.status === "skipped" && (attempt.workerId !== "server" || attempt.resultManifest?.executed !== false || !attempt.reusedAttemptId || attempt.executionReceipts.length)) invalid();
    if (attempt.reservationIds.some(id => !state.modelBudgetReservations.some(reservation => reservation.id === id && reservation.attemptId === attempt.id))) invalid();
  }
  for (const task of state.productionTaskBlueprints) {
    const attempts = state.productionTaskAttempts.filter(row => row.taskId === task.taskId);
    if (attempts.some((attempt, index) => index > 0 && attempt.epoch <= attempts[index - 1].epoch) || attempts.filter(attempt => ["claimed", "running", "dispatch_recorded"].includes(attempt.status)).length > 1) invalid();
    if (!Array.isArray(task.outputSpec) || new Set(task.outputSpec.map(output => output.outputKey)).size !== task.outputSpec.length || task.inputRefs.planHash !== state.contentOpsJobs.find(job => job.id === task.jobId)?.planHash) invalid();
    if (task.kind === "format.transform") {
      const job = state.contentOpsJobs.find(row => row.id === task.jobId), plan = state.adaptationPlans.find(row => row.id === job.planId).normalizedPlan, policy = task.neutralPolicy;
      if (!policy || hashObject(policy) !== task.inputRefs.effectivePolicyHash || !Array.isArray(task.neutralTargetKeys) || !task.neutralTargetKeys.length || new Set(task.neutralTargetKeys).size !== task.neutralTargetKeys.length || !task.neutralTargetKeys.includes(task.targetKey) || !Array.isArray(task.neutralAuthorContributionRefs)) invalid();
      for (const targetKey of task.neutralTargetKeys) {
        const target = plan.targets.find(row => row.targetKey === targetKey), run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === targetKey);
        if (!target || !run?.taskIds.includes(task.taskId) || policy.allowedAiActions.some(action => !run.effectivePolicy.allowedAiActions.includes(action)) || run.effectivePolicy.requiresAuthorContribution && !policy.requiresAuthorContribution || task.neutralAuthorContributionRefs.some(ref => !target.authorContributionRefs.some(other => hashObject(other) === hashObject(ref)))) invalid();
      }
      if (policy.requiresAuthorContribution && (!task.neutralAuthorContributionRefs.length || policy.allowedAiActions.includes("draft")) || hashObject(task.transformSpec.authority) !== hashObject({ allowedAiActions: policy.allowedAiActions, requiresAuthorContribution: policy.requiresAuthorContribution, authorContributionRefs: task.neutralAuthorContributionRefs })) invalid();
    }
  }
  const targets = state.contentOpsTargetRuns.map(row => `${row.jobId}:${row.targetKey}`); if (new Set(targets).size !== targets.length) invalid();
  for (const row of state.contentOpsTargetRuns) if (!state.contentOpsJobs.some(job => job.id === row.jobId) || !SHA256.test(row.targetKey) || !Array.isArray(row.taskIds) || row.taskIds.some(taskId => !state.productionTaskBlueprints.some(task => task.taskId === taskId && task.jobId === row.jobId))) invalid();
  const calls = state.modelBudgetReservations.map(row => `${row.attemptId}:${row.callKey}`); if (new Set(calls).size !== calls.length) invalid();
  for (const row of state.nativeCandidatePackages) {
    const job = state.contentOpsJobs.find(job => job.id === row.jobId), pkg = row.package;
    if (!job || row.planId !== job.planId || !state.contentOpsTargetRuns.some(run => run.id === row.targetRunId && run.jobId === row.jobId && run.targetKey === row.targetKey) || contentOpsPackageHash(pkg) !== row.packageHash || pkg.packageHash !== row.packageHash || pkg.candidateId !== row.id || pkg.targetKey !== row.targetKey || pkg.adaptationPlanHash !== job.planHash || pkg.compiledBlueprintHash !== job.blueprintHash || !Array.isArray(pkg.artifactRefs) || pkg.artifactRefs.some(ref => !state.productionArtifacts.some(artifact => artifact.id === ref.id && artifact.sha256 === ref.sha256 && artifact.mime === ref.mime && artifact.bytes === ref.bytes && artifact.commitStatus === "committed"))) invalid();
    if (row.reviewEnvelope && (row.reviewEnvelope.packageHash !== row.packageHash || hashObject(row.reviewEnvelope) !== row.reviewSnapshotHash || hashObject(row.reviewEnvelope.qualityReportHashes) !== hashObject(row.qualityReportHashes) || row.qualityReportHashes.some(hash => !state.contentQualityReports.some(report => report.reportHash === hash && report.candidateId === row.id)))) invalid();
  }
  for (const row of state.contentQualityReports) if (contentOpsReportHash(row) !== row.reportHash || !state.nativeCandidatePackages.some(candidate => candidate.id === row.candidateId && candidate.packageHash === row.checkedPackageHash)) invalid();
  for (const row of state.modelBudgetAuthorizations) if (hashObject(without(row, ["authorizationHash", "etag"])) !== row.authorizationHash || !validDate(row.deadlineAt) || !/^[A-Z]{3}$/.test(row.currency) || ["maxCalls", "maxInputTokens", "maxOutputTokens", "maxPerCallInputTokens", "maxPerCallOutputTokens", "maxInFlight", "maxCostMicros", "maxRenderSeconds", "maxTempBytes", "maxNativeProcesses"].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0) || row.pricingSnapshotHash !== null && !state.modelPricingSnapshots.some(pricing => pricing.hash === row.pricingSnapshotHash && pricing.currency === row.currency)) invalid();
  for (const row of state.modelPricingSnapshots) if (hashObject(without(row, ["hash", "etag"])) !== row.hash || !validDate(row.expiresAt) || !validDate(row.verifiedAt) || ["inputCostMicrosPerMillion", "outputCostMicrosPerMillion", "requestCostMicros"].some(key => !Number.isSafeInteger(row[key]) || row[key] < 0)) invalid();
  for (const row of state.modelBudgetReservations) {
    const attempt = state.productionTaskAttempts.find(attempt => attempt.id === row.attemptId), budget = state.modelBudgetAuthorizations.find(budget => budget.id === row.budgetAuthorizationId);
    if (!attempt || !attempt.reservationIds.includes(row.id) || attempt.jobId !== row.jobId || attempt.taskId !== row.taskId || !budget || row.authorizationHash !== budget.authorizationHash || row.currency !== budget.currency || !row.reserved || !row.actual || ["inputTokens", "outputTokens", "costMicros", "renderSeconds", "tempBytes", "nativeProcesses"].some(key => !Number.isSafeInteger(row.reserved[key]) || row.reserved[key] < 0) || ["inputTokens", "outputTokens", "costMicros"].some(key => row.actual[key] !== null && (!Number.isSafeInteger(row.actual[key]) || row.actual[key] < 0)) || row.costClass === "model" && !state.modelPricingSnapshots.some(pricing => pricing.hash === row.pricingSnapshotHash && pricing.provider === row.provider && pricing.model === row.model)) invalid();
  }
  for (const row of state.productionWorkers) if (!SHA256.test(row.credentialHash ?? "") || !validDate(row.expiresAt)) invalid();
  if (new Set(state.productionWorkers.map(row => row.credentialHash)).size !== state.productionWorkers.length) invalid();
  for (const row of state.workerGrants) if (!state.productionWorkers.some(worker => worker.id === row.workerId) || !SHA256.test(row.scopeHash) || !SHA256.test(row.localGrantHash) || hashObject(row.scope) !== row.scopeHash || !validDate(row.expiresAt) || !Array.isArray(row.scope.jobIds) || row.scope.jobIds.some(id => !state.contentOpsJobs.some(job => job.id === id))) invalid();
  for (const row of state.workerPairings) if (!SHA256.test(row.challengeHash) || !SHA256.test(row.scopeHash) || hashObject(row.scope) !== row.scopeHash || !validDate(row.expiresAt)) invalid();
  for (const row of state.productionArtifacts) {
    if (!SHA256.test(row.sha256) || !Number.isSafeInteger(row.bytes ?? row.size) || (row.bytes ?? row.size) < 1 || row.bytes !== row.size || (row.commitStatus === "committed" && row.committed !== true)) invalid();
    if (row.origin === "administrator_upload") { if (row.taskId !== null || row.attemptId !== null || !state.stories.some(story => story.id === row.storyId) || !row.sourceUploadId) invalid(); }
    else { const attempt = state.productionTaskAttempts.find(attempt => attempt.id === row.attemptId), task = state.productionTaskBlueprints.find(task => task.taskId === row.taskId); if (!attempt || !task || attempt.taskId !== task.taskId || row.jobId !== task.jobId || !task.outputSpec.some(output => output.outputKey === row.outputKey && output.role === row.role && output.allowedMimes.includes(row.mime) && row.bytes <= output.maxBytes)) invalid(); }
    if (row.mediaAssetId && !state.mediaAssets.some(asset => asset.id === row.mediaAssetId && asset.sha256 === row.sha256)) invalid();
    if (row.status === "reviewed" && (!row.review || row.review.sha256 !== row.sha256 || row.review.rightsConfirmed !== true || row.review.privacyConfirmed !== true || row.review.licenseConfirmed !== true || !SHA256.test(row.rightsReviewHash) || !SHA256.test(row.privacyReviewHash))) invalid();
  }
  for (const key of ["ruleSnapshots", "styleVersions", "authorContributions"]) for (const row of state[key]) if (hashObject(without(row, ["hash", "etag"])) !== row.hash) invalid();
  for (const row of state.authorContributions) if (!state.stories.some(story => story.id === row.storyId && row.storyRef?.id === story.id) || !row.body || !row.authoredBy) invalid();
  for (const row of state.ruleSnapshots) if (!state.destinations.some(destination => destination.id === row.destinationId && destination.platformId === row.platformId) || !validDate(row.expiresAt)) invalid();
  for (const row of state.styleVersions) if (!state.destinations.some(destination => destination.id === row.scope?.destinationId) || row.supersedes && !state.styleVersions.some(previous => previous.id === row.supersedes && hashObject(previous.scope) === hashObject(row.scope) && previous.revision < row.revision)) invalid();
  for (const row of state.modelUsageReconciliations) if (!state.modelBudgetReservations.some(reservation => reservation.id === row.reservationId && reservation.attemptId === row.attemptId) || hashObject(without(row, ["hash"])) !== row.hash) invalid();
}
