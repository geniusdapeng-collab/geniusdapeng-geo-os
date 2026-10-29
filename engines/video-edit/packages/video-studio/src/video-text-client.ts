import { createHash } from "node:crypto";
import { normalizeModelContent, planDeepSeekWindow } from "@workloom/base/model-router";
import {
  DEEPSEEK_FLASH_CONTEXT_TOKENS,
  DEEPSEEK_FLASH_MODEL,
  VIDEO_SCENE_POLICY_VERSION,
  resolveOpenAiCompatibleBaseUrl,
  resolveVideoApiKey,
  resolveVideoModel,
  resolveVideoScene,
  videoThinkingBody,
  type VideoScene,
} from "./llm-config.js";

export interface VideoTextEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface VideoTextMessage {
  role: "system" | "user" | "assistant";
  content: unknown;
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
  policyVersion: string;
}

export class VideoTextDispatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly options: {
      retryable?: boolean;
      unknown?: boolean;
      status?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VideoTextDispatchError";
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function videoTextEndpointFromEnv(
  env: Record<string, string | undefined> = process.env,
): VideoTextEndpoint | null {
  const baseUrl = resolveOpenAiCompatibleBaseUrl(env);
  const apiKey = resolveVideoApiKey(env);
  const model = resolveVideoModel(env);
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model } : null;
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

async function readBoundedBody(response: Response): Promise<string> {
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
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
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
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } finally {
    reader.releaseLock();
  }
}

