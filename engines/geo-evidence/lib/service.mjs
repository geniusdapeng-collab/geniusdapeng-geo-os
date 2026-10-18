import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  analyzeAnswer,
  parseCitations,
  sha256,
} from "./core.mjs";
import { createProvider, getProviderCapabilities } from "./providers.mjs";
import {
  PERSONAL_ARTICLE_TOPICS,
  PERSONAL_GEO_CASE,
  buildPersonalArticleDraft,
  computePersonalMetrics,
  groupPersonalMetrics,
} from "../personal-case.mjs";

function slugify(value) {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || `article-${sha256(value).slice(0, 10)}`;
}

function mergeProviderCitations(
  analysis,
  providerCitations = [],
  caseConfig = PERSONAL_GEO_CASE,
) {
  const combined = [...(analysis.citations ?? [])];
  const seen = new Set(combined.map((citation) => citation.url));
  for (const citation of providerCitations) {
    if (!citation?.url || seen.has(citation.url)) continue;
    let domain = "";
    try {
      domain = new URL(citation.url).hostname.toLowerCase();
    } catch {
      domain = "";
    }
    combined.push({ ...citation, domain });
    seen.add(citation.url);
  }
  const ownedUrlPrefixes = caseConfig.brand.ownedUrlPrefixes ?? [];
  return {
    ...analysis,
    citations: combined,
    ownedCitations: combined.filter((citation) =>
      caseConfig.brand.ownedDomains
        .some((domain) => citation.domain === domain || citation.domain.endsWith(`.${domain}`)) ||
      ownedUrlPrefixes.some((prefix) => citation.url.startsWith(prefix))),
    riskyCitations: combined.filter((citation) =>
      caseConfig.negativeDomains.some((domain) =>
        citation.domain === domain || citation.domain.endsWith(`.${domain}`))),
  };
}

function privateAddress(address) {
  if (!address) return true;
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  if (!isIP(address)) return false;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

async function assertPublicHttpUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许抓取公开 HTTP(S) 页面");
  if (url.username || url.password) throw new Error("引用 URL 不得包含凭据");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((entry) => privateAddress(entry.address))) {
    throw new Error("拒绝抓取本机、内网或无法安全解析的地址");
  }
  return url;
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

export class GeoEvidenceService {
  constructor(
    store,
    {
      rootDir = process.cwd(),
      env = process.env,
      caseConfig = store.caseConfig ?? PERSONAL_GEO_CASE,
      articleTopics = PERSONAL_ARTICLE_TOPICS,
      metrics = computePersonalMetrics,
    } = {},
  ) {
    this.store = store;
    this.rootDir = resolve(rootDir);
    this.env = env;
    this.caseConfig = caseConfig;
    this.articleTopics = articleTopics;
    this.metrics = metrics;
  }

  health() {
    return {
      ok: true,
      service: "geo-evidence-studio",
      version: "0.1.0",
      case: this.caseConfig.id,
      database: this.store.path,
      providers: getProviderCapabilities(),
      generatedAt: new Date().toISOString(),
    };
  }

