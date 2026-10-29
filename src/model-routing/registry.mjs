import { modelError } from "./errors.mjs";

export const DEEPSEEK_FLASH_MODEL_ID = "deepseek-flash";
export const DEEPSEEK_FLASH_CONTEXT_TOKENS = 1_048_576;
export const DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS = 393_216;
export const DEEPSEEK_OFFICIAL_BASE_URL = "https://api.deepseek.com";
export const TEXT_PRIMARY_REGISTRY_VERSION = "2026-10-30.1";
export const TOKENIZER_ARCHIVE_SHA256 =
  "e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495";
export const TOKENIZER_JSON_SHA256 =
  "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614";
export const TOKENIZER_SOURCE =
  "https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip";

const LEGACY_ALIASES = new Map([
  ["deepseek-v4-flash", DEEPSEEK_FLASH_MODEL_ID],
  ["deepseek-v4-flash-vision-exp", DEEPSEEK_FLASH_MODEL_ID],
]);

const REJECTED_TEXT_MODELS = new Set([
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-pro",
]);

export const TEXT_PRIMARY_MODEL = Object.freeze({
  key: "text.primary",
  registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
  provider: "deepseek",
  protocol: "openai-chat",
  officialModelId: DEEPSEEK_FLASH_MODEL_ID,
  release: "DeepSeek-V4.1-Flash-1017",
  contextTokens: DEEPSEEK_FLASH_CONTEXT_TOKENS,
  maxOutputTokens: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  tokenizer: Object.freeze({
    source: TOKENIZER_SOURCE,
    archiveSha256: TOKENIZER_ARCHIVE_SHA256,
    jsonSha256: TOKENIZER_JSON_SHA256,
  }),
  capabilities: Object.freeze({
    thinking: true,
    jsonOutput: true,
    tools: true,
    imageInput: true,
  }),
});

export function cleanBaseUrl(value, fallback = DEEPSEEK_OFFICIAL_BASE_URL) {
  const raw = String(value ?? "").trim() || fallback;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw modelError("MODEL_ENDPOINT_INVALID", "模型端点必须是有效的 HTTP(S) URL。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw modelError("MODEL_ENDPOINT_INVALID", "模型端点不得包含凭据或 URL 片段。");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
  return `${url.origin}${pathname}${url.search}`;
}

export function normalizeTextModelId(value) {
  const model = String(value ?? "").trim() || DEEPSEEK_FLASH_MODEL_ID;
  if (LEGACY_ALIASES.has(model)) return LEGACY_ALIASES.get(model);
  if (REJECTED_TEXT_MODELS.has(model)
    || /^(?:kimi|moonshot|glm|qwen|gpt|claude|gemini|minimax)[-.:/]/i.test(model)
    || /^openai[/.:-]/i.test(model)) {
    throw modelError(
      "MODEL_ID_NOT_ALLOWED",
      `文本模型 ${model} 不属于 WorkLoom text.primary 契约。`,
    );
  }
  if (model !== DEEPSEEK_FLASH_MODEL_ID) {
    throw modelError(
      "MODEL_ID_NOT_REGISTERED",
      `文本模型 ${model} 未在 WorkLoom registry 中登记。`,
    );
  }
  return model;
}

export function textModelRegistration({
  env = process.env,
  baseUrl,
  model,
  contextTokens,
  maxOutputTokens,
} = {}) {
  const endpoint = cleanBaseUrl(
    baseUrl ?? env.LLM_BASE_URL ?? env.DEEPSEEK_BASE_URL,
    DEEPSEEK_OFFICIAL_BASE_URL,
  );
  const officialModelId = normalizeTextModelId(
    model ?? env.LLM_MODEL ?? env.DEEPSEEK_MODEL,
  );
  const resolvedContextTokens = contextTokens ?? DEEPSEEK_FLASH_CONTEXT_TOKENS;
  const resolvedMaxOutputTokens = maxOutputTokens ?? DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS;
  if (!Number.isSafeInteger(resolvedContextTokens) || resolvedContextTokens < 1) {
    throw modelError("MODEL_CONTEXT_INVALID", "模型上下文必须为正安全整数。");
  }
  if (!Number.isSafeInteger(resolvedMaxOutputTokens) || resolvedMaxOutputTokens < 1) {
    throw modelError("MODEL_OUTPUT_BUDGET_INVALID", "模型输出上限必须为正安全整数。");
  }
  return {
    ...TEXT_PRIMARY_MODEL,
    officialModelId,
    baseUrl: endpoint,
    contextTokens: resolvedContextTokens,
    maxOutputTokens: resolvedMaxOutputTokens,
  };
}

export function assertDeepSeekTextModel(model) {
  return normalizeTextModelId(model);
}
