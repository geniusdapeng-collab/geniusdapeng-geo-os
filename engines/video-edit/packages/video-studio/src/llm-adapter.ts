/**
 * llm-adapter.ts —— WorkLoom model-router ↔ SuperMickey LLMEngine 接口适配
 *
 * vendor 侧所有 LLM 调用点都期望 systems/llm-reasoning-engine.js 的接口：
 *   reason(prompt, opts)          → { success, content?, error?, retryable? }
 *   chat(system, user, temp)      → string（失败抛错）
 *   reasonRaw(prompt, opts)       → { success, content? ... }（不强制 JSON 提取）
 *   reasonStructured(prompt, schema, opts) → { success, data?/content? ... }
 * 本适配器用任意 OpenAI 兼容端点（底座 LLM_* 四环境变量）实现同一接口，
 * 不在 TS 层复制 vendor 的模型名等字面值——模型选择交由调用方/配置注入。
 *
 * v3.0 收口：配置 router 后，全部调用经 routeSmart（preproduction 场景，
 * 真实计量 + model.call 事件留痕 + 降级链），vendor 只读纪律不破。
 */
import {
  normalizeModelContent,
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  planDeepSeekWindow,
  routeSmart, type EventSink, type ModelPolicy, type ModelProvider, type PlanId,
  type VideoScene,
} from "@workloom/base/model-router";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { productionModelInput } from "./prd-authority-bridge.js";
import {
  DEEPSEEK_FLASH_MODEL,
  VIDEO_SCENE_POLICY_VERSION,
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
  resolveVideoNonThinking,
  resolveVideoScene,
} from "./llm-config.js";
import { createHash } from "node:crypto";

export interface LLMReasonOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  forceJson?: boolean;
  responseFormat?: { type: string };
  thinking?: Record<string, unknown>;
  signal?: AbortSignal;
  policyScene?: VideoScene;
}

export interface LLMReasonResult {
  success: boolean;
  content?: string;
  data?: unknown;
  error?: string;
  retryable?: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
  requestedModel?: string;
  resolvedModel?: string;
  mode?: "enabled" | "disabled";
  effort?: "low" | "high" | "max" | null;
  finishReason?: string;
  requestHash?: string;
  responseHash?: string;
  policyVersion?: string;
}

export interface WorkloomLLMEngineConfig {
  /** OpenAI 兼容端点，如 https://api.moonshot.cn/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  fastModel?: string;
  timeoutMs?: number;
  maxTokens?: number;
  /** Video-pipeline reasoning policy; Flash defaults to non-thinking. */
  nonThinking?: boolean;
  /**
   * v3.0 收口：注入路由配置后，全部 LLM 调用经 routeSmart
   * （场景 preproduction；opts.model===fastModel 的快速调用强制 L1 轻量档）——
   * 场景表 × 降级链 × 真实计量 × model.call 事件留痕，vendor 目录保持只读。
   */
  router?: {
    providers: Map<string, ModelProvider>;
    sink: EventSink;
    policy?: ModelPolicy;
    plan?: PlanId;
    /** 覆盖默认场景（默认 preproduction） */
    scene?: string;
    /** Explicit caller override for off-peak-only scenes; never enabled implicitly. */
    allowPeak?: boolean;
    /** Deployment-level model pin. It bypasses tier substitution and fallback. */
    forceModel?: string;
    /** Deployment policy for OpenAI-compatible reasoning models. */
    nonThinking?: boolean;
  };
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: unknown; reasoning_content?: string | null };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { message?: string };
}

export class WorkloomLLMEngine {
  private readonly cfg: Required<Omit<WorkloomLLMEngineConfig, "router">> & { router?: WorkloomLLMEngineConfig["router"] };
  readonly stats = { totalCalls: 0, totalFailures: 0 };

  get model(): string {
    return this.cfg.model;
  }

  get fastModel(): string {
    return this.cfg.fastModel;
  }

