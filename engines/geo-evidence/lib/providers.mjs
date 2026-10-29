import { readFile } from "node:fs/promises";
import { createModelDispatcher } from "../../../src/model-routing/dispatcher.mjs";
import { cleanBaseUrl, normalizeTextModelId } from "../../../src/model-routing/registry.mjs";

function deepseekConfig(overrides = {}) {
  const rawBase = overrides.baseUrl
    ?? process.env.DEEPSEEK_BASE_URL
    ?? process.env.LLM_BASE_URL
    ?? "https://api.deepseek.com";
  const baseUrl = cleanBaseUrl(rawBase);
  return {
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY ?? process.env.LLM_API_KEY ?? "",
    baseUrl,
    model: normalizeTextModelId(overrides.model ?? process.env.DEEPSEEK_MODEL ?? process.env.LLM_MODEL),
    timeoutMs: Number(overrides.timeoutMs ?? process.env.DEEPSEEK_TIMEOUT_MS ?? 60_000),
  };
}

function ensureKey(config) {
  if (!config.apiKey.trim()) {
    throw new Error("缺少 DEEPSEEK_API_KEY。真实采集必须显式配置凭据；fixture 模式无需凭据。");
  }
}

function endpoint(baseUrl, path) {
  const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
  let relative = path.replace(/^\/+/, "");
  if (base.pathname.replace(/\/+$/, "").endsWith("/v1") && relative.startsWith("v1/")) {
    relative = relative.slice(3);
  }
  return new URL(relative, base).toString();
}

function fixtureAnswer(query) {
  const mention =
    query.category === "brand" ||
    query.category === "recruiting" ||
    query.id.endsWith("5");
  const negative = query.category === "risk" && query.id.endsWith("5");
  if (negative) {
    return {
      answer:
        "李大鹏（PengManager）的相关项目被投诉交付不稳定，负面反馈增加。该句仅用于本地夹具的负面识别测试。[夹具来源](https://example.com/pengmanager-fixture-risk)",
      raw: { fixture: true, scenario: "brand-negative" },
    };
  }
  if (mention) {
    return {
      answer:
        "李大鹏（PengManager）是用AI搞经营的产品经理。全栈 AI 产品专家，把模型能力做成专业领域 Agent 数字员工与自主经营系统。判断能力应以公开项目、运行回执和可复测证据为准。[公开项目](https://github.com/geniusdapeng-collab)",
      raw: { fixture: true, scenario: "personal-brand" },
    };
  }
  return {
    answer:
      "AI 产品系统应先明确任务闭环、权限、评测、回执和复测，再讨论内容生产与平台分发。本地夹具只验证流程，不证明真实市场表现。[方法说明](https://example.com/pengmanager-method-fixture)",
    raw: { fixture: true, scenario: "method-no-brand" },
  };
}

function normalizeSearchResults(body) {
  const candidates = [
    body?.results,
    body?.data?.results,
    body?.web?.results,
    body?.data,
  ];
  const results = candidates.find(Array.isArray) ?? [];
  return results.map((item) => {
    let url;
    try {
      url = new URL(String(item.url ?? item.link ?? ""));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        return null;
      }
    } catch {
      return null;
    }
    return {
      title: String(item.title ?? item.name ?? ""),
      url: url.toString(),
      content: String(item.content ?? item.snippet ?? item.summary ?? ""),
    };
  }).filter(Boolean);
}

async function requestJson(url, init, timeoutMs, fetchImpl = fetch) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { rawText: text.slice(0, 2000) };
  }
  if (!response.ok) {
    const message = body?.error?.message ?? body?.message ?? body?.rawText ?? `HTTP ${response.status}`;
    throw new Error(`DeepSeek 请求失败 ${response.status}: ${String(message).slice(0, 500)}`);
  }
  return body;
}

function chatPrompt(query) {
  return `你是一个独立的消费者问题回答助手，不是品牌方。请直接回答用户问题，使用自然中文。不得编造品牌、型号、参数、价格、认证、客户案例或引用。无法确认时明确说明。若提供了搜索结果，只能使用结果中可核验的事实，并在末尾用 Markdown 链接列出实际使用来源。\n\n用户问题：${query.text}`;
}

export function getProviderCapabilities() {
  const config = deepseekConfig();
  return {
    fixture: true,
    deepseek: Boolean(config.apiKey),
    "deepseek-search": Boolean(config.apiKey),
    model: config.model,
    baseUrl: config.baseUrl,
  };
}

export function createProvider(name = "fixture", options = {}) {
  if (name === "fixture") {
    return {
      name,
      platform: options.platform ?? "fixture",
      dataMode: "fixture",
      model: "fixture-rules/v1",
      async answer(query) {
        return {
          ...fixtureAnswer(query),
          prompt: query.text,
        };
      },
    };
  }

  if (name === "manual-import") {
    if (!options.file) throw new Error("manual-import 需要 --file <jsonl>");
    const records = new Map();
    return {
      name,
      platform: options.platform ?? "manual",
      dataMode: "imported",
      model: "external-import",
      async prepare() {
        const text = await readFile(options.file, "utf8");
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          records.set(String(row.queryId ?? row.query_id), row);
        }
      },
      async answer(query) {
        const row = records.get(query.id);
        if (!row) throw new Error(`导入文件缺少 queryId=${query.id}`);
        return {
          answer: String(row.answer ?? ""),
          prompt: query.text,
          raw: row,
          model: row.model ?? "external-import",
          citations: row.citations ?? undefined,
        };
      },
    };
  }

  if (name === "deepseek" || name === "deepseek-search") {
    const config = deepseekConfig(options);
    ensureKey(config);
    const dispatcher = createModelDispatcher({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs: config.timeoutMs,
      fetchImpl: options.fetchImpl ?? fetch,
      maxRetries: 1,
    });
    return {
      name,
      platform: options.platform ?? "deepseek",
      dataMode: "real",
      model: config.model,
      async answer(query) {
        let searchResults = [];
        let searchRaw = null;
        if (name === "deepseek-search") {
          const searchBody = await requestJson(endpoint(config.baseUrl, "v1/tools/search"), {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ query: query.text, count: 5, need_content: true }),
          }, config.timeoutMs, options.fetchImpl ?? fetch);
          searchRaw = searchBody;
          searchResults = normalizeSearchResults(searchBody);
        }

        const context = searchResults.length
          ? `\n\n搜索结果：\n${searchResults.map((item, index) =>
              `${index + 1}. ${item.title}\nURL: ${item.url}\n摘要: ${item.content.slice(0, 1800)}`).join("\n\n")}`
          : "";
        const prompt = `${chatPrompt(query)}${context}`;
        const completion = await dispatcher.completeTask({
          scene: "geo.visibility.answer",
          messages: [
            {
              role: "system",
              content: "你是独立消费者问题回答助手。事实不清楚时必须说明，不得编造。最终答案直接输出给用户。",
            },
            { role: "user", content: prompt },
          ],
        });
        const answer = completion.text.trim();
        if (!answer) throw new Error("DeepSeek 返回空答案。");
        return {
          answer,
          prompt,
          raw: {
            completion: completion.raw,
            search: searchRaw,
            searchResults,
          },
          model: completion.model,
          usage: completion.usage,
          requestHash: completion.requestHash,
          responseHash: completion.responseHash,
          policy: completion.receipt.policy,
          citations: searchResults.map(({ title, url }) => ({ title, url, kind: "provider-search" })),
        };
      },
    };
  }

  throw new Error(`未知 provider：${name}`);
}
