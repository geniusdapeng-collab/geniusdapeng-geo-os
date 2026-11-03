/**
 * Official DeepSeek Flash window planning.
 *
 * DeepSeek documents 1,048,576 input/output shared context tokens and
 * 393,216 maximum output tokens. Images are independently capped at 1,024
 * tokens each, with at most 600 images and a 48 MiB chat request body.
 *
 * The token estimate helper remains only for explanatory UI copy. Production
 * dispatch and tests use the pinned official tokenizer.
 */
import { DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS } from "./deepseek-window.mjs";

export {
  DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS, DEEPSEEK_IMAGE_TOKEN_LIMIT,
  DEEPSEEK_MAX_IMAGES, DEEPSEEK_REQUEST_BODY_LIMIT_BYTES, DEEPSEEK_IMAGE_LIMIT_BYTES,
  DEEPSEEK_TOKENIZER_SHA256, DEEPSEEK_TOKENIZER_SOURCE, DEEPSEEK_INPUT_TOKEN_BASIS,
  countDeepSeekTokens, getDeepSeekTokenizer, planDeepSeekWindow,
} from "./deepseek-window.mjs";

export const DEEPSEEK_FLASH_MODEL_ID = "deepseek-flash" as const;
export const TEXT_PRIMARY_REGISTRY_VERSION = "2026-11-03.1" as const;
export const TEXT_PRIMARY_POLICY_VERSION = "2026-10-30.1" as const;

/** @deprecated Legacy compatibility only. New dispatches use the maximum legal window. */
export const DEFAULT_JSON_OUTPUT_TOKENS = 16_384 as const;

export interface ImageUrlPart {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "original" | "auto";
  };
}

export interface FileImagePart {
  type: "file";
  file_id?: string;
  file_data?: string;
  filename?: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

export type ModelContentPart = TextPart | ImageUrlPart | FileImagePart;
export type ModelMessageContent = string | ModelContentPart[];

export interface BudgetMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: ModelMessageContent | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
  wo_eos?: boolean;
}

export function isDeepSeekFlashModel(model: string | null | undefined): boolean {
  return model === DEEPSEEK_FLASH_MODEL_ID;
}

export function canonicalDeepSeekModel(model: string | null | undefined): typeof DEEPSEEK_FLASH_MODEL_ID {
  const normalized = String(model ?? "").trim();
  if (!normalized || isDeepSeekFlashModel(normalized)) return DEEPSEEK_FLASH_MODEL_ID;
  throw new Error(`MODEL_ID_NOT_ALLOWED: ${normalized}; use ${DEEPSEEK_FLASH_MODEL_ID}`);
}

/** @deprecated Explanatory estimate only; production planning uses the official tokenizer. */
export function estimateDeepSeekTokens(text: string): number {
  let cjk = 0;
  let textChars = 0;
  let symbols = 0;
  for (const char of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) cjk += 1;
    else if (/[\p{L}\p{N}\s]/u.test(char)) textChars += 1;
    else symbols += 1;
  }
  return Math.ceil(cjk * 0.6 + textChars * 0.3 + symbols);
}

export interface DeepSeekWindowOptions {
  messages: BudgetMessage[];
  tools?: unknown;
  responseFormat?: unknown;
  thinking?: unknown;
  reasoningEffort?: unknown;
  requestBytes?: number;
  /** Host-priced image allowance for encoded media outside the token messages. */
  imageTokens?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
  productOutputCap?: number;
}

export interface DeepSeekWindowPlan {
  inputTokens: number;
  inputTokenUpperBound: number;
  inputTokenBasis: string;
  imageTokens: number;
  outputCeiling: number;
  productConstrained: boolean;
  requestBytes: number;
  imageCount: number;
}

/** @deprecated The dispatcher uses the complete request window. */
export function deepSeekInputTokenBudget(
  maxOutputTokens: number = DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
): number {
  if (!Number.isInteger(maxOutputTokens)
    || maxOutputTokens < 1
    || maxOutputTokens > DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS) {
    throw new Error("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  }
  return DEEPSEEK_FLASH_CONTEXT_TOKENS - maxOutputTokens;
}
