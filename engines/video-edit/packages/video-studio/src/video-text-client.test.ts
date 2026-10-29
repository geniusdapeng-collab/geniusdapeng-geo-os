import { describe, expect, it } from "vitest";
import { completeVideoTextTask } from "./video-text-client.js";

const endpoint = {
  baseUrl: "https://api.deepseek.com",
  apiKey: "test-only",
  model: "deepseek-flash",
};

function envelope(content = '{"ok":true}', overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "video-text-request-1",
    model: "deepseek-flash",
    choices: [{ finish_reason: "stop", message: { content } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

describe("embedded video text dispatcher", () => {
  it("uses scene thinking, explicit JSON mode and the maximum legal output window", async () => {
    let body: Record<string, any>;
    const result = await completeVideoTextTask({
      endpoint,
      scene: "video.quality.producer-review",
      messages: [{ role: "user", content: [{ type: "text", text: "完整评审" }] }],
      tokenMessages: [{ role: "user", content: "完整评审" }],
      requireJson: true,
      fetchImpl: (async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(envelope()));
      }) as typeof fetch,
    });
    expect(body!).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 393_216,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(body!).not.toHaveProperty("temperature");
    expect(result.value).toEqual({ ok: true });
    expect(result.requestHash).toHaveLength(64);
    expect(result.responseHash).toHaveLength(64);
  });

  it("rejects wrong model identity, truncation and missing usage after preserving the response", async () => {
    const cases = [
      [envelope('{"ok":true}', { model: "deepseek-v4-pro" }), "MODEL_IDENTITY_CHANGED"],
      [envelope('{"ok":true}', {
        choices: [{ finish_reason: "length", message: { content: '{"ok":' } }],
      }), "MODEL_OUTPUT_TRUNCATED"],
      [envelope('{"ok":true}', { usage: undefined }), "MODEL_USAGE_INVALID"],
    ] as const;
    for (const [payload, code] of cases) {
      await expect(completeVideoTextTask({
        endpoint,
        scene: "video.quality.producer-review",
        messages: [{ role: "user", content: "评审" }],
        fetchImpl: (async () => new Response(JSON.stringify(payload))) as typeof fetch,
      })).rejects.toMatchObject({ code, options: { unknown: true } });
    }
  });

  it("rejects any unregistered symbolic model before making an HTTP request", async () => {
    let calls = 0;
    await expect(completeVideoTextTask({
      endpoint: { ...endpoint, model: "deepseek-v4-pro" },
      scene: "video.deterministic",
      messages: [{ role: "user", content: "任务" }],
      fetchImpl: (async () => {
        calls += 1;
        return new Response("{}");
      }) as typeof fetch,
    })).rejects.toMatchObject({ code: "VIDEO_TEXT_MODEL_NOT_REGISTERED" });
    expect(calls).toBe(0);
  });
});