export async function completeVideoTextTask(input: {
  endpoint: VideoTextEndpoint;
  scene: VideoScene;
  messages: VideoTextMessage[];
  tokenMessages?: VideoTextMessage[];
  imageTokens?: number;
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
  const tokenMessages = input.tokenMessages ?? input.messages;
  let budget: Awaited<ReturnType<typeof planDeepSeekWindow>>;
  try {
    budget = await planDeepSeekWindow({
      messages: tokenMessages,
      responseFormat,
      imageTokens: input.imageTokens,
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
    ...videoThinkingBody(input.scene),
  };
  if (Buffer.byteLength(JSON.stringify(body)) > 48 * 1024 * 1024) {
    throw new VideoTextDispatchError(
      "DEEPSEEK_REQUEST_TOO_LARGE",
      "完整文本/图像请求超过 DeepSeek 48MiB 单请求硬上限。",
      { retryable: false },
    );
  }

  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs ?? 600_000)])
    : AbortSignal.timeout(input.timeoutMs ?? 600_000);
  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(`${input.endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    throw new VideoTextDispatchError(
      input.signal?.aborted ? "MODEL_CANCELLED" : "MODEL_RESULT_UNKNOWN",
      input.signal?.aborted ? "模型调用已被调用方取消。" : "模型网络结果未知，不能自动重复可能已计费的请求。",
      { retryable: false, unknown: true, cause: error },
    );
  }
  const rawBody = await readBoundedBody(response);
  if (!response.ok) {
    let parsedFailure: unknown;
    try { parsedFailure = JSON.parse(rawBody); } catch { /* non-JSON failures stay bounded */ }
    const detail = failureDetail(parsedFailure);
    throw new VideoTextDispatchError(
      `MODEL_HTTP_${response.status}`,
      `模型调用失败：HTTP ${response.status}${detail ? `（${detail}）` : ""}`,
      {
        retryable: response.status === 429,
        unknown: response.status >= 500,
        status: response.status,
      },
    );
  }
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (error) {
    throw new VideoTextDispatchError("MODEL_RESPONSE_JSON_INVALID", "模型响应不是合法 JSON。", {
      retryable: false,
      unknown: true,
      cause: error,
    });
  }
  if (envelope.model !== input.endpoint.model) {
    throw new VideoTextDispatchError(
      "MODEL_IDENTITY_CHANGED",
      `模型响应身份 ${String(envelope.model ?? "<missing>")} 与请求 ${input.endpoint.model} 不一致。`,
      { retryable: false, unknown: true },
    );
  }
  if (typeof envelope.id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(envelope.id)) {
    throw new VideoTextDispatchError(
      "MODEL_IDENTITY_MISSING",
      "模型响应缺少稳定的请求身份。",
      { retryable: false, unknown: true },
    );
  }
  const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
  if (choices.length !== 1) {
    throw new VideoTextDispatchError("MODEL_CHOICE_INVALID", "模型响应必须包含唯一 choice。", {
      retryable: false,
      unknown: true,
    });
  }
  const choice = choices[0] as {
    finish_reason?: string;
    message?: { content?: unknown; reasoning_content?: string | null };
  };
  if (choice.finish_reason !== "stop") {
    throw new VideoTextDispatchError(
      choice.finish_reason === "length" ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_OUTPUT_INCOMPLETE",
      `模型未完整结束：${choice.finish_reason ?? "missing"}`,
      { retryable: false, unknown: true },
    );
  }
  if (policy.thinking.type === "disabled" && String(choice.message?.reasoning_content ?? "").trim()) {
    throw new VideoTextDispatchError(
      "MODEL_THINKING_POLICY_VIOLATION",
      "非思考场景返回了 reasoning_content。",
      { retryable: false, unknown: true },
    );
  }
  const text = normalizeModelContent(choice.message?.content).trim();
  if (!text) {
    throw new VideoTextDispatchError("MODEL_CONTENT_EMPTY", "模型最终 content 为空。", {
      retryable: false,
      unknown: true,
    });
  }
  const usage = envelope.usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | undefined;
  if (!Number.isSafeInteger(usage?.prompt_tokens) || usage!.prompt_tokens! < 0
    || !Number.isSafeInteger(usage?.completion_tokens) || usage!.completion_tokens! < 0) {
    throw new VideoTextDispatchError("MODEL_USAGE_INVALID", "模型 usage 缺失或无效。", {
      retryable: false,
      unknown: true,
    });
  }
  const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (!Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0
    || reasoningTokens > usage!.completion_tokens!) {
    throw new VideoTextDispatchError("MODEL_USAGE_INVALID", "模型 reasoning_tokens 无效。", {
      retryable: false,
      unknown: true,
    });
  }
  if (policy.thinking.type === "disabled" && reasoningTokens !== 0) {
    throw new VideoTextDispatchError(
      "MODEL_THINKING_POLICY_VIOLATION",
      "非思考场景返回了 reasoning tokens。",
      { retryable: false, unknown: true },
    );
  }
  if (usage!.prompt_tokens! > DEEPSEEK_FLASH_CONTEXT_TOKENS
    || usage!.completion_tokens! > budget.outputCeiling
    || usage!.prompt_tokens! + usage!.completion_tokens! > DEEPSEEK_FLASH_CONTEXT_TOKENS) {
    throw new VideoTextDispatchError(
      "MODEL_USAGE_INVALID",
      "模型 usage 超过本次上下文或输出预算。",
      { retryable: false, unknown: true },
    );
  }
  let value: unknown;
  if (input.requireJson === true) {
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new VideoTextDispatchError("MODEL_JSON_INVALID", "模型最终 content 不是完整 JSON。", {
        retryable: false,
        unknown: true,
        cause: error,
      });
    }
  }
  return {
    text,
    value,
    model: input.endpoint.model,
    responseId: envelope.id,
    finishReason: "stop",
    usage: {
      inputTokens: usage!.prompt_tokens!,
      outputTokens: usage!.completion_tokens!,
      reasoningTokens,
    },
    requestHash: hashJson({ endpoint: input.endpoint.baseUrl, scene: input.scene, body }),
    responseHash: hashJson(envelope),
    outputCeiling: budget.outputCeiling,
    policyVersion: VIDEO_SCENE_POLICY_VERSION,
  };
}
