import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, resetCircuit, type ChatOptions, type EventSink, type ModelProvider } from "@workloom/base/model-router";
import { WorkloomLLMEngine, type LLMReasonOptions } from "./llm-adapter.js";

let server: Server;
let origin: string;
let bodies: Array<Record<string, unknown>>;
let httpStatus: number;
let hang: boolean;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url === "/models") { res.writeHead(200); res.end("{}"); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    bodies.push(request);
    if (hang) return;
    res.writeHead(httpStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `routed-${bodies.length}`,
      model: request.model,
      choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 },
    }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { bodies = []; httpStatus = 200; hang = false; resetCircuit(); });
afterEach(() => { vi.restoreAllMocks(); resetCircuit(); });
function setup(routed = true, timeoutMs = 180_000, maxTokens = 8192) {
  const traces: unknown[] = [], degrades: unknown[] = [];
  const sink: EventSink = { recordModelTrace: async t => { traces.push(t); }, recordDegradation: async d => { degrades.push(d); }, recordCircuitBreak: async () => undefined };
  const provider = new OpenAiCompatibleProvider("deepseek-v4-pro", { baseUrl: origin });
  const providers = new Map<string, ModelProvider>([[provider.modelId, provider]]);
  const engine = new WorkloomLLMEngine({ baseUrl: origin, apiKey: "local-test-only", model: "direct-model", timeoutMs, maxTokens,
    ...(routed ? { router: { providers, sink, scene: "preproduction" } } : {}) });
  return { engine, provider, traces, degrades };
}

