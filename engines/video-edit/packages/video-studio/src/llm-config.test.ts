import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS,
  estimateDeepSeekTokens,
  planDeepSeekWindow,
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
  resolveVideoNonThinking,
  resolveVideoScene,
} from "./llm-config.js";

describe("video model configuration", () => {
  it("uses the canonical official model and a million-token context", () => {
    expect(DEEPSEEK_FLASH_MODEL).toBe("deepseek-flash");
    expect(DEEPSEEK_FLASH_CONTEXT_TOKENS).toBe(1_048_576);
    expect(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS).toBe(393_216);
    expect(DEEPSEEK_VIDEO_JSON_OUTPUT_TOKENS).toBe(393_216);
    expect(resolveVideoModel({ LLM_BASE_URL: "https://api.deepseek.com" })).toBe("deepseek-flash");
    expect(resolveVideoModel({ DEEPSEEK_MODEL: "deepseek-v4-flash" })).toBe("deepseek-flash");
    expect(resolveVideoModel({ LLM_PROVIDER: "mock", LLM_MODEL: "deepseek-flash" })).toBe("");
    expect(() => resolveVideoModel({ LLM_PROVIDER: "openai", LLM_MODEL: "deepseek-flash" }))
      .toThrow("VIDEO_TEXT_PROVIDER_NOT_REGISTERED");
  });

  it("uses DeepSeek's documented token ratios instead of treating characters as tokens", () => {
    expect(estimateDeepSeekTokens("你好")).toBe(2);
    expect(estimateDeepSeekTokens("abcd")).toBe(2);
    expect(estimateDeepSeekTokens("{")).toBe(1);
  });

  it("prefers the OpenAI-compatible endpoint over the Anthropic endpoint", () => {
    expect(resolveOpenAiCompatibleBaseUrl({
      LLM_BASE_URL: "https://api.deepseek.com",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
    })).toBe("https://api.deepseek.com");
    expect(resolveOpenAiCompatibleBaseUrl({ DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic" }))
      .toBe("https://api.deepseek.com");
  });

  it("uses the DeepSeek credential when the generic LLM key is absent", () => {
    expect(resolveVideoApiKey({ DEEPSEEK_API_KEY: "deepseek-key" })).toBe("deepseek-key");
    expect(resolveVideoApiKey({ LLM_API_KEY: "generic-key", DEEPSEEK_API_KEY: "deepseek-key" }))
      .toBe("generic-key");
  });

  it("selects thinking by scene and retains the explicit deployment rollback", () => {
    expect(resolveVideoScene("video.preproduction.plan").thinking).toEqual({ type: "enabled", effort: "high" });
    expect(resolveVideoScene("video.quality.producer-review").thinking).toEqual({ type: "enabled", effort: "high" });
    expect(resolveVideoScene("video.quality.final-review").thinking).toEqual({ type: "enabled", effort: "high" });
    expect(resolveVideoScene("video.deterministic").thinking).toEqual({ type: "disabled" });
    expect(resolveVideoScene("video.preproduction.plan", { LLM_THINKING_TYPE: "disabled" }).thinking).toEqual({ type: "disabled" });
    expect(resolveVideoNonThinking("deepseek-flash", {})).toBe(false);
    expect(resolveVideoNonThinking("deepseek-v4-flash", {})).toBe(false);
    expect(resolveVideoNonThinking("deepseek-flash", { LLM_NON_THINKING: "0" })).toBe(false);
    expect(resolveVideoNonThinking("custom-model", {})).toBe(false);
    expect(resolveVideoNonThinking("custom-model", { LLM_NON_THINKING: "1" })).toBe(true);
  });

  it("uses the official tokenizer to maximize the legal output window", async () => {
    const plan = await planDeepSeekWindow({
      messages: [{ role: "user", content: "完整任务" }],
      responseFormat: { type: "json_object" },
    });
    expect(plan.inputTokens).toBeGreaterThan(0);
    expect(plan.outputCeiling).toBe(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS);
  });
});
