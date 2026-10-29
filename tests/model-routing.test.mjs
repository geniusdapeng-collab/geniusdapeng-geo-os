import test from "node:test";
import assert from "node:assert/strict";
import { createModelDispatcher } from "../src/model-routing/dispatcher.mjs";
import { resolveScenePolicy } from "../src/model-routing/policy.mjs";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
} from "../src/model-routing/registry.mjs";
import { countTextTokens } from "../src/model-routing/tokenizer.mjs";

const HASH = "a".repeat(64);

function envelope(content = "完整回答", overrides = {}) {
  return {
    id: "request-identity-1",
    model: "deepseek-flash",
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content },
    }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

test("official tokenizer is pinned and returns a real token count", async () => {
  const count = await countTextTokens("Hello! 你好，WorkLoom");
  assert.ok(Number.isSafeInteger(count));
  assert.ok(count > 0);
  assert.ok(count < 100);
});

test("scene policy makes thinking explicit and keeps generation/review on one model", () => {
  const deterministic = resolveScenePolicy("format.transform");
  const generation = resolveScenePolicy("text.adapt");
  const finalReview = resolveScenePolicy("quality.final");
  const translation = resolveScenePolicy("translation.localize");
  assert.equal(deterministic.thinking.type, "disabled");
  assert.equal(generation.thinking.type, "enabled");
  assert.equal(generation.thinking.effort, "high");
  assert.equal(finalReview.thinking.effort, "high");
  assert.equal(translation.thinking.effort, "low");
  assert.equal(generation.generationReviewGroup, finalReview.generationReviewGroup);
  assert.equal(finalReview.sameModelAs, "text.adapt");
});

test("deterministic scene sends explicit disabled thinking, JSON mode, and maximum legal output", async () => {
  const requests = [];
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify(envelope('{"ok":true}')), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const result = await dispatcher.completeTask({
    scene: "format.transform",
    messages: [{ role: "user", content: "完整来源" }],
  });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].thinking.type, "disabled");
  assert.equal("reasoning_effort" in requests[0], false);
  assert.deepEqual(requests[0].response_format, { type: "json_object" });
  assert.equal(requests[0].max_tokens, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS);
  assert.equal(result.receipt.registry.requestedModel, "deepseek-flash");
  assert.equal(result.receipt.registry.returnedModel, "deepseek-flash");
  assert.equal(result.receipt.requestHash.length, 64);
});

test("complex generation enables high thinking and ignores sampling knobs", async () => {
  let request;
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify(envelope('{"title":"完整标题","body":"完整正文"}', {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 150,
          total_tokens: 250,
          completion_tokens_details: { reasoning_tokens: 100 },
        },
      })), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const result = await dispatcher.completeTask({
    scene: "content.draft",
    messages: [{ role: "user", content: "完整任务和事实" }],
  });
  assert.equal(request.thinking.type, "enabled");
  assert.equal(request.reasoning_effort, "high");
  assert.equal("temperature" in request, false);
  assert.equal("presence_penalty" in request, false);
  assert.equal("frequency_penalty" in request, false);
  assert.equal(result.usage.reasoningTokens, 100);
  assert.equal(result.receipt.policy.scene, "content.draft");
});

