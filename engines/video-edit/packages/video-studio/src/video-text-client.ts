import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { creativeBudgetActive, creativeExecutionSignal, guardedCreativeModelCall,
  modelResponseEvidence, modelTransportFailureClass, type CreativeModelOutcome } from "./creative-runtime.js";
import {
  normalizeModelContent,
  planDeepSeekWindow,
  type ModelMessageContent,
} from "@workloom/base/model-router";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MODEL,
  VIDEO_SCENE_POLICY_VERSION,
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
  resolveVideoScene,
  type VideoScene,
} from "./llm-config.js";

export interface VideoTextEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VideoTextMessage {
  role: "system" | "user" | "assistant";
  content: ModelMessageContent;
}

export interface VideoTextUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface VideoTextResult {
  text: string;
  value?: unknown;
  model: string;
  responseId: string | null;
  finishReason: "stop";
  usage: VideoTextUsage;
  requestHash: string;
  responseHash: string;
  outputCeiling: number;
  inputTokenEstimate: number;
  inputTokenUpperBound: number;
  inputTokenBasis: string;
  policyVersion: string;
}

type VideoJsonFailure = Pick<VideoTextResult, "model" | "responseId" | "requestHash" | "responseHash"> & {
  kind: "empty_json" | "invalid_json";
};

export class VideoTextDispatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly options: {
      retryable?: boolean;
      unknown?: boolean;
      status?: number;
      cause?: unknown;
      jsonFailure?: VideoJsonFailure;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VideoTextDispatchError";
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Node's global fetch uses undici's 300-second body timeout. Long, complete
 * producer reviews can legitimately exceed that budget even when their own
 * 600-second timeout has not elapsed, surfacing a bare `terminated` and
 * discarding a successful paid response. Keep the public fetch-compatible
 * seam for fixtures, but use a bounded native HTTP request by default.
 */
async function nodeHttpFetch(input: string, init: RequestInit, onHeaders: (status: number | undefined, requestId: unknown) => void): Promise<Response> {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MODEL_ENDPOINT_PROTOCOL_INVALID");
  const body = init.body === undefined || init.body === null
    ? undefined
    : typeof init.body === "string"
      ? Buffer.from(init.body)
      : Buffer.isBuffer(init.body)
        ? init.body
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body)
          : (() => { throw new Error("MODEL_REQUEST_BODY_UNSUPPORTED"); })();
  const headers = new Headers(init.headers);
  if (body !== undefined) headers.set("content-length", String(body.length));
  headers.set("accept-encoding", "identity");
  return await new Promise<Response>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method: init.method ?? "GET",
      headers: Object.fromEntries(headers.entries()),
    }, response => {
      onHeaders(response.statusCode, response.headers["x-request-id"]);
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", chunk => {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          response.destroy(new VideoTextDispatchError("MODEL_RESPONSE_TOO_LARGE", "模型响应超过允许的字节上限。", { unknown: true }));
        } else chunks.push(buffer);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const status = response.statusCode ?? 502;
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : String(value));
          }
          // Fetch's null-body statuses reject even an empty Buffer as a body.
          // Constructor errors in this event callback must reject the request.
          const bodyless = status === 204 || status === 205 || status === 304;
          resolve(new Response(bodyless ? null : Buffer.concat(chunks), {
            status,
            statusText: response.statusMessage ?? "",
            headers: responseHeaders,
          }));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
    const abort = () => request.destroy(init.signal?.reason instanceof Error ? init.signal.reason : new Error("MODEL_REQUEST_ABORTED"));
    if (init.signal?.aborted) return abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    request.once("close", () => init.signal?.removeEventListener("abort", abort));
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export function videoTextEndpointFromEnv(
  env: Record<string, string | undefined> = process.env,
): VideoTextEndpoint | null {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(env);
  const apiKey = resolveVideoApiKey(env);
  const model = resolveVideoModel(env);
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
}

