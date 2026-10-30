import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
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
  it("uses native HTTP by default so undici's body timeout cannot terminate a long complete review", async () => {
    const globalFetch = vi.fn(() => Promise.reject(new Error("global fetch must not run")));
    vi.stubGlobal("fetch", globalFetch);
    let received = "";
    const server = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", chunk => { received += String(chunk); });
      request.on("end", () => {
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(envelope('{"approved":true}')));
        }, 25);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("loopback fixture has no port");
      const result = await completeVideoTextTask({
        endpoint: { ...endpoint, baseUrl: `http://127.0.0.1:${address.port}` },
        scene: "video.quality.producer-review",
        messages: [{ role: "user", content: [{ type: "text", text: "完整长评审" }] }],
        tokenMessages: [{ role: "user", content: "完整长评审" }],
        timeoutMs: 2_000,
        requireJson: true,
      });
      expect(result.value).toEqual({ approved: true });
      expect(JSON.parse(received)).toMatchObject({ model: "deepseek-flash", stream: false });
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      vi.unstubAllGlobals();
    }
  });

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
