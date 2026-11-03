import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withCreativeBudget, type CreativeBudgetHooks, type CreativeModelOutcome } from "./creative-runtime.js";
import {
  PRODUCER_RUBRICS,
  resolveProducerLlm,
  reviewStage,
  type ProducerGateOptions,
} from "./producer-gate.js";

const env = {
  LLM_BASE_URL: "https://api.deepseek.com",
  LLM_API_KEY: "test-only",
  LLM_MODEL: "deepseek-flash",
};
const dirs: string[] = [];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
  "base64",
);

function file(name: string, bytes: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "quality-test-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const good = {
  approved: true,
  score: 85,
  issues: [],
  suggestions: [],
  reason: "ok",
};

function judge(
  answer: unknown = good,
  bodies: string[] = [],
  overrides: Record<string, unknown> = {},
): typeof fetch {
  return (async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({
      id: "judge-response",
      model: "deepseek-flash",
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify(answer) },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        total_tokens: 130,
        completion_tokens_details: { reasoning_tokens: 10 },
      },
      ...overrides,
    }));
  }) as typeof fetch;
}

function textOptions(extra: Partial<ProducerGateOptions> = {}): ProducerGateOptions {
  return {
    stage: "prompt",
    projectId: "VID-中文",
    artifacts: [{ path: file("prompt.txt", "剧本与镜头约束"), kind: "text" }],
    deterministic: [],
    env,
    fetchImpl: judge(),
    ...extra,
  };
}