test("input token count reduces output ceiling without truncating input", async () => {
  const contextTokens = 10_000;
  let request;
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    contextTokens,
    maxOutputTokens: 20_000,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify(envelope("完整回答")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const input = "中文上下文".repeat(500);
  const result = await dispatcher.completeTask({
    scene: "geo.answer.synthesize",
    messages: [{ role: "user", content: input }],
  });
  assert.equal(request.messages[0].content, input);
  assert.equal(request.max_tokens, contextTokens - result.receipt.budget.inputTokens);
  assert.ok(request.max_tokens > 0);
  assert.ok(request.max_tokens < 20_000);
});

test("wrong model and truncated output fail closed while preserving usage evidence", async () => {
  for (const [payload, code] of [
    [envelope("完整回答", { model: "kimi-k2.6" }), "MODEL_IDENTITY_CHANGED"],
    [envelope("截断", {
      choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "截断" } }],
    }), "MODEL_OUTPUT_TRUNCATED"],
  ]) {
    const dispatcher = createModelDispatcher({
      apiKey: "test-only",
      baseUrl: "https://api.deepseek.com",
      fetchImpl: async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    });
    await assert.rejects(
      dispatcher.completeTask({
        scene: "geo.answer.synthesize",
        messages: [{ role: "user", content: "完整输入" }],
      }),
      (error) => {
        assert.equal(error.code, code);
        assert.equal(error.metering.inputTokens, 100);
        assert.equal(error.usageReceipt.providerRequestId, "request-identity-1");
        return true;
      },
    );
  }
});

test("non-thinking policy rejects hidden reasoning tokens", async () => {
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async () => new Response(JSON.stringify(envelope('{"ok":true}', {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    })), { status: 200, headers: { "Content-Type": "application/json" } }),
  });
  await assert.rejects(
    dispatcher.completeTask({
      scene: "format.transform",
      messages: [{ role: "user", content: "完整输入" }],
    }),
    (error) => error.code === "MODEL_THINKING_POLICY_VIOLATION",
  );
});

test("non-thinking policy rejects hidden reasoning content even when usage omits the count", async () => {
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async () => new Response(JSON.stringify(envelope('{"ok":true}', {
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: '{"ok":true}', reasoning_content: "hidden" },
      }],
    })), { status: 200 }),
  });
  await assert.rejects(
    dispatcher.completeTask({
      scene: "format.transform",
      messages: [{ role: "user", content: "完整输入" }],
    }),
    (error) => error.code === "MODEL_THINKING_POLICY_VIOLATION" && error.unknown === true,
  );
});

test("HTTP 500 fails closed without a duplicate paid request", async () => {
  let calls = 0;
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response('{"error":"upstream"}', { status: 500 });
    },
  });
  await assert.rejects(
    dispatcher.completeTask({
      scene: "geo.answer.synthesize",
      messages: [{ role: "user", content: "完整输入" }],
    }),
    (error) => {
      assert.equal(error.code, "MODEL_HTTP_500");
      assert.equal(error.unknown, true);
      assert.equal(error.attempts.length, 1);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("HTTP 429 retries the same model/mode once and records the first attempt", async () => {
  let calls = 0;
  const requests = [];
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    maxRetries: 1,
    fetchImpl: async (_url, init) => {
      calls += 1;
      requests.push(JSON.parse(init.body));
      if (calls === 1) return new Response('{"error":"rate limited"}', { status: 429 });
      return new Response(JSON.stringify(envelope("完整回答")), { status: 200 });
    },
  });
  const result = await dispatcher.completeTask({
    scene: "geo.answer.synthesize",
    messages: [{ role: "user", content: "完整输入" }],
  });
  assert.equal(calls, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].httpStatus, 429);
  assert.equal(result.receipt.attempts.length, 1);
});

test("full-window scheduler serializes quality-critical calls", async () => {
  let active = 0;
  let maximumActive = 0;
  const dispatcher = createModelDispatcher({
    apiKey: "test-only",
    baseUrl: "https://api.deepseek.com",
    fetchImpl: async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(JSON.stringify(envelope("完整回答")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await Promise.all([
    dispatcher.completeTask({
      scene: "geo.answer.synthesize",
      messages: [{ role: "user", content: "任务一" }],
    }),
    dispatcher.completeTask({
      scene: "geo.answer.synthesize",
      messages: [{ role: "user", content: "任务二" }],
    }),
  ]);
  assert.equal(maximumActive, 1);
});

test("registry facts remain the documented model window", () => {
  assert.equal(DEEPSEEK_FLASH_CONTEXT_TOKENS, 1_048_576);
  assert.equal(DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS, 393_216);
  assert.equal(HASH.length, 64);
});
