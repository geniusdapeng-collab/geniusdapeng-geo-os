import { hashObject } from "./hash.mjs";
import { requirePublicUrl } from "./public-url.mjs";
import { AI_ACTIONS, NATIVE_FORMS, SHA256, closed, text, integer, oneOf, list, id, sha, record, checkRef, contentOpsRef, contentOpsTargetKey, contentOpsClaimFingerprint, contentOpsSourceBundle, fail, without, validDate } from "./content-ops.mjs";

const LOCALES = ["zh-CN", "en-US"];
const CREATION = ["ai_assisted_draft", "author_led_editor_assist", "human_original_copyedit", "human_only", "ineligible"];
const DELIVERY = ["prepare_only", "manual_only", "separately_authorized", "ineligible"];
const OUTPUT_KINDS = ["text", "image", "video", "captions", "repository_diff", "model_card", "dataset_card", "notebook", "demo_manifest", "document"];
const SETTINGS = {
  article: ["canonicalSourceRef", "disclosure"], image_text: ["coverOutputKey", "orderedImageOutputKeys", "disclosure"],
  video: ["durationMs", "aspect", "chapters", "disclosure"], thread: ["orderedSegmentKeys", "disclosure"], document: ["orderedPageOutputKeys", "disclosure"],
  repository_change: ["repositoryRef", "baseCommit", "operation", "tag"], model_card: ["repositoryRef", "modelArtifactRefs", "licenseRef"], dataset_card: ["datasetArtifactRefs", "licenseRef", "synthetic"],
  notebook: ["notebookRef", "inputDatasetRefs", "executionEvidenceRef", "executeCode"], demo_bundle: ["demoArtifactRefs", "runtimeEvidenceRef", "deploy"], community_message: ["channelRef", "threadRef", "visibility", "send"],
};
export function validateRefShape(ref) { closed(ref, ["id", "revision", "sha256"]); id(ref.id); integer(ref.revision, "revision", 1); sha(ref.sha256); return ref; }
const strings = (value, name, max = 128) => list(value, name, max).forEach(item => text(item, name, 2000));
function referencedEntity(state, ref) {
  validateRefShape(ref);
  const row = ["authorContributions", "productionArtifacts", "mediaAssets", "editions", "stories", "destinations", "accounts", "sourceReferences", "researchBundles", "voiceProfiles"].flatMap(key => state[key] ?? []).find(item => item.id === ref.id);
  if (!row) fail(404, "SOURCE_NOT_FOUND", "原生设置引用不存在。", { id: ref.id });
  checkRef(ref, row); return row;
}
function disclosure(value) { closed(value, ["aiUse", "requiredLabels", "authorExplanation"]); oneOf(value.aiUse, ["none", "copyedit", "translated", "generated_text", "generated_media", "mixed"], "aiUse"); strings(value.requiredLabels, "requiredLabels", 32); text(value.authorExplanation, "authorExplanation", 4000, true); }
function settings(state, target) {
  const value = target.settings; closed(value, ["kind", ...SETTINGS[target.nativeForm]]); if (value.kind !== target.nativeForm) fail(400, "NATIVE_PACKAGE_INVALID", "原生形式与 settings.kind 不一致。");
  if (value.disclosure) disclosure(value.disclosure);
  for (const key of ["canonicalSourceRef", "repositoryRef", "licenseRef", "notebookRef", "executionEvidenceRef", "runtimeEvidenceRef", "channelRef", "threadRef"]) if (value[key] !== undefined && value[key] !== null) referencedEntity(state, value[key]);
  for (const key of ["modelArtifactRefs", "datasetArtifactRefs", "inputDatasetRefs", "demoArtifactRefs"]) if (value[key]) list(value[key], key, 100).forEach(ref => referencedEntity(state, ref));
  const requireReference = (key, matches) => {
    const values = Array.isArray(value[key]) ? value[key] : value[key] === null ? [] : [value[key]];
    if (!values.length) { if (target.decision === "prepare") fail(422, "ARTIFACT_MISSING", `缺少 ${key} 的真实来源。`); return; }
    for (const ref of values) { const entity = referencedEntity(state, ref); if (!matches(entity)) fail(422, "NATIVE_REFERENCE_TYPE_INVALID", `${key} 的真实对象类型或用途不相符。`); }
  };
  const reviewed = row => row.committed === true && row.commitStatus === "committed" && row.status === "reviewed" && SHA256.test(row.rightsReviewHash ?? "") && SHA256.test(row.privacyReviewHash ?? "");
  if (["repository_change", "model_card"].includes(target.nativeForm)) requireReference("repositoryRef", row => ["repository", "artifact_repository"].includes(row.kind));
  if (target.nativeForm === "model_card") requireReference("modelArtifactRefs", row => reviewed(row) && row.role === "model_weights" && row.mime === "application/x-safetensors");
  if (target.nativeForm === "dataset_card") requireReference("datasetArtifactRefs", row => reviewed(row) && row.role === "dataset" && ["text/csv", "application/json"].includes(row.mime));
  if (["model_card", "dataset_card"].includes(target.nativeForm)) requireReference("licenseRef", row => reviewed(row) && row.role === "rights_evidence" && ["text/plain", "text/markdown", "application/json", "application/pdf"].includes(row.mime));
  if (target.nativeForm === "notebook") { requireReference("notebookRef", row => reviewed(row) && row.role === "notebook" && row.mime === "application/x-ipynb+json"); for (const ref of value.inputDatasetRefs) { const row = referencedEntity(state, ref); if (!reviewed(row) || row.role !== "dataset" || !["text/csv", "application/json"].includes(row.mime)) fail(422, "NATIVE_REFERENCE_TYPE_INVALID", "notebook 数据引用须为真实已审核数据。"); } if (value.executionEvidenceRef) requireReference("executionEvidenceRef", row => reviewed(row) && row.role === "run_log"); }
  if (target.nativeForm === "demo_bundle") { requireReference("demoArtifactRefs", row => reviewed(row) && row.role === "code" && ["application/zip", "text/javascript", "text/x-python", "application/json"].includes(row.mime)); if (value.runtimeEvidenceRef) requireReference("runtimeEvidenceRef", row => reviewed(row) && row.role === "run_log"); }
  if (target.nativeForm === "community_message") requireReference("channelRef", row => row.id === target.destinationRef.id && ["community", "community_channel", "profile_feed", "page", "repository", "artifact_repository"].includes(row.kind));
  if (target.nativeForm === "video") {
    integer(value.durationMs, "durationMs", 1, 24 * 3600 * 1000); oneOf(value.aspect, ["16:9", "9:16", "1:1"], "aspect"); let last = -1;
    for (const chapter of list(value.chapters, "chapters", 200)) { closed(chapter, ["atMs", "title"]); integer(chapter.atMs, "atMs", 0, value.durationMs - 1); if (chapter.atMs <= last) fail(400, "NATIVE_PACKAGE_INVALID", "章节时间必须严格递增。"); last = chapter.atMs; text(chapter.title, "chapter title", 240); }
  }
  for (const key of ["coverOutputKey", "orderedImageOutputKeys", "orderedSegmentKeys", "orderedPageOutputKeys"]) if (value[key] !== undefined) {
    const keys = typeof value[key] === "string" ? [value[key]] : list(value[key], key, 200, 1); if (new Set(keys).size !== keys.length) fail(400, "NATIVE_PACKAGE_INVALID", "有序原生输出不得重复。");
    const expectedKind = key === "orderedSegmentKeys" ? "text" : key === "orderedPageOutputKeys" ? "document" : "image";
    for (const outputKey of keys) if (!target.outputs.some(output => output.outputKey === outputKey && output.kind === expectedKind && output.required === true)) fail(400, "NATIVE_PACKAGE_INVALID", "原生顺序必须引用准确类型的必需输出。");
  }
  if (value.executeCode !== undefined && value.executeCode !== false || value.deploy !== undefined && value.deploy !== false || value.send !== undefined && value.send !== false) fail(403, "PLATFORM_POLICY_BLOCKED", "准备计划不能执行代码、部署或发送。");
  if (value.baseCommit !== undefined && !(target.decision !== "prepare" && value.baseCommit === null) && !/^[a-f0-9]{40,64}$/.test(value.baseCommit)) fail(400, "NATIVE_PACKAGE_INVALID", "仓库变更需准确 baseCommit。");
  if (value.operation !== undefined) oneOf(value.operation, ["prepare_diff", "prepare_release_notes"], "operation");
  if (value.tag !== undefined && value.tag !== null) text(value.tag, "tag", 200);
  if (value.synthetic !== undefined && typeof value.synthetic !== "boolean") fail(400, "NATIVE_PACKAGE_INVALID", "synthetic 必须是布尔值。");
  if (value.visibility !== undefined) oneOf(value.visibility, ["public", "restricted"], "visibility");
}
export function effectivePolicy(profile, rule, authorization, target) {
  const platform = profile.policy, destination = rule.policy;
  const allowedAiActions = AI_ACTIONS.filter(action => platform.allowedAiActions.includes(action) && destination.allowedAiActions.includes(action) && (authorization?.allowedAiActions ?? AI_ACTIONS).includes(action));
  if (target.requestedCreationMode === "human_only" || target.requestedCreationMode === "ineligible") allowedAiActions.splice(0);
  else if (target.requestedCreationMode === "human_original_copyedit") for (let at = allowedAiActions.length - 1; at >= 0; at--) if (!["copyedit", "translate"].includes(allowedAiActions[at])) allowedAiActions.splice(at, 1);
  if ((target.nativeForm === "community_message") && ["devto", "kaggle"].includes(profile.platformId)) for (let at = allowedAiActions.length - 1; at >= 0; at--) if (!["copyedit", "translate"].includes(allowedAiActions[at])) allowedAiActions.splice(at, 1);
  const requiredConditions = [...new Set([...(platform.requiredConditions ?? []), ...(destination.requiredConditions ?? []), ...(authorization?.requiredConditions ?? [])])];
  const requiresAuthorContribution = platform.requiresAuthorContribution || destination.requiresAuthorContribution || target.requestedCreationMode === "author_led_editor_assist" || target.requestedCreationMode === "human_original_copyedit" || (target.nativeForm === "community_message" && ["devto", "kaggle"].includes(profile.platformId));
  const creationMode = !allowedAiActions.length ? "human_only" : requiresAuthorContribution ? "author_led_editor_assist" : "ai_assisted_draft";
  const deliveryMode = [platform.deliveryMode, destination.deliveryMode, target.requestedDeliveryMode].includes("ineligible") ? "ineligible" : [platform.deliveryMode, destination.deliveryMode, target.requestedDeliveryMode].includes("manual_only") ? "manual_only" : "prepare_only";
  return { creationMode, deliveryMode, allowedAiActions, requiresAuthorContribution, requiredConditions, ruleBindingHash: hashObject({ profile: contentOpsRef(profile), rule: contentOpsRef(rule), authorization: authorization ? contentOpsRef(authorization) : null, requestedCreationMode: target.requestedCreationMode, requestedDeliveryMode: target.requestedDeliveryMode }) };
}
export function typedArtifactBindings(state, target) {
  const settings = target.settings, refs = [settings.modelArtifactRefs, settings.datasetArtifactRefs, settings.inputDatasetRefs, settings.demoArtifactRefs, [settings.notebookRef, settings.licenseRef, settings.executionEvidenceRef, settings.runtimeEvidenceRef]].flat().filter(Boolean);
  return [...new Map(refs.map(ref => (state.productionArtifacts ?? []).find(row => row.id === ref.id)).filter(Boolean).map(row => [row.id, { artifactId: row.id, sha256: row.sha256, bytes: row.bytes ?? row.size, mime: row.mime, role: row.role, rightsReviewHash: row.rightsReviewHash, privacyReviewHash: row.privacyReviewHash }])).values()];
}
export function validateAdaptationPlan(state, value, { now = new Date(), expectedBindings = null, targetKeys = null } = {}) {
  closed(value, ["schema", "storyRef", "motherEditionRefs", "claimBindings", "sourceBundleHash", "researchBundleRefs", "goal", "targets", "budgetAuthorizationRef", "mode", "containsCommands"]);
  if (value.schema !== "pengmanager.adaptation-plan/v1" || value.mode !== "prepare" || value.containsCommands !== false) fail(400, "ADAPTATION_PLAN_INVALID", "只接受无命令的 v1 准备计划。");
  const plan = structuredClone(value), story = checkRef(plan.storyRef, record(state.stories, plan.storyRef?.id));
  if (story.status === "archived") fail(409, "SOURCE_OUTDATED", "选题已经归档。");
  const editions = list(plan.motherEditionRefs, "motherEditionRefs", 12, 1).map(ref => { validateRefShape(ref); return checkRef(ref, record(state.editions, ref.id)); });
  if (new Set(editions.map(row => row.id)).size !== editions.length || editions.some(row => row.storyId !== story.id)) fail(400, "ADAPTATION_PLAN_INVALID", "母版必须是同一选题的独立准确修订。");
  for (const binding of list(plan.claimBindings, "claimBindings", 500)) {
    closed(binding, ["claimId", "fingerprint"]); id(binding.claimId); sha(binding.fingerprint); const claim = record(state.claims, binding.claimId);
    if (contentOpsClaimFingerprint(claim) !== binding.fingerprint || claim.state !== "approved" || claim.publicLevel !== "approved_public" || claim.sensitivity && claim.sensitivity !== "low" || claim.expiresAt && (!Number.isFinite(Date.parse(claim.expiresAt)) || Date.parse(claim.expiresAt) <= now.getTime())) fail(409, "CLAIM_CHANGED", "事实未经公开批准、已过期或已改变。", { claimId: claim.id });
    if (claim.source?.visibility !== "public") fail(409, "CLAIM_CHANGED", "私有来源的事实不能进入对外候选。"); requirePublicUrl(claim.source.url, "claim.source.url", { allowHttp: true }); text(claim.text, "claim.text", 100_000);
  }
  if (new Set(plan.claimBindings.map(row => row.claimId)).size !== plan.claimBindings.length || editions.some(edition => (edition.claimIds ?? []).some(claimId => !plan.claimBindings.some(binding => binding.claimId === claimId)))) fail(400, "ADAPTATION_PLAN_INVALID", "母版事实必须完整冻结且不能重复。");
  sha(plan.sourceBundleHash); if (plan.sourceBundleHash !== contentOpsSourceBundle(plan)) fail(409, "SOURCE_OUTDATED", "来源资料包摘要不一致。");
  for (const ref of list(plan.researchBundleRefs, "researchBundleRefs", 32)) referencedEntity(state, ref);
  text(plan.goal, "goal", 4000);
  const budget = plan.budgetAuthorizationRef === null ? null : checkRef(plan.budgetAuthorizationRef, record(state.modelBudgetAuthorizations, plan.budgetAuthorizationRef?.id), "BUDGET_CHANGED");
  const seen = new Set(), targets = [];
  for (const target of list(plan.targets, "targets", 28, 1)) {
    if (targetKeys && !targetKeys.includes(target.targetKey)) continue;
    closed(target, ["targetKey", "platformId", "destinationRef", "accountRef", "locale", "nativeForm", "decision", "decisionReasons", "profileRef", "rulesRef", "styleRef", "requestedCreationMode", "requestedDeliveryMode", "authorContributionRefs", "readerNeed", "angle", "thesis", "retainClaimIds", "mustRetainQualifiers", "removeSections", "structure", "languagePlan", "inputFiles", "outputs", "settings", "knownGaps"]);
    for (const gap of list(target.knownGaps, "knownGaps", 100)) { closed(gap, ["code", "inputKey", "explanation"]); id(gap.code); text(gap.inputKey, "inputKey", 200); text(gap.explanation, "explanation", 2000); }
    id(target.platformId); oneOf(target.locale, LOCALES, "locale"); oneOf(target.nativeForm, NATIVE_FORMS, "nativeForm"); oneOf(target.decision, ["prepare", "skip", "needs_input"], "decision"); strings(target.decisionReasons, "decisionReasons", 32);
    const destination = checkRef(target.destinationRef, record(state.destinations, target.destinationRef?.id), "IDENTITY_CHANGED");
    const account = target.accountRef === null ? null : checkRef(target.accountRef, record(state.accounts, target.accountRef?.id), "IDENTITY_CHANGED");
    if (destination.platformId !== target.platformId || destination.accountId !== (account?.id ?? null) || (!account && target.platformId !== "official-site") || account && account.platformId !== target.platformId) fail(409, "IDENTITY_CHANGED", "目标平台、目的地与账号不相容。");
    const profile = checkRef(target.profileRef, record(state.operatorProfiles, target.profileRef?.id), "RULES_CHANGED");
    const missingRule = target.rulesRef === null && target.decision === "needs_input" && target.knownGaps.some(gap => gap.code === "RULES_REVIEW_REQUIRED");
    const rule = missingRule ? { id: "UNREVIEWED", revision: 1, hash: hashObject({ destinationId: destination.id, unreviewed: true }), policy: { ...profile.policy, allowedAiActions: [], deliveryMode: "ineligible" } } : checkRef(target.rulesRef, record(state.ruleSnapshots, target.rulesRef?.id), "RULES_CHANGED");
    const ruleHead = state.ruleSnapshots.filter(row => row.destinationId === destination.id).at(-1); if (!missingRule && ruleHead?.id !== rule.id) fail(409, "RULES_CHANGED", "目的地已有新的规则修订，须重验计划。");
    if (profile.platformId !== target.platformId || !profile.supportedNativeForms.includes(target.nativeForm) || !missingRule && (rule.platformId !== target.platformId || rule.destinationId !== destination.id || rule.reviewed !== true || !validDate(rule.expiresAt) || Date.parse(rule.expiresAt) <= now.getTime())) fail(409, "RULES_CHANGED", "岗位、目的地规则或原生形式尚未核实或已过期。");
    if (target.styleRef) { const style = checkRef(target.styleRef, record(state.styleVersions, target.styleRef.id), "RULES_CHANGED"); if (style.scope.destinationId !== destination.id || style.scope.accountId !== (account?.id ?? null) || style.scope.locale !== target.locale) fail(403, "WORKER_SCOPE_DENIED", "风格版本不属于本次账号、目的地与语言。"); }
    oneOf(target.requestedCreationMode, CREATION, "requestedCreationMode"); oneOf(target.requestedDeliveryMode, DELIVERY, "requestedDeliveryMode");
    const contributions = list(target.authorContributionRefs, "authorContributionRefs", 32).map(ref => checkRef(ref, record(state.authorContributions, ref.id)));
    if (contributions.some(row => row.storyId !== story.id || !row.body?.trim() || !row.authoredBy)) fail(422, "AUTHOR_INPUT_REQUIRED", "作者贡献必须来自同一选题的真实有版本原稿。");
    for (const key of ["readerNeed", "angle", "thesis"]) text(target[key], key, 4000);
    for (const key of ["retainClaimIds", "mustRetainQualifiers", "removeSections"]) strings(target[key], key, 500);
    if (target.retainClaimIds.some(claimId => !plan.claimBindings.some(binding => binding.claimId === claimId))) fail(409, "CLAIM_CHANGED", "目标引用了未冻结事实。");
    for (const section of list(target.structure, "structure", 100, 1)) { closed(section, ["key", "purpose", "sourceSectionKeys"]); id(section.key); text(section.purpose, "purpose", 2000); strings(section.sourceSectionKeys, "sourceSectionKeys", 100); }
    const lang = closed(target.languagePlan, ["sourceLocale", "targetLocale", "translateBody", "subtitleMode", "voiceMode", "approvedVoiceProfileRef"]); oneOf(lang.sourceLocale, LOCALES, "sourceLocale"); if (lang.targetLocale !== target.locale || typeof lang.translateBody !== "boolean") fail(400, "ADAPTATION_PLAN_INVALID", "语言计划与目标不一致。"); oneOf(lang.subtitleMode, ["none", "original", "translated", "bilingual"], "subtitleMode"); oneOf(lang.voiceMode, ["preserve_original", "explicit_approved_profile"], "voiceMode"); if (lang.voiceMode === "explicit_approved_profile" && !lang.approvedVoiceProfileRef) fail(422, "AUTHOR_INPUT_REQUIRED", "配音需要真实获准档案。"); if (lang.approvedVoiceProfileRef) referencedEntity(state, lang.approvedVoiceProfileRef);
    if (!editions.some(edition => edition.locale === lang.sourceLocale) || lang.translateBody !== (lang.sourceLocale !== lang.targetLocale)) fail(400, "ADAPTATION_PLAN_INVALID", "源语言、目标语言与正文翻译决定不相容。");
    if (lang.approvedVoiceProfileRef) { const voice = record(state.voiceProfiles, lang.approvedVoiceProfileRef.id); if (voice.status !== "approved" || !voice.consentHash || voice.storyId && voice.storyId !== story.id) fail(422, "AUTHOR_INPUT_REQUIRED", "配音档案必须有准确可追溯的真实授权。"); }
    for (const file of list(target.inputFiles, "inputFiles", 100)) {
      closed(file, ["artifactId", "sha256", "bytes", "role", "rightsReviewHash", "privacyReviewHash"]); id(file.artifactId); sha(file.sha256); integer(file.bytes, "bytes", 1); sha(file.rightsReviewHash); sha(file.privacyReviewHash); oneOf(file.role, ["source_video", "source_image", "transcript", "timed_captions", "code", "dataset", "notebook", "run_log", "rights_evidence"], "file role");
      const artifact = record(state.productionArtifacts, file.artifactId); if (artifact.commitStatus !== "committed" || artifact.status !== "reviewed" || artifact.sha256 !== file.sha256 || (artifact.bytes ?? artifact.size) !== file.bytes || artifact.rightsReviewHash !== file.rightsReviewHash || artifact.privacyReviewHash !== file.privacyReviewHash) fail(409, "RIGHTS_CHANGED", "源文件字节、权利或隐私审核不相符。");
      const roleMimes = { source_video: ["video/mp4"], source_image: ["image/png", "image/jpeg", "image/webp"], transcript: ["text/plain", "text/markdown"], timed_captions: ["text/vtt", "application/x-subrip", "text/x-ass"], code: ["text/plain", "text/markdown", "text/javascript", "text/x-python", "text/x-diff", "application/zip", "application/json"], dataset: ["text/csv", "application/json"], notebook: ["application/x-ipynb+json"], run_log: ["text/plain", "text/markdown", "application/json"], rights_evidence: ["text/plain", "text/markdown", "application/json", "application/pdf", "image/png", "image/jpeg", "image/webp"] };
      if (!roleMimes[file.role].includes(artifact.mime) || artifact.role !== file.role || artifact.storyId && artifact.storyId !== story.id) fail(422, "NATIVE_REFERENCE_TYPE_INVALID", "真实源文件的 MIME、用途或选题不相符。");
    }
    const outputKeys = new Set(); for (const output of list(target.outputs, "outputs", 200, 1)) { closed(output, ["outputKey", "kind", "locale", "required", "derivedFromKeys"]); id(output.outputKey); if (outputKeys.has(output.outputKey)) fail(400, "DUPLICATE_OUTPUT", "输出键不可重复。"); outputKeys.add(output.outputKey); oneOf(output.kind, OUTPUT_KINDS, "output kind"); if (output.locale !== null) oneOf(output.locale, LOCALES, "output locale"); if (typeof output.required !== "boolean") fail(400, "ADAPTATION_PLAN_INVALID", "required 必须是布尔值。"); strings(output.derivedFromKeys, "derivedFromKeys", 200); }
    const resolved = new Set(), visiting = new Set(); const visit = output => { if (visiting.has(output.outputKey)) fail(400, "OUTPUT_DAG_CYCLE", "输出依赖不能有环。"); if (resolved.has(output.outputKey)) return; visiting.add(output.outputKey); for (const key of output.derivedFromKeys) { const parent = target.outputs.find(row => row.outputKey === key); if (!parent) fail(400, "OUTPUT_DEPENDENCY_MISSING", "输出依赖不存在。"); visit(parent); } visiting.delete(output.outputKey); resolved.add(output.outputKey); }; target.outputs.forEach(visit);
    settings(state, target); for (const gap of list(target.knownGaps, "knownGaps", 100)) { closed(gap, ["code", "inputKey", "explanation"]); id(gap.code); text(gap.inputKey, "inputKey", 200); text(gap.explanation, "explanation", 2000); }
    const key = contentOpsTargetKey(target); if (target.targetKey !== key) fail(400, "TARGET_KEY_INVALID", "目标键不是服务端准确计算结果。"); if (seen.has(key)) fail(409, "DUPLICATE_TARGET", "同一准确目标不能重复。"); seen.add(key);
    const policy = effectivePolicy(profile, rule, budget, target), gaps = structuredClone(target.knownGaps);
    const gap = (code, inputKey, explanation) => { if (!gaps.some(row => row.code === code)) gaps.push({ code, inputKey, explanation }); };
    if (destination.status !== "active" || account && account.status !== "active") gap("DESTINATION_INACTIVE", "destinationRef", "目的地或账号未启用；归档不会由计划自动恢复。");
    if (policy.requiresAuthorContribution && !contributions.length) gap("AUTHOR_INPUT_REQUIRED", "authorContributionRefs", "本岗位需真实作者原稿，最终人审不能替代作者参与。");
    if (!policy.allowedAiActions.length || policy.deliveryMode === "ineligible") gap("PLATFORM_POLICY_BLOCKED", "rulesRef", "本次政策交集不允许自动准备。");
    if (lang.translateBody && !policy.allowedAiActions.includes("translate")) gap("PLATFORM_POLICY_BLOCKED", "languagePlan", "本次规则与授权不允许正文翻译。");
    if (target.nativeForm === "video" && !target.inputFiles.some(row => row.role === "source_video")) gap("ARTIFACT_MISSING", "source_video", "缺少真实源视频，脚本不能计为成片。");
    if (target.nativeForm === "image_text" && !target.inputFiles.some(row => row.role === "source_image")) gap("ARTIFACT_MISSING", "source_image", "图文需要已审核真实图像。");
    if (target.nativeForm === "notebook" && !target.inputFiles.some(row => row.role === "notebook")) gap("ARTIFACT_MISSING", "notebook", "缺少真实 notebook；仅做静态预览。");
    if (target.nativeForm === "model_card" && !target.settings.modelArtifactRefs.length || target.nativeForm === "dataset_card" && !target.settings.datasetArtifactRefs.length || target.nativeForm === "demo_bundle" && !target.settings.demoArtifactRefs.length) gap("ARTIFACT_MISSING", target.nativeForm, "缺少实际作品，不能用说明文字代替。");
    if (lang.subtitleMode !== "none" && !target.inputFiles.some(row => row.role === "timed_captions")) gap("CAPTION_TIMING_REQUIRED", "timed_captions", "字幕需要可信台词与时间轴。");
    if (lang.voiceMode === "explicit_approved_profile") gap("EXPLICIT_VOICE_ADAPTER_REQUIRED", "voiceMode", "当前固定执行器尚未开启有逐段预算的显式配音；原声不会被静默替换。");
    if (["devto", "kaggle"].includes(target.platformId) && /(?:营销|获客|流量|seo|marketing)/i.test(plan.goal) && target.decision === "prepare") gap("PLATFORM_POLICY_BLOCKED", "goal", "该岗位不能以营销或 SEO 为主目的准备社区内容。");
    targets.push({ targetKey: key, effectivePolicy: policy, gaps, decision: target.decision === "skip" ? "skip" : gaps.length || target.decision === "needs_input" ? "needs_input" : "prepare" });
  }
  const sourceBindings = { storyRef: plan.storyRef, motherEditionRefs: plan.motherEditionRefs, claimBindings: plan.claimBindings, sourceBundleHash: plan.sourceBundleHash, targets: plan.targets.filter(target => !targetKeys || targetKeys.includes(target.targetKey)).map(target => ({ targetKey: target.targetKey, profileRef: target.profileRef, rulesRef: target.rulesRef, styleRef: target.styleRef, destinationRef: target.destinationRef, accountRef: target.accountRef, authorContributionRefs: target.authorContributionRefs, fileBindings: target.inputFiles, typedArtifactBindings: typedArtifactBindings(state, target) })) };
  const expected = expectedBindings && targetKeys ? { ...expectedBindings, targets: expectedBindings.targets.filter(target => targetKeys.includes(target.targetKey)) } : expectedBindings;
  if (expected && hashObject(sourceBindings) !== hashObject(expected)) fail(409, "RIGHTS_CHANGED", "冻结的来源、规则或typed附件权利／隐私绑定已改变。");
  return { plan, sourceBindings, targets, budget };
}
