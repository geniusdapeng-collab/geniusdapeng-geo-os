import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { GeoStore } from "../../engines/geo-evidence/lib/store.mjs";
import { GeoEvidenceService } from "../../engines/geo-evidence/lib/service.mjs";
import {
  PERSONAL_GEO_CASE,
  buildPersonalQueries,
} from "../../engines/geo-evidence/personal-case.mjs";
import { resolveDeepSeekApiKey } from "../adapters/auth.mjs";
import { hashObject } from "../domain/hash.mjs";

const LEGACY_CONTROL_QUERIES = JSON.parse(readFileSync(
  new URL("../../data/migrations/identity-v1.json", import.meta.url), "utf8",
)).queries;
const LEGACY_PERSONAL_QUERIES = JSON.parse(readFileSync(
  new URL("../../engines/geo-evidence/personal-case-v1-queries.json", import.meta.url), "utf8",
));

function mapControlQuery(query) {
  const category =
    query.intent === "recruiting"
      ? "recruiting"
      : query.intent === "entity"
        ? "brand"
        : query.intent === "project"
          ? "category"
          : "scene";
  return {
    id: query.id,
    text: query.text,
    category,
    categoryLabel:
      category === "brand"
        ? "个人实体"
        : category === "recruiting"
          ? "招聘意图"
          : category === "category"
            ? "能力与产品"
            : "方法与场景",
    priority: query.priority,
    risk: false,
    product: null,
    status: "approved",
    source: query.source ?? "control-plane-query-set/v1",
  };
}

export class PersonalGeoEngine {
  constructor({
    rootDir,
    databasePath = join(rootDir, "var", "geo-engine", "personal-geo.sqlite"),
    controlQueries = [],
    env = process.env,
  }) {
    this.rootDir = resolve(rootDir);
    this.controlQueryIds = new Set(controlQueries.map((query) => query.id));
    this.store = new GeoStore(databasePath, {
      caseConfig: PERSONAL_GEO_CASE,
      queries: [
        ...buildPersonalQueries(PERSONAL_GEO_CASE),
        ...controlQueries.map(mapControlQuery),
      ],
      queryBaseline: [
        ...LEGACY_PERSONAL_QUERIES,
        ...LEGACY_CONTROL_QUERIES.map(mapControlQuery),
      ],
    });
    this.service = new GeoEvidenceService(this.store, {
      rootDir: join(this.rootDir, "var", "geo-engine"),
      env,
      caseConfig: PERSONAL_GEO_CASE,
    });
  }

  health() {
    return {
      ok: true,
      configured: true,
      mode: "in-process-personal-geo-engine",
      caseId: PERSONAL_GEO_CASE.id,
      database: this.store.path,
      queries: this.store.listQueries({ limit: 2000 }).length,
      summary: this.summary().metrics,
    };
  }

  summary({ runId } = {}) {
    const summary = this.service.summary({
      runId,
      dataModes: ["real", "imported"],
    });
    const queries = this.store.listQueries({ limit: 2000 });
    const samples = this.store.listSamples({ runId, limit: 5000 })
      .filter((sample) => ["real", "imported"].includes(sample.dataMode));
    const observedQueries = new Set(samples.map((sample) => sample.query_id));
    const coverageIds =
      this.controlQueryIds.size > 0
        ? this.controlQueryIds
        : new Set(queries.map((query) => query.id));
    const observedCoverage = [...coverageIds].filter((id) =>
      observedQueries.has(id),
    ).length;
    return {
      ...summary,
      totalQueries: coverageIds.size,
      observedQueries: observedCoverage,
      queryCoverage:
        coverageIds.size === 0
          ? null
          : Number((observedCoverage / coverageIds.size).toFixed(4)),
    };
  }

  listQueries(options) {
    return this.store.listQueries(options);
  }

  upsertControlQueries(queries) {
    this.store.upsertQueries(queries.map(mapControlQuery), PERSONAL_GEO_CASE);
    return queries;
  }

  listSamples(options) {
    return this.store.listSamples(options);
  }

  listIncidents(options) {
    return this.store.listIncidents(options);
  }

  async runVisibility({
    provider = "deepseek-search",
    limit = 12,
    queryIds,
    platform = "deepseek",
  } = {}) {
    if (provider.startsWith("deepseek")) {
      this.service.env = {
        ...this.service.env,
        DEEPSEEK_API_KEY: resolveDeepSeekApiKey(),
        DEEPSEEK_BASE_URL:
          process.env.DEEPSEEK_BASE_URL || "http://127.0.0.1:8788",
        DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      };
    }
    const run = await this.service.runObservations({
      provider,
      limit,
      queryIds,
      platform,
      concurrency: 2,
    });
    const samples = this.store.listSamples({
      runId: run.runId,
      limit: 1000,
    });
    return {
      ...run,
      samples,
      receipt: {
        synced: run.successful > 0,
        mode: run.dataMode === "fixture" ? "simulated" : "real",
        verifiedAt: new Date().toISOString(),
        snapshotUri: `geo-personal://run/${run.runId}`,
      },
      responseHash: hashObject({
        runId: run.runId,
        status: run.status,
        successful: run.successful,
        failed: run.failed,
        metrics: run.metrics,
      }),
    };
  }

  generateArticles(options) {
    return this.service.generateArticles(options);
  }

  listArticles(limit = 100) {
    return this.store.listArticles(limit);
  }

  listRuns(limit = 20) {
    return this.store.listRuns(limit);
  }

  close() {
    this.store.close();
  }
}
