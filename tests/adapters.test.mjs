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
            finish_reason: "stop",
            message: {
              content: "DeepSeek Harness 提供插件化 Agent 能力。[官方页面](https://www.deepseek.com/harness/)",
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
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
  assert.deepEqual(requests[1].body.thinking, { type: "enabled" });
  assert.equal(requests[1].body.reasoning_effort, "high");
  assert.equal(requests[1].body.max_tokens, 393216);
  assert.equal(result.evidence.policy.scene, "geo.answer.synthesize");
});

test("DeepSeek adapter fails closed on empty content without Responses or model fallback", async () => {
  const paths = [];
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async (url) => {
      paths.push(new URL(String(url)).pathname);
      if (String(url).endsWith("/v1/tools/search")) {
        return jsonResponse({ results: [] });
      }
      return jsonResponse({
        id: "empty-1",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: "" } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    },
  });
  await assert.rejects(
    adapter.answerQuery({
      id: "Q008",
      text: "no fallback query",
      locale: "zh-CN",
    }),
    /content 为空/,
  );
  assert.deepEqual(paths, ["/v1/tools/search", "/chat/completions"]);
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
        choices: [{ finish_reason: "stop", message: { content: "Safe answer." } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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

test("DeepSeek adapter does not duplicate a configured /v1 API prefix", async () => {
  const paths = [];
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test/v1",
    fetchImpl: async (url) => {
      const parsed = new URL(String(url));
      paths.push(parsed.pathname);
      if (parsed.pathname === "/v1/tools/search") {
        return jsonResponse({ results: [] });
      }
      return jsonResponse({
        id: "chat-v1",
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  await adapter.answerQuery({ id: "Q-V1", text: "prefix", locale: "en" });
  assert.deepEqual(paths, ["/v1/tools/search", "/v1/chat/completions"]);
});

test("DeepSeek adapter parses model-generated content and rejects sensitive output", async () => {
  const adapter = new DeepSeekAdapter({
    apiKey: "test-key",
    baseUrl: "http://deepseek.test",
    fetchImpl: async () =>
      jsonResponse({
        id: "resp-1",
        model: "deepseek-flash",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              title: "证据优先的 GEO",
              body: "先确认 Claim，再生成内容和发布回执。",
              hook: "没有回执就不算发布",
              cta: "查看公开项目",
              hashtags: ["#GEO"],
            }),
          },
        }],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 80,
          total_tokens: 100,
          completion_tokens_details: { reasoning_tokens: 30 },
        },
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
        id: "resp-sensitive",
        model: "deepseek-flash",
        choices: [{
          finish_reason: "stop",
          message: {
            content: JSON.stringify({
              title: "Bad",
              body: "联系 test@example.com",
            }),
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
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
