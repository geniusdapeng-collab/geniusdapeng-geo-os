import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { completeVideoTextTask } from "./video-text-client.js";
import { withCreativeBudget, type CreativeModelOutcome } from "./creative-runtime.js";

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
  it("handles empty native HTTP responses without crashing the worker or repeating a POST", async () => {
    const program = `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { completeVideoTextTask } from './packages/video-studio/src/video-text-client.ts';
      const codes = [204, 205, 304];
      let count = 0;
      const server = createServer((req, res) => {
        req.resume();
        req.once('end', () => res.writeHead(codes[count++]).end());
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        for (const status of codes) {
          await assert.rejects(completeVideoTextTask({
            endpoint: {baseUrl: 'http://127.0.0.1:' + server.address().port, apiKey: 'fixture', model: 'deepseek-flash'},
            scene: 'video.quality.producer-review', messages: [{role:'user', content:'离线验证空响应'}], timeoutMs: 3000,
          }), error => {
            assert.equal(error.code, status === 304 ? 'MODEL_HTTP_304' : 'MODEL_RESPONSE_JSON_INVALID');
            assert.equal(error.options.status, status);
            assert.equal(error.options.retryable, false);
            assert.equal(error.options.unknown, true);
            return true;
          });
        }
        assert.equal(count, codes.length);
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    `;
    await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program], {
      cwd: new URL("../../../", import.meta.url), timeout: 8_000,
    });
  }, 10_000);

  it.each(["malformed-content", "truncated"])("settles known usage for %s without masking the output error or freezing later calls", async kind => {
    const outcomes: CreativeModelOutcome[] = [], requests: string[] = [];
    const first = kind === "truncated"
      ? envelope("", { choices: [{ finish_reason: "length", message: { content: "{\"still\":" } }] }) : envelope("not json");
    const fetchImpl = (async (_url, init) => {
      requests.push(String(init?.body));
      return new Response(JSON.stringify(requests.length === 1 ? first : envelope()));
    }) as typeof fetch;
    const call = () => completeVideoTextTask({ endpoint, scene: "video.quality.producer-review",
      messages: [{ role: "user", content: "保留完整返回证据" }], requireJson: true, fetchImpl });
    await withCreativeBudget({ beforeModelCall: async () => requests.length,
      afterModelCall: async (_reservation, outcome) => { outcomes.push(outcome); } }, async () => {
      await expect(call()).rejects.toMatchObject({ code: kind === "truncated" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_JSON_INVALID",
        options: { retryable: false, unknown: false } });
      await expect(call()).resolves.toMatchObject({ value: { ok: true } });
    });
    expect(requests).toHaveLength(2);
    expect(outcomes).toEqual([{ usageKnown: true, success: false, inputTokens: 100, outputTokens: 50 },
      { usageKnown: true, success: true, inputTokens: 100, outputTokens: 50 }]);
  });

  it.each(["wrong-identity", "missing-usage", "over-window"])("holds the charge and freezes dispatch when usage is unverified: %s", async kind => {
    const outcomes: CreativeModelOutcome[] = [], wires: string[] = [];
    const payload = envelope("not json", kind === "wrong-identity" ? { model: "wrong-model" }
      : kind === "over-window" ? { usage: { prompt_tokens: 1, completion_tokens: 393_217 } } : { usage: undefined });
    const call = () => completeVideoTextTask({ endpoint, scene: "video.quality.producer-review", requireJson: true,
      messages: [{ role: "user", content: "未验证回包不能重复收费" }], fetchImpl: (async (_url, init) => {
        wires.push(String(init?.body)); return new Response(JSON.stringify(payload));
      }) as typeof fetch });
    await expect(withCreativeBudget({ beforeModelCall: async () => wires.length,
      afterModelCall: async (_reservation, outcome) => { outcomes.push(outcome); } }, async () => {
      await expect(call()).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
      await expect(call()).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
    })).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
    expect(wires).toHaveLength(1);
    expect(outcomes).toEqual([{ usageKnown: false, success: false, actualCny: null }]);
  });

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
