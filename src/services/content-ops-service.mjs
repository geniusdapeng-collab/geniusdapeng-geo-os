import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashObject, hashText } from "../domain/hash.mjs";
import { parseStrictJson } from "../domain/strict-json.mjs";
import { requirePublicUrl } from "../domain/public-url.mjs";
import { JsonStore } from "../storage/json-store.mjs";
import { AI_ACTIONS, OPS_VERSION, SHA256, closed, text, integer, list, id, sha, fail, record, without, initializeContentOpsState, contentOpsEtag, contentOpsRef, checkRef, assertMatch, contentOpsTargetKey, contentOpsClaimFingerprint, contentOpsSourceBundle, contentOpsPackageHash, contentOpsReportHash, contentOpsReviewEnvelope, accountIdentity, destinationIdentity, validDate } from "../domain/content-ops.mjs";
import { validateAdaptationPlan, validateRefShape } from "../domain/content-ops-plan.mjs";
import { compileContentOpsPlan } from "../domain/content-ops-compiler.mjs";
import { normalizeBudget, normalizePricing, reserveBudget, budgetTotals } from "../domain/content-ops-budget.mjs";
import { FINAL_CHECKER_VERSION, candidateCheckContext, qualityTextKeys, assertCandidateCurrentBindings, validateCandidateForReview } from "../domain/content-ops-quality.mjs";

const entity = row => ({ ...structuredClone(row), etag: contentOpsEtag(row), ref: contentOpsRef(row) });
const uid = prefix => `${prefix}-${randomBytes(12).toString("hex")}`;
const ADMIN = ["session", "local"];
const TERMINAL = ["cancelled", "deadline_exceeded", "completed", "failed"];
const publicWorker = row => without(row, ["credentialHash", "challengeHash"]);
const safeReason = value => text(value, "reason", 2000);
function safeResultStrings(value) {
  if (typeof value === "string") text(value, "result text", 100_000, true);
  else if (Array.isArray(value)) value.forEach(safeResultStrings);
  else if (value && typeof value === "object") Object.values(value).forEach(safeResultStrings);
}
const taskRecord = (state, taskId) => { const task = state.productionTaskBlueprints.find(row => row.taskId === taskId); if (!task) fail(404, "TASK_NOT_FOUND", "准确任务不存在。"); return task; };
function assertAdmin(ctx) { if (!ADMIN.includes(ctx?.method)) fail(403, "AGENT_SCOPE_DENIED", "内容准备管理操作需要管理员权限。"); }
function validatePolicy(policy) {
  closed(policy, ["creationMode", "deliveryMode", "allowedAiActions", "requiresAuthorContribution", "requiredConditions"]);
  if (!["ai_assisted_draft", "author_led_editor_assist", "human_original_copyedit", "human_only", "ineligible"].includes(policy.creationMode) || !["prepare_only", "manual_only", "separately_authorized", "ineligible"].includes(policy.deliveryMode) || typeof policy.requiresAuthorContribution !== "boolean") fail(400, "ADAPTATION_PLAN_INVALID", "规则政策轴无效。");
  list(policy.allowedAiActions, "allowedAiActions", 6).forEach(action => { if (!AI_ACTIONS.includes(action)) fail(400, "ADAPTATION_PLAN_INVALID", "规则 AI 动作无效。"); });
  list(policy.requiredConditions, "requiredConditions", 100).forEach(condition => text(condition, "condition", 500));
}

