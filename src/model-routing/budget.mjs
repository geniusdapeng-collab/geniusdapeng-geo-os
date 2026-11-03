import { modelError } from "./errors.mjs";
import { planDeepSeekWindow } from "../../engines/video-edit/packages/base/model-router/deepseek-window.mjs";

export async function planWindow({
  messages,
  tools = [],
  responseFormat,
  thinking,
  reasoningEffort,
  contextTokens,
  maxOutputTokens,
  policyMaxOutputTokens,
}) {
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1) {
    throw modelError("MODEL_CONTEXT_INVALID", "模型上下文必须为正安全整数。");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw modelError("MODEL_OUTPUT_BUDGET_INVALID", "模型输出上限必须为正安全整数。");
  }
  if (policyMaxOutputTokens !== undefined
    && (!Number.isSafeInteger(policyMaxOutputTokens) || policyMaxOutputTokens < 1)) {
    throw modelError("MODEL_OUTPUT_BUDGET_INVALID", "产品输出上限必须为正安全整数。");
  }
  try {
    const plan = await planDeepSeekWindow({ messages, tools, responseFormat, thinking, reasoningEffort,
      contextTokens, maxOutputTokens, productOutputCap: policyMaxOutputTokens });
    return {
      // This established field is the ledger bound; keep the offline estimate
      // visible separately from both the reservation and provider settlement.
      inputTokens: plan.inputTokenUpperBound,
      inputTokenEstimate: plan.inputTokens,
      inputTokenBasis: plan.inputTokenBasis,
      imageTokens: plan.imageTokens,
      legalRemaining: contextTokens - plan.inputTokenUpperBound,
      outputCeiling: plan.outputCeiling,
      outputConstrainedByProduct: plan.productConstrained,
    };
  } catch (cause) {
    if (cause?.message === "DEEPSEEK_CONTEXT_EXCEEDED") {
      throw modelError("MODEL_CONTEXT_EXCEEDED", `完整输入已占用模型上下文 ${contextTokens}，无法为输出预留空间。`, { cause });
    }
    throw modelError("MODEL_INPUT_WINDOW_UNVERIFIED", "无法核实完整模型输入及其预算，尚未发送请求。", { cause });
  }
}