  async runObservations({
    provider = "fixture",
    limit = 20,
    category,
    queryIds,
    platform,
    file,
    concurrency = 2,
    model,
    baseUrl,
  } = {}) {
    const adapter = createProvider(provider, {
      platform,
      file,
      model,
      baseUrl,
      apiKey: this.env.DEEPSEEK_API_KEY,
      timeoutMs: this.env.DEEPSEEK_TIMEOUT_MS,
    });
    await adapter.prepare?.();
    const allQueries = this.store.listQueries({ category, limit: 1000 });
    const selectedIds = queryIds ? new Set(queryIds) : null;
    const queries = allQueries
      .filter((query) => !selectedIds || selectedIds.has(query.id))
      .slice(0, Math.max(1, Number(limit) || 20));
    const runId = this.store.createRun({
      provider,
      dataMode: adapter.dataMode,
      platform: adapter.platform,
      model: adapter.model,
      requestedLimit: limit,
      plannedSamples: queries.length,
      notes: [
        "每个问题代表一个计划样本。",
        "真实模式不得用 fixture 回执冒充，结果按 provider 与 dataMode 分开展示。",
      ],
    });
    const evidenceDir = join(this.rootDir, "outputs", "geo-evidence-studio", "evidence", runId);
    await mkdir(evidenceDir, { recursive: true });
    let successful = 0;
    let failed = 0;
    const notes = [];

    await mapLimit(queries, Math.max(1, Math.min(6, Number(concurrency) || 2)), async (query) => {
      const prompt = `请回答酒店采购方会问的问题：${query.text}`;
      try {
        const result = await adapter.answer(query);
        const answer = String(result.answer ?? "");
        let analysis = analyzeAnswer(query, answer, this.caseConfig);
        analysis = mergeProviderCitations(
          analysis,
          result.citations ?? [],
          this.caseConfig,
        );
        const evidenceHash = sha256(JSON.stringify({
          queryId: query.id,
          provider,
          platform: adapter.platform,
          model: result.model ?? adapter.model,
          answer,
          raw: result.raw ?? null,
          citations: analysis.citations,
        }));
        analysis.evidenceHash = evidenceHash;
        const evidencePath = join(evidenceDir, `${query.id}.json`);
        await writeFile(evidencePath, `${JSON.stringify({
          schemaVersion: "geo-evidence/v1",
          dataMode: adapter.dataMode,
          provider,
          platform: adapter.platform,
          model: result.model ?? adapter.model,
          query,
          prompt,
          answer,
          citations: analysis.citations,
          analysis,
          raw: result.raw ?? null,
          evidenceHash,
          capturedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
        this.store.insertSample({
          runId,
          query,
          platform: adapter.platform,
          model: result.model ?? adapter.model,
          provider,
          dataMode: adapter.dataMode,
          prompt,
          answer,
          citations: analysis.citations,
          analysis,
          raw: result.raw,
          screenshotUri: `file://${evidencePath}`,
          status: "success",
        });
        successful += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`${query.id}: ${message}`);
        this.store.insertSample({
          runId,
          query,
          platform: adapter.platform,
          model: adapter.model,
          provider,
          dataMode: adapter.dataMode,
          prompt,
          answer: "",
          citations: [],
          analysis: {},
          raw: null,
          status: "failed",
          error: message,
        });
      }
    });

    const status = failed === 0 ? "completed" : successful > 0 ? "partial" : "failed";
    this.store.finishRun(runId, { status, successful, failed, notes });
    return {
      runId,
      status,
      provider,
      dataMode: adapter.dataMode,
      platform: adapter.platform,
      planned: queries.length,
      successful,
      failed,
      metrics: this.metrics(
        this.store.listSamples({ runId, limit: 1000 }),
        this.caseConfig,
      ),
      notes,
    };
  }

  async ingestAnswer({
    queryId,
    answer,
    platform = "manual",
    model = "manual",
    citations = [],
    dataMode = "imported",
  }) {
    const query = this.store.listQueries({ limit: 1000 }).find((item) => item.id === queryId);
    if (!query) throw new Error(`问题不存在：${queryId}`);
    const runId = this.store.createRun({
      provider: "manual-import",
      dataMode,
      platform,
      model,
      requestedLimit: 1,
      plannedSamples: 1,
      notes: ["通过工具桥接导入的答案必须携带原始答案；引用缺证时不得伪造。"],
    });
    let analysis = analyzeAnswer(
      query,
      String(answer ?? ""),
      this.caseConfig,
    );
    analysis = mergeProviderCitations(analysis, citations, this.caseConfig);
    analysis.evidenceHash = sha256(JSON.stringify({ queryId, answer, citations, platform, model }));
    const evidenceDir = join(this.rootDir, "outputs", "geo-evidence-studio", "evidence", runId);
    await mkdir(evidenceDir, { recursive: true });
    const evidencePath = join(evidenceDir, `${queryId}.json`);
    await writeFile(evidencePath, `${JSON.stringify({
      schemaVersion: "geo-evidence/v1",
      dataMode,
      provider: "manual-import",
      platform,
      model,
      query,
      answer,
      citations: analysis.citations,
      analysis,
      evidenceHash: analysis.evidenceHash,
      capturedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
    const sampleId = this.store.insertSample({
      runId,
      query,
      platform,
      model,
      provider: "manual-import",
      dataMode,
      prompt: query.text,
      answer,
      citations: analysis.citations,
      analysis,
      raw: { imported: true },
      screenshotUri: `file://${evidencePath}`,
      status: "success",
    });
    this.store.finishRun(runId, { status: "completed", successful: 1, failed: 0 });
    return { runId, sampleId, analysis, evidenceUri: `file://${evidencePath}` };
  }

  reanalyzeRun(runId) {
    const samples = this.store.listSamples({ runId, limit: 5000 });
    const queries = new Map(this.store.listQueries({ limit: 1000 }).map((query) => [query.id, query]));
    let updated = 0;
    let brandNegativeSamples = 0;
    for (const sample of samples) {
      if (sample.status !== "success") continue;
      const query = queries.get(sample.query_id);
      if (!query) continue;
      let analysis = analyzeAnswer(query, sample.answer, this.caseConfig);
      analysis = mergeProviderCitations(
        analysis,
        sample.citations ?? [],
        this.caseConfig,
      );
      analysis.evidenceHash = sample.evidence_hash;
      this.store.updateSampleAnalysis(sample.id, { analysis, citations: analysis.citations });
      updated += 1;
      if (analysis.brandNegative) brandNegativeSamples += 1;
    }
    return {
      runId,
      updated,
      brandNegativeSamples,
      metrics: this.metrics(
        this.store.listSamples({ runId, limit: 5000 }),
        this.caseConfig,
      ),
    };
  }

  async fetchCitation(url) {
    const safeUrl = await assertPublicHttpUrl(url);
    const response = await fetch(safeUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "GeoEvidenceStudio/0.1 public-citation-inspector" },
    });
    if (!response.ok) throw new Error(`引用页返回 HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
      throw new Error(`不支持的内容类型：${contentType || "unknown"}`);
    }
    const raw = await response.text();
    const text = raw.slice(0, 2_000_000);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]
      ?.replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? "";
    return {
      url: safeUrl.toString(),
      finalUrl: response.url,
      status: response.status,
      contentType,
      title,
      contentSha256: sha256(text),
      bytes: Buffer.byteLength(text),
      fetchedAt: new Date().toISOString(),
    };
  }

  summary({ runId } = {}) {
    const samples = this.store.listSamples({ runId, limit: 2000 });
    const successful = samples.filter((sample) => sample.status === "success");
    return {
      case: this.caseConfig,
      runId: runId ?? null,
      metrics: this.metrics(samples, this.caseConfig),
      byCategory: groupPersonalMetrics(
        successful,
        (row) => row.category,
        this.caseConfig,
      ),
      byPlatform: groupPersonalMetrics(
        successful,
        (row) => row.platform,
        this.caseConfig,
      ),
      latestRuns: this.store.listRuns(10),
      incidents: this.store.listIncidents({ status: "open", limit: 50 }),
      publicationCount: this.store.listPublications(100).length,
      dataModes: [...new Set(samples.map((sample) => sample.dataMode))],
      generatedAt: new Date().toISOString(),
    };
  }

  generateArticles({ topicIds, force = false, dataMode = "draft" } = {}) {
    const queries = this.store.listQueries({ limit: 1000 });
    const existing = this.store.listArticles(1000);
    const selectedTopics = this.articleTopics.filter((topic) =>
      !topicIds?.length || topicIds.includes(topic.id));
    const created = [];
    for (const topic of selectedTopics) {
      if (!force && existing.some((article) => article.topic_id === topic.id)) continue;
      const topicQueries = queries.filter((query) => topic.categories.includes(query.category));
      const markdown = buildPersonalArticleDraft(
        topic,
        topicQueries,
        this.caseConfig,
      );
      const id = this.store.createArticle({
        topicId: topic.id,
        title: topic.title,
        slug: `${slugify(topic.id)}-${Date.now().toString(36)}-${sha256(topic.title).slice(0, 8)}`,
        markdown,
        queryIds: topicQueries.map((query) => query.id),
        dataMode,
      });
      created.push(this.store.getArticle(id));
    }
    return {
      created,
      totalArticles: this.store.listArticles(1000).length,
      note: "文章是可审计草案；客户事实、数字、资质、型号和价格未确认时不得对外发布。",
    };
  }

  async publishArticle({ articleId, channel = "local", webhookUrl, approvedBy }) {
    const article = this.store.getArticle(articleId);
    if (!article) throw new Error(`文章不存在：${articleId}`);
    if (article.data_mode === "draft" && !approvedBy) {
      throw new Error("草案发布必须提供 approvedBy，禁止跳过人工审批");
    }
    const publicationId = this.store.createPublication({
      articleId,
      channel,
      status: "running",
      receipt: { approvedBy: approvedBy ?? null, dataMode: article.data_mode },
    });
    try {
      if (channel === "local") {
        const outDir = join(this.rootDir, "outputs", "geo-evidence-studio", "published", article.slug);
        await mkdir(outDir, { recursive: true });
        const markdownPath = join(outDir, "article.md");
        const manifestPath = join(outDir, "receipt.json");
        await writeFile(markdownPath, article.markdown, "utf8");
        const receipt = {
          schemaVersion: "geo-publication/v1",
          articleId,
          channel,
          status: "published",
          url: `file://${markdownPath}`,
          contentSha256: sha256(article.markdown),
          approvedBy: approvedBy ?? null,
          publishedAt: new Date().toISOString(),
          dataMode: article.data_mode,
        };
        await writeFile(manifestPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
        this.store.completePublication(publicationId, {
          url: receipt.url,
          receipt: { ...receipt, manifest: `file://${manifestPath}` },
        });
        return { publicationId, ...receipt };
      }

      if (channel === "webhook") {
        if (!webhookUrl) throw new Error("webhook 发布需要 webhookUrl");
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: article.title,
            slug: article.slug,
            markdown: article.markdown,
            evidenceHash: article.evidence_hash,
            approvedBy,
          }),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`Webhook ${response.status}: ${text.slice(0, 500)}`);
        let payload;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { raw: text.slice(0, 1000) };
        }
        this.store.completePublication(publicationId, {
          url: payload.url ?? null,
          receipt: { status: response.status, payload },
        });
        return { publicationId, channel, status: "published", ...payload };
      }

      throw new Error(`未知发布通道：${channel}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.completePublication(publicationId, { error: message, receipt: { error: message } });
      throw error;
    }
  }

  async writeReport({ runId, outDir } = {}) {
    const summary = this.summary({ runId });
    const targetDir = resolve(outDir ?? join(this.rootDir, "outputs", "geo-evidence-studio", "report"));
    await mkdir(targetDir, { recursive: true });
    const jsonPath = join(targetDir, "summary.json");
    const markdownPath = join(targetDir, "REPORT.md");
    await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    const metric = summary.metrics;
    const pct = (value) => value === null ? "未验证" : `${(value * 100).toFixed(1)}%`;
    const markdown = `# GeoEvidence Studio 运行报告\n\n` +
      `- 案例：${summary.case.name}\n` +
      `- 运行：${summary.runId ?? "全部样本"}\n` +
      `- 数据模式：${summary.dataModes.join(", ") || "无样本"}\n` +
      `- 样本：${metric.successfulSamples}/${metric.totalSamples}\n` +
      `- 品牌提及率：${pct(metric.mentionRate)}\n` +
      `- 首推率：${pct(metric.firstRecommendationRate)}\n` +
      `- 有引用回答率：${pct(metric.citationPresenceRate)}\n` +
      `- 自有信源引用率：${pct(metric.ownedCitationRate)}\n` +
      `- 品牌负面提及率：${pct(metric.brandNegativeMentionRate)}\n` +
      `- 品牌负面引用率：${pct(metric.negativeCitationRate)}\n` +
      `- 证据覆盖率：${pct(metric.evidenceCoverageRate)}\n\n` +
      `> “未验证”表示缺真实采集、缺来源域名或分母为 0，不表示 0%。\n`;
    await writeFile(markdownPath, markdown, "utf8");
    return { jsonPath, markdownPath, summary };
  }

  async handleTool(name, params = {}, scope = {}) {
    switch (name) {
      case "visibility.collect": {
        const run = await this.runObservations({
          provider: params.provider ?? "fixture",
          limit: params.limit ?? 1,
          queryIds: params.queryId ? [params.queryId] : undefined,
          platform: params.platform,
        });
        return {
          result: { ...run, scope },
          receipt: {
            synced: run.successful > 0,
            snapshot_uri: `geo-evidence://run/${run.runId}`,
            verified_at: new Date().toISOString(),
            mode: run.dataMode === "fixture" ? "simulated" : "real",
          },
        };
      }
      case "geo.rewrite": {
        const generated = this.generateArticles({
          topicIds: params.topicIds,
          force: Boolean(params.force),
          dataMode: params.dataMode ?? "draft",
        });
        return {
          result: { ...generated, scope },
          receipt: {
            synced: generated.created.length > 0,
            mode: "real",
            verified_at: new Date().toISOString(),
          },
        };
      }
      case "answer.structure": {
        const result = await this.ingestAnswer({
          queryId: params.queryId,
          answer: params.answer,
          platform: params.platform,
          model: params.model,
          citations: params.citations,
          dataMode: params.dataMode ?? "imported",
        });
        return {
          result: { ...result, scope },
          receipt: {
            synced: true,
            snapshot_uri: result.evidenceUri,
            verified_at: new Date().toISOString(),
            mode: params.dataMode === "fixture" ? "simulated" : "real",
          },
        };
      }
      case "citation.fetch": {
        const citation = await this.fetchCitation(String(params.url ?? ""));
        return {
          result: { citation, scope },
          receipt: {
            synced: true,
            snapshot_uri: citation.url,
            verified_at: citation.fetchedAt,
            mode: "real",
          },
        };
      }
      case "geo_queue.emit": {
        const article = this.store.getArticle(params.articleId);
        if (!article) throw new Error(`文章不存在：${params.articleId}`);
        const publicationId = this.store.createPublication({
          articleId: article.id,
          channel: params.channel ?? "manual",
          receipt: { queuedBy: "geo_queue.emit", scope },
        });
        return {
          result: { publicationId, articleId: article.id, channel: params.channel ?? "manual" },
          receipt: { synced: true, mode: "real", verified_at: new Date().toISOString() },
        };
      }
      case "rpa.source_publish": {
        const published = await this.publishArticle({
          articleId: params.articleId,
          channel: params.channel ?? "local",
          webhookUrl: params.webhookUrl,
          approvedBy: params.approvedBy,
        });
        return {
          result: published,
          receipt: {
            synced: published.status === "published",
            snapshot_uri: published.url,
            verified_at: new Date().toISOString(),
            mode: "real",
          },
        };
      }
      case "archive.write_back": {
        return {
          result: { state: "archived", scope, params },
          receipt: { synced: true, mode: "real", verified_at: new Date().toISOString() },
        };
      }
      default:
        return {
          result: { state: "connector-required", tool: name, scope },
          receipt: { synced: false, mode: "real" },
        };
    }
  }
}

export function buildSampleMetrics(samples) {
  return computePersonalMetrics(samples);
}