describe("video adapter → routeSmart → provider → serialized HTTP", () => {
  it("resolves the base implementation in this isolated worktree", () => {
    const resolved = realpathSync(createRequire(import.meta.url).resolve("@workloom/base/model-router"));
    expect(resolved).toBe(fileURLToPath(new URL("../../base/model-router/index.ts", import.meta.url)));
  });
  it("uses scene thinking and the full legal window while preserving timeout, topP, JSON precedence and metering", async () => {
    const { engine, provider, traces } = setup();
    const chat = vi.spyOn(provider, "chat");
    const result = await engine.reason("Return JSON", { forceJson: true, responseFormat: { type: "text" }, temperature: 0, topP: 0.7, maxTokens: 7000, thinking: { type: "disabled" } });
    expect(result.success).toBe(true); expect(result.data).toEqual({ ok: true });
    expect(chat.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: 180_000, topP: 0.7, maxTokens: 393_216, responseFormat: { type: "json_object" }, thinking: { type: "enabled" }, reasoningEffort: "high" });
    expect(chat.mock.calls[0]?.[1]).not.toHaveProperty("temperature");
    expect(bodies[0]).toMatchObject({ model: "deepseek-v4-pro", top_p: 0.95, max_tokens: 393_216, response_format: { type: "json_object" }, thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(traces).toHaveLength(1); expect(traces[0]).toMatchObject({ model_id: "deepseek-v4-pro", scene: "preproduction", bill_to: "tenant", tier: "L2", credits: expect.any(Number) });
  });
  it("scene policy wins over the legacy global non-thinking flag and caller thinking override", async () => {
    const sink: EventSink = { recordModelTrace: async () => undefined, recordDegradation: async () => undefined, recordCircuitBreak: async () => undefined };
    const provider = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: origin });
    const engine = new WorkloomLLMEngine({ baseUrl: origin, apiKey: "local-test-only", model: "deepseek-flash",
      router: { providers: new Map([[provider.modelId, provider]]), sink, forceModel: "deepseek-flash", nonThinking: true } });
    expect(await engine.reason("text", { thinking: { type: "enabled", budget: 10_000 } })).toMatchObject({ success: true });
    expect(bodies[0]).toMatchObject({ model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "high" });
  });
  it("automatically pins a canonical DeepSeek engine to text.primary without cross-vendor fallback", async () => {
    const traces: any[] = [];
    const sink: EventSink = {
      recordModelTrace: async trace => { traces.push(trace); },
      recordDegradation: async () => undefined,
      recordCircuitBreak: async () => undefined,
    };
    const flash = new OpenAiCompatibleProvider("deepseek-flash", { baseUrl: origin });
    const fallback = new OpenAiCompatibleProvider("glm-5.2", { baseUrl: origin });
    const engine = new WorkloomLLMEngine({
      baseUrl: origin,
      apiKey: "local-test-only",
      model: "deepseek-flash",
      router: { providers: new Map([[flash.modelId, flash], [fallback.modelId, fallback]]), sink },
    });
    expect(await engine.reason("text")).toMatchObject({ success: true });
    expect(bodies[0]).toMatchObject({ model: "deepseek-flash" });
    expect(traces[0]).toMatchObject({ model_id: "deepseek-flash" });
  });
  it("matches direct and routed scene-policy request shapes", async () => {
    expect(await setup().engine.reason("text")).toMatchObject({ success: true });
    const routed = bodies[0]!;
    expect(await setup(false).engine.reason("text")).toMatchObject({ success: true });
    const direct = bodies[1]!;
    expect({ ...routed, model: direct.model }).toEqual(direct);
    expect(routed).toMatchObject({ max_tokens: 393_216, thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(routed).not.toHaveProperty("response_format"); expect(routed).not.toHaveProperty("temperature");
  });
  it.each([true, false])("preserves explicit responseFormat and ignores a self-imposed token cap (routed=%s)", async routed => {
    await setup(routed, 9000, 1234).engine.reason("text", { responseFormat: { type: "text" }, thinking: { type: "enabled", budget: 3 } });
    expect(bodies[0]).toMatchObject({ response_format: { type: "text" }, max_tokens: 393_216, thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(bodies[0]).not.toHaveProperty("temperature");
  });
  it("reasonRaw disables forced JSON without discarding explicit responseFormat", async () => {
    await setup().engine.reasonRaw("text", { forceJson: true, responseFormat: { type: "text" } });
    expect(bodies[0]).toMatchObject({ response_format: { type: "text" } });
  });
  it("forwards the adapter timeout to a short cancellable HTTP request", async () => {
    hang = true;
    const { engine, provider, traces, degrades } = setup(true, 30);
    const chat = vi.spyOn(provider, "chat");
    const result = await engine.reason("text");
    expect(result).toMatchObject({ success: false, retryable: true });
    expect(chat.mock.calls[0]?.[1]?.timeoutMs).toBe(30); expect(traces).toHaveLength(0);
    expect(degrades).toContainEqual(expect.objectContaining({ reason: expect.stringContaining("模型调用超时") }));
  });
  it.each([true, false])("caller abort reaches the HTTP request (routed=%s)", async routed => {
    hang = true;
    const controller = new AbortController();
    const { engine, provider } = setup(routed);
    const chat = vi.spyOn(provider, "chat");
    const promise = engine.reason("text", { signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    expect(await promise).toMatchObject({ success: false, retryable: false });
    if (routed) expect(chat.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });
  it("keeps provider errors as degradation evidence and preserves the provider retry classification", async () => {
    httpStatus = 400;
    const { engine, traces, degrades } = setup();
    expect(await engine.reason("text")).toMatchObject({ success: false, retryable: true });
    expect(traces).toHaveLength(0);
    expect(degrades).toContainEqual(expect.objectContaining({ reason: "模型调用失败：HTTP 400" }));
  });
  it("does not allow generation options to overwrite routing signal or timeout", async () => {
    const { engine, provider } = setup(true, 2222);
    const chat = vi.spyOn(provider, "chat");
    await engine.reason("text", { temperature: 0, timeoutMs: 1 } as LLMReasonOptions);
    expect(chat.mock.calls[0]?.[1] as ChatOptions).toMatchObject({ timeoutMs: 2222, maxTokens: 393_216, thinking: { type: "enabled" } });
    expect(chat.mock.calls[0]?.[1]).not.toHaveProperty("temperature");
    expect(bodies[0]).not.toHaveProperty("timeoutMs");
  });
  it("preserves structured third-argument options and chat zero through the real vendor bridge", async () => {
    // The production tsx loader owns CommonJS vendor loading; Vite's ESM test loader cannot load it directly.
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const temp = await mkdtemp(path.join(tmpdir(), "routed-llm-bridge-"));
    try {
      const script = path.join(temp, "probe.mts");
      await writeFile(script, `
import { createRequire } from "node:module";
import { WorkloomLLMEngine, installVendorEngineBridge } from ${JSON.stringify(fileURLToPath(new URL("./llm-adapter.ts", import.meta.url)))};
import { OpenAiCompatibleProvider } from ${JSON.stringify(path.join(repo, "packages/base/model-router/index.ts"))};
const module = createRequire(${JSON.stringify(path.join(repo, "package.json"))})(${JSON.stringify(path.join(repo, "vendor/supermickey/systems/llm-reasoning-engine.js"))});
const provider = new OpenAiCompatibleProvider("deepseek-v4-pro", { baseUrl: ${JSON.stringify(origin)} });
const engine = new WorkloomLLMEngine({ baseUrl: ${JSON.stringify(origin)}, apiKey: "local-test-only", model: "direct-model",
 router: { providers: new Map([[provider.modelId, provider]]), sink: { recordModelTrace: async()=>{}, recordDegradation: async()=>{}, recordCircuitBreak: async()=>{} } } });
const restore = installVendorEngineBridge(engine);
try {
 const vendor = Object.create(module.LLMEngine.prototype);
 const structured = await vendor.reasonStructured("JSON", { type: "object" }, { temperature: 0, topP: 0.5, maxTokens: 4321, thinking: { type: "disabled" } });
 const chat = await vendor.chat("system", "text", 0);
 const legacy = new module.LLMEngine({ model: "kimi-k2p6" });
 const legacyResult = await legacy.reason("legacy vendor call", { model: "kimi-k2p6" });
 console.log("RESULT " + JSON.stringify({ structured, chat, legacyResult, legacyUnavailable: legacy._noApiKey }));
} finally { restore(); }
`, "utf8");
      const { stdout } = await promisify(execFile)(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), script], { cwd: repo, timeout: 20_000 });
      const result = JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
      expect(result).toMatchObject({
        structured: { success: true, data: { ok: true } }, chat: '{"ok":true}',
        legacyResult: { success: true, content: '{"ok":true}' }, legacyUnavailable: false,
      });
      expect(bodies[0]).toMatchObject({ top_p: 0.95, max_tokens: 393_216, response_format: { type: "json_object" }, thinking: { type: "enabled" }, reasoning_effort: "high" });
      expect(bodies[0]).not.toHaveProperty("temperature");
      expect(bodies[1]).not.toHaveProperty("temperature");
      expect(bodies[2]).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoning_effort: "high" });
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
