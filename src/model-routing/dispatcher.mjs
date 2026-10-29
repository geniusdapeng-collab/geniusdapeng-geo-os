import { hashObject, hashText } from "../domain/hash.mjs";
import { parseStrictJson } from "../domain/strict-json.mjs";
import { modelError } from "./errors.mjs";
import { planWindow } from "./budget.mjs";
import { MODEL_POLICY, policyReceipt, resolveScenePolicy } from "./policy.mjs";
import {
  DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS,
  normalizeTextModelId,
  TEXT_PRIMARY_MODEL,
  TEXT_PRIMARY_REGISTRY_VERSION,
} from "./registry.mjs";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function textFromContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object")
    .map((part) => {
      if (part.type === "text" && typeof part.text === "string") return part.text;
      if (part.type === "output_text" && typeof part.text === "string") return part.text;
      return "";
    })
    .join("")
    .trim();
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateUsage(usage, mode) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw modelError("MODEL_USAGE_MISSING", "模型响应缺少 usage，无法形成计量证据。");
  }
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const total = usage.total_tokens ?? (safeInteger(prompt) && safeInteger(completion) ? prompt + completion : undefined);
  if (!safeInteger(prompt) || !safeInteger(completion) || !safeInteger(total) || total !== prompt + completion) {
    throw modelError("MODEL_USAGE_INVALID", "模型 usage 缺失或不一致。");
  }
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined && (!safeInteger(reasoning) || reasoning > completion)) {
    throw modelError("MODEL_USAGE_INVALID", "模型 reasoning_tokens 无效。");
  }
  if (mode === "disabled" && reasoning !== undefined && reasoning !== 0) {
    throw modelError(
      "MODEL_THINKING_POLICY_VIOLATION",
      "非思考场景返回了 reasoning tokens，策略未按请求执行。",
    );
  }
  return {
    inputTokens: prompt,
    outputTokens: completion,
    totalTokens: total,
    reasoningTokens: reasoning ?? null,
    promptCacheHitTokens: safeInteger(usage.prompt_cache_hit_tokens)
      ? usage.prompt_cache_hit_tokens
      : null,
    promptCacheMissTokens: safeInteger(usage.prompt_cache_miss_tokens)
      ? usage.prompt_cache_miss_tokens
      : null,
  };
}

async function readBoundedBytes(response, maximumBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw modelError("MODEL_RESPONSE_TOO_LARGE", "模型响应超过字节上限。");
    return bytes;
  }
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw modelError("MODEL_RESPONSE_TOO_LARGE", "模型响应超过字节上限。");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

class WindowScheduler {
  #tail = Promise.resolve();

  async run(work) {
    let release;
    const previous = this.#tail;
    this.#tail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function requestHash(model, endpoint, scene, body, policy, budget) {
  return hashObject({
    model,
    endpoint,
    scene,
    body,
    policy: policyReceipt(policy),
    budget,
  });
}

export class ModelDispatcher {
  #apiKey;
  #scheduler = new WindowScheduler();

