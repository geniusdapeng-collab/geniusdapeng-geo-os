import { hashObject, hashText } from "../domain/hash.mjs";
import { scanSensitiveText } from "../domain/policy.mjs";
import { MAIN_PROFILE } from "../domain/identity.mjs";
import { resolveDeepSeekApiKey } from "./auth.mjs";
import { createModelDispatcher } from "../model-routing/dispatcher.mjs";
import {
  cleanBaseUrl,
  normalizeTextModelId,
} from "../model-routing/registry.mjs";

function endpoint(baseUrl, path) {
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  let relative = path.replace(/^\/+/, "");
  if (base.pathname.replace(/\/+$/, "").endsWith("/v1") && relative.startsWith("v1/")) {
    relative = relative.slice(3);
  }
  return new URL(relative, base).toString();
}

function normalizeSearchResults(body) {
  const candidates = [body?.results, body?.data?.results, body?.web?.results];
  const results = candidates.find(Array.isArray) ?? [];
  return results
    .map((entry) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(String(entry.url ?? entry.link ?? ""));
        if (!["http:", "https:"].includes(parsedUrl.protocol)
          || parsedUrl.username || parsedUrl.password) {
          return null;
        }
      } catch {
        return null;
      }
      return {
        title: String(entry.title ?? entry.name ?? ""),
        url: parsedUrl.toString(),
        domain: parsedUrl.hostname,
        snippet: String(entry.content ?? entry.snippet ?? entry.summary ?? "").slice(0, 2_000),
      };
    })
    .filter(Boolean)
    .filter((entry) => entry.url);
}

async function requestJson(fetchImpl, url, init, timeoutMs) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawText: text.slice(0, 1_000) };
  }
  if (!response.ok) {
    const detail =
      body?.error?.message ?? body?.message ?? body?.rawText ?? `HTTP ${response.status}`;
    throw new Error(`DeepSeek API ${response.status}: ${String(detail).slice(0, 500)}`);
  }
  return body;
}

function validateGeneratedContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型没有返回 JSON 对象。");
  }
  const allowed = new Set(["title", "body", "hook", "cta", "hashtags"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`模型返回未声明字段：${key}`);
  }
  if (typeof value.title !== "string" || !value.title.trim()) {
    throw new Error("模型没有返回有效的 title。");
  }
  if (typeof value.body !== "string" || !value.body.trim()) {
    throw new Error("模型没有返回有效的 body。");
  }
  if (value.hook !== undefined && typeof value.hook !== "string") {
    throw new Error("模型返回的 hook 无效。");
  }
  if (value.cta !== undefined && typeof value.cta !== "string") {
    throw new Error("模型返回的 cta 无效。");
  }
  if (value.hashtags !== undefined
    && (!Array.isArray(value.hashtags) || value.hashtags.some((item) => typeof item !== "string"))) {
    throw new Error("模型返回的 hashtags 无效。");
  }
  return value;
}

