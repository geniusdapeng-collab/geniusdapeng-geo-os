import { hashObject } from "./hash.mjs";
import { AI_ACTIONS, hashTask, hashBlueprint, hashPlan, fail } from "./content-ops.mjs";

const MIME = {
  image: { role: "image", allowedMimes: ["image/png", "image/jpeg", "image/webp"], maxBytes: 50 * 1024 * 1024 },
  video: { role: "video", allowedMimes: ["video/mp4"], maxBytes: 50 * 1024 * 1024 },
  captions: { role: "captions", allowedMimes: ["text/vtt", "application/x-subrip", "text/x-ass"], maxBytes: 1024 * 1024 },
  document: { role: "document", allowedMimes: ["application/pdf"], maxBytes: 20 * 1024 * 1024 },
  repository_diff: { role: "repository_diff", allowedMimes: ["text/x-diff", "text/markdown"], maxBytes: 8 * 1024 * 1024 },
  model_card: { role: "model_card", allowedMimes: ["text/markdown"], maxBytes: 2 * 1024 * 1024 },
  dataset_card: { role: "dataset_card", allowedMimes: ["text/markdown", "text/csv"], maxBytes: 8 * 1024 * 1024 },
  notebook: { role: "notebook", allowedMimes: ["application/x-ipynb+json"], maxBytes: 8 * 1024 * 1024 },
  demo_manifest: { role: "demo_manifest", allowedMimes: ["application/json", "application/zip"], maxBytes: 50 * 1024 * 1024 },
};
export function outputSpecFor(output) { return { outputKey: output.outputKey, kind: output.kind, locale: output.locale, required: output.required, ...(MIME[output.kind] ?? { role: "text", allowedMimes: ["text/markdown", "application/json"], maxBytes: 2 * 1024 * 1024 }) }; }
function neutralAuthorities(plan, validations, state) {
  const editions = plan.motherEditionRefs.map(ref => (state.editions ?? []).find(row => row.id === ref.id)).filter(Boolean), groups = new Map(), result = new Map();
  for (const target of plan.targets) {
    const validation = validations.find(row => row.targetKey === target.targetKey), targetFormat = ["video", "image_text"].includes(target.nativeForm) ? target.nativeForm : "article";
    if (!editions.length || validation.decision !== "prepare" || editions.some(edition => edition.locale === target.locale && edition.format === targetFormat)) continue;
    const key = hashObject({ targetLocale: target.locale, targetFormat });
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push({ target, policy: validation.effectivePolicy });
  }
  const authorityFor = members => {
    const requiresAuthorContribution = members.some(row => row.policy.requiresAuthorContribution), allowedAiActions = AI_ACTIONS.filter(action => members.every(row => row.policy.allowedAiActions.includes(action)) && !(requiresAuthorContribution && action === "draft"));
    const authorContributionRefs = members[0].target.authorContributionRefs.filter(ref => members.every(row => row.target.authorContributionRefs.some(other => hashObject(other) === hashObject(ref)))).sort((a, b) => a.id.localeCompare(b.id));
    const targetFormat = ["video", "image_text"].includes(members[0].target.nativeForm) ? members[0].target.nativeForm : "article", crossFormat = editions.some(edition => edition.format !== targetFormat), crossLanguage = editions.some(edition => edition.locale !== members[0].target.locale);
    return { allowedAiActions, requiresAuthorContribution, authorContributionRefs, crossFormat, crossLanguage };
  };
  for (const members of groups.values()) {
    const common = authorityFor(members), usable = value => (value.crossLanguage && !value.crossFormat ? value.allowedAiActions.includes("translate") : value.allowedAiActions.some(action => ["draft", "copyedit"].includes(action))) && (!value.requiresAuthorContribution || value.authorContributionRefs.length);
    // A common transform may only use authority and author material possessed
    // by every consumer. Incompatible author sets or action scopes split it.
    const split = new Map(); if (!usable(common)) for (const row of members) { const key = hashObject({ allowedAiActions: row.policy.allowedAiActions, requiresAuthorContribution: row.policy.requiresAuthorContribution, authorContributionRefs: row.target.authorContributionRefs }); if (!split.has(key)) split.set(key, []); split.get(key).push(row); }
    const partitions = usable(common) ? [members] : [...split.values()];
    for (const partition of partitions) {
      const authority = authorityFor(partition); if (!usable(authority)) fail(422, "PLATFORM_POLICY_BLOCKED", "中立转换没有共同允许的操作或真实作者材料。");
      const targetKeys = partition.map(row => row.target.targetKey), policy = { creationMode: authority.requiresAuthorContribution ? "author_led_editor_assist" : "ai_assisted_draft", deliveryMode: "prepare_only", allowedAiActions: authority.allowedAiActions, requiresAuthorContribution: authority.requiresAuthorContribution, requiredConditions: [...new Set(partition.flatMap(row => row.policy.requiredConditions))], ruleBindingHash: hashObject(partition.map(row => ({ targetKey: row.target.targetKey, effectivePolicyHash: hashObject(row.policy), authorContributionRefs: row.target.authorContributionRefs }))) };
      const value = { ...authority, targetKeys, policy }; for (const row of partition) result.set(row.target.targetKey, value);
    }
  }
  return result;
}
export function compileContentOpsPlan(plan, validations, { jobId, adapterBindings = [], state = {} } = {}) {
  const tasks = [], targetRuns = [], budgetAuthorizationHash = plan.budgetAuthorizationRef?.sha256 ?? null;
  const transforms = new Map(), authorities = neutralAuthorities(plan, validations, state);
  const bindingFor = kind => {
    const binding = adapterBindings.find(row => row.kind === kind || row.adapterId === kind);
    if (!binding) return { adapterId: kind, version: "unbound", entrypointSha: null, nativeCapabilityId: null, fixedTransport: kind === "package.freeze" ? "server" : "worker", validatorVersion: "unbound", declared: true, codePresent: false, ready: false, productionVerified: false };
    return structuredClone(binding);
  };
  for (const [index, target] of plan.targets.entries()) {
    const validation = validations.find(row => row.targetKey === target.targetKey);
    const targetRun = { id: `TR-${hashObject({ jobId, key: target.targetKey }).slice(0, 24)}`, jobId, targetKey: target.targetKey, targetIndex: index, platformId: target.platformId, destinationId: target.destinationRef.id, accountId: target.accountRef?.id ?? null, locale: target.locale, nativeForm: target.nativeForm, revision: 1, effectivePolicy: validation.effectivePolicy, gaps: validation.gaps, decision: validation.decision, status: validation.decision === "skip" ? "skipped" : validation.decision === "needs_input" ? "needs_input" : budgetAuthorizationHash ? "queued" : "blocked_budget", candidateIds: [], taskIds: [] };
    targetRuns.push(targetRun); if (targetRun.status === "skipped" || targetRun.status === "needs_input") continue;
    const add = (kind, dependsOn = [], outputSpec = [], inputRefs = []) => {
      const taskId = `TASK-${hashObject({ jobId, targetKey: target.targetKey, kind, ordinal: tasks.length }).slice(0, 24)}`;
      const logicalInputs = dependsOn.map(producerTaskId => ({ producerTaskId, outputKey: "result" }));
      const settingsRefs = [target.settings.modelArtifactRefs, target.settings.datasetArtifactRefs, target.settings.inputDatasetRefs, target.settings.demoArtifactRefs, [target.settings.notebookRef, target.settings.licenseRef, target.settings.executionEvidenceRef, target.settings.runtimeEvidenceRef]].flat().filter(Boolean);
      const typedFiles = settingsRefs.map(ref => (state.productionArtifacts ?? []).find(artifact => artifact.id === ref.id)).filter(Boolean).map(artifact => ({ artifactId: artifact.id, sha256: artifact.sha256, bytes: artifact.bytes ?? artifact.size, role: artifact.role, rightsReviewHash: artifact.rightsReviewHash, privacyReviewHash: artifact.privacyReviewHash }));
      const compileInputs = { planHash: hashPlan(plan), planProjectionHash: hashPlan({ ...plan, targets: [target] }), targetHash: hashObject(target), effectivePolicyHash: hashObject(validation.effectivePolicy), sourceRefs: [plan.storyRef, ...plan.motherEditionRefs, target.destinationRef, ...(target.accountRef ? [target.accountRef] : []), target.profileRef, target.rulesRef, ...(target.styleRef ? [target.styleRef] : []), ...target.authorContributionRefs], fileRefs: [...new Map([...target.inputFiles, ...typedFiles].map(ref => [ref.artifactId, ref])).values()], logicalInputs, inputRefs };
      const task = { schema: "pengmanager.task-blueprint/v1", taskId, jobId, targetKey: target.targetKey, kind, adapterBinding: bindingFor(kind), dependsOn: [...dependsOn], inputRefs: compileInputs, outputSpec, permissionRequirements: { aiActions: kind === "text.adapt" ? [validation.effectivePolicy.allowedAiActions.includes("draft") ? "draft" : "copyedit"] : kind === "translation.localize" ? ["translate"] : kind === "text.polish" ? ["copyedit"] : [], independentChecker: ["quality.check", "quality.final"].includes(kind), localOwnerRequired: kind !== "package.freeze" }, costClass: ["strategy.plan", "text.adapt", "translation.localize", "text.polish", "quality.check", "quality.final"].includes(kind) ? "model" : kind.startsWith("video.") ? "local_render" : "local_deterministic", budgetAuthorizationHash, timeoutMs: kind.startsWith("video.") ? 15 * 60 * 1000 : 120_000, compileInputHash: hashObject(compileInputs) };
      task.taskHash = hashTask(task); tasks.push(task); targetRun.taskIds.push(taskId); return taskId;
    };
    const targetFormat = ["video", "image_text"].includes(target.nativeForm) ? target.nativeForm : "article";
    const compatible = plan.motherEditionRefs.map(ref => (state.editions ?? []).find(row => row.id === ref.id)).filter(Boolean).some(edition => edition.locale === target.locale && edition.format === targetFormat);
    let neutralTaskId = null;
    if (!compatible && (state.editions ?? []).length) {
      const authority = authorities.get(target.targetKey), transformSpec = { schema: "pengmanager.format-transform/v1", targetLocale: target.locale, targetFormat, preserveClaims: true, preserveAuthorContribution: true, platformNeutral: true, authority: { allowedAiActions: authority.allowedAiActions, requiresAuthorContribution: authority.requiresAuthorContribution, authorContributionRefs: authority.authorContributionRefs } }, formatTransformKey = hashObject({ sourceEditionRefs: plan.motherEditionRefs, targetLocale: target.locale, targetFormat, transformSpec });
      if (!transforms.has(formatTransformKey)) {
        const sourceEditions = plan.motherEditionRefs.map(ref => (state.editions ?? []).find(row => row.id === ref.id)), crossFormat = sourceEditions.some(edition => edition.format !== targetFormat), crossLanguage = sourceEditions.some(edition => edition.locale !== target.locale);
        const transformKind = crossFormat && crossLanguage ? "cross_format_and_language" : crossFormat ? "cross_format" : "cross_language";
        const taskId = add("format.transform"); const task = tasks.find(row => row.taskId === taskId);
        const familyId = `${plan.storyRef.id}-${target.locale}-${targetFormat}`, head = (state.editions ?? []).filter(row => row.familyId === familyId).sort((a, b) => b.editorialRevision - a.editorialRevision)[0];
        task.transformSpec = transformSpec; task.formatTransformKey = formatTransformKey; task.transformKind = transformKind; task.expectedFamilyHeadId = head?.id ?? null; task.costClass = "model"; task.neutralPolicy = authority.policy; task.neutralTargetKeys = authority.targetKeys; task.neutralAuthorContributionRefs = authority.authorContributionRefs;
        task.inputRefs.effectivePolicyHash = hashObject(authority.policy); task.inputRefs.sourceRefs = task.inputRefs.sourceRefs.filter(ref => !target.authorContributionRefs.some(author => hashObject(author) === hashObject(ref))).concat(authority.authorContributionRefs); task.permissionRequirements.aiActions = [crossLanguage && !crossFormat ? "translate" : authority.allowedAiActions.includes("draft") ? "draft" : "copyedit"];
        task.compileInputHash = hashObject({ ...task.inputRefs, transformSpec, formatTransformKey, expectedFamilyHeadId: task.expectedFamilyHeadId }); task.taskHash = hashTask(task); transforms.set(formatTransformKey, taskId);
      }
      neutralTaskId = transforms.get(formatTransformKey); if (!targetRun.taskIds.includes(neutralTaskId)) targetRun.taskIds.push(neutralTaskId);
    }
    const strategy = add("strategy.plan", neutralTaskId ? [neutralTaskId] : []), draft = add(target.languagePlan.translateBody && !neutralTaskId ? "translation.localize" : "text.adapt", [strategy, ...(neutralTaskId ? [neutralTaskId] : [])]);
    let lastDraft = draft, lastCheck = add("quality.check", [draft]);
    for (let repairIndex = 1; repairIndex <= 2; repairIndex++) {
      const revisionId = add("text.revise", [lastDraft, lastCheck]), revision = tasks.find(row => row.taskId === revisionId); revision.conditionalRepair = { repairIndex, checkTaskId: lastCheck, draftTaskId: lastDraft }; revision.costClass = "model"; revision.permissionRequirements.aiActions = [validation.effectivePolicy.allowedAiActions.includes("draft") ? "draft" : "copyedit"]; revision.taskHash = hashTask(revision);
      const checkId = add("quality.check", [revisionId]), check = tasks.find(row => row.taskId === checkId); check.conditionalCheck = { repairTaskId: revisionId, previousCheckTaskId: lastCheck }; check.finalPrecheck = repairIndex === 2; check.taskHash = hashTask(check); lastDraft = revisionId; lastCheck = checkId;
    }
    const polish = add("text.polish", [lastDraft, lastCheck]);
    const producerByOutput = new Map(), materialTasks = [];
    const compileOutput = output => {
      if (producerByOutput.has(output.outputKey)) return producerByOutput.get(output.outputKey);
      const deps = output.derivedFromKeys.map(key => compileOutput(target.outputs.find(row => row.outputKey === key)));
      if (output.kind === "text") { producerByOutput.set(output.outputKey, polish); return polish; }
      const kind = output.kind === "image" ? "image.compose" : output.kind === "video" ? "video.assemble" : output.kind === "captions" ? "caption.align" : output.kind === "document" ? "document.render" : "native.prepare";
      const producer = add(kind, [...new Set([polish, ...deps])], [outputSpecFor(output)], [{ targetOutputKey: output.outputKey }]);
      producerByOutput.set(output.outputKey, producer); materialTasks.push(producer); return producer;
    };
    target.outputs.forEach(compileOutput);
    const freeze = add("package.freeze", [...new Set([polish, ...materialTasks])], [], [{ targetOutputBindings: [...producerByOutput].map(([outputKey, producerTaskId]) => ({ outputKey, producerTaskId })) }]);
    add("quality.final", [freeze]);
  }
  for (const task of tasks) if (task.permissionRequirements.aiActions.some(action => !(task.neutralPolicy ?? targetRuns.find(run => run.targetKey === task.targetKey).effectivePolicy).allowedAiActions.includes(action))) fail(422, "PLATFORM_POLICY_BLOCKED", "编译任务超出平台、目的地与授权共同允许的 AI 操作。");
  return { tasks, targetRuns, blueprintHash: hashBlueprint(tasks) };
}
