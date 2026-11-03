import type { Tokenizer } from "tokenizers";
import type { DeepSeekWindowOptions, DeepSeekWindowPlan } from "./token-budget.js";

export const DEEPSEEK_FLASH_CONTEXT_TOKENS: 1048576;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS: 393216;
export const DEEPSEEK_IMAGE_TOKEN_LIMIT: 1024;
export const DEEPSEEK_MAX_IMAGES: 600;
export const DEEPSEEK_REQUEST_BODY_LIMIT_BYTES: number;
export const DEEPSEEK_IMAGE_LIMIT_BYTES: number;
export const DEEPSEEK_TOKENIZER_SHA256: string;
export const DEEPSEEK_TOKENIZER_SOURCE: string;
export const DEEPSEEK_INPUT_TOKEN_BASIS: "deepseek-v4.1-1017-public-prompt-plus-host-margin/v1";
export function getDeepSeekTokenizer(): Promise<Tokenizer>;
export function countDeepSeekTokens(text: string): Promise<number>;
export function renderDeepSeekPrompt(input: DeepSeekWindowOptions): { prompt: string; imageCount: number };
export function planDeepSeekWindow(input: DeepSeekWindowOptions): Promise<DeepSeekWindowPlan>;
