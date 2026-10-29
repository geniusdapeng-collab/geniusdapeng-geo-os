/**
 * DeepSeek token units shared by routing and video text generation.
 * Official facts: 1,048,576 context tokens; 393,216 max output tokens.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Tokenizer } from "tokenizers";

export const DEEPSEEK_FLASH_MODEL_ID = "deepseek-flash" as const;
export const DEEPSEEK_FLASH_CONTEXT_TOKENS = 1_048_576 as const;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216 as const;
/** @deprecated Legacy compatibility constant; new dispatches use the maximum legal window. */
export const DEFAULT_JSON_OUTPUT_TOKENS = 16_384 as const;
export const LONG_CONTEXT_TOKENS = 32_000 as const;
export const DEEPSEEK_TOKENIZER_SHA256 =
  "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614" as const;

const DEEPSEEK_TOKENIZER_URL = new URL("./assets/deepseek-v4-tokenizer.json", import.meta.url);
let tokenizerPromise: Promise<Tokenizer> | undefined;

export function isDeepSeekFlashModel(model: string | null | undefined): boolean {
  return model === DEEPSEEK_FLASH_MODEL_ID || model === "deepseek-v4-flash";
}

/** @deprecated Explanatory estimate only; routing and dispatch use countDeepSeekTokens. */
export function estimateDeepSeekTokens(text: string): number {
  let cjk = 0, textChars = 0, symbols = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/[\p{L}\p{N}\s]/u.test(char)) textChars += 1;
    else symbols += 1;
  }
  return Math.ceil(cjk * 0.6 + textChars * 0.3 + symbols);
}

async function loadOfficialTokenizer(): Promise<Tokenizer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(DEEPSEEK_TOKENIZER_URL);
  } catch (error) {
    throw new Error("DEEPSEEK_TOKENIZER_MISSING", { cause: error });
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== DEEPSEEK_TOKENIZER_SHA256) {
    throw new Error("DEEPSEEK_TOKENIZER_CHANGED");
  }
  try {
    return Tokenizer.fromString(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("DEEPSEEK_TOKENIZER_INVALID", { cause: error });
  }
}

export function getDeepSeekTokenizer(): Promise<Tokenizer> {
  tokenizerPromise ??= loadOfficialTokenizer();
  return tokenizerPromise;
}

export async function countDeepSeekTokens(value: string): Promise<number> {
  const tokenizer = await getDeepSeekTokenizer();
  return (await tokenizer.encode(value)).getLength();
}

export async function planDeepSeekWindow(input: {
  messages: unknown;
  tools?: unknown;
  responseFormat?: unknown;
  imageTokens?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
  productOutputCap?: number;
}): Promise<{
  inputTokens: number;
  outputCeiling: number;
  productConstrained: boolean;
}> {
  const contextTokens = input.contextTokens ?? DEEPSEEK_FLASH_CONTEXT_TOKENS;
  const maxOutputTokens = input.maxOutputTokens ?? DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(contextTokens) || contextTokens < 1) throw new Error("DEEPSEEK_CONTEXT_INVALID");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  const serialized = JSON.stringify({
    messages: input.messages,
    tools: input.tools ?? [],
    responseFormat: input.responseFormat ?? null,
  });
  const messageCount = Array.isArray(input.messages) ? input.messages.length : 1;
  // Chat framing is real input overhead, not an arbitrary output-quality cap.
  const imageTokens = input.imageTokens ?? 0;
  if (!Number.isInteger(imageTokens) || imageTokens < 0) throw new Error("DEEPSEEK_IMAGE_TOKEN_BUDGET_INVALID");
  const inputTokens = await countDeepSeekTokens(serialized) + 32 + Math.max(1, messageCount) * 8 + imageTokens;
  const legalRemaining = contextTokens - inputTokens;
  if (legalRemaining < 1) throw new Error("DEEPSEEK_CONTEXT_EXCEEDED");
  const mathematical = Math.min(maxOutputTokens, legalRemaining);
  const requested = input.productOutputCap ?? mathematical;
  if (!Number.isInteger(requested) || requested < 1) throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  return {
    inputTokens,
    outputCeiling: Math.min(mathematical, requested),
    productConstrained: requested < mathematical,
  };
}

export function deepSeekInputTokenBudget(maxOutputTokens: number = DEFAULT_JSON_OUTPUT_TOKENS): number {
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS) {
    throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  }
  return DEEPSEEK_FLASH_CONTEXT_TOKENS - maxOutputTokens;
}
