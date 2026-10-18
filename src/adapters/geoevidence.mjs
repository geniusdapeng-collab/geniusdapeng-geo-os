import { hashObject } from "../domain/hash.mjs";

async function requestJson(fetchImpl, baseUrl, path, options = {}, token = "") {
  const response = await fetchImpl(new URL(path, `${baseUrl.replace(/\/+$/, "")}/`), {
    ...options,
    headers: {
      Accept: "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { rawText: text.slice(0, 1_000) };
  }
  if (!response.ok) {
    throw new Error(
      `GeoEvidence API ${response.status}: ${String(body.error ?? body.rawText ?? "request failed").slice(0, 500)}`,
    );
  }
  return body;
}

export class GeoEvidenceAdapter {
  constructor({
    baseUrl = process.env.GEO_EVIDENCE_BASE_URL,
    token = process.env.GEO_EVIDENCE_TOKEN,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  status() {
    return {
      configured: Boolean(this.baseUrl),
      baseUrl: this.baseUrl || null,
      mode: "official-geo-evidence-http-api",
    };
  }

  #baseUrl() {
    if (!this.baseUrl) {
      throw new Error("缺少 GEO_EVIDENCE_BASE_URL，GeoEvidence 适配器保持 fail-closed。");
    }
    return this.baseUrl;
  }

  async health() {
    if (!this.baseUrl) {
      return { ...this.status(), ok: false, error: "GEO_EVIDENCE_BASE_URL not configured" };
    }
    try {
      const body = await requestJson(
        this.fetchImpl,
        this.#baseUrl(),
        "/api/health",
        {},
        this.token,
      );
      return { ...this.status(), ok: Boolean(body.ok), health: body };
    } catch (error) {
      return { ...this.status(), ok: false, error: error.message };
    }
  }

  async listQueries() {
    const body = await requestJson(
      this.fetchImpl,
      this.#baseUrl(),
      "/api/queries?limit=1000",
      {},
      this.token,
    );
    return body.queries ?? [];
  }

  async runVisibility({
    provider = "deepseek-search",
    limit = 1,
    queryId,
    platform = "deepseek",
  } = {}) {
    const body = await requestJson(
      this.fetchImpl,
      this.#baseUrl(),
      "/api/tool",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "visibility.collect",
          params: {
            provider,
            limit,
            ...(queryId ? { queryId } : {}),
            platform,
          },
          scope: {
            tenantId: "personal-pengstack",
            workspaceId: "geo-evidence",
            requestedBy: "geniusdapeng-geo-os",
          },
        }),
      },
      this.token,
    );
    if (body?.receipt?.synced !== true || body?.result?.successful < 1) {
      throw new Error("GeoEvidence 未返回成功同步回执，拒绝标记完成。");
    }
    return {
      runId: body.result.runId,
      status: body.result.status,
      provider: body.result.provider,
      dataMode: body.result.dataMode,
      successful: body.result.successful,
      failed: body.result.failed,
      metrics: body.result.metrics,
      receipt: body.receipt,
      responseHash: hashObject(body),
    };
  }
}
