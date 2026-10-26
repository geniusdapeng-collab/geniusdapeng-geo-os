import { hashObject } from "./hash.mjs";
import { requirePublicUrl } from "./public-url.mjs";
import { closed, integer, text, oneOf, list, sha, fail, without, record, validDate } from "./content-ops.mjs";

export const BUDGET_NUMBERS = ["maxCalls", "maxInputTokens", "maxOutputTokens", "maxPerCallInputTokens", "maxPerCallOutputTokens", "maxInFlight", "maxCostMicros", "maxRenderSeconds", "maxTempBytes", "maxNativeProcesses"];
export function normalizePricing(value, { now = new Date(), id, actor } = {}) {
  closed(value, ["provider", "model", "currency", "unit", "inputCostMicrosPerMillion", "outputCostMicrosPerMillion", "requestCostMicros", "coveredBillingDimensions", "verifiedAt", "expiresAt", "sourceUrl", "reviewed"]);
  for (const key of ["provider", "model", "sourceUrl"]) text(value[key], key, 1000);
  if (!/^[A-Z]{3}$/.test(value.currency) || value.unit !== "million_tokens" || value.reviewed !== true || !validDate(value.verifiedAt) || !validDate(value.expiresAt) || Date.parse(value.verifiedAt) > now.getTime() || Date.parse(value.expiresAt) <= now.getTime()) fail(422, "PRICING_REQUIRED", "需要准确币种、价格单位、官方依据与未过期人工审阅快照。");
  let url; try { url = new URL(value.sourceUrl); } catch { fail(422, "PRICING_REQUIRED", "价格来源无效。"); } if (url.protocol !== "https:" || url.username || url.password) fail(422, "PRICING_REQUIRED", "价格依据须为无凭据的 HTTPS 来源。");
  requirePublicUrl(value.sourceUrl, "pricing.sourceUrl");
  for (const key of ["inputCostMicrosPerMillion", "outputCostMicrosPerMillion", "requestCostMicros"]) integer(value[key], key);
  const dimensions = list(value.coveredBillingDimensions, "coveredBillingDimensions", 16, 2); if (!["inputTokens", "outputTokens"].every(key => dimensions.includes(key)) || dimensions.some(key => !["inputTokens", "outputTokens", "requests", "reasoningIncludedInOutput", "cacheChargedAtInputUpperBound"].includes(key))) fail(422, "PRICING_REQUIRED", "计费维度不可界定，不能派发。");
  const row = { id, revision: 1, ...structuredClone(value), reviewedBy: actor }; row.hash = hashObject(row); return row;
}
export function normalizeBudget(input, { id, now, actor, pricing } = {}) {
  closed(input, ["name", ...BUDGET_NUMBERS, "currency", "deadlineAt", "pricingSnapshot", "allowedAiActions", "requiredConditions"], ["name", ...BUDGET_NUMBERS, "currency", "deadlineAt", "pricingSnapshot"]);
  text(input.name, "name", 240); for (const key of BUDGET_NUMBERS) integer(input[key], key);
  if (input.maxInFlight < 1 || input.maxInFlight > 32 || input.maxPerCallInputTokens > input.maxInputTokens || input.maxPerCallOutputTokens > input.maxOutputTokens || !/^[A-Z]{3}$/.test(input.currency) || !validDate(input.deadlineAt) || Date.parse(input.deadlineAt) <= now.getTime()) fail(422, "BUDGET_CONFIG_REQUIRED", "预算、并发、币种或截止时间不完整。");
  if (pricing && pricing.currency !== input.currency) fail(422, "CURRENCY_MISMATCH", "预算和价格币种必须一致。");
  const allowedAiActions = input.allowedAiActions ?? ["research", "outline", "copyedit", "translate", "draft", "generate_media"];
  list(allowedAiActions, "allowedAiActions", 6).forEach(action => oneOf(action, ["research", "outline", "copyedit", "translate", "draft", "generate_media"], "action"));
  const row = { id, revision: 1, name: input.name, ...Object.fromEntries(BUDGET_NUMBERS.map(key => [key, input[key]])), currency: input.currency, deadlineAt: new Date(input.deadlineAt).toISOString(), pricingSnapshotHash: pricing?.hash ?? null, allowedAiActions, requiredConditions: input.requiredConditions ?? [], authorizedBy: actor, authorizedAt: now.toISOString() };
  list(row.requiredConditions, "requiredConditions", 32).forEach(condition => text(condition, "condition", 240)); row.authorizationHash = hashObject(row); return row;
}
const safe = value => { if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(422, "PRICING_REQUIRED", "费用计算超出安全整数范围。"); return Number(value); };
export function upperBoundCost(pricing, bound) { return safe((BigInt(bound.inputTokens) * BigInt(pricing.inputCostMicrosPerMillion) + 999999n) / 1000000n + (BigInt(bound.outputTokens) * BigInt(pricing.outputCostMicrosPerMillion) + 999999n) / 1000000n + BigInt(pricing.requestCostMicros)); }
export function budgetTotals(state, authorizationId) {
  const rows = state.modelBudgetReservations.filter(row => row.budgetAuthorizationId === authorizationId);
  const totals = { calls: rows.filter(row => row.costClass === "model").length, inputTokens: 0, outputTokens: 0, costMicros: 0, renderSeconds: 0, tempBytes: 0, nativeProcesses: 0, inFlight: 0, used: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, reserved: { inputTokens: 0, outputTokens: 0, costMicros: 0 }, unknown: { count: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 } };
  for (const row of rows) {
    const active = ["reserved", "dispatch_recorded", "running", "unknown_usage"].includes(row.status);
    if (active) totals.inFlight++;
    for (const key of ["inputTokens", "outputTokens", "costMicros"]) {
      const actual = row.actual?.[key], pending = !Number.isSafeInteger(actual), amount = pending ? row.reserved[key] : actual; totals[key] += amount;
      totals[pending ? "reserved" : "used"][key] += amount;
      if (["unknown_usage", "partially_settled"].includes(row.status) && pending) totals.unknown[key] += amount;
    }
    if (["unknown_usage", "partially_settled"].includes(row.status)) totals.unknown.count++;
    for (const key of ["renderSeconds", "tempBytes"]) totals[key] += row.reserved[key];
    if (active) totals.nativeProcesses += row.reserved.nativeProcesses;
  }
  return totals;
}
export function reserveBudget(state, { job, task, attempt, input, now, reservationId }) {
  const authorization = record(state.modelBudgetAuthorizations, job.budgetAuthorizationId, "BUDGET_CONFIG_REQUIRED");
  if (task.budgetAuthorizationHash !== authorization.authorizationHash || !validDate(authorization.deadlineAt) || Date.parse(authorization.deadlineAt) <= now.getTime()) fail(409, "JOB_DEADLINE_EXCEEDED", "预算授权已过期或不匹配。");
  const bound = closed(input.upperBound, ["inputTokens", "outputTokens", "renderSeconds", "tempBytes", "nativeProcesses"]); for (const key of Object.keys(bound)) integer(bound[key], key);
  const paid = task.costClass === "model"; let costMicros = 0;
  if (paid) {
    const pricing = state.modelPricingSnapshots.find(row => row.hash === input.pricingSnapshotHash && row.hash === authorization.pricingSnapshotHash);
    if (!pricing || !validDate(pricing.expiresAt) || Date.parse(pricing.expiresAt) <= now.getTime() || pricing.provider !== input.provider || pricing.model !== input.model) fail(422, "PRICING_REQUIRED", "缺少与本次供应商和模型准确匹配的有效价格。");
    if (pricing.currency !== authorization.currency) fail(422, "CURRENCY_MISMATCH", "计费币种不一致。");
    if (bound.inputTokens < 1 || bound.outputTokens < 1 || bound.inputTokens > authorization.maxPerCallInputTokens || bound.outputTokens > authorization.maxPerCallOutputTokens) fail(429, "JOB_BUDGET_EXCEEDED", "单次请求 token 上界超限。");
    costMicros = upperBoundCost(pricing, bound);
  } else if (input.provider !== null || input.model !== null || bound.inputTokens || bound.outputTokens || input.pricingSnapshotHash !== null) fail(422, "PRICING_REQUIRED", "本地零模型调用不得携带隐含付费供应商。");
  const totals = budgetTotals(state, authorization.id);
  const checks = { maxCalls: totals.calls + (paid ? 1 : 0), maxInputTokens: totals.inputTokens + bound.inputTokens, maxOutputTokens: totals.outputTokens + bound.outputTokens, maxCostMicros: totals.costMicros + costMicros, maxInFlight: totals.inFlight + 1, maxRenderSeconds: totals.renderSeconds + bound.renderSeconds, maxTempBytes: totals.tempBytes + bound.tempBytes, maxNativeProcesses: totals.nativeProcesses + bound.nativeProcesses };
  for (const [key, amount] of Object.entries(checks)) if (!Number.isSafeInteger(amount) || amount > authorization[key]) fail(429, "JOB_BUDGET_EXCEEDED", "原子预算预留超过授权上限。", { dimension: key });
  const row = { id: reservationId, jobId: job.id, taskId: task.taskId, attemptId: attempt.id, callKey: input.callKey, requestHash: input.requestHash, provider: input.provider, model: input.model, pricingSnapshotHash: input.pricingSnapshotHash, budgetAuthorizationId: authorization.id, authorizationHash: authorization.authorizationHash, costClass: task.costClass, reserved: { ...bound, costMicros }, actual: { inputTokens: null, outputTokens: null, costMicros: null }, currency: authorization.currency, status: "dispatch_recorded", createdAt: now.toISOString(), providerRequestId: null };
  state.modelBudgetReservations.push(row); return row;
}
