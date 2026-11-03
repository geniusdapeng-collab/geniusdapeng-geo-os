import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creativeCanonical } from "./constraint-compiler.js";
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
  vi.unstubAllEnvs();
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
    expect(() => creativeCanonical(verdict)).not.toThrow();
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

  it("sends the original accepted image bytes even if the live path is replaced and restored", async () => {
    const path = file("portrait.png", png);
    const replacement = Buffer.concat([png, Buffer.from("unapproved replacement")]);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const bodies: string[] = [];
    const fetchImpl: typeof fetch = (url, init) => {
      writeFileSync(path, png);
      return judge(good, bodies)(url, init);
    };
    const verdict = await reviewStage(textOptions({ stage: "keyframe", fetchImpl, artifacts: [{
      path, expectedSha256: sha256,
      get kind() { writeFileSync(path, replacement); return "image" as const; },
    }] }));
    expect(verdict.approved).toBe(true);
    expect(verdict.evidence).toContainEqual({ path, sha256, scope: "image" });
    expect(bodies[0]).toContain(`data:image/png;base64,${png.toString("base64")}`);
    expect(bodies[0]).not.toContain(replacement.toString("base64"));
  });

  it("compresses only the captured image and records the exact compressed wire hash", async () => {
    const large = Buffer.concat([png, Buffer.alloc(900_000)]);
    const path = file("large.png", large), sourceSha256 = createHash("sha256").update(large).digest("hex");
    const compressedSha256 = createHash("sha256").update(png).digest("hex");
    const bodies: string[] = [];
    let shrinkInput: Buffer | undefined;
    const verdict = await reviewStage(textOptions({ stage: "keyframe", fetchImpl: judge(good, bodies),
      artifacts: [{ path, kind: "image", expectedSha256: sourceSha256 }],
      shrinkImage: input => {
        writeFileSync(path, "path was replaced while the compressor ran");
        shrinkInput = readFileSync(input);
        writeFileSync(path, large);
        writeFileSync(`${input}.resized`, png);
        return `${input}.resized`;
      },
    }));
    expect(shrinkInput?.equals(large)).toBe(true);
    expect(verdict.approved).toBe(true);
    expect(verdict).toMatchObject({ visualEvidence: [{ path, sourceSha256, sha256: compressedSha256, kind: "resized" }] });
    expect(bodies[0]).toContain(png.toString("base64"));
  });

  it("probes and samples a single video snapshot while the original is temporarily replaced", async () => {
    const path = file("shot.mp4", "approved fixture video"), sourceSha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    const probe = file("fixture-probe", `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(path)}, 'different fixture video');
if (fs.readFileSync(process.argv.at(-1), 'utf8') !== 'approved fixture video') process.exit(1);
console.log(JSON.stringify({format: {duration: 5}}));`);
    const frame = file("fixture-frame", `#!/usr/bin/env node
const fs = require('node:fs');
if (fs.readFileSync(process.argv[process.argv.indexOf('-i') + 1], 'utf8') !== 'approved fixture video') process.exit(1);
fs.writeFileSync(process.argv.at(-1), Buffer.from(${JSON.stringify(png.toString("base64"))}, 'base64'));`);
    chmodSync(probe, 0o700); chmodSync(frame, 0o700);
    vi.stubEnv("WL_FFPROBE", probe); vi.stubEnv("WL_FFMPEG", frame);
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({ stage: "shot", artifacts: [{ path, kind: "video", expectedSha256: sourceSha256 }],
      fetchImpl: (url, init) => {
        writeFileSync(path, "approved fixture video");
        return judge(good, bodies)(url, init);
      },
    }));
    expect(verdict.approved).toBe(true);
    expect(verdict.visualEvidence).toEqual([0, 1, 2, 3, 4].map(timestampSec => ({ path, sourceSha256, timestampSec,
      sha256: createHash("sha256").update(png).digest("hex"), kind: "temporal-frame" })));
    expect(bodies[0]?.match(/"type":"image_url"/g)).toHaveLength(5);
  });

  it("refuses to shrink an evidence image whose original bytes are required", async () => {
    const path = file("original-required.png", Buffer.concat([png, Buffer.alloc(900_000)]));
    const bodies: string[] = [], shrinkImage = vi.fn(() => file("incomplete-alternative.png", png));
    const verdict = await reviewStage(textOptions({ stage: "keyframe", fetchImpl: judge(good, bodies), shrinkImage,
      artifacts: [{ path, kind: "image", requireOriginalImage: true }],
    }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified" });
    expect(shrinkImage).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(0);
  });

  it("allows digest-bound original qualification images on the direct official vision route", async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(5_000_000)]);
    const path = file("exact-reference.png", bytes), sha256 = createHash("sha256").update(bytes).digest("hex");
    const bodies: string[] = [], shrinkImage = vi.fn();
    const verdict = await reviewStage(textOptions({ allowExactQualificationImages: true, fetchImpl: judge(good, bodies), shrinkImage,
      artifacts: [{ path, kind: "image", expectedSha256: sha256, requireOriginalImage: true }],
    }));
    expect(verdict).toMatchObject({ approved: true, status: "passed", visualEvidence: [{ path, sourceSha256: sha256, sha256, kind: "original" }] });
    expect(shrinkImage).not.toHaveBeenCalled();
    expect(bodies).toHaveLength(1);
    const attached = JSON.parse(bodies[0]!).messages[0].content.find((part: { type: string }) => part.type === "image_url").image_url;
    expect(attached.detail).toBe("original");
    expect(createHash("sha256").update(Buffer.from(attached.url.split(",")[1], "base64")).digest("hex")).toBe(sha256);
  });

  it("keeps default, gateway, other-stage, missing-digest and aggregate exact-image fences", async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(4_000_000)]);
    const path = file("bounded-reference.png", bytes), sha256 = createHash("sha256").update(bytes).digest("hex");
    const original = { path, kind: "image" as const, expectedSha256: sha256, requireOriginalImage: true };
    const bodies: string[] = [];
    for (const options of [
      { allowExactQualificationImages: false },
      { env: { ...env, LLM_BASE_URL: "https://api.deepseek.com.gateway.example.test" } },
      { stage: "keyframe" as const },
      { artifacts: [{ ...original, expectedSha256: undefined }] },
      { artifacts: [original, { ...original, path: file("second-reference.png", bytes) }] },
    ]) {
      const verdict = await reviewStage(textOptions({ allowExactQualificationImages: true, fetchImpl: judge(good, bodies), artifacts: [original], ...options }));
      expect(verdict).toMatchObject({ approved: false, status: "unverified" });
    }
    expect(bodies).toHaveLength(0);
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