function failureDetail(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const error = (value as { error?: { message?: unknown; code?: unknown } }).error;
  return [error?.code, error?.message]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join(": ")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .slice(0, 500);
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new VideoTextDispatchError("MODEL_RESPONSE_TOO_LARGE", "模型响应超过允许的字节上限。", {
      retryable: false,
      unknown: true,
    });
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) {
      throw new VideoTextDispatchError("MODEL_RESPONSE_TOO_LARGE", "模型响应超过允许的字节上限。", {
        retryable: false,
        unknown: true,
      });
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new VideoTextDispatchError("MODEL_RESPONSE_TOO_LARGE", "模型响应超过允许的字节上限。", {
          retryable: false,
          unknown: true,
        });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}

export async function completeVideoTextTask(input: {
  endpoint: VideoTextEndpoint;
  scene: VideoScene;
  messages: VideoTextMessage[];
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  requireJson?: boolean;
}): Promise<VideoTextResult> {
  if (input.endpoint.model !== DEEPSEEK_FLASH_MODEL) {
    throw new VideoTextDispatchError(
      "VIDEO_TEXT_MODEL_NOT_REGISTERED",
      `VIDEO_TEXT_MODEL_NOT_REGISTERED: ${input.endpoint.model}`,
      { retryable: false },
    );
  }
  const policy = resolveVideoScene(input.scene);
  const responseFormat = policy.responseFormat === "json_object"
    ? { type: "json_object" as const }
    : undefined;
  const thinking = { type: policy.thinking.type };
  const reasoningEffort = thinking.type === "enabled" ? policy.thinking.effort ?? "high" : undefined;
  let budget: Awaited<ReturnType<typeof planDeepSeekWindow>>;
  try {
    budget = await planDeepSeekWindow({
      messages: input.messages,
      responseFormat,
      thinking,
      reasoningEffort,
    });
  } catch (error) {
    throw new VideoTextDispatchError(
      error instanceof Error ? error.message : "DEEPSEEK_CONTEXT_EXCEEDED",
      error instanceof Error ? error.message : String(error),
      { retryable: false, cause: error },
    );
  }

  const body = {
    model: input.endpoint.model,
    messages: input.messages,
    max_tokens: budget.outputCeiling,
    stream: false,
    ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
    thinking,
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
  };
  const serialized = JSON.stringify(body);
  const requestBytes = Buffer.byteLength(serialized);
  if (requestBytes > 48 * 1024 * 1024) {
    throw new VideoTextDispatchError(
      "DEEPSEEK_REQUEST_TOO_LARGE",
      "完整文本/图像请求超过 DeepSeek 48MiB 单请求硬上限。",
      { retryable: false },
    );
  }

  let billedFailure: CreativeModelOutcome | undefined;
  const unknownOutcome: CreativeModelOutcome = { usageKnown: false, success: false, actualCny: null };
  const requestHash = createHash("sha256").update(serialized).digest("hex");
  return guardedCreativeModelCall({
    requestHash, inputChars: requestBytes, requestBytes, inputTokenEstimate: budget.inputTokens,
    inputTokenUpperBound: budget.inputTokenUpperBound,
    inputTokenBasis: budget.inputTokenBasis, maxOutputTokens: budget.outputCeiling,
    model: input.endpoint.model, ...(budget.imageTokens ? { imageInputTokens: budget.imageTokens } : {}),
  }, async () => {
  const executionSignal = creativeExecutionSignal();
  const signals = [input.signal, executionSignal, AbortSignal.timeout(input.timeoutMs ?? 600_000)]
    .filter((signal): signal is AbortSignal => Boolean(signal));
  const signal = AbortSignal.any(signals);
  let headersReceived = false;
  const observeHeaders = (status: number | undefined, requestId: unknown) => {
    headersReceived = true;
    Object.assign(unknownOutcome, modelResponseEvidence(status, requestId, input.endpoint.apiKey));
  };
  let response: Response;
  try {
    const url = `${input.endpoint.baseUrl}/chat/completions`;
    const init: RequestInit = {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.endpoint.apiKey}`,
      },
      body: serialized,
      signal,
    };
    if (input.fetchImpl) {
      response = await input.fetchImpl(url, init);
      observeHeaders(response.status, response.headers.get("x-request-id"));
    } else {
      response = await nodeHttpFetch(url, init, observeHeaders);
    }
  } catch (error) {
    unknownOutcome.failureClass = modelTransportFailureClass(error, signal, headersReceived);
    throw new VideoTextDispatchError(
      input.signal?.aborted ? "MODEL_CANCELLED" : "MODEL_RESULT_UNKNOWN",
      input.signal?.aborted ? "模型调用已被调用方取消。" : "模型网络结果未知，不能自动重复可能已计费的请求。",
      { retryable: false, unknown: true, cause: error },
    );
  }
  let rawBody: string;
  try {
    const bytes = response.body === null ? Buffer.alloc(0) : await readBoundedBody(response);
    unknownOutcome.responseHash = createHash("sha256").update(bytes).digest("hex");
    rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    unknownOutcome.failureClass = modelTransportFailureClass(error, signal, true);
    if (error instanceof VideoTextDispatchError) throw error;
    throw new VideoTextDispatchError("MODEL_RESPONSE_BODY_INVALID", "模型响应正文未完整读取或编码无效。", {
      retryable: false, unknown: true, status: response.status, cause: error,
    });
  }
  if (!response.ok) {
    unknownOutcome.failureClass = "http_error";
    let parsedFailure: unknown;
    try { parsedFailure = JSON.parse(rawBody); } catch { /* non-JSON failures stay bounded */ }
    const detail = failureDetail(parsedFailure);
    throw new VideoTextDispatchError(
      `MODEL_HTTP_${response.status}`,
      `模型调用失败：HTTP ${response.status}${detail ? `（${detail}）` : ""}`,
      {
        retryable: response.status === 429,
        unknown: response.status >= 500 || (response.status >= 300 && response.status < 400),
        status: response.status,
      },
    );
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as Record<string, unknown>;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("response envelope must be an object");
  } catch (error) {
    unknownOutcome.failureClass = "response_json_invalid";
    throw new VideoTextDispatchError("MODEL_RESPONSE_JSON_INVALID", "模型响应不是合法 JSON。", {
      retryable: false,
      unknown: true,
      status: response.status,
      cause: error,
    });
  }
  if (envelope.model !== input.endpoint.model) {
    unknownOutcome.failureClass = "response_identity_invalid";
    throw new VideoTextDispatchError(
      "MODEL_IDENTITY_CHANGED",
      `模型响应身份 ${String(envelope.model ?? "<missing>")} 与请求 ${input.endpoint.model} 不一致。`,
      { retryable: false, unknown: true },
    );
  }
  if (typeof envelope.id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(envelope.id)) {
    unknownOutcome.failureClass = "response_identity_invalid";
    throw new VideoTextDispatchError(
      "MODEL_IDENTITY_MISSING",
      "模型响应缺少稳定的请求身份。",
      { retryable: false, unknown: true },
    );
  }
  unknownOutcome.providerRequestId ??= modelResponseEvidence(undefined, envelope.id, input.endpoint.apiKey).providerRequestId;
  unknownOutcome.failureClass = "response_usage_invalid";
  const usage = envelope.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | undefined;
  const responseHash = createHash("sha256").update(rawBody).digest("hex");
  const reportedReasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;
  // Billing is a separate receipt from content acceptance. A complete,
  // identified response can have known usage and still be a failed output.
  if (Number.isSafeInteger(usage?.prompt_tokens) && usage!.prompt_tokens! >= 0
    && Number.isSafeInteger(usage?.completion_tokens) && usage!.completion_tokens! >= 0
    && usage!.completion_tokens! <= budget.outputCeiling
    && usage!.total_tokens === usage!.prompt_tokens! + usage!.completion_tokens!
    && usage!.total_tokens <= DEEPSEEK_FLASH_CONTEXT_TOKENS) {
    billedFailure = { usageKnown: true, success: false, inputTokens: usage!.prompt_tokens, outputTokens: usage!.completion_tokens,
      totalTokens: usage!.total_tokens, providerRequestId: envelope.id, responseHash,
      ...(reportedReasoningTokens !== undefined && Number.isSafeInteger(reportedReasoningTokens)
        && reportedReasoningTokens >= 0 && reportedReasoningTokens <= usage!.completion_tokens!
        ? { reasoningTokens: reportedReasoningTokens } : {}) };
  }
  const outputFailure = { retryable: false, unknown: !creativeBudgetActive() || !billedFailure };
  const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
  if (choices.length !== 1 || !choices[0] || typeof choices[0] !== "object" || Array.isArray(choices[0])) {
    throw new VideoTextDispatchError("MODEL_CHOICE_INVALID", "模型响应必须包含唯一 choice。", outputFailure);
  }
  const choice = choices[0] as {
    finish_reason?: string;
    message?: { content?: unknown; reasoning_content?: string | null };
  };
  if (billedFailure && (choice.finish_reason === "stop" || choice.finish_reason === "length")) {
    billedFailure.finishReason = choice.finish_reason;
  }
  if (choice.finish_reason !== "stop") {
    throw new VideoTextDispatchError(
      choice.finish_reason === "length" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_OUTPUT_INCOMPLETE",
      `模型未完整结束：${choice.finish_reason ?? "missing"}`,
      outputFailure,
    );
  }
  if (policy.thinking.type === "disabled" && String(choice.message?.reasoning_content ?? "").trim()) {
    throw new VideoTextDispatchError(
      "MODEL_THINKING_POLICY_VIOLATION",
      "非思考场景返回了 reasoning_content。",
      outputFailure,
    );
  }
  if (!billedFailure) {
    throw new VideoTextDispatchError("MODEL_USAGE_INVALID", "模型 usage 缺失或无效。", {
      retryable: false,
      unknown: true,
    });
  }
  const reasoningTokens = reportedReasoningTokens ?? 0;
  if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0
    || reasoningTokens > usage!.completion_tokens!) {
    throw new VideoTextDispatchError("MODEL_USAGE_INVALID", "模型 reasoning_tokens 无效。", outputFailure);
  }
  if (policy.thinking.type === "disabled" && reasoningTokens !== 0) {
    throw new VideoTextDispatchError(
      "MODEL_THINKING_POLICY_VIOLATION",
      "非思考场景返回了 reasoning tokens。",
      outputFailure,
    );
  }
  const responseIdentity = { model: input.endpoint.model, responseId: envelope.id, requestHash, responseHash };
  const jsonFailure = (kind: VideoJsonFailure["kind"]) => input.requireJson === true && responseFormat
    ? { jsonFailure: { ...responseIdentity, kind } }
    : {};
  const text = normalizeModelContent(choice.message?.content).trim();
  if (!text) {
    throw new VideoTextDispatchError("MODEL_CONTENT_EMPTY", "模型最终 content 为空。", {
      ...outputFailure,
      ...(typeof choice.message?.content === "string" ? jsonFailure("empty_json") : {}),
    });
  }
  let value: unknown;
  if (input.requireJson === true) {
    try {
      value = JSON.parse(text);
    } catch {
      // SyntaxError can contain raw model output. Expose only the wire identity
      // and fixed classification after model, terminal status and usage checks.
      throw new VideoTextDispatchError("MODEL_JSON_INVALID", "模型最终 content 不是完整 JSON。", {
        ...outputFailure,
        ...jsonFailure("invalid_json"),
      });
    }
  }
  return {
    text,
    value,
    ...responseIdentity,
    finishReason: "stop",
    usage: {
      inputTokens: usage!.prompt_tokens!,
      outputTokens: usage!.completion_tokens!,
      reasoningTokens,
    },
    outputCeiling: budget.outputCeiling,
    inputTokenEstimate: budget.inputTokens,
    inputTokenUpperBound: budget.inputTokenUpperBound,
    inputTokenBasis: budget.inputTokenBasis,
    policyVersion: VIDEO_SCENE_POLICY_VERSION,
  };
  }, result => ({ ...billedFailure, usageKnown: true, success: true,
    inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }), () => billedFailure ?? unknownOutcome);
}
