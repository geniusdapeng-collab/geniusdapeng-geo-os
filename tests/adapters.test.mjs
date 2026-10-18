import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";
import { GitHubAdapter } from "../src/adapters/github.mjs";
import { GeoEvidenceAdapter } from "../src/adapters/geoevidence.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("DeepSeek adapter combines provider search with Chat Completions", async () => {
  const requests = [];
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      if (String(url).endsWith("/v1/tools/search")) {
        return jsonResponse({
          results: [
            {
              title: "Official Harness",
              url: "https://www.deepseek.com/harness/",
              content: "Harness is an official developer preview.",
            },
          ],
        });
      }
      return jsonResponse({
        id: "chat-1",
        model: "deepseek-flash",
        choices: [
          {
            message: {
              content: "DeepSeek Harness 提供插件化 Agent 能力。[官方页面](https://www.deepseek.com/harness/)",
            },
          },
        ],
      });
    },
  });

  const result = await adapter.answerQuery({
    id: "Q001",
    text: "DeepSeek Harness 是什么",
    locale: "zh-CN",
  });
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].domain, "www.deepseek.com");
  assert.equal(result.evidence.completionId, "chat-1");
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.messages[1].content, /Official Harness/);
});

test("DeepSeek adapter falls back to Responses when chat reasoning exhausts the answer budget", async () => {
  let chatCalls = 0;
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/v1/tools/search")) {
        return jsonResponse({ results: [] });
      }
      if (String(url).endsWith("/chat/completions")) {
        chatCalls += 1;
        return jsonResponse({
          id: `empty-${chatCalls}`,
          model: "deepseek-flash",
          choices: [{ message: { content: "" } }],
        });
      }
      return jsonResponse({
        id: "response-fallback",
        model: "deepseek-flash",
        output: [
          {
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "internal reasoning" }],
          },
          {
            type: "message",
            content: [{ type: "output_text", text: "Responses fallback answer." }],
          },
        ],
      });
    },
  });
  const result = await adapter.answerQuery({
    id: "Q008",
    text: "fallback query",
    locale: "zh-CN",
  });
  assert.equal(chatCalls, 2);
  assert.equal(result.answer, "Responses fallback answer.");
  assert.equal(result.evidence.completionSurface, "deepseek-responses");
});

test("DeepSeek search citations reject non-HTTP schemes", async () => {
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/v1/tools/search")) {
        return jsonResponse({
          results: [
            { title: "Unsafe", url: "javascript:alert(1)", content: "unsafe" },
            { title: "Unsafe file", url: "file:///tmp/secret", content: "unsafe" },
            { title: "Safe", url: "https://example.com/source", content: "safe" },
          ],
        });
      }
      return jsonResponse({
        id: "chat-safe",
        model: "deepseek-flash",
        choices: [{ message: { content: "Safe answer." } }],
      });
    },
  });
  const result = await adapter.answerQuery({
    id: "Q-safe",
    text: "safe links",
    locale: "zh-CN",
  });
  assert.deepEqual(result.citations.map((citation) => citation.url), [
    "https://example.com/source",
  ]);
});

test("DeepSeek adapter parses model-generated content and rejects sensitive output", async () => {
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async () =>
      jsonResponse({
        id: "resp-1",
        model: "deepseek-flash",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  title: "证据优先的 GEO",
                  body: "先确认 Claim，再生成内容和发布回执。",
                  hook: "没有回执就不算发布",
                  cta: "查看公开项目",
                  hashtags: ["#GEO"],
                }),
              },
            ],
          },
        ],
      }),
  });
  const generated = await adapter.generateContent({
    brief: "解释证据优先",
    claims: [{ id: "C001", text: "公开 Claim" }],
    platform: "GitHub",
  });
  assert.equal(generated.title, "证据优先的 GEO");
  assert.equal(generated.responseId, "resp-1");

  const sensitiveAdapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async () =>
      jsonResponse({
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  title: "Bad",
                  body: "联系 test@example.com",
                }),
              },
            ],
          },
        ],
      }),
  });
  await assert.rejects(
    sensitiveAdapter.generateContent({
      brief: "bad",
      claims: [{ id: "C001", text: "Claim" }],
      platform: "GitHub",
    }),
    /敏感信息/,
  );
});

test("GitHub adapter creates a label and a real issue receipt shape", async () => {
  let issueBody;
  const adapter = new GitHubAdapter({
    token: "test-token",
    repository: "owner/repo",
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes("/labels/") && (!init.method || init.method === "GET")) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      if (String(url).endsWith("/labels") && init.method === "POST") {
        return jsonResponse({ name: "geo-live-smoke" }, 201);
      }
      if (String(url).endsWith("/issues") && init.method === "POST") {
        issueBody = JSON.parse(init.body);
        return jsonResponse(
          {
            id: 9,
            number: 7,
            html_url: "https://github.com/owner/repo/issues/7",
            url: "https://api.github.com/repos/owner/repo/issues/7",
            state: "open",
            created_at: "2026-10-18T10:00:00Z",
            title: issueBody.title,
          },
          201,
        );
      }
      throw new Error(`Unexpected request ${url}`);
    },
  });
  const receipt = await adapter.createIssue({
    title: "Live content",
    body: "Evidence-backed body",
  });
  assert.equal(receipt.number, 7);
  assert.equal(receipt.receiptHash.length, 64);
  assert.deepEqual(issueBody.labels, ["geo-live-smoke"]);
});

test("GeoEvidence adapter requires a synced upstream receipt", async () => {
  const adapter = new GeoEvidenceAdapter({
    baseUrl: "http://geo.test",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/health")) {
        return jsonResponse({ ok: true, service: "geo-evidence-studio" });
      }
      return jsonResponse({
        result: {
          runId: "run-1",
          status: "completed",
          provider: "deepseek-search",
          dataMode: "real",
          successful: 1,
          failed: 0,
          metrics: { citationPresenceRate: 1 },
        },
        receipt: { synced: true, mode: "real" },
      });
    },
  });
  const health = await adapter.health();
  assert.equal(health.ok, true);
  const run = await adapter.runVisibility({
    provider: "deepseek-search",
    limit: 1,
    queryId: "query-1",
  });
  assert.equal(run.runId, "run-1");
  assert.equal(run.receipt.synced, true);
});
