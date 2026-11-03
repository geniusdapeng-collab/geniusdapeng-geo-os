import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  deepSeekInputTokenBudget,
  estimateDeepSeekTokens,
  planDeepSeekWindow,
  type DeepSeekWindowOptions,
} from "./token-budget.js";
import { renderDeepSeekPrompt } from "./deepseek-window.mjs";

describe("DeepSeek token budget", () => {
  it("keeps the official context and output ceilings in the same unit", () => {
    expect(DEEPSEEK_FLASH_CONTEXT_TOKENS).toBe(1_048_576);
    expect(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS).toBe(393_216);
    expect(deepSeekInputTokenBudget(16_384)).toBe(1_032_192);
    expect(deepSeekInputTokenBudget(393_216)).toBe(655_360);
  });

  it("uses the documented text ratios and a conservative symbol estimate", () => {
    expect(estimateDeepSeekTokens("你好")).toBe(2);
    expect(estimateDeepSeekTokens("abcd")).toBe(2);
    expect(estimateDeepSeekTokens("{")).toBe(1);
    expect(estimateDeepSeekTokens("a\n中{}")).toBe(4);
  });

  it("rejects output budgets outside the official range", () => {
    expect(() => deepSeekInputTokenBudget(-1)).toThrow("DEEPSEEK_OUTPUT_BUDGET_INVALID");
    expect(() => deepSeekInputTokenBudget(393_217)).toThrow("DEEPSEEK_OUTPUT_BUDGET_INVALID");
    expect(() => deepSeekInputTokenBudget(1.5)).toThrow("DEEPSEEK_OUTPUT_BUDGET_INVALID");
  });

  it("matches the pinned official 1017 reference prompt for chat, vision, history, tools and schema", () => {
    const cases: Array<{ options: DeepSeekWindowOptions; hash: string }> = [
      { options: { messages: [{ role: "user", content: "连续完整镜头：张雪 820RR-RC / café" }] },
        hash: "3cdc1881983c849b5a0229f7cec499281511fb9a1de343da37445bce54e5c19a" },
      { options: { thinking: { type: "disabled" }, messages: [{ role: "user", content: [
        { type: "text", text: "第一张人物" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAA=" } }, { type: "text", text: "保持一致" },
      ] }] }, hash: "68da1428ec7762d958f4457fed3e2b3b754f0d5e9be483858e5edc62f39a6ffe" },
      { options: { thinking: { type: "enabled" }, reasoningEffort: "max",
        responseFormat: { type: "object", properties: { report: { type: "string" } } },
        tools: [{ type: "function", function: { name: "facts", description: "查事实",
          parameters: { type: "object", properties: { id: { type: "string" } } } } }],
        messages: [{ role: "system", content: "服务端合同" }, { role: "user", content: "需要查两种事实" },
          { role: "assistant", content: "", reasoning_content: "对照两个来源", tool_calls: [
            { id: "f1", type: "function", function: { name: "facts", arguments: '{"id":"a","n":1}' } },
            { id: "f2", type: "function", function: { name: "facts", arguments: '{"id":"b"}' } },
          ] }, { role: "tool", tool_call_id: "f2", content: "第二份证据" },
          { role: "tool", tool_call_id: "f1", content: "第一份证据" }, { role: "user", content: "完成原定报告" }],
      }, hash: "7283ae48e21741dac554c0902897cacd278d0cd4e3ddc1c99285a4f1041167ef" },
      { options: { thinking: { type: "enabled" }, reasoningEffort: "low",
        messages: [{ role: "system", content: "只使用许可事实" }, { role: "user", content: "先分析一个问题" },
          { role: "assistant", content: "明确一条", reasoning_content: "这是此前应省略的思考" },
          { role: "system", content: "现在追加要求" }, { role: "user", content: "保持原结论" }],
      }, hash: "6d2ea715aba1b8272572bc15a0a971c82b1529299eaaa3332821d53d637e3ef5" },
    ];
    for (const { options, hash } of cases) {
      expect(createHash("sha256").update(renderDeepSeekPrompt(options).prompt).digest("hex")).toBe(hash);
    }
  });

  it("keeps original image transport bytes separate from token reservation and uses the full remaining window", async () => {
    const withImage = (bytes: number): DeepSeekWindowOptions => ({ messages: [{ role: "user", content: [
      { type: "text", text: "按原件复核人物和镜头" }, { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.alloc(bytes).toString("base64")}` } },
    ] }] });
    const small = await planDeepSeekWindow(withImage(16));
    const request = withImage(5_003_858), large = await planDeepSeekWindow(request);
    expect(large).toMatchObject({ inputTokens: small.inputTokens, inputTokenUpperBound: small.inputTokenUpperBound,
      imageCount: 1, imageTokens: 1024, outputCeiling: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS });
    expect(large.requestBytes).toBeGreaterThan(6_600_000);
    expect(large.inputTokenUpperBound).toBeGreaterThan(large.inputTokens);
    await expect(planDeepSeekWindow({ ...request, contextTokens: large.inputTokenUpperBound + 99 }))
      .resolves.toMatchObject({ outputCeiling: 99, productConstrained: false });
    await expect(planDeepSeekWindow({ ...request, contextTokens: large.inputTokenUpperBound }))
      .rejects.toThrow("DEEPSEEK_CONTEXT_EXCEEDED");
  });
});