export class ContentOpsService {
  constructor({ store, clock = () => new Date(), artifactStore, sourceResolver = null, adapterBindings = [] }) {
    this.store = store; this.clock = clock; this.artifactStore = artifactStore; this.sourceResolver = sourceResolver; this.adapterBindings = structuredClone(adapterBindings);
  }
  state() { const state = this.store.snapshot(); if (state.schemaVersion !== 3) fail(503, "CONTENT_OPS_MIGRATION_REQUIRED", "内容运营需要完成 v3 迁移。"); return state; }
  async write(scope, input, ctx, handler, methods = ADMIN) {
    if (!methods.includes(ctx?.method)) fail(403, "AGENT_SCOPE_DENIED", "当前身份无此内容运营操作权限。");
    const actor = text(ctx.actor ?? (ctx.workerId ? `worker:${ctx.workerId}` : ""), "actor", 120);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(ctx.idempotencyKey ?? "")) fail(400, "IDEMPOTENCY_KEY_REQUIRED", "写入需要 8 到 128 位幂等键。");
    this.state(); const keyHash = hashObject({ actor, scope, key: ctx.idempotencyKey }), requestHash = hashObject(input), payload = { scope, requestHash };
    const { result } = await this.store.mutate({ type: `content_ops.${scope.split(":")[0]}`, actor, payload }, state => {
      const previous = state.contentOpsRequests.find(row => row.keyHash === keyHash);
      if (previous) { if (previous.requestHash !== requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "幂等键已用于不同请求。"); return JsonStore.noChange(previous.result); }
      const result = handler(state, { actor, now: this.clock(), payload });
      if (result && typeof result.then === "function") throw new Error("ContentOps transactions cannot perform asynchronous IO.");
      state.contentOpsRequests.push({ keyHash, requestHash, result: structuredClone(result), at: this.clock().toISOString() }); return result;
    }); return result;
  }
  profiles() { const state = this.state(); return { version: OPS_VERSION, profiles: state.operatorProfiles.map(entity) }; }
  bootstrap(ctx) {
    assertAdmin(ctx); const state = this.state();
    const sources = { stories: state.stories.map(entity), editions: state.editions.map(entity), claims: state.claims.filter(claim => claim.state === "approved").map(claim => ({ ...claim, fingerprint: contentOpsClaimFingerprint(claim) })), destinations: state.destinations.map(entity), accounts: state.accounts.map(entity), authorContributions: state.authorContributions.map(entity), rules: state.ruleSnapshots.map(entity), styles: state.styleVersions.map(entity) };
    return { schemaVersion: 3, ...sources, profiles: state.operatorProfiles.map(entity), jobs: state.contentOpsJobs.map(entity), targets: state.contentOpsTargetRuns.map(entity), budgetAuthorizations: state.modelBudgetAuthorizations.map(entity), budgets: state.modelBudgetAuthorizations.map(entity), pricingSnapshots: state.modelPricingSnapshots.map(entity), workers: state.productionWorkers.map(row => entity(publicWorker(row))), grants: state.workerGrants.map(row => entity(publicWorker(row))), candidates: state.nativeCandidatePackages.map(entity), qualityReports: state.contentQualityReports.map(entity), ruleSnapshots: sources.rules, styles: sources.styles, styleMemoryCandidates: state.styleMemoryCandidates.map(entity), sourceRefs: sources, sources, adapterBindings: this.adapterBindings };
  }
  listJobs(ctx) { assertAdmin(ctx); return { items: this.state().contentOpsJobs.map(entity) }; }
  listBudgets(ctx) { assertAdmin(ctx); return { items: this.state().modelBudgetAuthorizations.map(entity) }; }
  listWorkers(ctx) { assertAdmin(ctx); const state = this.state(); return { items: state.productionWorkers.map(row => entity(publicWorker(row))), grants: state.workerGrants.map(row => entity(publicWorker(row))) }; }
  getJob(jobId, ctx) {
    const state = this.state(), job = record(state.contentOpsJobs, jobId, "JOB_NOT_FOUND"); if (!ADMIN.includes(ctx?.method)) this.grant(state, ctx, job);
    const tasks = state.productionTaskBlueprints.filter(row => row.jobId === job.id).map(task => ({ ...task, id: task.taskId, status: this.taskStatus(state, task) }));
    return { ...entity(job), targets: state.contentOpsTargetRuns.filter(row => row.jobId === job.id), tasks, attempts: state.productionTaskAttempts.filter(row => row.jobId === job.id), reservations: state.modelBudgetReservations.filter(row => row.jobId === job.id), artifacts: state.productionArtifacts.filter(row => tasks.some(task => task.taskId === row.taskId)), candidates: state.nativeCandidatePackages.filter(row => row.jobId === job.id), reports: state.contentQualityReports.filter(row => row.jobId === job.id), budgetTotals: job.budgetAuthorizationId ? budgetTotals(state, job.budgetAuthorizationId) : null };
  }
  getCandidate(candidateId, ctx) { assertAdmin(ctx); const state = this.state(), candidate = record(state.nativeCandidatePackages, candidateId, "CANDIDATE_NOT_FOUND"); return { ...entity(candidate), requiredCoverage: { textKeys: qualityTextKeys(candidate.package), artifactHashes: [...new Set(candidate.package.artifactRefs.map(ref => ref.sha256))] }, reports: state.contentQualityReports.filter(row => row.candidateId === candidateId) }; }
  planTemplate(input, ctx) {
    assertAdmin(ctx); closed(input, ["storyId", "editionId", "motherEditionIds", "targets", "goal", "budgetAuthorizationId", "sourceArtifactIds", "nativeInputs"], ["storyId", "targets", "goal", "budgetAuthorizationId"]);
    const state = this.state(), story = record(state.stories, input.storyId), editionIds = input.motherEditionIds ?? (input.editionId ? [input.editionId] : []), editions = list(editionIds, "motherEditionIds", 12, 1).map(value => record(state.editions, value));
    if (editions.some(edition => edition.storyId !== story.id)) fail(400, "ADAPTATION_PLAN_INVALID", "母版不属于所选选题。");
    const claimIds = [...new Set(editions.flatMap(edition => edition.claimIds ?? []))];
    const plan = { schema: "pengmanager.adaptation-plan/v1", storyRef: contentOpsRef(story), motherEditionRefs: editions.map(contentOpsRef), claimBindings: claimIds.map(claimId => ({ claimId, fingerprint: contentOpsClaimFingerprint(record(state.claims, claimId)) })), sourceBundleHash: "", researchBundleRefs: [], goal: text(input.goal, "goal", 4000), targets: [], budgetAuthorizationRef: input.budgetAuthorizationId === null ? null : contentOpsRef(record(state.modelBudgetAuthorizations, input.budgetAuthorizationId)), mode: "prepare", containsCommands: false };
    const gaps = [], sourceArtifacts = list(input.sourceArtifactIds ?? [], "sourceArtifactIds", 100).map(artifactId => { const artifact = record(state.productionArtifacts, artifactId); if (artifact.storyId !== story.id || artifact.status !== "reviewed" || artifact.commitStatus !== "committed") fail(422, "RIGHTS_REVIEW_REQUIRED", "只可选择本选题已完整审核的真实源文件。"); return artifact; });
    const nativeInputs = list(input.nativeInputs ?? [], "nativeInputs", 28); nativeInputs.forEach(value => { closed(value, ["destinationId", "baseCommit", "operation", "tag"]); id(value.destinationId); });
    for (const selection of list(input.targets, "targets", 28, 1)) {
      closed(selection, ["destinationId", "locale", "nativeForm"]); const destination = record(state.destinations, selection.destinationId), account = destination.accountId ? record(state.accounts, destination.accountId) : null, profile = state.operatorProfiles.filter(row => row.platformId === destination.platformId).at(-1);
      if (!profile) fail(404, "SOURCE_NOT_FOUND", "目的地没有对应岗位。");
      const rule = state.ruleSnapshots.filter(row => row.destinationId === destination.id && row.reviewed && Date.parse(row.expiresAt) > this.clock().getTime()).at(-1);
      const targetGaps = [];
      const addGap = (code, inputKey, explanation) => { targetGaps.push({ code, inputKey, explanation }); gaps.push({ destinationId: destination.id, code, explanation }); };
      if (!rule) addGap("RULES_REVIEW_REQUIRED", "rulesRef", "需要管理员先保存当次目的地规则快照。");
      const style = state.styleVersions.filter(row => row.scope.destinationId === destination.id && row.scope.accountId === (account?.id ?? null) && row.scope.locale === selection.locale).at(-1);
      const contributions = state.authorContributions.filter(row => row.storyId === story.id && row.locale === editions[0].locale);
      const textOutput = { outputKey: "copy", kind: "text", locale: selection.locale, required: true, derivedFromKeys: [] }, outputs = [textOutput];
      const disclosure = { aiUse: profile.policy.requiresAuthorContribution ? "copyedit" : "generated_text", requiredLabels: [], authorExplanation: "保留作者事实与限定；生成范围以有效规则交集为准。" };
      const refsFor = role => sourceArtifacts.filter(artifact => artifact.role === role).map(contentOpsRef), licenseRef = refsFor("rights_evidence")[0] ?? null;
      const nativeInput = nativeInputs.find(value => value.destinationId === destination.id);
      const repository = ["repository", "artifact_repository"].includes(destination.kind) ? destination : null;
      let settings;
      switch (selection.nativeForm) {
        case "article": settings = { kind: "article", canonicalSourceRef: null, disclosure }; break;
        case "thread": settings = { kind: "thread", orderedSegmentKeys: ["copy"], disclosure }; break;
        case "image_text": outputs.push({ outputKey: "cover", kind: "image", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "image_text", coverOutputKey: "cover", orderedImageOutputKeys: ["cover"], disclosure }; break;
        case "video": outputs.push({ outputKey: "film", kind: "video", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "video", durationMs: 30_000, aspect: "16:9", chapters: [], disclosure }; break;
        case "document": outputs.push({ outputKey: "pages", kind: "document", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "document", orderedPageOutputKeys: ["pages"], disclosure }; break;
        case "repository_change": outputs.push({ outputKey: "change", kind: "repository_diff", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "repository_change", repositoryRef: repository ? contentOpsRef(repository) : null, baseCommit: nativeInput?.baseCommit ?? null, operation: nativeInput?.operation ?? "prepare_release_notes", tag: nativeInput?.tag ?? null }; if (!repository || !nativeInput?.baseCommit || !refsFor("code").length) addGap("REPOSITORY_INPUT_REQUIRED", "repositoryRef", "需要准确仓库、真实代码／diff和baseCommit，准备过程不写入仓库。"); break;
        case "model_card": outputs.push({ outputKey: "card", kind: "model_card", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "model_card", repositoryRef: repository ? contentOpsRef(repository) : null, modelArtifactRefs: refsFor("model_weights"), licenseRef }; if (!repository || !settings.modelArtifactRefs.length || !licenseRef) addGap("ARTIFACT_MISSING", "modelArtifactRefs", "模型卡需要真实模型权重、模型目的地与许可文件。"); break;
        case "dataset_card": outputs.push({ outputKey: "card", kind: "dataset_card", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "dataset_card", datasetArtifactRefs: refsFor("dataset"), licenseRef, synthetic: false }; if (!settings.datasetArtifactRefs.length || !licenseRef) addGap("ARTIFACT_MISSING", "datasetArtifactRefs", "数据卡需要真实数据与许可，是否合成须人工核对。"); break;
        case "notebook": outputs.push({ outputKey: "notebook", kind: "notebook", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "notebook", notebookRef: refsFor("notebook")[0] ?? null, inputDatasetRefs: refsFor("dataset"), executionEvidenceRef: refsFor("run_log")[0] ?? null, executeCode: false }; if (!settings.notebookRef) addGap("ARTIFACT_MISSING", "notebookRef", "需要实际notebook；本期仅静态预览，不运行单元格。"); break;
        case "demo_bundle": outputs.push({ outputKey: "demo", kind: "demo_manifest", locale: selection.locale, required: true, derivedFromKeys: ["copy"] }); settings = { kind: "demo_bundle", demoArtifactRefs: sourceArtifacts.filter(artifact => artifact.role === "code" && ["application/zip", "text/javascript", "text/x-python", "application/json"].includes(artifact.mime)).map(contentOpsRef), runtimeEvidenceRef: refsFor("run_log")[0] ?? null, deploy: false }; if (!settings.demoArtifactRefs.length) addGap("ARTIFACT_MISSING", "demoArtifactRefs", "需要真实Demo源码／bundle；README或diff不能单独冒充完整Demo。"); break;
        case "community_message": settings = { kind: "community_message", channelRef: contentOpsRef(destination), threadRef: null, visibility: destination.visibility === "restricted" ? "restricted" : "public", send: false }; break;
        default: fail(400, "NATIVE_PACKAGE_INVALID", "原生形式不受支持。");
      }
      const target = { targetKey: "", platformId: destination.platformId, destinationRef: contentOpsRef(destination), accountRef: account ? contentOpsRef(account) : null, locale: selection.locale, nativeForm: selection.nativeForm, decision: targetGaps.length ? "needs_input" : "prepare", decisionReasons: [], profileRef: contentOpsRef(profile), rulesRef: rule ? contentOpsRef(rule) : null, styleRef: style ? contentOpsRef(style) : null, requestedCreationMode: profile.policy.creationMode, requestedDeliveryMode: "prepare_only", authorContributionRefs: contributions.map(contentOpsRef), readerNeed: profile.readerTask, angle: profile.strategy, thesis: editions[0].title, retainClaimIds: claimIds, mustRetainQualifiers: [], removeSections: [], structure: [{ key: "main", purpose: profile.strategy, sourceSectionKeys: [] }], languagePlan: { sourceLocale: editions[0].locale, targetLocale: selection.locale, translateBody: editions[0].locale !== selection.locale, subtitleMode: "none", voiceMode: "preserve_original", approvedVoiceProfileRef: null }, inputFiles: sourceArtifacts.filter(artifact => artifact.role !== "model_weights").map(artifact => ({ artifactId: artifact.id, sha256: artifact.sha256, bytes: artifact.bytes ?? artifact.size, role: artifact.role, rightsReviewHash: artifact.rightsReviewHash, privacyReviewHash: artifact.privacyReviewHash })), outputs, settings, knownGaps: targetGaps };
      target.targetKey = contentOpsTargetKey(target); plan.targets.push(target);
    }
    plan.sourceBundleHash = contentOpsSourceBundle(plan);
    return { plan, gaps, sourceRefs: { story: entity(story), editions: editions.map(entity) } };
  }
  validatePlanImport(input, ctx) {
    closed(input, ["plan", "rawPlanJson"], []); if (Object.hasOwn(input, "plan") === Object.hasOwn(input, "rawPlanJson")) fail(400, "ADAPTATION_PLAN_INVALID", "提供 plan 或 rawPlanJson 其中一个。");
    const raw = input.rawPlanJson ?? input.plan, rawPlan = typeof raw === "string" ? raw : JSON.stringify(raw), parsed = parseStrictJson(rawPlan);
    return this.write("plan_imported", { rawSha256: hashText(rawPlan) }, ctx, (state, { actor, now, payload }) => {
      const valid = validateAdaptationPlan(state, parsed, { now });
      const row = { id: uid("IMP"), revision: 1, rawSha256: hashText(rawPlan), normalizedPlan: valid.plan, planHash: hashObject(without(valid.plan, ["containsCommands"])), sourceBindings: valid.sourceBindings, targets: valid.targets, validationVersion: OPS_VERSION, createdBy: actor, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString() };
      state.adaptationPlanImports.push(row); payload.planHash = row.planHash; return { ...entity(row), validatedImportId: row.id };
    });
  }
  validatePlan(input, ctx) { return this.validatePlanImport(input, ctx); }
  createBudget(input, ctx) {
    return this.write("budget_authorized", input, ctx, (state, { actor, now, payload }) => {
      const pricing = input.pricingSnapshot === null ? null : normalizePricing(input.pricingSnapshot, { id: uid("PRICE"), now, actor });
      if (pricing) state.modelPricingSnapshots.push(pricing);
      const row = normalizeBudget(input, { id: uid("BUDGET"), now, actor, pricing }); state.modelBudgetAuthorizations.push(row); payload.authorizationHash = row.authorizationHash; return entity(row);
    });
  }
  createJob(input, ctx) {
    closed(input, ["validatedImportId", "planHash", "budgetAuthorizationHash", "mode"]);
    return this.write("job_created", input, ctx, (state, { actor, now, payload }) => {
      const imported = record(state.adaptationPlanImports, input.validatedImportId);
      if (imported.createdBy !== actor || Date.parse(imported.expiresAt) <= now.getTime() || input.planHash !== imported.planHash || input.mode !== "prepare") fail(409, "SOURCE_OUTDATED", "校验快照已过期、主体或计划不匹配。");
      const valid = validateAdaptationPlan(state, imported.normalizedPlan, { now, expectedBindings: imported.sourceBindings }); assertMatch(record(state.stories, valid.plan.storyRef.id), ctx.ifMatch);
      if (input.budgetAuthorizationHash !== (valid.budget?.authorizationHash ?? null)) fail(409, "BUDGET_CHANGED", "预算必须来自同一准确计划引用，不能向旧 null 计划补入新授权。");
      const old = state.contentOpsJobs.find(row => row.planHash === imported.planHash && !["cancelled", "failed"].includes(row.status));
      if (old) return { ...entity(old), jobId: old.id, targets: state.contentOpsTargetRuns.filter(row => row.jobId === old.id) };
      const planRow = { id: uid("PLAN"), revision: 1, normalizedPlan: valid.plan, planHash: imported.planHash, inputBindings: valid.sourceBindings, importId: imported.id, createdAt: now.toISOString(), createdBy: actor }; state.adaptationPlans.push(planRow);
      const jobId = uid("JOB"), compiled = compileContentOpsPlan(valid.plan, valid.targets, { jobId, adapterBindings: this.adapterBindings, state });
      const row = { id: jobId, revision: 1, storyId: valid.plan.storyRef.id, planId: planRow.id, planHash: imported.planHash, blueprintHash: compiled.blueprintHash, budgetAuthorizationId: valid.budget?.id ?? null, budgetAuthorizationHash: valid.budget?.authorizationHash ?? null, status: valid.budget ? compiled.targetRuns.some(run => run.status === "queued") ? "queued" : "needs_input" : "blocked_budget", deadlineAt: valid.budget?.deadlineAt ?? null, createdBy: actor, createdAt: now.toISOString(), cancelledAt: null, cancellationReason: null };
      state.contentOpsJobs.push(row); state.productionTaskBlueprints.push(...compiled.tasks); state.contentOpsTargetRuns.push(...compiled.targetRuns); payload.jobId = jobId; return { ...entity(row), jobId, targets: compiled.targetRuns };
    });
  }
  createRuleSnapshot(input, ctx) {
    closed(input, ["platformId", "destinationId", "policy", "sources", "checkedAt", "expiresAt", "reviewed", "note"]);
    return this.write("rule_reviewed", input, ctx, (state, { actor, now }) => {
      const destination = record(state.destinations, input.destinationId); if (destination.platformId !== input.platformId || input.reviewed !== true || !validDate(input.expiresAt) || Date.parse(input.expiresAt) <= now.getTime() || !validDate(input.checkedAt) || Date.parse(input.checkedAt) > now.getTime()) fail(400, "RULES_CHANGED", "规则必须准确对应目的地且有有效的实际审阅时间。");
      validatePolicy(input.policy); text(input.note, "note", 4000);
      for (const source of list(input.sources, "sources", 32, 1)) { closed(source, ["url", "title", "scope"]); requirePublicUrl(source.url, "rule.source.url"); text(source.title, "title", 500); text(source.scope, "scope", 4000); }
      const revision = state.ruleSnapshots.filter(row => row.destinationId === input.destinationId).length + 1, row = { id: uid("RULE"), revision, ...structuredClone(input), reviewedBy: actor, createdAt: now.toISOString() }; row.hash = hashObject(row); state.ruleSnapshots.push(row); return entity(row);
    });
  }
  createAuthorContribution(input, ctx) {
    closed(input, ["storyRef", "title", "body", "locale", "sourceNote", "authoredBy"]);
    return this.write("author_contribution", input, ctx, (state, { actor, now }) => {
      const story = checkRef(input.storyRef, record(state.stories, input.storyRef?.id)); text(input.title, "title", 240); text(input.body, "body", 100_000); text(input.sourceNote, "sourceNote", 2000); text(input.authoredBy, "authoredBy", 120); if (!["zh-CN", "en-US"].includes(input.locale)) fail(400, "ADAPTATION_PLAN_INVALID", "作者语言无效。");
      const row = { id: uid("AUTHOR"), revision: 1, ...structuredClone(input), storyId: story.id, recordedBy: actor, createdAt: now.toISOString() }; row.hash = hashObject(row); state.authorContributions.push(row); return entity(row);
    });
  }
  createPairing(input, ctx) {
    closed(input, ["workerId", "origin", "workspaceId", "projectIds", "jobIds", "targetKeys", "adapterIds", "expiresAt", "maxTempBytes", "maxRenderSeconds", "maxNativeProcesses", "checker"]);
    const challenge = randomBytes(32).toString("base64url"), challengeHash = hashText(challenge);
    return this.write("worker_pairing_created", input, ctx, (state, { actor, now }) => {
      id(input.workerId); id(input.workspaceId); let origin; try { origin = new URL(input.origin); } catch { fail(400, "WORKER_SCOPE_DENIED", "cloud origin 无效。"); } if (origin.origin !== input.origin || origin.protocol !== "https:") fail(400, "WORKER_SCOPE_DENIED", "worker 仅允许准确 HTTPS cloud origin。");
      for (const key of ["projectIds", "jobIds"]) list(input[key], key, 100, 1).forEach(id);
      list(input.adapterIds, "adapterIds", 100, 1).forEach(value => { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) || value.includes("..")) fail(400, "WORKER_SCOPE_DENIED", "固定适配器标识无效。"); });
      list(input.targetKeys, "targetKeys", 28).forEach(sha);
      if (!validDate(input.expiresAt) || Date.parse(input.expiresAt) <= now.getTime() || Date.parse(input.expiresAt) > now.getTime() + 7 * 24 * 3600_000 || typeof input.checker !== "boolean") fail(400, "WORKER_SCOPE_DENIED", "配对范围、期限或检查身份无效。");
      for (const key of ["maxTempBytes", "maxRenderSeconds", "maxNativeProcesses"]) integer(input[key], key);
      input.jobIds.forEach(jobId => record(state.contentOpsJobs, jobId, "JOB_NOT_FOUND"));
      const scope = structuredClone(input), scopeHash = hashObject(scope), row = { id: uid("PAIR"), workerId: input.workerId, scope, scopeHash, challengeHash, status: "pending", createdBy: actor, createdAt: now.toISOString(), expiresAt: new Date(Math.min(Date.parse(input.expiresAt), now.getTime() + 10 * 60_000)).toISOString() };
      state.workerPairings.push(row); return { challengeId: row.id, scopeHash, scope, expiresAt: row.expiresAt };
    }).then(result => { const row = this.state().workerPairings.find(pair => pair.id === result.challengeId); return { ...result, challenge: row?.challengeHash === challengeHash ? challenge : null, requiresNewChallenge: row?.challengeHash !== challengeHash }; });
  }
  confirmPairing(input, ctx) {
    closed(input, ["challengeId", "challenge", "localGrantHash", "scopeHash", "credentialHash"]); text(input.challenge, "challenge", 128); sha(input.localGrantHash); sha(input.scopeHash); sha(input.credentialHash);
    return this.write("worker_pairing_confirmed", { ...without(input, ["challenge"]), challengeHash: hashText(input.challenge) }, { ...ctx, actor: `pairing:${input.challengeId}` }, (state, { now }) => {
      const pairing = record(state.workerPairings, input.challengeId, "WORKER_AUTH_REQUIRED");
      if (pairing.status !== "pending" || Date.parse(pairing.expiresAt) <= now.getTime() || pairing.scopeHash !== input.scopeHash || hashText(input.challenge) !== pairing.challengeHash) fail(403, "WORKER_SCOPE_DENIED", "配对挑战无效、过期或已使用。");
      if (state.productionWorkers.some(row => row.credentialHash === input.credentialHash)) fail(409, "WORKER_CREDENTIAL_REUSED", "每个 worker 凭据必须独立。");
      let worker = state.productionWorkers.find(row => row.id === pairing.workerId);
      if (worker && worker.status !== "revoked") fail(409, "WORKER_ALREADY_PAIRED", "worker 已配对，先撤销原授权。");
      if (!worker) { worker = { id: pairing.workerId, revision: 1 }; state.productionWorkers.push(worker); }
      Object.assign(worker, { revision: worker.revision + 1, status: "active", credentialHash: input.credentialHash, pairedAt: now.toISOString(), expiresAt: pairing.scope.expiresAt });
      const grant = { id: uid("GRANT"), workerId: worker.id, scope: pairing.scope, scopeHash: pairing.scopeHash, localGrantHash: input.localGrantHash, status: "active", createdAt: now.toISOString(), expiresAt: pairing.scope.expiresAt };
      state.workerGrants.push(grant); pairing.status = "used"; pairing.usedAt = now.toISOString(); return { workerId: worker.id, grantId: grant.id, scopeHash: grant.scopeHash, localGrantHash: grant.localGrantHash, expiresAt: grant.expiresAt };
    }, ["pairing"]);
  }
  authenticateWorker(credential) {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(credential ?? "")) return null;
    const digest = hashText(credential), state = this.state(), worker = state.productionWorkers.find(row => row.credentialHash && SHA256.test(row.credentialHash) && timingSafeEqual(Buffer.from(digest), Buffer.from(row.credentialHash)));
    if (!worker || worker.status !== "active" || !validDate(worker.expiresAt) || Date.parse(worker.expiresAt) <= this.clock().getTime()) return null;
    const grant = state.workerGrants.filter(row => row.workerId === worker.id && row.status === "active" && Date.parse(row.expiresAt) > this.clock().getTime()).at(-1); if (!grant) return null;
    return { method: grant.scope.checker ? "checker" : "worker", actor: `worker:${worker.id}`, workerId: worker.id, grantId: grant.id, scopeHash: grant.scopeHash };
  }
  grant(state, ctx, job, task = null, now = this.clock()) {
    if (!["worker", "checker"].includes(ctx?.method)) fail(401, "WORKER_AUTH_REQUIRED", "需要独立 worker 凭据。");
    const worker = record(state.productionWorkers, ctx.workerId, "WORKER_AUTH_REQUIRED"), grant = record(state.workerGrants, ctx.grantId, "WORKER_SCOPE_DENIED");
    if (worker.status !== "active" || grant.status !== "active" || grant.workerId !== worker.id || grant.scopeHash !== ctx.scopeHash || hashObject(grant.scope) !== grant.scopeHash || !SHA256.test(grant.localGrantHash) || !validDate(worker.expiresAt) || !validDate(grant.expiresAt) || Date.parse(worker.expiresAt) <= now.getTime() || Date.parse(grant.expiresAt) <= now.getTime() || job && !grant.scope.jobIds.includes(job.id) || task && (!grant.scope.adapterIds.includes(task.adapterBinding.adapterId) || grant.scope.targetKeys.length && (task.neutralTargetKeys ?? [task.targetKey]).some(key => !grant.scope.targetKeys.includes(key)))) fail(403, "WORKER_SCOPE_DENIED", "双端 worker 授权不属于该任务或已撤销／过期。");
    return grant;
  }
  liveJob(state, job, now, targetKey = null) {
    if (job.status === "cancelled") fail(409, "JOB_CANCELLED", "工单已经取消，迟到结果仅保留审计。");
    if (!validDate(job.deadlineAt) || Date.parse(job.deadlineAt) <= now.getTime()) fail(409, "JOB_DEADLINE_EXCEEDED", "准备授权已到期。");
    const plan = record(state.adaptationPlans, job.planId); validateAdaptationPlan(state, plan.normalizedPlan, { now, expectedBindings: plan.inputBindings, targetKeys: targetKey ? Array.isArray(targetKey) ? targetKey : [targetKey] : null });
  }
  taskStatus(state, task) {
    const attempts = state.productionTaskAttempts.filter(row => row.taskId === task.taskId), last = attempts.at(-1);
    return last?.status ?? "queued";
  }
  resolveInputs(state, task) {
    const job = record(state.contentOpsJobs, task.jobId), plan = record(state.adaptationPlans, job.planId).normalizedPlan, target = plan.targets.find(row => row.targetKey === task.targetKey);
    const refs = { sourceRefs: task.inputRefs.sourceRefs, fileRefs: task.inputRefs.fileRefs, dependencyRefs: task.dependsOn.map(taskId => { const attempt = state.productionTaskAttempts.filter(row => row.taskId === taskId && ["succeeded", "skipped"].includes(row.status)).at(-1); if (!attempt) fail(409, "TASK_DEPENDENCY_PENDING", "任务前置未成功。"); return { taskId, attemptId: attempt.id, outputHash: attempt.outputHash, resultRef: attempt.resultRef ?? null, artifactRefs: attempt.resultManifest?.artifacts ?? [] }; }) };
    const run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey);
    const data = { plan: { ...structuredClone(plan), targets: [structuredClone(target)] }, target: { ...structuredClone(target), inputFiles: refs.fileRefs }, effectivePolicy: run.effectivePolicy, sourceEditions: plan.motherEditionRefs.map(ref => structuredClone(record(state.editions, ref.id))), claims: plan.claimBindings.map(binding => structuredClone(record(state.claims, binding.claimId))), profile: record(state.operatorProfiles, target.profileRef.id), rules: record(state.ruleSnapshots, target.rulesRef.id), style: target.styleRef ? record(state.styleVersions, target.styleRef.id) : null, authorContributions: target.authorContributionRefs.map(ref => record(state.authorContributions, ref.id)), priorResults: refs.dependencyRefs.map(ref => { const attempt = record(state.productionTaskAttempts, ref.attemptId); return { taskId: ref.taskId, kind: taskRecord(state, ref.taskId).kind, data: attempt.resultManifest?.data ?? null, artifactRefs: ref.artifactRefs }; }) };
    const candidateRef = refs.dependencyRefs.find(ref => ref.resultRef?.candidateId)?.resultRef;
    data.budget = { authorizationHash: job.budgetAuthorizationHash, currency: record(state.modelBudgetAuthorizations, job.budgetAuthorizationId).currency, pricingSnapshotHash: record(state.modelBudgetAuthorizations, job.budgetAuthorizationId).pricingSnapshotHash };
    if (task.kind === "format.transform") { data.transformSpec = task.transformSpec; data.effectivePolicy = structuredClone(task.neutralPolicy); data.authorContributions = task.neutralAuthorContributionRefs.map(ref => structuredClone(record(state.authorContributions, ref.id))); }
    if (candidateRef) { const candidate = record(state.nativeCandidatePackages, candidateRef.candidateId); refs.packageRef = { candidateId: candidate.id, packageHash: candidate.packageHash, checkContextHash: candidate.checkContextHash }; data.candidate = candidate; data.package = candidate.package; data.packageHash = candidate.packageHash; data.checkContextHash = candidate.checkContextHash; }
    if (task.kind === "quality.check") { const draft = [...data.priorResults].reverse().find(result => ["text.adapt", "translation.localize", "text.revise"].includes(result.kind))?.data; if (draft) { data.package = { schema: "pengmanager.preliminary-draft/v1", ...draft, artifactRefs: task.inputRefs.fileRefs.map(file => ({ id: file.artifactId, sha256: file.sha256 })) }; data.packageHash = hashObject(data.package); } }
    return { refs, data };
  }
  claimTask(input, ctx) {
    closed(input, ["workerId", "adapterReadinessRefs", "maxTasks"]); if (input.workerId !== ctx.workerId || input.maxTasks !== 1) fail(403, "WORKER_SCOPE_DENIED", "只能领取当前 worker 的一个任务。");
    return this.write("task_claimed", input, ctx, (state, { now }) => {
      const grant = this.grant(state, ctx, null, null, now); list(input.adapterReadinessRefs, "adapterReadinessRefs", 100);
      this.expireAttempts(state, now); this.advanceConditionalTasks(state, now); this.freezeReadyPackages(state, now);
      for (const task of state.productionTaskBlueprints) {
        if (task.kind === "package.freeze") continue;
        const job = record(state.contentOpsJobs, task.jobId); if (!grant.scope.jobIds.includes(job.id) || TERMINAL.includes(job.status) || !job.budgetAuthorizationId) continue;
        const targetRunHead = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey); if (["needs_input", "skipped", "failed", "cancelled", "deadline_exceeded", "needs_reconcile"].includes(targetRunHead.status)) continue;
        try { this.grant(state, ctx, job, task, now); this.liveJob(state, job, now, task.neutralTargetKeys ?? task.targetKey); } catch (error) { if (["WORKER_SCOPE_DENIED", "JOB_CANCELLED", "JOB_DEADLINE_EXCEEDED", "SOURCE_OUTDATED", "CLAIM_CHANGED", "RULES_CHANGED", "IDENTITY_CHANGED", "RIGHTS_CHANGED"].includes(error.code)) continue; throw error; }
        const status = this.taskStatus(state, task), previous = state.productionTaskAttempts.filter(row => row.taskId === task.taskId);
        if (!["queued", "failed_known"].includes(status) || previous.length >= 3 || task.dependsOn.some(dep => !["succeeded", "skipped"].includes(this.taskStatus(state, taskRecord(state, dep))))) continue;
        if (task.permissionRequirements.independentChecker !== grant.scope.checker) continue;
        if (task.permissionRequirements.independentChecker && state.productionTaskAttempts.some(attempt => attempt.jobId === job.id && (attempt.targetKey === task.targetKey || state.productionTaskBlueprints.find(row => row.taskId === attempt.taskId)?.kind === "format.transform") && attempt.workerId === ctx.workerId && ["text.adapt", "translation.localize", "text.revise", "text.polish", "format.transform"].includes(state.productionTaskBlueprints.find(row => row.taskId === attempt.taskId)?.kind))) continue;
        const readiness = input.adapterReadinessRefs.find(ref => ref.adapterId === task.adapterBinding.adapterId && ref.version === task.adapterBinding.version && ref.entrypointSha === task.adapterBinding.entrypointSha && ref.ready === true && SHA256.test(ref.proofHash) && Date.parse(ref.expiresAt) > now.getTime() && Number.isFinite(Date.parse(ref.checkedAt)));
        if (!readiness || task.adapterBinding.codePresent === false || !SHA256.test(task.adapterBinding.entrypointSha ?? "")) continue;
        const resolved = previous.length ? { refs: previous[0].resolvedInputRefs, data: previous[0].resolvedInputData } : this.resolveInputs(state, task);
        const attempt = { id: uid("ATT"), attemptId: null, taskId: task.taskId, jobId: job.id, targetKey: task.targetKey, epoch: (previous.at(-1)?.epoch ?? 0) + 1, workerId: ctx.workerId, grantId: grant.id, scopeHash: grant.scopeHash, taskHash: task.taskHash, resolvedInputRefs: structuredClone(resolved.refs), resolvedInputData: structuredClone(resolved.data), resolvedInputHash: hashObject({ taskHash: task.taskHash, resolvedInputRefs: resolved.refs }), status: "claimed", leaseExpiresAt: new Date(Math.min(now.getTime() + 60_000, Date.parse(job.deadlineAt), Date.parse(grant.expiresAt))).toISOString(), createdAt: now.toISOString(), reservationIds: [] }; attempt.attemptId = attempt.id; state.productionTaskAttempts.push(attempt); job.status = "running"; job.revision++;
        const targetRun = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey); targetRun.status = task.kind === "quality.final" ? "final_checking" : task.kind; targetRun.revision++;
        return this.lease(task, attempt, job, grant);
      } return null;
    }, ["worker", "checker"]);
  }
  lease(task, attempt, job, grant) { return { task, attemptId: attempt.id, epoch: attempt.epoch, leaseExpiresAt: attempt.leaseExpiresAt, taskHash: task.taskHash, blueprintHash: job.blueprintHash, resolvedInputRefs: attempt.resolvedInputRefs, resolvedInputHash: attempt.resolvedInputHash, resolvedInputData: attempt.resolvedInputData, scopeHash: grant.scopeHash, budgetAuthorizationHash: task.budgetAuthorizationHash, localGrantHash: grant.localGrantHash }; }
  fence(state, taskId, input, ctx, now, { allowLate = false } = {}) {
    const task = taskRecord(state, taskId), job = record(state.contentOpsJobs, task.jobId), attempt = record(state.productionTaskAttempts, input.attemptId, "ATTEMPT_NOT_FOUND"), grant = this.grant(state, ctx, job, task, now);
    if (attempt.workerId !== ctx.workerId || attempt.grantId !== grant.id || attempt.taskId !== task.taskId || input.epoch !== attempt.epoch || input.taskHash !== task.taskHash || input.resolvedInputHash !== attempt.resolvedInputHash) fail(409, "TASK_EPOCH_STALE", "任务、租约 epoch 或解析输入摘要不匹配。");
    const head = state.productionTaskAttempts.filter(row => row.taskId === task.taskId).at(-1); let late = head.id !== attempt.id || !validDate(attempt.leaseExpiresAt) || Date.parse(attempt.leaseExpiresAt) <= now.getTime() || job.status === "cancelled" || !validDate(job.deadlineAt) || Date.parse(job.deadlineAt) <= now.getTime();
    if (late && !allowLate) fail(409, "TASK_EPOCH_STALE", "租约已过期、被取消或被新 epoch 取代。");
    if (!late) { try { this.liveJob(state, job, now, task.neutralTargetKeys ?? task.targetKey); } catch (error) { if (allowLate && ["SOURCE_OUTDATED", "CLAIM_CHANGED", "IDENTITY_CHANGED", "RULES_CHANGED", "RIGHTS_CHANGED", "JOB_CANCELLED", "JOB_DEADLINE_EXCEEDED"].includes(error.code)) late = true; else throw error; } } return { task, job, attempt, grant, late };
  }
  heartbeatTask(taskId, input, ctx) {
    closed(input, ["attemptId", "epoch", "taskHash", "resolvedInputHash"]);
    return this.write(`task_heartbeat:${taskId}`, input, ctx, (state, { now }) => { const { task, attempt, job, grant } = this.fence(state, taskId, input, ctx, now); if (!["claimed", "running", "dispatch_recorded"].includes(attempt.status)) fail(409, "TASK_EPOCH_STALE", "终态尝试不能续租。"); attempt.leaseExpiresAt = new Date(Math.min(now.getTime() + 60_000, Date.parse(job.deadlineAt), Date.parse(grant.expiresAt))).toISOString(); return this.lease(task, attempt, job, grant); }, ["worker", "checker"]);
  }
  dispatchTask(taskId, input, ctx) {
    closed(input, ["attemptId", "epoch", "taskHash", "resolvedInputHash", "callKey", "requestHash", "provider", "model", "pricingSnapshotHash", "upperBound"]); if (typeof input.callKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(input.callKey) || input.callKey.includes("..")) fail(400, "INVALID_CALL_KEY", "底层请求键无效。"); sha(input.requestHash);
    return this.write(`task_dispatch:${taskId}`, input, ctx, (state, { now, payload }) => {
      const { task, job, attempt, grant } = this.fence(state, taskId, input, ctx, now);
      const old = state.modelBudgetReservations.find(row => row.attemptId === attempt.id && row.callKey === input.callKey);
      if (old) { if (old.requestHash !== input.requestHash) fail(409, "IDEMPOTENCY_CONFLICT", "相同底层调用键对应不同请求。"); return { reservationId: old.id, dispatchPermitId: old.dispatchPermitId, attemptId: attempt.id, epoch: attempt.epoch, requestHash: old.requestHash, scopeHash: grant.scopeHash, expiresAt: attempt.leaseExpiresAt, dispatchRecorded: true, execute: false }; }
      if (!["claimed", "running", "dispatch_recorded"].includes(attempt.status)) fail(409, "ATTEMPT_UNKNOWN", "结果未知或终态尝试不能继续派发。");
      for (const [key, scopeKey] of [["tempBytes", "maxTempBytes"], ["renderSeconds", "maxRenderSeconds"], ["nativeProcesses", "maxNativeProcesses"]]) if (input.upperBound[key] > grant.scope[scopeKey]) fail(403, "LOCAL_PERMISSION_REQUIRED", "本机 owner 范围不足。");
      const row = reserveBudget(state, { job, task, attempt, input, now, reservationId: uid("RES") }); row.dispatchPermitId = uid("PERMIT"); attempt.reservationIds.push(row.id); attempt.status = "dispatch_recorded"; attempt.dispatchRecordedAt = now.toISOString(); payload.reservationId = row.id;
      return { reservationId: row.id, dispatchPermitId: row.dispatchPermitId, attemptId: attempt.id, epoch: attempt.epoch, requestHash: input.requestHash, scopeHash: grant.scopeHash, expiresAt: attempt.leaseExpiresAt, dispatchRecorded: true, execute: true };
    }, ["worker", "checker"]).then(result => {
      // A replay of the same HTTP idempotency key is a readback, never a second
      // permission to perform the provider request. The original permit's
      // monotonic delivery record is persisted before it is returned.
      return this.deliverPermit(result, ctx);
    });
  }
  async deliverPermit(result, ctx) {
    if (!result.execute) return result;
    const { result: delivered } = await this.store.mutate({ type: "content_ops.dispatch_permit_delivered", actor: ctx.actor, payload: { reservationId: result.reservationId } }, state => {
      const reservation = record(state.modelBudgetReservations, result.reservationId);
      if (reservation.permitDeliveredAt) return JsonStore.noChange({ ...result, execute: false });
      reservation.permitDeliveredAt = this.clock().toISOString(); return result;
    }); return delivered;
  }
  settleCall(reservationId, input, ctx) {
    closed(input, ["attemptId", "providerRequestId", "usage", "usageReceipt"]);
    return this.write(`usage_settled:${reservationId}`, input, ctx, (state, { now }) => {
      const reservation = record(state.modelBudgetReservations, reservationId), attempt = record(state.productionTaskAttempts, input.attemptId), job = record(state.contentOpsJobs, reservation.jobId);
      this.grant(state, ctx, job); if (attempt.id !== reservation.attemptId || attempt.workerId !== ctx.workerId) fail(403, "WORKER_SCOPE_DENIED", "用量不属于此 worker 的准确尝试。");
      closed(input.usage, ["inputTokens", "outputTokens", "costMicros", "currency"]);
      for (const key of ["inputTokens", "outputTokens", "costMicros"]) if (input.usage[key] !== null) { integer(input.usage[key], key); if (input.usage[key] > reservation.reserved[key]) fail(409, "USAGE_EXCEEDS_RESERVATION", "实际用量超过预留，需管理员核对账单。"); }
      if (input.usage.currency !== reservation.currency) fail(422, "CURRENCY_MISMATCH", "用量与授权币种不一致。");
      const receipt = input.usageReceipt; if (!receipt || !SHA256.test(receipt.sha256) || !["provider_response_usage", "local_execution_receipt"].includes(receipt.kind) || receipt.providerRequestId !== input.providerRequestId || reservation.provider && !input.providerRequestId) fail(422, "USAGE_RECONCILIATION_REQUIRED", "缺少可关联准确请求的实际用量证据。");
      const knownLocal = reservation.costClass !== "model";
      if (knownLocal && (input.providerRequestId !== null || ["inputTokens", "outputTokens", "costMicros"].some(key => input.usage[key] !== 0))) fail(422, "USAGE_RECONCILIATION_REQUIRED", "固定本地任务需准确零模型用量凭据。");
      // Provider token usage does not establish an actual billed amount. Only
      // administrator reconciliation may replace a model's monetary reserve.
      if (!knownLocal && input.usage.costMicros !== null) fail(422, "USAGE_RECONCILIATION_REQUIRED", "模型金额须以实际账单经管理员核对，不能由 worker 自签。");
      const receiptHash = hashObject(input), old = reservation.settlementHash;
      if (old && old !== receiptHash) fail(409, "USAGE_RECEIPT_CONFLICT", "该底层请求已有不同用量证据。");
      reservation.actual = structuredClone(input.usage); delete reservation.actual.currency; reservation.providerRequestId = input.providerRequestId; reservation.usageReceipt = structuredClone(receipt); reservation.settlementHash = receiptHash; reservation.settledAt = now.toISOString(); reservation.status = Object.values(reservation.actual).some(value => value === null) ? "partially_settled" : "settled";
      return structuredClone(reservation);
    }, ["worker", "checker"]);
  }
  unknownCall(reservationId, input, ctx) {
    closed(input, ["attemptId", "reason", "providerRequestId"]); safeReason(input.reason);
    return this.write(`usage_unknown:${reservationId}`, input, ctx, (state, { now }) => {
      const reservation = record(state.modelBudgetReservations, reservationId), attempt = record(state.productionTaskAttempts, input.attemptId); this.grant(state, ctx, record(state.contentOpsJobs, reservation.jobId));
      if (reservation.attemptId !== attempt.id || attempt.workerId !== ctx.workerId) fail(403, "WORKER_SCOPE_DENIED", "未知用量不属于此 worker 的准确尝试。");
      if (reservation.status === "settled") fail(409, "USAGE_RECEIPT_CONFLICT", "已准确结算的请求不能改成未知。");
      reservation.status = "unknown_usage"; reservation.unknownReason = input.reason; reservation.providerRequestId = input.providerRequestId; reservation.unknownAt = now.toISOString(); return structuredClone(reservation);
    }, ["worker", "checker"]);
  }
  async uploadArtifact(taskId, readable, input, ctx) {
    closed(input, ["attemptId", "epoch", "taskHash", "resolvedInputHash", "artifactId", "mime", "size", "sha256", "role", "name", "outputKey"], ["attemptId", "epoch", "taskHash", "resolvedInputHash", "mime", "size", "sha256", "role", "name", "outputKey"]);
    const snapshot = this.state(), replayKeyHash = hashObject({ actor: ctx.actor ?? `worker:${ctx.workerId}`, scope: `artifact_committed:${taskId}:${input.outputKey}`, key: ctx.idempotencyKey }), previous = snapshot.contentOpsRequests.find(row => row.keyHash === replayKeyHash);
    let lease;
    if (previous) {
      if (previous.requestHash !== hashObject(input)) fail(409, "IDEMPOTENCY_CONFLICT", "原附件请求键对应不同元数据。");
      const task = taskRecord(snapshot, taskId), attempt = record(snapshot.productionTaskAttempts, input.attemptId), job = record(snapshot.contentOpsJobs, task.jobId); this.grant(snapshot, ctx, job, task);
      if (attempt.workerId !== ctx.workerId || attempt.taskId !== taskId || input.epoch !== attempt.epoch || input.taskHash !== task.taskHash || input.resolvedInputHash !== attempt.resolvedInputHash) fail(409, "TASK_EPOCH_STALE", "原附件请求与准确尝试不匹配。"); lease = { task, attempt, job };
    } else lease = this.fence(snapshot, taskId, input, ctx, this.clock());
    const spec = lease.task.outputSpec.find(output => output.outputKey === input.outputKey && output.role === input.role); if (!spec) fail(403, "ARTIFACT_OUTPUT_SCOPE_DENIED", "附件不在预声明任务输出中。");
    if (!lease.attempt.reservationIds.length) fail(409, "TASK_NOT_DISPATCHED", "任务必须先取得派发许可再提交产物。");
    const artifactId = `ART-${hashObject({ taskId, attemptId: input.attemptId, outputKey: input.outputKey, sha256: input.sha256 }).slice(0, 32)}`;
    if (input.artifactId !== undefined && input.artifactId !== artifactId) fail(409, "ARTIFACT_ID_MISMATCH", "附件标识由准确业务键生成。");
    if (!this.artifactStore) fail(503, "ARTIFACT_STORAGE_UNAVAILABLE", "实际附件存储尚未配置。");
    const staged = await this.artifactStore.stage(readable, { ...input, artifactId }, { taskId, attemptId: input.attemptId, outputSpec: [spec] });
    return this.write(`artifact_committed:${taskId}:${input.outputKey}`, input, ctx, (state, { now }) => {
      let late = false; try { late = this.fence(state, taskId, input, ctx, now, { allowLate: true }).late; } catch (error) { if (["WORKER_SCOPE_DENIED", "WORKER_AUTH_REQUIRED", "JOB_CANCELLED", "JOB_DEADLINE_EXCEEDED", "TASK_EPOCH_STALE"].includes(error.code)) late = true; else throw error; }
      const old = state.productionArtifacts.find(row => row.id === artifactId); if (old) { if (old.sha256 !== staged.sha256 || old.attemptId !== staged.attemptId) fail(409, "ARTIFACT_RECOVERY_CONFLICT", "准确业务附件已有不同登记。"); return structuredClone(old); }
      const artifact = { ...staged, outputKey: input.outputKey, jobId: lease.job.id, targetKey: lease.task.targetKey, epoch: input.epoch, taskHash: input.taskHash, resolvedInputHash: input.resolvedInputHash, committed: !late, commitStatus: late ? "quarantined" : "committed", status: late ? "quarantined" : "committed", review: null, committedAt: now.toISOString(), origin: "worker_upload" };
      state.productionArtifacts.push(artifact); return structuredClone(artifact);
    }, ["worker", "checker"]);
  }
  completeTask(taskId, input, ctx) {
    closed(input, ["attemptId", "epoch", "taskHash", "resolvedInputHash", "resultManifest", "executionReceipts"]);
    closed(input.resultManifest, ["schema", "executed", "dryRun", "data", "artifacts", "outputHash"], ["schema", "executed", "dryRun", "data", "artifacts"]);
    // Parse a bounded serialization before entering the short state transaction.
    parseStrictJson(JSON.stringify(input.resultManifest), { maxBytes: 1_000_000 });
    safeResultStrings(input.resultManifest); safeResultStrings(input.executionReceipts);
    return this.write(`task_completed:${taskId}`, input, ctx, (state, { now }) => {
      const { task, job, attempt, late } = this.fence(state, taskId, input, ctx, now, { allowLate: true });
      if (late) { attempt.lateResult = { manifestHash: hashObject(input.resultManifest), receivedAt: now.toISOString(), status: "quarantined" }; return { taskId, attemptId: attempt.id, status: "quarantined" }; }
      if (attempt.status === "succeeded") return { taskId, attemptId: attempt.id, status: "succeeded", candidateId: attempt.resultRef?.candidateId ?? null };
      if (!["dispatch_recorded", "running"].includes(attempt.status) || !attempt.reservationIds.length) fail(409, "TASK_NOT_DISPATCHED", "没有已持久化派发的实际执行尝试。");
      const manifest = input.resultManifest;
      if (manifest.schema !== "pengmanager.task-result/v1" || manifest.executed !== true || manifest.dryRun !== false) fail(422, "EXECUTION_NOT_VERIFIED", "未实际执行、dryRun 或预览不能作为真实完成。");
      if (manifest.outputHash !== undefined && manifest.outputHash !== hashObject({ data: manifest.data, artifacts: manifest.artifacts })) fail(409, "TASK_RESULT_HASH_MISMATCH", "任务实际结果摘要不一致。");
      const receipts = list(input.executionReceipts, "executionReceipts", 100, 1); if (receipts.some(receipt => receipt.executed === false || receipt.dryRun === true || receipt.synced === false)) fail(422, "EXECUTION_NOT_VERIFIED", "执行回执包含未执行或不确定结果。");
      for (const reservationId of attempt.reservationIds) { const reservation = record(state.modelBudgetReservations, reservationId); if (!["settled", "partially_settled"].includes(reservation.status)) fail(409, "USAGE_RECONCILIATION_REQUIRED", "底层请求未返回可核对的实际用量，不能标完成。"); }
      const artifacts = list(manifest.artifacts, "artifacts", 200).map(ref => { closed(ref, ["artifactId", "sha256", "outputKey"]); const artifact = record(state.productionArtifacts, ref.artifactId, "ARTIFACT_MISSING"); if (artifact.taskId !== task.taskId || artifact.attemptId !== attempt.id || artifact.commitStatus !== "committed" || artifact.sha256 !== ref.sha256 || artifact.outputKey !== ref.outputKey || !task.outputSpec.some(spec => spec.outputKey === ref.outputKey)) fail(422, "ARTIFACT_MISSING", "产物未准确提交或不属于本次尝试。"); return artifact; });
      if (new Set(manifest.artifacts.map(ref => ref.outputKey)).size !== manifest.artifacts.length || task.outputSpec.some(spec => spec.required && !artifacts.some(artifact => artifact.outputKey === spec.outputKey))) fail(422, "ARTIFACT_MISSING", "必需实际产物缺失或重复。");
      if (["text.adapt", "translation.localize", "text.revise", "text.polish", "format.transform"].includes(task.kind)) { text(manifest.data?.title, "title", 240); text(manifest.data?.summary ?? "", "summary", 2000, true); text(manifest.data?.body, "body", 50_000); list(manifest.data?.blocks ?? [], "blocks", 1000); }
      if (["text.adapt", "translation.localize", "text.revise", "text.polish"].includes(task.kind)) {
        const target = record(state.adaptationPlans, job.planId).normalizedPlan.targets.find(row => row.targetKey === task.targetKey); this.nativeContent(target, manifest.data);
      }
      if (task.kind === "strategy.plan") { if (!["prepare", "skip", "needs_input"].includes(manifest.data?.decision)) fail(422, "MODEL_OUTPUT_INVALID", "岗位策略没有准确决定。"); if (manifest.data.decision !== "prepare") { const run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey); run.status = manifest.data.decision === "skip" ? "skipped" : "needs_input"; run.decision = manifest.data.decision; run.gaps.push({ code: "STRATEGY_INPUT_REQUIRED", inputKey: "strategy", explanation: manifest.data.rationale }); } }
      attempt.status = "succeeded"; attempt.completedAt = now.toISOString(); attempt.resultManifest = structuredClone(manifest); attempt.executionReceipts = structuredClone(receipts); attempt.outputHash = hashObject(manifest); attempt.resultRef = { attemptId: attempt.id, outputHash: attempt.outputHash };
      if (task.kind === "quality.final") {
        const candidateId = attempt.resolvedInputRefs.packageRef?.candidateId; if (!candidateId) fail(422, "QUALITY_RECHECK_REQUIRED", "最终检查没有准确冻结包。");
        const report = this.recordQualityReport(state, candidateId, manifest.data, { method: "checker", actor: ctx.actor, workerId: ctx.workerId, grantId: ctx.grantId, scopeHash: ctx.scopeHash, attemptId: attempt.id }, now); attempt.resultRef = { ...attempt.resultRef, candidateId, reportHash: report.reportHash };
      }
      if (task.kind === "quality.check" && task.finalPrecheck && (manifest.data?.findings ?? manifest.data?.semanticFindings ?? []).some(finding => ["blocker", "major"].includes(finding.severity))) { const run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey); run.status = "needs_input"; run.gaps.push({ code: "QUALITY_BLOCKED", inputKey: task.taskId, explanation: "两次有限返修后的独立初检仍有问题；保留完整意见并等待真实输入。" }); }
      this.advanceConditionalTasks(state, now); this.freezeReadyPackages(state, now); this.refreshJob(state, job); job.revision++;
      return { taskId, attemptId: attempt.id, status: "succeeded", candidateId: attempt.resultRef?.candidateId ?? null };
    }, ["worker", "checker"]);
  }
  failTask(taskId, input, ctx) {
    closed(input, ["attemptId", "epoch", "taskHash", "resolvedInputHash", "code", "reason", "unknown"]); safeReason(input.reason); id(input.code); if (typeof input.unknown !== "boolean") fail(400, "INVALID_INPUT", "失败须明确用量是否未知。");
    return this.write(`task_failed:${taskId}`, input, ctx, (state, { now }) => {
      const { task, job, attempt, late } = this.fence(state, taskId, input, ctx, now, { allowLate: true });
      if (late) { attempt.lateFailure = { code: input.code, reason: input.reason, receivedAt: now.toISOString() }; return { taskId, status: "quarantined" }; }
      if (attempt.status === "succeeded") fail(409, "TASK_ALREADY_COMPLETED", "已成功任务不能改写失败。");
      const unresolved = attempt.reservationIds.some(value => !["settled", "partially_settled"].includes(record(state.modelBudgetReservations, value).status));
      attempt.status = input.unknown || unresolved ? "unknown" : "failed_known"; attempt.failure = { code: input.code, reason: input.reason }; attempt.completedAt = now.toISOString();
      for (const value of attempt.reservationIds) { const reservation = record(state.modelBudgetReservations, value); if (!["settled", "partially_settled"].includes(reservation.status)) { reservation.status = "unknown_usage"; reservation.unknownReason = input.reason; } }
      const run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey); run.status = attempt.status === "unknown" ? "needs_reconcile" : state.productionTaskAttempts.filter(row => row.taskId === taskId).length < 3 ? "retry_pending" : "failed"; this.refreshJob(state, job); job.revision++; return { taskId, attemptId: attempt.id, status: attempt.status };
    }, ["worker", "checker"]);
  }
  advanceConditionalTasks(state, now) {
    const successful = taskId => state.productionTaskAttempts.filter(row => row.taskId === taskId && ["succeeded", "skipped"].includes(row.status)).at(-1);
    for (const task of state.productionTaskBlueprints) {
      if (!task.conditionalRepair && !task.conditionalCheck || this.taskStatus(state, task) !== "queued") continue;
      const job = record(state.contentOpsJobs, task.jobId), run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey);
      if (TERMINAL.includes(job.status) || ["needs_input", "needs_reconcile", "skipped", "failed", "cancelled"].includes(run.status)) continue;
      let reuse;
      if (task.conditionalRepair) {
        const check = successful(task.conditionalRepair.checkTaskId), draft = successful(task.conditionalRepair.draftTaskId); if (!check || !draft) continue;
        const findings = check.resultManifest?.data?.findings ?? check.resultManifest?.data?.semanticFindings ?? []; if (findings.some(finding => ["blocker", "major"].includes(finding.severity) && finding.resolved !== true)) continue;
        reuse = draft;
      } else {
        const repair = successful(task.conditionalCheck.repairTaskId); if (repair?.status !== "skipped") continue; reuse = successful(task.conditionalCheck.previousCheckTaskId); if (!reuse) continue;
      }
      try { this.liveJob(state, job, now, task.targetKey); } catch (error) { if (["SOURCE_OUTDATED", "RULES_CHANGED", "CLAIM_CHANGED", "RIGHTS_CHANGED", "JOB_DEADLINE_EXCEEDED"].includes(error.code)) continue; throw error; }
      const resolved = this.resolveInputs(state, task), manifest = { schema: "pengmanager.task-result/v1", executed: false, dryRun: false, data: structuredClone(reuse.resultManifest.data), artifacts: structuredClone(reuse.resultManifest.artifacts ?? []), conditionalReuse: { sourceAttemptId: reuse.id, sourceOutputHash: reuse.outputHash, reason: "NO_UNRESOLVED_INITIAL_FINDINGS" } };
      const attempt = { id: uid("ATT"), taskId: task.taskId, jobId: job.id, targetKey: task.targetKey, epoch: 1, workerId: "server", grantId: null, taskHash: task.taskHash, resolvedInputRefs: structuredClone(resolved.refs), resolvedInputData: structuredClone(resolved.data), resolvedInputHash: hashObject({ taskHash: task.taskHash, resolvedInputRefs: resolved.refs }), status: "skipped", skipReason: "NO_REPAIR_NEEDED", reusedAttemptId: reuse.id, outputHash: hashObject(manifest), resultRef: { reusedAttemptId: reuse.id, outputHash: hashObject(manifest) }, resultManifest: manifest, executionReceipts: [], reservationIds: [], createdAt: now.toISOString(), completedAt: now.toISOString() }; attempt.attemptId = attempt.id; state.productionTaskAttempts.push(attempt);
    }
  }
  freezeReadyPackages(state, now) {
    for (const task of state.productionTaskBlueprints.filter(row => row.kind === "package.freeze")) {
      if (this.taskStatus(state, task) === "succeeded") continue;
      const job = record(state.contentOpsJobs, task.jobId), run = state.contentOpsTargetRuns.find(row => row.jobId === job.id && row.targetKey === task.targetKey);
      if (TERMINAL.includes(job.status) || ["skipped", "failed"].includes(run.status) || run.gaps.some(gap => ["QUALITY_BLOCKED", "STRATEGY_INPUT_REQUIRED"].includes(gap.code)) || task.dependsOn.some(taskId => this.taskStatus(state, state.productionTaskBlueprints.find(row => row.taskId === taskId)) !== "succeeded")) continue;
      try {
        this.liveJob(state, job, now, task.targetKey); const resolved = this.resolveInputs(state, task), plan = resolved.data.plan, target = resolved.data.target;
        const polish = resolved.data.priorResults.find(result => result.kind === "text.polish")?.data;
        if (!polish?.body || !polish.title) fail(422, "NATIVE_PACKAGE_INVALID", "最终润色缺少完整正文。");
        const generated = resolved.refs.dependencyRefs.flatMap(ref => ref.artifactRefs).map(ref => ({ ref, artifact: record(state.productionArtifacts, ref.artifactId, "ARTIFACT_MISSING") }));
        const source = task.inputRefs.fileRefs.map(ref => ({ ref: { artifactId: ref.artifactId, sha256: ref.sha256, outputKey: null }, artifact: record(state.productionArtifacts, ref.artifactId) }));
        const used = [...new Map([...generated, ...source].map(row => [row.artifact.id, row])).values()];
        for (const { artifact } of used) if (artifact.commitStatus !== "committed" || artifact.committed !== true || artifact.status !== "reviewed" || !SHA256.test(artifact.rightsReviewHash ?? "") || !SHA256.test(artifact.privacyReviewHash ?? "")) fail(422, "RIGHTS_REVIEW_REQUIRED", "最终引用附件需要管理员完成真实权利、许可和隐私审核。");
        const media = generated.filter(({ artifact }) => ["image/png", "image/jpeg", "image/webp", "video/mp4", "text/vtt"].includes(artifact.mime));
        const orderedMediaRefs = [], nativeContent = this.nativeContent(target, polish);
        const mediaFor = (entry, role) => {
          const { ref, artifact } = entry;
          const asset = state.mediaAssets.find(row => row.id === artifact.mediaAssetId);
          if (!asset || asset.sha256 !== artifact.sha256 || asset.status !== "reviewed") fail(422, "MEDIA_REVIEW_REQUIRED", "实际媒体须通过显式桥导入并完成媒体域审核。");
          const copy = nativeContent.find(row => row.outputKey === ref.outputKey);
          orderedMediaRefs.push({ assetId: asset.id, sha256: asset.sha256, role, alt: ["cover", "image", "poster"].includes(role) ? copy?.alt || copy?.title || polish.title : "", caption: copy?.caption ?? "", locale: role === "subtitle" ? target.outputs.find(output => output.outputKey === ref.outputKey)?.locale ?? target.locale : target.locale });
        };
        if (target.nativeForm === "image_text") {
          const cover = media.find(entry => entry.ref.outputKey === target.settings.coverOutputKey); if (!cover) fail(422, "ARTIFACT_MISSING", "图文封面缺少真实输出。"); mediaFor(cover, "cover");
          for (const outputKey of target.settings.orderedImageOutputKeys) { const image = media.find(entry => entry.ref.outputKey === outputKey && entry.artifact.mime.startsWith("image/")); if (!image) fail(422, "ARTIFACT_MISSING", "有序图文卡片缺少真实图像。"); mediaFor(image, "image"); }
          for (const entry of media.filter(entry => !entry.artifact.mime.startsWith("image/"))) mediaFor(entry, entry.artifact.mime === "video/mp4" ? "video" : "subtitle");
        } else {
          let poster = false; for (const entry of media) { const role = entry.artifact.mime === "video/mp4" ? "video" : entry.artifact.mime === "text/vtt" ? "subtitle" : target.nativeForm === "video" && !poster ? "poster" : "image"; if (role === "poster") poster = true; mediaFor(entry, role); }
        }
        const orderedBlocks = this.normalizeBlocks(polish.blocks, polish.body, orderedMediaRefs);
        const neutralTask = state.productionTaskBlueprints.find(row => run.taskIds.includes(row.taskId) && row.kind === "format.transform");
        let neutralTransformRef = null, lineageHash = null;
        if (neutralTask) {
          const attempt = state.productionTaskAttempts.find(row => row.taskId === neutralTask.taskId && row.status === "succeeded");
          if (!attempt) fail(409, "FORMAT_TRANSFORM_REQUIRED", "中立转换尚未有真实成功结果。");
          neutralTransformRef = { taskId: neutralTask.taskId, formatTransformKey: neutralTask.formatTransformKey, transformSpecHash: hashObject(neutralTask.transformSpec), transformKind: neutralTask.transformKind, expectedFamilyHeadId: neutralTask.expectedFamilyHeadId };
          lineageHash = hashObject({ schema: "pengmanager.format-lineage/v1", derivedFromEditionRefs: plan.motherEditionRefs, transformKind: neutralTask.transformKind, transformSpecHash: neutralTransformRef.transformSpecHash });
        }
        const candidateId = uid("CAND"), artifactRefs = used.map(({ ref, artifact }) => ({ id: artifact.id, role: artifact.role, mime: artifact.mime, bytes: artifact.bytes ?? artifact.size, sha256: artifact.sha256, validatorVersion: artifact.validatorVersion, rightsReviewHash: artifact.rightsReviewHash, privacyReviewHash: artifact.privacyReviewHash, outputKey: ref.outputKey }));
        const pkg = { schema: "pengmanager.publication-package/v3", candidateId, targetKey: target.targetKey, storyId: job.storyId, sourceEditionRefs: plan.motherEditionRefs, lineageHash, platformId: target.platformId, destinationIdentitySnapshot: destinationIdentity(record(state.destinations, target.destinationRef.id)), accountIdentitySnapshot: target.accountRef ? accountIdentity(record(state.accounts, target.accountRef.id)) : null, locale: target.locale, editorialFormat: this.editorialFormat(target.nativeForm), nativeForm: target.nativeForm, title: polish.title, summary: polish.summary ?? "", body: polish.body, orderedBlocks, orderedMediaRefs, nativeManifest: this.nativeManifest(target, polish, generated), sourceClaimBindings: plan.claimBindings, rightsReviewHashes: artifactRefs.map(ref => ref.rightsReviewHash), privacyReviewHashes: artifactRefs.map(ref => ref.privacyReviewHash), operatorProfileRef: target.profileRef, rulesRef: target.rulesRef, styleRef: target.styleRef, adaptationPlanHash: job.planHash, compiledBlueprintHash: job.blueprintHash, artifactRefs };
        pkg.packageHash = contentOpsPackageHash(pkg);
        const producers = state.productionTaskAttempts.filter(attempt => attempt.jobId === job.id && attempt.status === "succeeded" && (attempt.targetKey === task.targetKey || attempt.taskId === neutralTask?.taskId) && ["text.adapt", "translation.localize", "text.revise", "text.polish", "format.transform"].includes(state.productionTaskBlueprints.find(row => row.taskId === attempt.taskId)?.kind)).map(attempt => `worker:${attempt.workerId}`);
        const candidate = { id: candidateId, revision: 1, jobId: job.id, planId: job.planId, targetRunId: run.id, targetKey: run.targetKey, package: pkg, packageHash: pkg.packageHash, checkContextHash: candidateCheckContext(pkg), producerActors: [...new Set(producers)], neutralTransformRef, status: "awaiting_quality", qualityReportHashes: [], reviewEnvelope: null, reviewSnapshotHash: null, createdAt: now.toISOString() };
        state.nativeCandidatePackages.push(candidate); run.candidateIds.push(candidate.id); run.candidateId = candidate.id; run.latestCandidateId = candidate.id; run.status = "final_checking"; run.gaps = run.gaps.filter(gap => !["RIGHTS_REVIEW_REQUIRED", "MEDIA_REVIEW_REQUIRED", "QUALITY_RECHECK_REQUIRED"].includes(gap.code));
        const attempt = { id: uid("ATT"), taskId: task.taskId, jobId: job.id, targetKey: task.targetKey, epoch: 1, workerId: "server", grantId: null, taskHash: task.taskHash, resolvedInputRefs: resolved.refs, resolvedInputData: resolved.data, resolvedInputHash: hashObject({ taskHash: task.taskHash, resolvedInputRefs: resolved.refs }), status: "succeeded", outputHash: hashObject({ candidateId, packageHash: pkg.packageHash }), resultRef: { candidateId, packageHash: pkg.packageHash }, createdAt: now.toISOString(), completedAt: now.toISOString(), reservationIds: [] }; attempt.attemptId = attempt.id; state.productionTaskAttempts.push(attempt);
      } catch (error) {
        if (!["RIGHTS_REVIEW_REQUIRED", "MEDIA_REVIEW_REQUIRED", "NATIVE_PACKAGE_INVALID", "FORMAT_TRANSFORM_REQUIRED", "ARTIFACT_MISSING", "RULES_CHANGED", "SOURCE_OUTDATED", "CLAIM_CHANGED", "JOB_DEADLINE_EXCEEDED"].includes(error.code)) throw error;
        run.status = "needs_input"; if (!run.gaps.some(gap => gap.code === error.code)) run.gaps.push({ code: error.code, inputKey: task.taskId, explanation: error.message });
      }
    }
  }
  editorialFormat(nativeForm) { return ["image_text", "video"].includes(nativeForm) ? nativeForm : "article"; }
  normalizeBlocks(blocks, body, refs) {
    if (!blocks?.length) return body.split(/\n\s*\n/).filter(part => part.trim()).map(part => ({ type: "paragraph", text: part }));
    return list(blocks, "blocks", 1000, 1).map(block => {
      if (["paragraph", "quote"].includes(block.type)) { closed(block, ["type", "text"]); text(block.text, "block.text", 50_000); return structuredClone(block); }
      if (block.type === "heading") { closed(block, ["type", "text", "level"]); if (![2, 3].includes(block.level)) fail(422, "NATIVE_PACKAGE_INVALID", "标题层级需为 2 或 3。"); text(block.text, "heading", 500); return structuredClone(block); }
      if (block.type === "code") { closed(block, ["type", "text", "language"], ["type", "text"]); text(block.text, "code", 50_000); const language = block.language ?? ""; if (language && !/^[A-Za-z0-9_+.-]{1,40}$/.test(language)) fail(422, "NATIVE_PACKAGE_INVALID", "代码语言标识无效。"); return { type: "code", text: block.text, language }; }
      if (block.type === "list") { closed(block, ["type", "ordered", "items"]); if (typeof block.ordered !== "boolean") fail(422, "NATIVE_PACKAGE_INVALID", "列表排序标识无效。"); list(block.items, "items", 200, 1).forEach(item => text(item, "item", 5000)); return structuredClone(block); }
      if (block.type === "image") { closed(block, ["type", "assetId", "alt", "caption"], ["type", "assetId", "alt"]); if (!refs.some(ref => ref.assetId === block.assetId && ["image", "cover", "poster"].includes(ref.role))) fail(422, "NATIVE_PACKAGE_INVALID", "图片块没有准确已审媒体引用。"); return { type: "image", assetId: block.assetId, alt: text(block.alt, "alt", 1000), caption: text(block.caption ?? "", "caption", 2000, true) }; }
      if (block.type === "video") { closed(block, ["type", "assetId", "posterAssetId", "caption"], ["type", "assetId"]); if (!refs.some(ref => ref.assetId === block.assetId && ref.role === "video") || block.posterAssetId && !refs.some(ref => ref.assetId === block.posterAssetId && ["cover", "poster"].includes(ref.role))) fail(422, "NATIVE_PACKAGE_INVALID", "视频块没有准确媒体引用。"); return { type: "video", assetId: block.assetId, ...(block.posterAssetId ? { posterAssetId: block.posterAssetId } : {}), caption: text(block.caption ?? "", "caption", 2000, true) }; }
      fail(422, "NATIVE_PACKAGE_INVALID", "正文块类型不受支持。");
    });
  }
  nativeManifest(target, polished, generated) {
    const content = this.nativeContent(target, polished);
    const outputs = target.outputs.map(output => { const actual = generated.find(row => row.ref.outputKey === output.outputKey), copy = content.find(row => row.outputKey === output.outputKey); return { outputKey: output.outputKey, kind: output.kind, required: output.required, artifactId: actual?.artifact.id ?? null, sha256: actual?.artifact.sha256 ?? null, text: output.kind === "text" ? copy?.body ?? null : null, title: copy?.title ?? null, alt: copy?.alt ?? null, caption: copy?.caption ?? null }; });
    const base = { kind: target.nativeForm, settings: target.settings, outputs, disclosures: target.settings.disclosure ?? null };
    if (target.nativeForm === "thread") base.segments = target.settings.orderedSegmentKeys.map(key => ({ key, text: outputs.find(output => output.outputKey === key)?.text ?? "" }));
    if (target.nativeForm === "document") base.pages = target.settings.orderedPageOutputKeys.flatMap(key => { const actual = generated.find(row => row.ref.outputKey === key); if (!actual || !Number.isSafeInteger(actual.artifact.inspection?.pages)) fail(422, "NATIVE_PACKAGE_INVALID", "文档需要已解析真实 PDF 页数。"); return Array.from({ length: actual.artifact.inspection.pages }, (_, index) => ({ key, pageNumber: index + 1, artifactId: actual.artifact.id, sha256: actual.artifact.sha256 })); });
    if (target.nativeForm === "image_text") base.images = target.settings.orderedImageOutputKeys.map(key => ({ key, artifactId: outputs.find(output => output.outputKey === key)?.artifactId ?? null }));
    if (target.nativeForm === "video") base.chapters = target.settings.chapters;
    if (["repository_change", "model_card", "dataset_card", "notebook", "demo_bundle"].includes(target.nativeForm)) base.files = outputs.filter(output => output.artifactId).map(output => ({ outputKey: output.outputKey, artifactId: output.artifactId, sha256: output.sha256 }));
    return base;
  }
  nativeContent(target, polished) {
    const outputs = target.outputs.filter(output => ["text", "image", "document"].includes(output.kind)), rows = list(polished.nativeContent ?? [], "nativeContent", 200);
    const seen = new Set(); for (const row of rows) { closed(row, ["outputKey", "title", "body", "alt", "caption"]); id(row.outputKey); const output = outputs.find(output => output.outputKey === row.outputKey); if (!output || seen.has(row.outputKey)) fail(422, "NATIVE_OUTPUT_CONTENT_INVALID", "原生内容键必须准确对应独立输出且不能重复。"); seen.add(row.outputKey); text(row.title, "native title", 240); text(row.body, "native body", output.kind === "image" ? 10_000 : 50_000); text(row.alt, "native alt", 1000, output.kind !== "image"); text(row.caption, "native caption", 2000, true); }
    for (const kind of ["text", "image", "document"]) {
      const group = outputs.filter(output => output.kind === kind && output.required); if (group.length <= 1) continue;
      if (group.some(output => !seen.has(output.outputKey))) fail(422, "NATIVE_OUTPUT_CONTENT_REQUIRED", "多段、多卡或多文档必须逐项提供实际独立内容，不能复制整篇正文冒充。");
      const bodies = group.map(output => rows.find(row => row.outputKey === output.outputKey).body.trim()); if (new Set(bodies).size !== bodies.length) fail(422, "NATIVE_OUTPUT_CONTENT_INVALID", "不同原生分段或卡片不能使用完全重复的正文。");
    }
    return outputs.map(output => structuredClone(rows.find(row => row.outputKey === output.outputKey) ?? { outputKey: output.outputKey, title: polished.title, body: polished.body, alt: output.kind === "image" ? polished.title : "", caption: "" }));
  }
  recordQualityReport(state, candidateId, input, ctx, now) {
    closed(input, ["checkedPackageHash", "packageHash", "checkContextHash", "checkerVersion", "deterministicReceipts", "findings", "semanticFindings", "coverage", "mediaEvidence", "dimensions", "modelReceiptIds", "assessment", "reviewed"], ["coverage", "assessment"]);
    const candidate = record(state.nativeCandidatePackages, candidateId, "CANDIDATE_NOT_FOUND"), pkg = candidate.package;
    assertCandidateCurrentBindings(state, candidate, { now });
    if ((input.checkedPackageHash ?? input.packageHash) !== candidate.packageHash || input.checkContextHash && input.checkContextHash !== candidate.checkContextHash) fail(409, "QUALITY_REPORT_STALE", "检查结果没有绑定准确最终包与上下文。");
    if (candidate.producerActors.includes(ctx.actor) || ctx.workerId && candidate.producerActors.includes(`worker:${ctx.workerId}`)) fail(403, "INDEPENDENT_CHECKER_REQUIRED", "生成者不能签署自己的最终检查。");
    const human = ADMIN.includes(ctx.method), attempt = ctx.attemptId ? record(state.productionTaskAttempts, ctx.attemptId) : null;
    if (!human) { const grant = this.grant(state, ctx, record(state.contentOpsJobs, candidate.jobId)); if (!grant.scope.checker || !attempt || attempt.resolvedInputRefs.packageRef?.packageHash !== candidate.packageHash) fail(403, "INDEPENDENT_CHECKER_REQUIRED", "报告必须来自授权独立检查尝试。"); }
    const findings = input.findings ?? input.semanticFindings ?? []; list(findings, "findings", 200).forEach(finding => { closed(finding, ["severity", "dimension", "code", "message", "location", "resolved"], ["severity", "dimension", "code", "message", "location"]); if (!["blocker", "major", "minor", "suggestion"].includes(finding.severity)) fail(400, "QUALITY_REPORT_INVALID", "问题分级无效。"); text(finding.message, "finding", 10_000); text(finding.location, "location", 1000); });
    const coverageInput = input.coverage ?? {}, textKeys = list(coverageInput.textKeys, "textKeys", 2000), artifactHashes = list(coverageInput.artifactHashes, "artifactHashes", 200);
    if (new Set(textKeys).size !== textKeys.length || new Set(artifactHashes).size !== artifactHashes.length || input.checkerVersion && input.checkerVersion !== FINAL_CHECKER_VERSION) fail(422, "QUALITY_RECHECK_REQUIRED", "覆盖键不得重复且检查版本必须准确。");
    const mediaEvidence = list(input.mediaEvidence ?? [], "mediaEvidence", 200);
    for (const evidence of mediaEvidence) {
      if (human) { closed(evidence, ["artifactId", "sha256", "method", "coverage", "note"]); const artifact = pkg.artifactRefs.find(ref => ref.id === evidence.artifactId && ref.sha256 === evidence.sha256); if (!artifact || !["human_full_read", "human_full_playback", "deterministic_static_inspection"].includes(evidence.method)) fail(422, "QUALITY_RECHECK_REQUIRED", "实际附件覆盖证据不相符。"); text(evidence.note, "inspection note", 4000); if (evidence.coverage !== "full") fail(422, "QUALITY_RECHECK_REQUIRED", "必需附件需要完整实际覆盖。"); }
      else { closed(evidence, ["sha256", "mime", "byteHashVerified", "semanticInspection", "artisticInspection"]); if (!pkg.artifactRefs.some(ref => ref.sha256 === evidence.sha256 && ref.mime === evidence.mime) || evidence.byteHashVerified !== true || evidence.semanticInspection !== "unverified" || evidence.artisticInspection !== "unverified") fail(422, "QUALITY_RECHECK_REQUIRED", "文本模型不能自签媒体语义或艺术覆盖。"); }
    }
    if (human && pkg.artifactRefs.some(ref => !artifactHashes.includes(ref.sha256) || !mediaEvidence.some(evidence => evidence.artifactId === ref.id && evidence.sha256 === ref.sha256))) fail(422, "QUALITY_RECHECK_REQUIRED", "独立人类终检需逐个说明真实附件完整覆盖。");
    const fullText = qualityTextKeys(pkg).every(key => textKeys.includes(key)), fullMedia = pkg.artifactRefs.every(ref => artifactHashes.includes(ref.sha256)) && (human || !pkg.artifactRefs.some(ref => /^(image\/|video\/|audio\/)|^application\/(pdf|zip|x-safetensors)$/.test(ref.mime)));
    const severity = dimension => findings.some(finding => ["blocker", "major"].includes(finding.severity) && finding.resolved !== true && (dimension === "semantic" ? ["facts", "policy", "structure", "disclosure"].includes(finding.dimension) : dimension === "artistic" ? finding.dimension === "expression" : finding.dimension === "media"));
    const checked = dimension => coverageInput[dimension] === "checked" || coverageInput[dimension]?.status === "passed" || !human && (coverageInput[dimension] === "not_applicable" || input.dimensions?.[dimension] === "passed");
    const deterministicValid = contentOpsPackageHash(pkg) === pkg.packageHash && pkg.artifactRefs.every(ref => { const artifact = state.productionArtifacts.find(row => row.id === ref.id); return artifact?.status === "reviewed" && artifact.sha256 === ref.sha256 && artifact.rightsReviewHash === ref.rightsReviewHash && artifact.privacyReviewHash === ref.privacyReviewHash; });
    const dimensions = { deterministic: deterministicValid ? "passed" : "failed", semantic: fullText && checked("semantic") && !severity("semantic") ? "passed" : "unverified", media: fullMedia && !severity("media") ? "passed" : "unverified", artistic: fullText && checked("artistic") && !severity("artistic") ? "passed" : "unverified" };
    const reservations = attempt ? attempt.reservationIds.map(value => record(state.modelBudgetReservations, value)) : [];
    if (!human && !reservations.some(row => row.usageReceipt?.kind === "provider_response_usage" && row.usageReceipt.sha256)) fail(422, "QUALITY_RECHECK_REQUIRED", "模型检查缺少真实底层用量与响应证据。");
    const report = { schema: "pengmanager.quality-report/v1", id: uid("QC"), candidateId, jobId: candidate.jobId, checkedPackageHash: candidate.packageHash, checkerVersion: FINAL_CHECKER_VERSION, checkContextHash: candidate.checkContextHash, deterministicReceipts: [{ kind: "server_contract_validation", packageHash: candidate.packageHash, artifactHashes: pkg.artifactRefs.map(ref => ref.sha256), validatorVersion: OPS_VERSION }], semanticFindings: structuredClone(findings), mediaEvidence: structuredClone(mediaEvidence), coverage: { textKeys, artifactHashes, ...Object.fromEntries(Object.entries(dimensions).map(([key, status]) => [key, { status }])) }, dimensions, modelReceiptIds: reservations.map(row => row.id), assessment: text(input.assessment ?? "人工逐项核对最终完整包。", "assessment", 20_000), execution: { method: ctx.method, subject: ctx.workerId ? `worker:${ctx.workerId}` : ctx.actor, workerId: ctx.workerId ?? null, grantId: ctx.grantId ?? null, attemptId: attempt?.id ?? null, authorized: true, independent: true }, status: Object.values(dimensions).every(status => status === "passed") && !findings.some(finding => ["blocker", "major"].includes(finding.severity) && finding.resolved !== true) ? "passed" : "needs_input", checkedAt: now.toISOString() };
    report.reportHash = contentOpsReportHash(report); state.contentQualityReports.push(report);
    if (report.status === "passed") { candidate.qualityReportHashes = [report.reportHash]; candidate.reviewEnvelope = contentOpsReviewEnvelope(candidate.packageHash, [report.reportHash], candidate.checkContextHash); candidate.reviewSnapshotHash = hashObject(candidate.reviewEnvelope); candidate.status = "ready_for_review"; const run = record(state.contentOpsTargetRuns, candidate.targetRunId); run.status = "ready_for_review"; }
    else { candidate.status = "needs_input"; candidate.qualityReportHashes = []; candidate.reviewEnvelope = null; candidate.reviewSnapshotHash = null; record(state.contentOpsTargetRuns, candidate.targetRunId).status = "needs_input"; }
    return report;
  }
  async submitQualityReport(candidateId, input, ctx) {
    assertAdmin(ctx); closed(input, ["checkedPackageHash", "packageHash", "checkContextHash", "checkerVersion", "findings", "semanticFindings", "coverage", "mediaEvidence", "assessment", "reviewed"], ["coverage", "mediaEvidence", "assessment", "reviewed"]);
    if (input.reviewed !== true || input.checkerVersion && input.checkerVersion !== FINAL_CHECKER_VERSION) fail(422, "QUALITY_RECHECK_REQUIRED", "人工独立检查需明确完整审阅与固定版本。");
    const snapshot = this.state(), candidate = record(snapshot.nativeCandidatePackages, candidateId); if (this.artifactStore) await this.artifactStore.verifyReferences(candidate.package.artifactRefs, { state: snapshot, reviewed: true });
    return this.write(`quality_final_completed:${candidateId}`, input, ctx, (state, { now }) => { const current = record(state.nativeCandidatePackages, candidateId); assertMatch(current, ctx.ifMatch); const report = this.recordQualityReport(state, candidateId, input, ctx, now); this.refreshJob(state, record(state.contentOpsJobs, current.jobId)); return entity(report); });
  }
  refreshJob(state, job) {
    if (["cancelled", "deadline_exceeded"].includes(job.status)) return;
    if (!job.budgetAuthorizationId) { job.status = "blocked_budget"; return; }
    const runs = state.contentOpsTargetRuns.filter(row => row.jobId === job.id);
    job.status = runs.some(run => run.status === "needs_reconcile") ? "needs_reconcile" : runs.every(run => ["ready_for_review", "skipped"].includes(run.status)) ? "ready_for_review" : runs.some(run => run.status === "needs_input") ? "needs_input" : runs.every(run => ["failed", "skipped"].includes(run.status)) ? "failed" : "running";
  }
  expireAttempts(state, now, { startup = false } = {}) {
    const expired = [];
    for (const attempt of state.productionTaskAttempts) {
      if (!["claimed", "running", "dispatch_recorded"].includes(attempt.status) || !startup && Date.parse(attempt.leaseExpiresAt) > now.getTime()) continue;
      const dispatched = attempt.reservationIds.length > 0, unresolved = attempt.reservationIds.some(value => !["settled", "partially_settled"].includes(record(state.modelBudgetReservations, value).status));
      attempt.status = dispatched ? "unknown" : "failed_known"; attempt.recoveredAt = now.toISOString(); attempt.failure = { code: dispatched ? "ATTEMPT_UNKNOWN" : "LEASE_EXPIRED_BEFORE_DISPATCH", reason: "恢复只读取持久回执；未证明结果的已派发尝试不会自动重发。" };
      for (const value of attempt.reservationIds) { const reservation = record(state.modelBudgetReservations, value); if (!["settled", "partially_settled"].includes(reservation.status)) { reservation.status = "unknown_usage"; reservation.unknownReason = "DISPATCH_RESULT_NOT_VERIFIED"; } }
      const run = state.contentOpsTargetRuns.find(row => row.jobId === attempt.jobId && row.targetKey === attempt.targetKey); if (run && dispatched) run.status = "needs_reconcile";
      expired.push(attempt.id);
    }
    for (const job of state.contentOpsJobs) {
      if (job.deadlineAt && Date.parse(job.deadlineAt) <= now.getTime() && !TERMINAL.includes(job.status)) { job.status = "deadline_exceeded"; job.revision++; job.deadlineExceededAt = now.toISOString(); for (const run of state.contentOpsTargetRuns.filter(row => row.jobId === job.id && !["skipped", "ready_for_review"].includes(row.status))) run.status = "deadline_exceeded"; }
      else if (!TERMINAL.includes(job.status)) this.refreshJob(state, job);
    }
    return expired;
  }
  recover(ctx) {
    return this.write("recovered", {}, ctx, (state, { now }) => ({ recoveredAttemptIds: this.expireAttempts(state, now, { startup: true }), preservedUnknownReservations: state.modelBudgetReservations.filter(row => ["unknown_usage", "partially_settled"].includes(row.status)).length, externalRequestsStarted: 0 }));
  }
  cancelJob(jobId, input, ctx) {
    closed(input, ["reason"]); safeReason(input.reason);
    return this.write(`job_cancelled:${jobId}`, input, ctx, (state, { now }) => {
      const job = record(state.contentOpsJobs, jobId, "JOB_NOT_FOUND"); assertMatch(job, ctx.ifMatch); if (job.status === "cancelled") return entity(job);
      job.status = "cancelled"; job.cancelledAt = now.toISOString(); job.cancellationReason = input.reason; job.revision++;
      for (const attempt of state.productionTaskAttempts.filter(row => row.jobId === jobId && ["claimed", "dispatch_recorded", "running"].includes(row.status))) { attempt.status = attempt.reservationIds.length ? "cancel_requested" : "cancelled"; attempt.cancelledAt = now.toISOString(); for (const value of attempt.reservationIds) { const reservation = record(state.modelBudgetReservations, value); if (!["settled", "partially_settled"].includes(reservation.status)) { reservation.status = "unknown_usage"; reservation.unknownReason = "CANCELLED_AFTER_DISPATCH"; } } }
      for (const run of state.contentOpsTargetRuns.filter(row => row.jobId === jobId && row.status !== "skipped")) run.status = "cancelled";
      return { ...entity(job), inFlight: state.productionTaskAttempts.filter(row => row.jobId === jobId && row.status === "cancel_requested").map(row => ({ attemptId: row.id, status: row.status })), budgetTotals: job.budgetAuthorizationId ? budgetTotals(state, job.budgetAuthorizationId) : null };
    });
  }
  revokeWorker(workerId, input, ctx) {
    closed(input, ["reason"]); safeReason(input.reason);
    return this.write(`worker_revoked:${workerId}`, input, ctx, (state, { now }) => {
      const worker = record(state.productionWorkers, workerId); assertMatch(publicWorker(worker), ctx.ifMatch); worker.status = "revoked"; worker.revision++; worker.revokedAt = now.toISOString(); worker.revocationReason = input.reason;
      for (const grant of state.workerGrants.filter(row => row.workerId === workerId && row.status === "active")) { grant.status = "revoked"; grant.revokedAt = now.toISOString(); }
      for (const attempt of state.productionTaskAttempts.filter(row => row.workerId === workerId && ["claimed", "dispatch_recorded", "running"].includes(row.status))) { attempt.leaseExpiresAt = now.toISOString(); }
      this.expireAttempts(state, now); return entity(publicWorker(worker));
    });
  }
  reconcileUsage(jobId, reservationId, input, ctx) {
    closed(input, ["attemptId", "providerRequestId", "usage", "evidence", "reason", "reviewed"]);
    return this.write(`usage_reconciled:${reservationId}`, input, ctx, (state, { actor, now }) => {
      const job = record(state.contentOpsJobs, jobId); assertMatch(job, ctx.ifMatch); const reservation = record(state.modelBudgetReservations, reservationId);
      if (reservation.jobId !== job.id || reservation.attemptId !== input.attemptId || input.reviewed !== true || !["unknown_usage", "partially_settled"].includes(reservation.status)) fail(409, "USAGE_RECONCILIATION_REQUIRED", "只能核对准确未决请求与授权。");
      text(input.reason, "reason", 4000); closed(input.usage, ["inputTokens", "outputTokens", "costMicros", "currency"]); for (const key of ["inputTokens", "outputTokens", "costMicros"]) integer(input.usage[key], key);
      if (input.usage.currency !== reservation.currency) fail(422, "CURRENCY_MISMATCH", "账单币种与原授权不一致。");
      const evidence = closed(input.evidence, ["kind", "sha256", "providerRequestId", "reservationId", "dimensions", "description"]);
      if (!["provider_billing_receipt", "administrator_itemized_audit"].includes(evidence.kind) || evidence.reservationId !== reservationId || evidence.providerRequestId !== input.providerRequestId || reservation.providerRequestId && reservation.providerRequestId !== input.providerRequestId || !SHA256.test(evidence.sha256) || !["inputTokens", "outputTokens", "costMicros", "currency"].every(key => evidence.dimensions?.includes(key))) fail(422, "USAGE_RECONCILIATION_REQUIRED", "证据必须逐项关联原尝试、供应商请求及全部单位，不能仅声明零费用。");
      text(evidence.description, "description", 4000);
      const row = { id: uid("RECON"), jobId, reservationId, attemptId: reservation.attemptId, providerRequestId: input.providerRequestId, usage: structuredClone(input.usage), evidence: structuredClone(evidence), reason: input.reason, reviewedBy: actor, reviewedAt: now.toISOString() }; row.hash = hashObject(row); state.modelUsageReconciliations.push(row);
      reservation.actual = without(input.usage, ["currency"]); reservation.providerRequestId = input.providerRequestId; reservation.status = "settled"; reservation.reconciliationId = row.id; reservation.settledAt = now.toISOString(); job.revision++;
      // Reconciliation proves usage only. An unknown production result remains
      // unknown until a separately authorized new task or exact result recovery.
      return { reconciliation: row, reservation, budgetTotals: budgetTotals(state, job.budgetAuthorizationId), job: entity(job) };
    });
  }
  getWorkerTask(taskId, ctx) {
    const state = this.state(), task = taskRecord(state, taskId), job = record(state.contentOpsJobs, task.jobId), grant = this.grant(state, ctx, job, task), attempt = state.productionTaskAttempts.filter(row => row.taskId === taskId && row.workerId === ctx.workerId).at(-1);
    if (!attempt) fail(404, "ATTEMPT_NOT_FOUND", "该 worker 尚未领取准确任务。"); return this.lease(task, attempt, job, grant);
  }
  authorizeWorkerArtifact(artifactId, ctx) {
    const state = this.state(), artifact = record(state.productionArtifacts, artifactId, "ARTIFACT_NOT_FOUND"); this.grant(state, ctx, null);
    const permitted = state.productionTaskAttempts.some(attempt => {
      if (attempt.workerId !== ctx.workerId || attempt.grantId !== ctx.grantId || !["claimed", "running", "dispatch_recorded"].includes(attempt.status) || Date.parse(attempt.leaseExpiresAt) <= this.clock().getTime()) return false;
      const task = state.productionTaskBlueprints.find(row => row.taskId === attempt.taskId), job = record(state.contentOpsJobs, attempt.jobId); try { this.grant(state, ctx, job, task); this.liveJob(state, job, this.clock(), task.neutralTargetKeys ?? task.targetKey); } catch { return false; }
      const direct = attempt.resolvedInputRefs.fileRefs?.some(ref => ref.artifactId === artifactId && ref.sha256 === artifact.sha256), dependent = attempt.resolvedInputRefs.dependencyRefs?.some(ref => ref.artifactRefs?.some(ref => ref.artifactId === artifactId && ref.sha256 === artifact.sha256));
      const finalPackage = attempt.resolvedInputRefs.packageRef ? state.nativeCandidatePackages.find(candidate => candidate.id === attempt.resolvedInputRefs.packageRef.candidateId && candidate.packageHash === attempt.resolvedInputRefs.packageRef.packageHash) : null;
      return direct || dependent || finalPackage?.package.artifactRefs.some(ref => ref.id === artifactId && ref.sha256 === artifact.sha256);
    });
    if (!permitted || artifact.commitStatus !== "committed") fail(403, "WORKER_SCOPE_DENIED", "附件不在该 worker 当前准确解析输入中。"); return { id: artifact.id, sha256: artifact.sha256 };
  }
  authorizeWorkerMedia(assetId, ctx) {
    const state = this.state(), artifact = state.productionArtifacts.find(row => row.mediaAssetId === assetId); if (!artifact) fail(403, "WORKER_SCOPE_DENIED", "媒体不属于当前任务真实附件范围。"); return this.authorizeWorkerArtifact(artifact.id, ctx);
  }
  createStyleMemoryCandidate(input, ctx) {
    closed(input, ["scope", "before", "after", "reason", "evidence"]);
    return this.write("style_memory_proposed", input, ctx, (state, { actor, now }) => {
      this.validateStyleScope(state, input.scope); text(input.before, "before", 20_000); text(input.after, "after", 20_000); text(input.reason, "reason", 4000); if (input.before === input.after) fail(400, "STYLE_CHANGE_REQUIRED", "风格候选须有实际人工修改。");
      closed(input.evidence, ["candidateId", "packageHash", "contentId", "humanEditNote"]); const candidate = record(state.nativeCandidatePackages, input.evidence.candidateId); if (candidate.packageHash !== input.evidence.packageHash || candidate.package.destinationIdentitySnapshot.id !== input.scope.destinationId || candidate.package.locale !== input.scope.locale || candidate.package.accountIdentitySnapshot?.id !== (input.scope.accountId ?? undefined) || ![candidate.package.title, candidate.package.summary, candidate.package.body].some(part => part.includes(input.before))) fail(409, "STYLE_EVIDENCE_INVALID", "风格候选必须追溯同一限定范围的真实原文修改。");
      const content = record(state.content, input.evidence.contentId), original = state.content.find(row => row.candidateId === candidate.id && row.packageHash === candidate.packageHash);
      let ancestor = content, linked = false;
      for (let depth = 0; depth < 32 && ancestor?.supersedesContentId; depth++) { ancestor = state.content.find(row => row.id === ancestor.supersedesContentId); if (ancestor?.id === original?.id) { linked = true; break; } }
      if (!original || !linked || content.id === original.id || content.storyId !== candidate.package.storyId || content.destinationId !== input.scope.destinationId || content.locale !== input.scope.locale || content.format !== candidate.package.editorialFormat || ![content.title, content.summary, content.body].some(part => part.includes(input.after))) fail(409, "STYLE_EVIDENCE_INVALID", "人工修改必须来自准确成品的实际不可变修订链，且保持同一目的地、账号、语言和形式。"); text(input.evidence.humanEditNote, "humanEditNote", 4000);
      const beforeNumbers = new Set(input.before.match(/\d+(?:\.\d+)?%?/g) ?? []); if ((input.after.match(/\d+(?:\.\d+)?%?/g) ?? []).some(number => !beforeNumbers.has(number))) fail(422, "STYLE_FACT_PERMISSION_FORBIDDEN", "风格修改不能引入新的数字事实。");
      if (/(?:审批权限|令牌|cookie|secret|password|api.?key|提高预算|已批准事实|许可豁免)/i.test(input.after)) fail(422, "STYLE_FACT_PERMISSION_FORBIDDEN", "风格记忆不能提升事实、许可、身份、预算或权限。");
      const row = { id: uid("MEM"), revision: 1, ...structuredClone(input), status: "candidate", authority: "editorial_style_only", factsApproved: false, permissionsGranted: false, originalContentId: original.id, humanRevisionContentId: content.id, proposedBy: actor, createdAt: now.toISOString() }; state.styleMemoryCandidates.push(row); return entity(row);
    });
  }
  validateStyleScope(state, scope) { closed(scope, ["accountId", "destinationId", "locale"]); const destination = record(state.destinations, scope.destinationId); if (destination.accountId !== scope.accountId || !["zh-CN", "en-US"].includes(scope.locale)) fail(403, "WORKER_SCOPE_DENIED", "风格范围须准确限定账号、目的地和语言。"); }
  promoteStyleMemory(candidateId, input, ctx) {
    closed(input, ["scope", "reason", "reviewed"]);
    return this.write(`style_memory_promoted:${candidateId}`, input, ctx, (state, { actor, now }) => {
      const candidate = record(state.styleMemoryCandidates, candidateId); assertMatch(candidate, ctx.ifMatch); this.validateStyleScope(state, input.scope); if (input.reviewed !== true || hashObject(input.scope) !== hashObject(candidate.scope) || candidate.status !== "candidate") fail(409, "STYLE_SCOPE_CHANGED", "风格提升只能使用已完整审阅的同一范围候选。"); text(input.reason, "reason", 4000);
      const previous = state.styleVersions.filter(row => hashObject(row.scope) === hashObject(input.scope)).at(-1), row = { id: uid("STYLE"), revision: (previous?.revision ?? 0) + 1, scope: structuredClone(input.scope), constraints: [...(previous?.constraints ?? []), { before: candidate.before, after: candidate.after, reason: candidate.reason }], candidateId, supersedes: previous?.id ?? null, promotedBy: actor, promotionReason: input.reason, createdAt: now.toISOString() }; row.hash = hashObject(row); state.styleVersions.push(row); candidate.status = "promoted"; candidate.promotedVersionId = row.id; candidate.revision++; return entity(row);
    });
  }
  rollbackStyleMemory(versionId, input, ctx) {
    closed(input, ["reason", "reviewed"]);
    return this.write(`style_memory_rolled_back:${versionId}`, input, ctx, (state, { actor, now }) => {
      const target = record(state.styleVersions, versionId); this.validateStyleScope(state, target.scope); const head = state.styleVersions.filter(row => hashObject(row.scope) === hashObject(target.scope)).at(-1); assertMatch(head, ctx.ifMatch); if (input.reviewed !== true) fail(422, "STYLE_REVIEW_REQUIRED", "回滚需要明确审阅。"); text(input.reason, "reason", 4000);
      const row = { id: uid("STYLE"), revision: head.revision + 1, scope: structuredClone(target.scope), constraints: structuredClone(target.constraints), supersedes: head.id, rollbackToVersionId: target.id, promotedBy: actor, promotionReason: input.reason, createdAt: now.toISOString() }; row.hash = hashObject(row); state.styleVersions.push(row); return entity(row);
    });
  }
  reviseTarget(jobId, targetKey, input, ctx) {
    closed(input, ["candidateId", "packageHash", "instructions"]); text(input.instructions, "instructions", 8000);
    return this.write(`target_revised:${jobId}:${targetKey}`, input, ctx, (state, { actor, now }) => {
      const parent = record(state.contentOpsJobs, jobId); assertMatch(parent, ctx.ifMatch); this.liveJob(state, parent, now, targetKey); const candidate = record(state.nativeCandidatePackages, input.candidateId); if (candidate.jobId !== jobId || candidate.targetKey !== targetKey || candidate.packageHash !== input.packageHash) fail(409, "NATIVE_PACKAGE_CHANGED", "修订须绑定准确父候选和最终包。");
      const revisions = state.contentOpsJobs.filter(row => row.rootJobId === (parent.rootJobId ?? parent.id) && row.revisionTargetKey === targetKey); if (revisions.length >= 2) fail(422, "REVISION_LIMIT_REACHED", "本批目标已达到两次有限返修上限。");
      const oldPlan = record(state.adaptationPlans, parent.planId), plan = structuredClone(oldPlan.normalizedPlan); plan.targets = plan.targets.filter(target => target.targetKey === targetKey); plan.targets[0].angle += `\n明确修订要求：${input.instructions}`; plan.targets[0].decision = "prepare"; plan.targets[0].knownGaps = []; const valid = validateAdaptationPlan(state, plan, { now });
      const planRow = { id: uid("PLAN"), revision: oldPlan.revision + 1, normalizedPlan: valid.plan, planHash: hashObject(without(plan, ["containsCommands"])), inputBindings: valid.sourceBindings, parentPlanId: oldPlan.id, parentCandidateId: candidate.id, createdBy: actor, createdAt: now.toISOString() }; state.adaptationPlans.push(planRow);
      const childId = uid("JOB"), compiled = compileContentOpsPlan(plan, valid.targets, { jobId: childId, adapterBindings: this.adapterBindings, state });
      const child = { ...without(parent, ["etag"]), id: childId, revision: 1, planId: planRow.id, planHash: planRow.planHash, blueprintHash: compiled.blueprintHash, parentJobId: parent.id, rootJobId: parent.rootJobId ?? parent.id, revisionTargetKey: targetKey, parentCandidateId: candidate.id, status: "queued", createdBy: actor, createdAt: now.toISOString(), cancelledAt: null, cancellationReason: null };
      state.contentOpsJobs.push(child); state.productionTaskBlueprints.push(...compiled.tasks); state.contentOpsTargetRuns.push(...compiled.targetRuns); parent.revision++;
      return { ...entity(child), jobId: childId, targets: compiled.targetRuns, requiresWorkerAuthorization: true, budgetTotals: budgetTotals(state, parent.budgetAuthorizationId) };
    });
  }
}