  constructor(config: WorkloomLLMEngineConfig) {
    this.cfg = {
      fastModel: config.model,
      timeoutMs: 180_000,
      maxTokens: DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
      nonThinking: config.nonThinking ?? resolveVideoNonThinking(config.model),
      ...config
    };
    if (this.cfg.router && this.cfg.model === DEEPSEEK_FLASH_MODEL) {
      this.attachRouter(this.cfg.router);
    }
  }

  /** v3.0 收口：装配后注入路由配置（宿主侧 seam；vendor 无感） */
  attachRouter(router: NonNullable<WorkloomLLMEngineConfig["router"]>): void {
    if (this.cfg.model === DEEPSEEK_FLASH_MODEL) {
      if (router.forceModel !== undefined && router.forceModel !== DEEPSEEK_FLASH_MODEL) {
        throw new Error("VIDEO_TEXT_MODEL_NOT_REGISTERED");
      }
      this.cfg.router = { ...router, forceModel: DEEPSEEK_FLASH_MODEL };
      return;
    }
    this.cfg.router = router;
  }

  /** 从底座变量构建；DEEPSEEK_* is accepted for OpenAI-compatible CLI/server deployments. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): WorkloomLLMEngine | null {
    const baseUrl = resolveOpenAiCompatibleBaseUrl(env);
    const apiKey = resolveVideoApiKey(env);
    const model = resolveVideoModel(env);
    if (!baseUrl || !apiKey || !model) return null;
    return new WorkloomLLMEngine({
      baseUrl,
      apiKey,
      model,
      nonThinking: resolveVideoNonThinking(model, env),
    });
  }

  private async callChat(prompt: string, opts: LLMReasonOptions): Promise<LLMReasonResult> {
    const input = productionModelInput(prompt);
    try { return await this.requestChat(input.prompt, opts); }
    finally { input.verify(); }
  }

  private async requestChat(prompt: string, opts: LLMReasonOptions): Promise<LLMReasonResult> {
    const policyScene: VideoScene = opts.policyScene
      ?? (opts.forceJson || opts.responseFormat?.type === "json_object"
        ? "video.preproduction.structured"
        : "video.preproduction.plan");
    const scenePolicy = resolveVideoScene(policyScene);
    const responseFormat = opts.forceJson
      ? { type: "json_object" as const }
      : opts.responseFormat;
    const messages = [
      {
        role: "system" as const,
        content: opts.systemPrompt
          ?? (opts.forceJson
            ? "你是一个严格输出 JSON 的助手。除合法 JSON 外不要输出任何额外文字。"
            : "你是一个可靠的助手。"),
      },
      { role: "user" as const, content: prompt },
    ];
    let budget;
    try {
      budget = await planDeepSeekWindow({
        messages,
        responseFormat,
        maxOutputTokens: Math.max(this.cfg.maxTokens, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS),
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }
    // v3.0 收口：router 注入 → 经 routeSmart（场景 preproduction；fastModel 快速调用强制 L1）
    if (this.cfg.router) {
      const scene = this.cfg.router.scene ?? "preproduction";
      const isFast = !!opts.model && opts.model === this.cfg.fastModel && opts.model !== this.cfg.model;
      try {
        const r = await routeSmart(
          {
            action: scene, scene, plan: this.cfg.router.plan,
            forceTier: isFast ? "L1" : undefined,
            ...(this.cfg.router.forceModel ? { forceModel: this.cfg.router.forceModel } : {}),
            timeoutMs: this.cfg.timeoutMs,
            signal: opts.signal,
            generation: {
              ...(scenePolicy.thinking.type === "disabled"
                ? { temperature: opts.temperature ?? 0.2 }
                : {}),
              ...(opts.topP === undefined ? {} : { topP: opts.topP }),
              maxTokens: budget.outputCeiling,
              responseFormat,
              thinking: scenePolicy.thinking.type === "enabled"
                ? { type: "enabled" }
                : { type: "disabled" },
              ...(scenePolicy.thinking.type === "enabled"
                ? { reasoningEffort: scenePolicy.thinking.effort ?? "high" }
                : {}),
            },
            messages,
          },
          this.cfg.router.providers,
          this.cfg.router.sink,
          { policy: this.cfg.router.policy, allowPeak: this.cfg.router.allowPeak },
        );
        if ((r.kind === "answered" || r.kind === "circuit_broken" || r.kind === "reused") && r.text?.trim()) {
          return {
            success: true,
            content: r.text,
            usage: r.providerResult
              ? { promptTokens: r.providerResult.promptTokens, completionTokens: r.providerResult.completionTokens }
              : undefined,
            requestedModel: r.providerResult?.modelId ?? this.cfg.model,
            resolvedModel: r.providerResult?.modelId ?? r.modelTrace?.model_id ?? this.cfg.model,
            mode: scenePolicy.thinking.type,
            effort: scenePolicy.thinking.type === "enabled" ? scenePolicy.thinking.effort ?? "high" : null,
            finishReason: r.providerResult?.finishReason,
            requestHash: r.providerResult?.requestHash,
            responseHash: r.providerResult?.responseHash,
            policyVersion: VIDEO_SCENE_POLICY_VERSION,
          };
        }
        const failure = r.failure
          ? `；${r.failure.kind}：${r.failure.reason}`
          : "";
        // Preserve the router's actual state. A real timeout/outage must not be
        // presented as queued, and a deferred off-peak task must not be retried
        // immediately by vendor-level retry machinery.
        return {
          success: false,
          error: `模型路由不可用（${r.kind}${failure}）`,
          retryable: r.failure?.retryable ?? r.kind !== "queued",
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err), retryable: true };
      }
    }
    const body: Record<string, unknown> = {
      model: opts.model ?? this.cfg.model,
      messages,
      max_tokens: budget.outputCeiling,
      thinking: scenePolicy.thinking.type === "enabled"
        ? { type: "enabled" }
        : { type: "disabled" },
    };
    if (scenePolicy.thinking.type === "enabled") {
      body.reasoning_effort = scenePolicy.thinking.effort ?? "high";
      if (opts.topP !== undefined) body.top_p = Math.min(1, Math.max(0.95, opts.topP));
    } else {
      body.temperature = opts.temperature ?? 0.2;
      body.top_p = opts.topP ?? 1;
    }
    if (responseFormat) body.response_format = responseFormat;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const serializedBody = JSON.stringify(body);
    const requestHash = createHash("sha256").update(serializedBody).digest("hex");
    try {
      const resp = await fetch(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.apiKey}`
        },
        body: serializedBody,
        signal: opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
      });
      if (!resp.ok) {
        return {
          success: false,
          error: `LLM HTTP ${resp.status}`,
          retryable: resp.status >= 500 || resp.status === 429
        };
      }
      const rawBody = await resp.text();
      const responseHash = createHash("sha256").update(rawBody).digest("hex");
      let json: ChatCompletionResponse;
      try {
        json = JSON.parse(rawBody) as ChatCompletionResponse;
      } catch {
        return { success: false, error: "LLM 响应不是合法 JSON", retryable: false };
      }
      if (typeof json.model === "string" && json.model !== (opts.model ?? this.cfg.model)) {
        return {
          success: false,
          error: `LLM 模型身份 ${json.model || "<missing>"} 与请求 ${opts.model ?? this.cfg.model} 不一致`,
          retryable: false,
        };
      }
      if (json.choices?.length !== 1) {
        return { success: false, error: "LLM 响应必须包含唯一 choice", retryable: false };
      }
      const choice = json.choices[0]!;
      if (choice.finish_reason !== "stop") {
        return {
          success: false,
          error: `LLM 未完整结束：${choice.finish_reason ?? "missing"}`,
          retryable: false,
        };
      }
      if (scenePolicy.thinking.type === "disabled" && String(choice.message?.reasoning_content ?? "").trim()) {
        return { success: false, error: "非思考场景返回了 reasoning_content", retryable: false };
      }
      const content = normalizeModelContent(json.choices?.[0]?.message?.content);
      if (!content) return { success: false, error: "LLM 返回 content 为空", retryable: true };
      const promptTokens = json.usage?.prompt_tokens;
      const completionTokens = json.usage?.completion_tokens;
      const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens;
      if (!Number.isSafeInteger(promptTokens) || promptTokens! < 0
        || !Number.isSafeInteger(completionTokens) || completionTokens! < 0) {
        return { success: false, error: "LLM usage 缺失或无效", retryable: false };
      }
      if (reasoningTokens !== undefined
        && (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 || reasoningTokens > completionTokens!)) {
        return { success: false, error: "LLM reasoning_tokens 无效", retryable: false };
      }
      if (scenePolicy.thinking.type === "disabled" && reasoningTokens !== undefined && reasoningTokens !== 0) {
        return { success: false, error: "非思考场景返回了 reasoning tokens", retryable: false };
      }
      return {
        success: true,
        content,
        usage: {
          promptTokens,
          completionTokens
        },
        requestedModel: opts.model ?? this.cfg.model,
        resolvedModel: json.model,
        mode: scenePolicy.thinking.type,
        effort: scenePolicy.thinking.type === "enabled" ? scenePolicy.thinking.effort ?? "high" : null,
        finishReason: choice.finish_reason,
        requestHash,
        responseHash,
        policyVersion: VIDEO_SCENE_POLICY_VERSION,
      };
    } catch (err) {
      if (opts.signal?.aborted) {
        return { success: false, error: "LLM 调用已取消", retryable: false };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg, retryable: true };
    } finally {
      clearTimeout(timer);
    }
  }

  private static extractJson(text: string): unknown {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fence?.[1] ?? trimmed;
    const start = candidate.search(/[{[]/);
    if (start === -1) throw new Error("响应中未找到 JSON");
    const slice = candidate.slice(start);
    // 从最外层括号尝试整体解析，失败则回退到第一个完整对象
    try {
      return JSON.parse(slice);
    } catch {
      const end = slice.lastIndexOf(slice.startsWith("[") ? "]" : "}");
      if (end > 0) return JSON.parse(slice.slice(0, end + 1));
      throw new Error("JSON 提取失败");
    }
  }

  async reason(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    this.stats.totalCalls++;
    const result = await this.callChat(prompt, options);
    if (!result.success) this.stats.totalFailures++;
    if (result.success && options.forceJson && result.content) {
      try {
        result.data = WorkloomLLMEngine.extractJson(result.content);
      } catch (err) {
        this.stats.totalFailures++;
        return {
          ...result,
          success: false,
          error: `JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
          retryable: true
        };
      }
    }
    return result;
  }

  async generate(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.reason(prompt, options);
  }

  async reasonRaw(prompt: string, options: LLMReasonOptions = {}): Promise<LLMReasonResult> {
    return this.callChat(prompt, { ...options, forceJson: false });
  }

  async chat(systemPrompt: string, userPrompt: string, temperature = 1): Promise<string> {
    const forceJson = /(?:只输出|严格输出|严格返回|仅返回|结构化).{0,32}(?:JSON|json)|(?:JSON|json).{0,32}(?:只输出|不要解释|不得解释|结构化)/u.test(systemPrompt);
    const result = await this.reason(userPrompt, { systemPrompt, temperature, ...(forceJson ? { forceJson: true } : {}) });
    if (!result.success || !result.content) {
      throw new Error(result.error ?? "LLM chat 调用失败");
    }
    return result.content;
  }

  async reasonStructured(
    prompt: string,
    schema: unknown,
    options: LLMReasonOptions = {}
  ): Promise<LLMReasonResult> {
    let schemaText: string | undefined;
    try {
      schemaText = JSON.stringify(schema, null, 2);
    } catch (error) {
      return {
        success: false,
        error: `结构化输出结构不可序列化: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      };
    }
    // Match the vendor interface: its caller supplies the actual IDs and field
    // template here, independently of any illustrative examples in the prompt.
    const structuredPrompt = [
      prompt,
      "",
      "【硬性输出要求】",
      "1. 只输出合法 JSON",
      "2. 不要输出 markdown 代码块",
      "3. 不要输出解释、前言、结尾",
      "4. 所有字段必须存在",
      "5. 输出必须能被 JSON.parse 直接解析",
      "",
      "【目标JSON结构示例】",
      schemaText,
    ].join("\n");
    return this.reason(structuredPrompt, { ...options, forceJson: true });
  }

  /**
   * vendor 内部助手方法（2026-09-22 真机修复）
   *
   * `engines/requirement-discovery-engine.js:260` 直接调 `llmEngine._extractJsonObject(content)`；
   * 注入的是本适配器时该方法不存在 → `SceneArchitect` 连续两次失败 →
   * 日志出现「❌ 全部失败，使用兜底规则」→ 场景设计整段退化为规则模板（下游再补齐）。
   * 这里补上与 vendor `systems/llm-reasoning-engine.js:106` 同语义的实现（失败返回 null，不抛）。
   */
  _extractJsonObject(text: unknown): string | null {
    /**
     * 与 vendor `systems/llm-reasoning-engine.js#_extractJsonObject` **同语义**：
     * 返回**JSON 文本字符串**（调用方自己 `JSON.parse`），非字符串输入返回 null。
     *
     * 真机教训（VID-1022）：首版实现返回已解析对象，而
     * `requirement-discovery-engine.js:262` 是 `return JSON.parse(extracted)` →
     * `JSON.parse(对象)` 走 `String(对象)` → `"[object Object]" is not valid JSON`，
     * SceneArchitect 仍然全失败。此实现含输入截断与扫描预算，避免大响应冻结事件循环。
     */
    if (!text || typeof text !== "string") return null;
    const MAX_INPUT_LEN = 200_000;
    const input = text.length > MAX_INPUT_LEN ? text.slice(0, MAX_INPUT_LEN) : text;

    const fenced = input.match(/```json\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      const candidate = fenced[1].trim();
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        /* 继续 */
      }
    }
    const whole = input.trim();
    if (whole) {
      try {
        JSON.parse(whole);
        return whole;
      } catch {
        /* 继续 */
      }
    }
    // 单次栈扫描找"顶层完整 JSON"候选（与 vendor 同算法，带 300ms 预算、不阻塞事件循环）
    const stack: Array<"{" | "["> = [];
    let inString = false;
    let escaped = false;
    let start = -1;
    const budgetStart = Date.now();
    let ops = 0;
    for (let i = 0; i < input.length; i += 1) {
      if ((++ops & 0x3fff) === 0 && Date.now() - budgetStart > 300) break;
      const ch = input[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (stack.length === 0) start = i;
        stack.push(ch);
        continue;
      }
      if (ch === "}" || ch === "]") {
        const open = stack.pop();
        const matches = (open === "{" && ch === "}") || (open === "[" && ch === "]");
        if (!matches) {
          stack.length = 0;
          start = -1;
          continue;
        }
        if (stack.length === 0 && start >= 0) {
          const candidate = input.slice(start, i + 1);
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            start = -1;
          }
        }
      }
    }
    return null;
  }

  /** vendor 调用点清理钩子（无持久连接，空实现保持接口一致） */
  async close(): Promise<void> {
    return undefined;
  }

  /** vendor 调用点统计钩子（返回本适配器的真实统计） */
  getStats(): { totalCalls: number; totalFailures: number; model: string } {
    return { ...this.stats, model: this.cfg.model };
  }
}

/**
 * vendor 自建 LLMEngine 的「原型桥」（2026-09-21 真机修复）
 *
 * 问题：vendor 多条链路（剧本引擎、需求洞察子引擎、提示词/微动作…）会**自己** `new LLMEngine({...})`，
 * 读的是 vendor 自己的环境变量（LLM_ENDPOINT / KIMI_API_KEY …）与模型名（kimi-k2p6）。
 * 宿主注入的适配器只在主流水线生效，于是这些环节全部失败：
 *   `[ScriptGenerator] LLM引擎返回失败: API Key 未配置` → 剧本生成重试 3 次 → 预生产 pipeline.failed。
 *
 * 做法：**不改 vendor 目录**（只读纪律），在运行时把 vendor LLMEngine 原型的四个调用点
 * （reason / reasonRaw / reasonStructured / chat）重定向到宿主适配器 —— 这些方法被整体替换，
 * 构造函数里那句 `_noApiKey` 判断自然失效，模型/端点/计量/事件留痕全部走 WorkLoom 模型路由。
 *
 * 幂等：重复调用只覆盖一次；返回摘除函数（恢复原方法），便于测试与热重载。
 */
export function installVendorEngineBridge(engine: WorkloomLLMEngine): () => void {
  try {
    // 仓库根按**本模块位置**解析（服务进程 cwd 是 apps/server，用 cwd 会找不到 vendor）
    const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../..");
    const vendorRequire = createRequire(resolvePath(repoRoot, "package.json"));
    const enginePath = resolvePath(repoRoot, "vendor/supermickey/systems/llm-reasoning-engine.js");
    if (!existsSync(enginePath)) return () => undefined;
    const mod = vendorRequire(enginePath) as { LLMEngine?: { prototype: Record<string, unknown> } };
    const prototype = mod?.LLMEngine?.prototype;
    if (!prototype) return () => undefined;
    const patched: Array<[string, unknown]> = [];
    const redirect = (name: string, impl: (...args: unknown[]) => unknown) => {
      if (typeof prototype[name] !== "function") return;
      patched.push([name, prototype[name]]);
      prototype[name] = impl;
    };
    const hostOptions = (receiver: unknown, options: unknown): LLMReasonOptions => {
      const normalized = options && typeof options === "object" && !Array.isArray(options)
        ? { ...(options as Record<string, unknown>) }
        : {};
      // Vendor agents still carry the retired provider/model defaults. They are
      // not model-selection authority once the host router is installed.
      if (normalized.model === "kimi-k2p6") delete normalized.model;
      if (receiver && typeof receiver === "object" && Object.hasOwn(receiver, "_noApiKey")) {
        try { (receiver as Record<string, unknown>)._noApiKey = false; } catch { /* the host methods below do not read it */ }
      }
      return normalized as LLMReasonOptions;
    };
    redirect("reason", function (this: unknown, prompt: unknown, options: unknown = {}) {
      return engine.reason(String(prompt ?? ""), hostOptions(this, options));
    });
    redirect("reasonRaw", function (this: unknown, prompt: unknown, options: unknown = {}) {
      return engine.reasonRaw(String(prompt ?? ""), hostOptions(this, options));
    });
    redirect("reasonStructured", function (this: unknown, prompt: unknown, schema: unknown, options: unknown = {}) {
      return engine.reasonStructured(String(prompt ?? ""), schema, hostOptions(this, options));
    });
    redirect("chat", function (this: unknown, systemPrompt: unknown, userPrompt: unknown, temperature: unknown = 1) {
      const parsedTemperature = Number(temperature);
      return engine.chat(String(systemPrompt ?? ""), String(userPrompt ?? ""), Number.isFinite(parsedTemperature) ? parsedTemperature : 1);
    });
    redirect("generate", function (this: unknown, prompt: unknown, options: unknown = {}) {
      return engine.generate(String(prompt ?? ""), hostOptions(this, options));
    });
    return () => {
      for (const [name, original] of patched) prototype[name] = original;
    };
  } catch {
    // vendor 不在（例如只跑单测）时静默：桥接是增强，不是启动前置
    return () => undefined;
  }
}