  constructor({
    apiKey,
    baseUrl,
    chatEndpoint,
    fetchImpl = globalThis.fetch,
    model = TEXT_PRIMARY_MODEL.officialModelId,
    contextTokens = TEXT_PRIMARY_MODEL.contextTokens,
    maxOutputTokens = TEXT_PRIMARY_MODEL.maxOutputTokens,
    timeoutMs = 600_000,
    maxRetries = 0,
    allowUnregisteredModel = false,
  } = {}) {
    if (!String(apiKey ?? "").trim()) {
      throw modelError("MODEL_CREDENTIAL_MISSING", "模型调用缺少当前进程凭据。");
    }
    if (typeof fetchImpl !== "function") {
      throw modelError("MODEL_TRANSPORT_UNAVAILABLE", "模型传输实现不可用。");
    }
    this.#apiKey = String(apiKey).trim();
    this.model = allowUnregisteredModel ? String(model) : normalizeTextModelId(model);
    if (!Number.isSafeInteger(contextTokens) || contextTokens < 1) {
      throw modelError("MODEL_CONTEXT_INVALID", "模型上下文必须为正安全整数。");
    }
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
      throw modelError("MODEL_OUTPUT_BUDGET_INVALID", "模型输出上限必须为正安全整数。");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
      throw modelError("MODEL_TIMEOUT_INVALID", "模型超时必须是至少 100ms 的整数。");
    }
    this.contextTokens = contextTokens;
    this.maxOutputTokens = maxOutputTokens;
    this.timeoutMs = timeoutMs;
    this.maxRetries = Number.isSafeInteger(maxRetries) && maxRetries >= 0 ? maxRetries : 0;
    this.fetchImpl = fetchImpl;
    this.chatEndpoint = String(chatEndpoint ?? "").trim()
      || `${String(baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`;
    const endpoint = new URL(this.chatEndpoint);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw modelError("MODEL_ENDPOINT_INVALID", "模型调用端点无效。");
    }
    this.chatEndpoint = endpoint.toString();
  }

  health() {
    return {
      configured: true,
      model: this.model,
      modelKey: TEXT_PRIMARY_MODEL.key,
      contextTokens: this.contextTokens,
      maxOutputTokens: this.maxOutputTokens,
      policyVersion: MODEL_POLICY.policyVersion,
      fallback: MODEL_POLICY.defaults.fallback,
    };
  }

  async prepareTask({
    scene,
    messages,
    tools = [],
    responseFormat,
    maxOutputTokens,
    signal,
    retries = this.maxRetries,
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw modelError("MODEL_MESSAGES_REQUIRED", "模型任务至少需要一条完整消息。");
    }
    const policy = resolveScenePolicy(scene);
    const thinking = policy.thinking;
    if (!["enabled", "disabled"].includes(thinking?.type)) {
      throw modelError("MODEL_THINKING_POLICY_INVALID", `场景 ${scene} 未显式声明思考模式。`);
    }
    if (thinking.type === "enabled" && !["low", "high", "max"].includes(thinking.effort)) {
      throw modelError("MODEL_THINKING_POLICY_INVALID", `场景 ${scene} 未声明合法思考强度。`);
    }
    if (!["text", "json_object"].includes(policy.responseFormat)) {
      throw modelError("MODEL_RESPONSE_FORMAT_INVALID", `场景 ${scene} 的响应格式未登记。`);
    }
    // Scene policy owns the wire format. Callers cannot accidentally request a
    // different structured contract than the one used for validation/receipts.
    const format = policy.responseFormat === "json_object"
      ? { type: "json_object" }
      : undefined;
    void responseFormat;
    const budget = await planWindow({
      messages,
      tools,
      responseFormat: format,
      contextTokens: this.contextTokens,
      maxOutputTokens: this.maxOutputTokens,
      policyMaxOutputTokens: Number.isSafeInteger(policy.outputBudget)
        ? policy.outputBudget
        : maxOutputTokens,
    });
    const body = {
      model: this.model,
      messages,
      max_tokens: budget.outputCeiling,
      stream: false,
      thinking: thinking.type === "enabled"
        ? { type: "enabled" }
        : { type: "disabled" },
    };
    if (thinking.type === "enabled") body.reasoning_effort = thinking.effort;
    if (tools.length > 0) body.tools = tools;
    if (format) body.response_format = format;
    const hash = requestHash(this.model, this.chatEndpoint, scene, body, policy, budget);
    let invoked = false;
    return {
      provider: TEXT_PRIMARY_MODEL.provider,
      model: this.model,
      scene,
      policy,
      budget,
      requestHash: hash,
      upperBound: {
        inputTokens: budget.inputTokens,
        outputTokens: budget.outputCeiling,
        renderSeconds: 0,
        tempBytes: 1_000_000,
        nativeProcesses: 0,
      },
      execute: async ({ signal: executionSignal } = {}) => {
        if (invoked) throw modelError("MODEL_DISPATCH_REPLAY_BLOCKED", "同一已准备模型请求不得重复执行。");
        invoked = true;
        return this.#executePrepared({
          scene,
          policy,
          format,
          body,
          budget,
          requestHash: hash,
          signal: executionSignal ?? signal,
          retries,
        });
      },
    };
  }

  async completeTask(options) {
    const prepared = await this.prepareTask(options);
    return prepared.execute({ signal: options.signal });
  }

  async #executePrepared({ scene, policy, format, body, budget, requestHash: hash, signal, retries }) {
    return this.#scheduler.run(async () => {
      let attempt = 0;
      let lastError;
      const retryEvidence = [];
      while (attempt <= retries) {
        attempt += 1;
        const remaining = Math.max(1, this.timeoutMs - ((attempt - 1) * 1_000));
        const timeoutSignal = AbortSignal.timeout(remaining);
        const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let response;
        try {
          response = await this.fetchImpl(this.chatEndpoint, {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${this.#apiKey}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: combined,
          });
        } catch (error) {
          if (signal?.aborted) {
            throw modelError("MODEL_CANCELLED", "模型调用已被调用方取消。", { cause: error });
          }
          const timedOut = timeoutSignal.aborted;
          lastError = modelError(
            timedOut ? "MODEL_TIMEOUT" : "MODEL_NETWORK_UNKNOWN",
            timedOut ? "模型调用超时，输出结果未知。" : "模型网络结果未知。",
            { unknown: true, retryable: false, cause: error },
          );
          lastError.attempts = retryEvidence.concat({
            attempt,
            code: lastError.code,
            unknown: true,
            retryable: false,
          });
          throw lastError;
        }

        const responseBytes = await readBoundedBytes(response, MAX_RESPONSE_BYTES);
        if (!response.ok) {
          // A 429 was explicitly rejected and is safe to retry. A 5xx may have
          // executed after accepting the request, so its result and cost stay
          // unknown and the request fails closed without an automatic duplicate.
          const retryable = response.status === 429;
          const unknown = response.status >= 500;
          lastError = modelError(
            `MODEL_HTTP_${response.status}`,
            `模型调用失败：HTTP ${response.status}。`,
            { retryable, httpStatus: response.status, unknown },
          );
          const evidence = {
            attempt,
            code: lastError.code,
            httpStatus: response.status,
            unknown,
            retryable,
          };
          retryEvidence.push(evidence);
          if (attempt <= retries && retryable) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            continue;
          }
          lastError.attempts = [...retryEvidence];
          throw lastError;
        }

        let envelope;
        try {
          envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
        } catch (error) {
          throw modelError("MODEL_RESPONSE_JSON_INVALID", "模型响应不是合法 JSON。", {
            unknown: true,
            cause: error,
          });
        }
        const returnedModel = typeof envelope?.model === "string" ? envelope.model : "";
        const responseId = typeof envelope.id === "string" ? envelope.id : null;
        const responseHash = hashObject(envelope);
        let usage;
        try {
          usage = validateUsage(envelope.usage, policy.thinking.type);
          if (usage.inputTokens > this.contextTokens
            || usage.outputTokens > budget.outputCeiling
            || usage.totalTokens > this.contextTokens) {
            throw modelError(
              "MODEL_USAGE_INVALID",
              "模型 usage 超过本次上下文或输出预算，结果不可用于结算。",
              { unknown: true },
            );
          }
        } catch (error) {
          error.unknown = true;
          error.providerRequestId = responseId;
          error.usageReceipt = {
            kind: "provider_response_usage",
            sha256: responseHash,
            providerRequestId: responseId,
            model: returnedModel || null,
            pricingSnapshotHash: null,
            tokenBoundProofHash: null,
            actualCostVerified: false,
          };
          error.attempts = [...retryEvidence, {
            attempt,
            code: error.code ?? "MODEL_USAGE_INVALID",
            providerRequestId: responseId,
            unknown: true,
            retryable: false,
          }];
          throw error;
        }
        const metering = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costMicros: null,
          currency: null,
        };
        const usageReceipt = {
          kind: "provider_response_usage",
          sha256: responseHash,
          providerRequestId: responseId,
          model: returnedModel || null,
          pricingSnapshotHash: null,
          tokenBoundProofHash: null,
          actualCostVerified: false,
        };
        const attachEvidence = (error, { unknown } = {}) => {
          error.metering = metering;
          error.usageReceipt = usageReceipt;
          error.providerRequestId = responseId;
          error.attempts = [...retryEvidence, {
            attempt,
            code: error.code ?? "MODEL_OUTPUT_INVALID",
            providerRequestId: responseId,
            unknown: unknown ?? error.unknown === true,
            retryable: error.retryable === true,
          }];
          if (unknown === true || error.unknown === true) error.unknown = true;
          return error;
        };
        let choice;
        let content;
        let parsedValue;
        try {
          if (returnedModel !== this.model) {
            throw modelError(
              "MODEL_IDENTITY_CHANGED",
              `模型响应身份 ${returnedModel || "<missing>"} 与请求 ${this.model} 不一致。`,
              { unknown: true },
            );
          }
          if (!responseId || !/^[A-Za-z0-9_.:-]{1,200}$/.test(responseId)) {
            throw modelError("MODEL_IDENTITY_MISSING", "模型响应缺少稳定的 request identity。");
          }
          choice = Array.isArray(envelope.choices) && envelope.choices.length === 1
            ? envelope.choices[0]
            : null;
          if (!choice || choice.finish_reason !== "stop") {
            const code = choice?.finish_reason === "length"
              ? "MODEL_OUTPUT_TRUNCATED"
              : "MODEL_OUTPUT_INCOMPLETE";
            throw modelError(code, `模型未完整结束：${choice?.finish_reason ?? "missing"}`, {
              unknown: true,
            });
          }
          if (policy.thinking.type === "disabled" && String(choice.message?.reasoning_content ?? "").trim()) {
            throw modelError(
              "MODEL_THINKING_POLICY_VIOLATION",
              "非思考场景返回了 reasoning_content，策略未按请求执行。",
              { unknown: true },
            );
          }
          content = textFromContent(choice.message?.content);
          if (!content) {
            throw modelError("MODEL_CONTENT_EMPTY", "模型最终 content 为空。", { unknown: true });
          }
          if (format?.type === "json_object") {
            parsedValue = parseStrictJson(content, { maxBytes: 8_000_000, maxString: 4_000_000 });
          }
        } catch (error) {
          throw attachEvidence(error);
        }
        const policyHash = hashObject(policyReceipt(policy));
        const receipt = {
          schemaVersion: "workloom.model-receipt/v1",
          policy: policyReceipt(policy),
          policyHash,
          registry: {
            key: TEXT_PRIMARY_MODEL.key,
            version: TEXT_PRIMARY_REGISTRY_VERSION,
            provider: TEXT_PRIMARY_MODEL.provider,
            requestedModel: this.model,
            returnedModel,
            release: TEXT_PRIMARY_MODEL.release,
          },
          modelKey: TEXT_PRIMARY_MODEL.key,
          requestedModel: this.model,
          returnedModel,
          responseId,
          requestHash: hash,
          responseHash,
          contentHash: hashText(content),
          finishReason: choice.finish_reason,
          budget,
          usage,
          attempt,
          attempts: [...retryEvidence],
          receivedAt: new Date().toISOString(),
        };
        return {
          text: content,
          value: format?.type === "json_object" ? parsedValue : content,
          raw: envelope,
          requestedModel: this.model,
          resolvedModel: returnedModel,
          model: returnedModel,
          mode: policy.thinking.type,
          effort: policy.thinking.type === "enabled" ? policy.thinking.effort : null,
          responseId,
          finishReason: choice.finish_reason,
          outputCeiling: budget.outputCeiling,
          usage,
          requestHash: hash,
          responseHash,
          policyHash,
          registryVersion: TEXT_PRIMARY_REGISTRY_VERSION,
          attempts: [...retryEvidence],
          receipt,
        };
      }
      throw lastError ?? modelError("MODEL_UNKNOWN_FAILURE", "模型调用失败。");
    });
  }
}

export function createModelDispatcher(options) {
  return new ModelDispatcher(options);
}

export function maxOutputDefault() {
  return DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS;
}
