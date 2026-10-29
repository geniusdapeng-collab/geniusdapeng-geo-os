/**
 * Video-pipeline model policy.
 *
 * DeepSeek currently serves `deepseek-v4-flash` as a compatibility alias for
 * `deepseek-flash` (V4.1-Flash-1017). New code must use the canonical name so
 * routing, evidence budgets and traces all identify the same live model.
 */
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL_ID,
  VIDEO_SCENE_POLICY_VERSION,
  estimateDeepSeekTokens,
  planDeepSeekWindow,
  resolveVideoScenePolicy,
  type VideoScene,
  videoThinkingBody,
} from "@workloom/base/model-router";

export {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  VIDEO_SCENE_POLICY_VERSION,
  estimateDeepSeekTokens,
  planDeepSeekWindow,
  videoThinkingBody,
};
export type { VideoScene };
export const DEEPSEEK_FLASH_MODEL = DEEPSEEK_FLASH_MODEL_ID;
/** @deprecated Scene calls compute their own maximum legal output budget. */
export const DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS = DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS;

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isDeepSeekEndpoint(value: string): boolean {
  try {
    return new URL(value).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

/** Canonical model used by every video-pipeline call. Explicit pins win. */
export function resolveVideoModel(env: Env = process.env): string {
  const provider = clean(env.LLM_PROVIDER).toLowerCase();
  if (provider === "mock") return "";
  if (provider && provider !== "deepseek") throw new Error("VIDEO_TEXT_PROVIDER_NOT_REGISTERED");
  const configured = clean(env.LLM_FORCE_MODEL)
    || clean(env.LLM_MODEL)
    || clean(env.DEEPSEEK_MODEL);
  if (configured) {
    if (configured === "deepseek-v4-flash") return DEEPSEEK_FLASH_MODEL;
    if (configured !== DEEPSEEK_FLASH_MODEL) throw new Error("VIDEO_TEXT_MODEL_NOT_REGISTERED");
    return configured;
  }
  const endpoint = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return isDeepSeekEndpoint(endpoint) || clean(env.DEEPSEEK_API_KEY)
    ? DEEPSEEK_FLASH_MODEL
    : "";
}

/**
 * OpenAI-compatible endpoint for chat completions.
 * `DEEPSEEK_BASE_URL` may point at `/anthropic` in deployed secrets; that path
 * cannot serve `/chat/completions`, so normalize it without hiding the config.
 */
export function resolveOpenAiCompatibleBaseUrl(env: Env = process.env): string {
  const base = clean(env.LLM_BASE_URL) || clean(env.DEEPSEEK_BASE_URL);
  return base.replace(/\/+$/, "").replace(/\/anthropic$/i, "");
}

export function resolveVideoApiKey(env: Env = process.env): string {
  return clean(env.LLM_API_KEY) || clean(env.DEEPSEEK_API_KEY);
}

/**
 * Legacy deployment-level comprehension of LLM_NON_THINKING. Scene policy is
 * authoritative; an explicit value is retained only as a reviewed rollback
 * switch and is not the old default-off reasoning behavior.
 */
export function resolveVideoNonThinking(_model: string, env: Env = process.env): boolean {
  const flag = clean(env.LLM_NON_THINKING).toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  if (["1", "true", "on", "yes"].includes(flag)) return true;
  // Thinking is selected by scene policy. This legacy deployment switch only
  // forces a global override when explicitly configured.
  return false;
}

/**
 * Scene policy is the source of truth. LLM_THINKING_TYPE is only a deployment
 * rollback switch and is intentionally global when set explicitly.
 */
export function resolveVideoScene(scene: VideoScene, env: Env = process.env) {
  const base = resolveVideoScenePolicy(scene);
  const override = clean(env.LLM_THINKING_TYPE).toLowerCase();
  if (override === "enabled" || override === "disabled") {
    return {
      ...base,
      thinking: override === "enabled"
        ? { type: "enabled" as const, effort: base.thinking.effort ?? "high" }
        : { type: "disabled" as const },
    };
  }
  return base;
}