describe("AI producer evidence gate", () => {
  it("reserves and settles every actual producer HTTP batch including a known malformed response", async () => {
    const bodies: string[] = [], receipts: CreativeModelOutcome[] = [];
    const reservations: Array<Parameters<CreativeBudgetHooks["beforeModelCall"]>[0]> = [];
    const images = ["a", "b"].map(name => ({ path: file(`${name}.png`, png), kind: "image" as const }));
    const fetchImpl = (async (url, init) => {
      expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(reservations).toHaveLength(bodies.length + 1);
      if (!bodies.length) return judge(good, bodies, { choices: [{ finish_reason: "stop", message: { content: "not json" } }] })(url, init);
      return judge(good, bodies)(url, init);
    }) as typeof fetch;
    const verdict = await withCreativeBudget({ beforeModelCall: async request => { reservations.push(request); return request.attempt; },
      afterModelCall: async (_id, receipt) => { receipts.push(receipt); } }, () => reviewStage(textOptions({
      stage: "keyframe", artifacts: images, batchSize: 1, fetchImpl,
    })));
    expect(verdict).toMatchObject({ approved: true, status: "passed" });
    expect(verdict.receipts).toHaveLength(3); expect(bodies).toHaveLength(3);
    for (const [index, body] of bodies.entries()) expect(reservations[index]).toMatchObject({ attempt: index + 1,
      requestHash: createHash("sha256").update(body).digest("hex"), inputChars: Buffer.byteLength(body), maxOutputTokens: JSON.parse(body).max_tokens,
      imageInputTokens: 1024 });
    expect(receipts.map(receipt => [receipt.usageKnown, receipt.success, receipt.inputTokens, receipt.outputTokens]))
      .toEqual([[true, false, 100, 30], [true, true, 100, 30], [true, true, 100, 30]]);
  });

  it("reserves independent vision tokens for multiple compact images on a single real provider request", async () => {
    const bodies: string[] = [], reservations: Array<Parameters<CreativeBudgetHooks["beforeModelCall"]>[0]> = [];
    const images = ["image-a", "image-b"].map(name => ({ path: file(`${name}.png`, png), kind: "image" as const }));
    const verdict = await withCreativeBudget({ beforeModelCall: async request => { reservations.push(request); return request.attempt; },
      afterModelCall: async () => undefined }, () => reviewStage(textOptions({ stage: "keyframe", artifacts: images, fetchImpl: judge(good, bodies) })));
    expect(verdict.approved).toBe(true); expect(bodies).toHaveLength(1);
    expect(reservations).toMatchObject([{ inputChars: Buffer.byteLength(bodies[0]!), imageInputTokens: 2048 }]);
  });

  it("never dispatches a review if its budget reservation is refused", async () => {
    const bodies: string[] = [];
    const verdict = await withCreativeBudget({ beforeModelCall: async () => { throw new Error("CREATIVE_BUDGET_EXHAUSTED"); },
      afterModelCall: async () => { throw new Error("must not settle an unreserved request"); } },
    () => reviewStage(textOptions({ fetchImpl: judge(good, bodies) })));
    expect(verdict).toMatchObject({ status: "unverified", approved: false, reason: expect.stringContaining("CREATIVE_BUDGET_EXHAUSTED") });
    expect(bodies).toHaveLength(0);
  });

  it("holds unknown producer usage and prevents every following batch", async () => {
    const bodies: string[] = [], receipts: CreativeModelOutcome[] = [];
    await expect(withCreativeBudget({ beforeModelCall: async request => request.attempt,
      afterModelCall: async (_id, receipt) => { receipts.push(receipt); } }, async () => {
      const verdict = await reviewStage(textOptions({ fetchImpl: judge(good, bodies, { usage: undefined }) }));
      expect(verdict).toMatchObject({ status: "unverified", approved: false });
      const second = await reviewStage(textOptions({ fetchImpl: judge(good, bodies) }));
      expect(second).toMatchObject({ status: "unverified", approved: false });
    })).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
    expect(bodies).toHaveLength(1);
    expect(receipts).toEqual([{ usageKnown: false, success: false, actualCny: null }]);
  });

  it("has review criteria for every stage", () => {
    for (const rubric of Object.values(PRODUCER_RUBRICS)) {
      expect(rubric.every((line) => line.length > 4)).toBe(true);
    }
  });

  it("hard deterministic failure never calls the model", async () => {
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      deterministic: [{ id: "duration", pass: false, hard: true, detail: "bad" }],
      fetchImpl: judge(good, bodies),
    }));
    expect(verdict).toMatchObject({ status: "failed", approved: false });
    expect(bodies).toHaveLength(0);
  });

  it("missing model stays unverified even if the legacy fallback flag is true", async () => {
    for (const allowFallbackApprove of [false, true]) {
      const verdict = await reviewStage(textOptions({ env: {}, allowFallbackApprove }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    }
  });

  it("sends complete text evidence to one canonical thinking review", async () => {
    const content = "正常描述".repeat(4_000) + "末尾约束冲突";
    const path = file("long.txt", content);
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      artifacts: [{ path, kind: "text" }],
      fetchImpl: judge(good, bodies),
    }));
    expect(verdict.approved).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      response_format: { type: "json_object" },
    });
    expect(body.max_tokens).toBeGreaterThan(300_000);
    expect(JSON.stringify(body)).toContain("末尾约束冲突");
    expect(verdict.evidence?.[0]?.sha256)
      .toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(verdict.evidence?.[0]?.scope).toBe("complete-text");
    expect(verdict.receipts?.[0]).toMatchObject({
      modelId: "deepseek-flash",
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 10,
      finishReason: "stop",
    });
  });

  it("HTTP failure stays unverified", async () => {
    const verdict = await reviewStage(textOptions({
      fetchImpl: (async () => new Response("failure", { status: 500 })) as typeof fetch,
    }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(verdict.reason).toContain("HTTP 500");
  });

  it("wrong model, truncation, empty content and non-JSON fail closed", async () => {
    const payloads = [
      {
        id: "wrong-model",
        model: "kimi-k3",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(good) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "truncated",
        model: "deepseek-flash",
        choices: [{ finish_reason: "length", message: { content: JSON.stringify(good) } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
      {
        id: "empty",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: "" } }],
        usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
      },
      {
        id: "bad-json",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: "not json" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
    for (const payload of payloads) {
      const verdict = await reviewStage(textOptions({
        fetchImpl: (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch,
      }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    }
  });

  it("retries only malformed judge responses with a bounded JSON-only instruction", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetchImpl = (async (_url, init) => {
      bodies.push(String(init?.body));
      calls++;
      const content = calls === 1
        ? '{"approved":true,"score":85,'
        : JSON.stringify(good);
      return new Response(JSON.stringify({
        id: `judge-${calls}`,
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    }) as typeof fetch;
    const verdict = await reviewStage(textOptions({ fetchImpl }));
    expect(verdict.approved).toBe(true);
    expect(calls).toBe(2);
    expect(bodies[1]).toContain("只输出一个 JSON");
    expect(verdict.receipts).toHaveLength(2);
  });

  it("normalizes only unambiguous answer shapes", async () => {
    for (const answer of [
      { ...good, approved: "true" },
      { ...good, issues: "bad" },
      { ...good, score: "88" },
      { approved: true, score: 85, summary: "ok" },
    ]) {
      const verdict = await reviewStage(textOptions({ fetchImpl: judge(answer) }));
      expect(verdict).toMatchObject({ approved: true, status: "passed" });
    }
  });

  it("invalid shape and score stay unverified after bounded repair", async () => {
    for (const answer of [
      { ...good, score: 101 },
      { ...good, score: null },
      { ...good, suggestions: [false] },
      [],
      null,
    ]) {
      const bodies: string[] = [];
      const verdict = await reviewStage(textOptions({ fetchImpl: judge(answer, bodies) }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified" });
      expect(bodies).toHaveLength(3);
    }
  });

  it("reviews all supplied images in one complete call by default", async () => {
    const images = Array.from({ length: 7 }, (_, index) => ({
      path: file(`image-${index}.png`, png),
      kind: "image" as const,
    }));
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({
      stage: "keyframe",
      artifacts: images,
      fetchImpl: judge(good, bodies),
    }));
    expect(verdict.approved).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.match(/"type":"image_url"/g)).toHaveLength(7);
    expect(verdict.evidence).toHaveLength(7);
  });

  it("binds expected artifact hashes before and after review", async () => {
    const path = file("bound.txt", "完整证据");
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    expect((await reviewStage(textOptions({
      artifacts: [{ path, kind: "text", expectedSha256: sha256 }],
    }))).approved).toBe(true);
    expect((await reviewStage(textOptions({
      artifacts: [{ path, kind: "text", expectedSha256: "a".repeat(64) }],
    }))).approved).toBe(false);
  });

  it("missing files, missing references and unsupported audio fail closed", async () => {
    expect((await reviewStage(textOptions({
      artifacts: [{ path: "/does-not-exist/evidence.txt", kind: "text" }],
    }))).approved).toBe(false);
    expect((await reviewStage(textOptions({
      referenceImages: ["/missing-reference.png"],
    }))).approved).toBe(false);
    expect((await reviewStage(textOptions({
      artifacts: [{ path: file("audio.wav", "data"), kind: "audio" }],
    }))).approved).toBe(false);
  });

  it("producer LLM requires canonical DeepSeek configuration", () => {
    expect(resolveProducerLlm({})).toBeNull();
    expect(resolveProducerLlm({
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "key",
    })?.model).toBe("deepseek-flash");
    expect(() => resolveProducerLlm({
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "key",
      LLM_MODEL: "deepseek-chat",
    })).toThrow("MODEL_ID_NOT_ALLOWED");
  });
});
