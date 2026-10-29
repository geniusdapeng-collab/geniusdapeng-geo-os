import { modelError } from "./errors.mjs";
import { countMessagesTokens } from "./tokenizer.mjs";

export async function planWindow({
  messages,
  tools = [],
  responseFormat,
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
  const inputTokens = await countMessagesTokens(messages, { tools, responseFormat });
  const legalRemaining = contextTokens - inputTokens;
  if (!Number.isSafeInteger(legalRemaining) || legalRemaining < 1) {
    throw modelError(
      "MODEL_CONTEXT_EXCEEDED",
      `完整输入占用 ${inputTokens} tokens，已超过模型上下文 ${contextTokens}。`,
    );
  }
  const requested = Number.isSafeInteger(policyMaxOutputTokens)
    ? policyMaxOutputTokens
    : maxOutputTokens;
  const outputCeiling = Math.min(
    maxOutputTokens,
    legalRemaining,
    Number.isSafeInteger(requested) && requested > 0 ? requested : maxOutputTokens,
  );
  if (outputCeiling < 1) {
    throw modelError("MODEL_OUTPUT_BUDGET_INVALID", "完整输入后没有可用的输出预算。");
  }
  return {
    inputTokens,
    legalRemaining,
    outputCeiling,
    outputConstrainedByProduct:
      Number.isSafeInteger(requested) && requested > 0 && requested < Math.min(maxOutputTokens, legalRemaining),
  };
}
