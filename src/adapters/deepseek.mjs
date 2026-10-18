import { hashObject, hashText } from "../domain/hash.mjs";
import { scanSensitiveText } from "../domain/policy.mjs";
import { resolveDeepSeekApiKey } from "./auth.mjs";

function endpoint(baseUrl, path) {
  return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function textFromResponses(body) {
  const parts = [];
  for (const item of body?.output ?? []) {
    if (item?.type !== "message") {
      continue;
    }
    for (const content of item?.content ?? []) {
      if (
        ["output_text", "text"].includes(content?.type) &&
        typeof content?.text === "string"
      ) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("\n").trim();
}

function parseJsonText(text) {
  const trimmed = String(text ?? "").trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  return JSON.parse(unfenced);
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
      let domain = "";
      try {
        domain = parsedUrl.hostname;
      } catch {
        domain = "";
      }
      return {
        title: String(entry.title ?? entry.name ?? ""),
        url: parsedUrl.toString(),
        domain,
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

export class DeepSeekAdapter {
  constructor({
    baseUrl = process.env.DEEPSEEK_BASE_URL || "http://127.0.0.1:8788",
    model = process.env.DEEPSEEK_MODEL || "deepseek-flash",
    apiKey,
    timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 120_000),
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  #auth() {
    if (!this.apiKey) {
      this.apiKey = resolveDeepSeekApiKey();
    }
    return this.apiKey;
  }

  async health() {
    let configured = Boolean(this.apiKey);
    if (!configured) {
      try {
        this.#auth();
        configured = true;
      } catch {
        configured = false;
      }
    }
    try {
      const response = await this.fetchImpl(endpoint(this.baseUrl, "/health"), {
        signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json();
      return {
        configured,
        ok: response.ok && body.status === "ok",
        mode: "direct-deepseek-api",
        baseUrl: this.baseUrl,
        model: this.model,
        upstream: body.upstream,
      };
    } catch (error) {
      return {
        configured,
        ok: false,
        mode: "direct-deepseek-api",
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

  async chat(prompt, { maxTokens = 1_500, temperature = 0.2 } = {}) {
    const body = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#auth()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "你是独立的 AI 产品与 GEO 研究助手。只能依据给定事实和搜索结果回答；证据不足时明确说明，不得编造。",
            },
            { role: "user", content: prompt },
          ],
          temperature,
          max_tokens: maxTokens,
          stream: false,
        }),
      },
      this.timeoutMs,
    );
    const answer = String(body?.choices?.[0]?.message?.content ?? "").trim();
    if (!answer) {
      throw new Error("DeepSeek Chat 返回空答案。");
    }
    return {
      answer,
      model: String(body?.model ?? this.model),
      completionId: body?.id ?? null,
      usage: body?.usage ?? null,
      responseHash: hashObject(body),
    };
  }

  async respond(prompt, { maxOutputTokens = 4_000 } = {}) {
    const body = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/responses"),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#auth()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: prompt,
          max_output_tokens: maxOutputTokens,
          stream: false,
        }),
      },
      this.timeoutMs,
    );
    const answer = textFromResponses(body);
    if (!answer) {
      throw new Error("DeepSeek Responses 返回空答案。");
    }
    return {
      answer,
      model: String(body.model ?? this.model),
      completionId: body.id ?? null,
      usage: body.usage ?? null,
      responseHash: hashObject(body),
    };
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
    let completion;
    let completionSurface = "deepseek-chat-completions";
    try {
      completion = await this.chat(prompt, { maxTokens: 1_200 });
    } catch (error) {
      if (!/空答案/.test(error.message)) {
        throw error;
      }
      try {
        completion = await this.chat(prompt, { maxTokens: 3_200 });
      } catch (retryError) {
        if (!/空答案/.test(retryError.message)) {
          throw retryError;
        }
        completion = await this.respond(prompt, { maxOutputTokens: 4_000 });
        completionSurface = "deepseek-responses";
      }
    }
    const evidence = {
      schemaVersion: "pengstack.deepseek-answer/v1",
      queryId: query.id,
      query: query.text,
      queryLocale: query.locale,
      surface: `DeepSeek Search + ${completionSurface === "deepseek-responses" ? "Responses API" : "Chat API"}`,
      completionSurface,
      model: completion.model,
      completionId: completion.completionId,
      searchResponseHash: search.responseHash,
      completionResponseHash: completion.responseHash,
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
      "请为鹏栈 / PengStack 生成一条可审核的平台内容草案。",
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
    let body;
    let generated;
    let parseError;
    for (const maxOutputTokens of [1_400, 4_000]) {
      body = await requestJson(
        this.fetchImpl,
        endpoint(this.baseUrl, "/responses"),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.#auth()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: this.model,
            input: prompt,
            max_output_tokens: maxOutputTokens,
            stream: false,
          }),
        },
        this.timeoutMs,
      );
      const text = textFromResponses(body);
      if (!text) {
        parseError = new Error("模型未返回 message/output_text。");
        continue;
      }
      try {
        generated = parseJsonText(text);
        break;
      } catch (error) {
        parseError = error;
      }
    }
    if (!generated) {
      throw parseError ?? new Error("模型没有返回可解析的内容 JSON。");
    }
    if (!generated.title?.trim() || !generated.body?.trim()) {
      throw new Error("模型没有返回有效的 title/body。");
    }
    const sensitive = scanSensitiveText(
      `${generated.title}\n${generated.body}\n${generated.cta ?? ""}`,
    );
    if (sensitive.length > 0) {
      throw new Error("模型生成内容包含敏感信息，已拒绝保存。");
    }
    return {
      ...generated,
      model: String(body.model ?? this.model),
      responseId: body.id ?? null,
      usage: body.usage ?? null,
      responseHash: hashObject(body),
    };
  }
}