export class DeepSeekAdapter {
  constructor({
    baseUrl = process.env.LLM_BASE_URL || process.env.DEEPSEEK_BASE_URL || "http://127.0.0.1:8788",
    model = process.env.LLM_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-flash",
    apiKey,
    timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 600_000),
    fetchImpl = fetch,
    dispatcher,
    maxRetries = 1,
  } = {}) {
    this.baseUrl = cleanBaseUrl(baseUrl);
    this.model = normalizeTextModelId(model);
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.maxRetries = maxRetries;
    this.dispatcher = dispatcher ?? null;
  }

  #auth() {
    if (!this.apiKey) this.apiKey = resolveDeepSeekApiKey();
    return this.apiKey;
  }

  #dispatcher() {
    if (!this.dispatcher) {
      this.dispatcher = createModelDispatcher({
        apiKey: this.#auth(),
        model: this.model,
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        maxRetries: this.maxRetries,
      });
    }
    return this.dispatcher;
  }

  async health() {
    const configured = Boolean(this.apiKey || process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY);
    const url = new URL(this.baseUrl);
    const healthUrl = url.hostname === "api.deepseek.com"
      ? endpoint(this.baseUrl, "/models")
      : endpoint(this.baseUrl, "/health");
    try {
      const headers = this.apiKey || process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY
        ? { Authorization: `Bearer ${this.#auth()}` }
        : {};
      const response = await this.fetchImpl(healthUrl, {
        headers,
        signal: AbortSignal.timeout(5_000),
      });
      return {
        configured,
        ok: response.ok || (url.hostname === "api.deepseek.com" && response.status === 404),
        mode: "unified-deepseek-dispatcher",
        baseUrl: this.baseUrl,
        model: this.model,
        policyVersion: this.#dispatcher().health().policyVersion,
      };
    } catch (error) {
      return {
        configured,
        ok: false,
        mode: "unified-deepseek-dispatcher",
        baseUrl: this.baseUrl,
        model: this.model,
        error: error.message,
      };
    }
  }

  async search(query, { count = 5 } = {}) {
    const body = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/v1/tools/search"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#auth()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          count,
          need_content: true,
        }),
      },
      this.timeoutMs,
    );
    return {
      results: normalizeSearchResults(body),
      responseHash: hashObject(body),
    };
  }

  async chat(prompt, {
    scene = "geo.answer.synthesize",
    systemPrompt = "你是独立的 AI 产品与 GEO 研究助手。只能依据给定事实和搜索结果回答；证据不足时明确说明，不得编造。",
    signal,
  } = {}) {
    const result = await this.#dispatcher().completeTask({
      scene,
      signal,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
    });
    return {
      answer: result.text,
      model: result.model,
      completionId: result.responseId,
      usage: result.usage,
      responseHash: result.responseHash,
      requestHash: result.requestHash,
      mode: result.mode,
      effort: result.effort,
      outputCeiling: result.outputCeiling,
      policyHash: result.policyHash,
      registryVersion: result.registryVersion,
      attempts: result.attempts,
      receipt: result.receipt,
    };
  }

  async respond(prompt, options = {}) {
    return this.chat(prompt, options);
  }

  async answerQuery(query) {
    const search = await this.search(query.text, { count: 5 });
    const sources = search.results
      .map(
        (result, index) =>
          `${index + 1}. ${result.title}\nURL: ${result.url}\n摘要: ${result.snippet}`,
      )
      .join("\n\n");
    const prompt = [
      `用户问题：${query.text}`,
      "请以独立回答助手的身份回答。只使用下列真实搜索结果中的信息；无法确认时明确说不知道。",
      "末尾列出实际使用的 Markdown 来源链接。",
      "",
      sources || "未返回搜索结果。",
    ].join("\n");
    const completion = await this.chat(prompt, { scene: "geo.answer.synthesize" });
    const evidence = {
      schemaVersion: "pengstack.deepseek-answer/v2",
      queryId: query.id,
      query: query.text,
      queryLocale: query.locale,
      surface: "DeepSeek Search + unified Chat API",
      transport: "openai-chat",
      model: completion.model,
      completionId: completion.completionId,
      searchResponseHash: search.responseHash,
      completionResponseHash: completion.responseHash,
      completionRequestHash: completion.requestHash,
      policy: completion.receipt.policy,
      usage: completion.usage,
      answer: completion.answer,
      answerHash: hashText(completion.answer),
      citations: search.results.map(({ title, url, domain }) => ({ title, url, domain })),
      capturedAt: new Date().toISOString(),
    };
    return {
      answer: completion.answer,
      citations: evidence.citations,
      model: completion.model,
      evidence,
    };
  }

  async generateContent({ brief, claims, platform, contentType = "social_post" }) {
    const claimText = claims.map((claim) => `- ${claim.id}: ${claim.text}`).join("\n");
    const prompt = [
      "请为鹏经理系统 / PengManager System 的主账号生成一条可审核的平台内容草案。",
      `中文账号名：${MAIN_PROFILE.nameZh}；英文账号名：${MAIN_PROFILE.nameEn}。`,
      `中文展示名：${MAIN_PROFILE.displayNameZh}；英文展示名：${MAIN_PROFILE.displayNameEn}。`,
      `中文简介：${MAIN_PROFILE.bioZh}`,
      `英文简介：${MAIN_PROFILE.bioEn}`,
      "只使用给定 Claim，不得补造客户、数字、奖项、雇佣关系或合作方。",
      "不使用“行业第一”“AI大师”“颠覆世界”等自封表达。",
      `目标平台：${platform}`,
      `内容类型：${contentType}`,
      `任务：${brief}`,
      "事实：",
      claimText,
      "",
      "严格只输出一个 JSON 对象，字段为 title、body、hook、cta、hashtags。",
      "body 使用自然中文，控制在 300 至 800 字。",
    ].join("\n");
    const result = await this.#dispatcher().completeTask({
      scene: "content.draft",
      messages: [
        {
          role: "system",
          content: "你是有事实边界的 GEO 内容编辑。只输出合法 JSON，不得输出 Markdown 围栏或解释。",
        },
        { role: "user", content: prompt },
      ],
    });
    const generated = validateGeneratedContent(result.value);
    const sensitive = scanSensitiveText(
      `${generated.title}\n${generated.body}\n${generated.cta ?? ""}`,
    );
    if (sensitive.length > 0) {
      throw new Error("模型生成内容包含敏感信息，已拒绝保存。");
    }
    return {
      ...generated,
      model: result.model,
      responseId: result.responseId,
      usage: result.usage,
      responseHash: result.responseHash,
      requestHash: result.requestHash,
      policy: result.receipt.policy,
      finishReason: result.finishReason,
      mode: result.mode,
      effort: result.effort,
      outputCeiling: result.outputCeiling,
      policyHash: result.policyHash,
      registryVersion: result.registryVersion,
      attempts: result.attempts,
      receipt: result.receipt,
    };
  }
}
