import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sha256 } from "./core.mjs";
import {
  PERSONAL_GEO_CASE,
  buildPersonalQueries,
} from "../personal-case.mjs";

const PERSONAL_QUERY_V1 = JSON.parse(readFileSync(
  new URL("../personal-case-v1-queries.json", import.meta.url), "utf8",
));

const QUERY_FIELDS = [
  "text", "category", "category_label", "priority", "risk", "product", "status", "source",
];

function queryFields(query) {
  return {
    text: query.text,
    category: query.category,
    category_label: query.categoryLabel,
    priority: query.priority,
    risk: query.risk ? 1 : 0,
    product: query.product ?? null,
    status: query.status,
    source: query.source,
  };
}

function now() {
  return new Date().toISOString();
}

function asJson(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function defaultDatabasePath(root = process.cwd()) {
  return resolve(root, "var/geo-evidence-studio/geo-evidence.sqlite");
}

export class GeoStore {
  constructor(
    databasePath = defaultDatabasePath(),
    {
      caseConfig = PERSONAL_GEO_CASE,
      queries = buildPersonalQueries(caseConfig),
      queryBaseline = PERSONAL_QUERY_V1,
    } = {},
  ) {
    this.path = resolve(databasePath);
    this.caseConfig = caseConfig;
    this.querySeed = queries;
    this.queryBaseline = queryBaseline;
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS queries (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        case_version TEXT NOT NULL,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        category_label TEXT NOT NULL,
        priority TEXT NOT NULL,
        risk INTEGER NOT NULL,
        product TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        platform TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL,
        requested_limit INTEGER NOT NULL,
        planned_samples INTEGER NOT NULL DEFAULT 0,
        successful_samples INTEGER NOT NULL DEFAULT 0,
        failed_samples INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        notes_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS samples (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        query_id TEXT NOT NULL REFERENCES queries(id),
        platform TEXT NOT NULL,
        model TEXT,
        provider TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        prompt TEXT NOT NULL,
        answer TEXT NOT NULL DEFAULT '',
        citations_json TEXT NOT NULL DEFAULT '[]',
        analysis_json TEXT NOT NULL DEFAULT '{}',
        raw_json TEXT,
        evidence_hash TEXT,
        screenshot_uri TEXT,
        status TEXT NOT NULL,
        error TEXT,
        captured_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_samples_run ON samples(run_id);
      CREATE INDEX IF NOT EXISTS idx_samples_query ON samples(query_id);
      CREATE INDEX IF NOT EXISTS idx_samples_platform ON samples(platform);

      CREATE TABLE IF NOT EXISTS articles (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        title TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        markdown TEXT NOT NULL,
        query_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        data_mode TEXT NOT NULL,
        evidence_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS publications (
        id TEXT PRIMARY KEY,
        article_id TEXT NOT NULL REFERENCES articles(id),
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        url TEXT,
        receipt_json TEXT NOT NULL,
        published_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        sample_id TEXT NOT NULL REFERENCES samples(id),
        query_id TEXT NOT NULL REFERENCES queries(id),
        severity TEXT NOT NULL,
        kind TEXT NOT NULL,
        claim TEXT NOT NULL,
        source_urls_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    this.setMeta("schema_version", "1");
    this.seedCase();
  }

  setMeta(key, value) {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, String(value));
  }

  getMeta(key) {
    return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  }

  seedCase(caseConfig = this.caseConfig) {
    if (caseConfig.id === PERSONAL_GEO_CASE.id) {
      this.seedPersonalQueries(caseConfig);
      return;
    }
    const insert = this.db.prepare(`
      INSERT INTO queries (
        id, case_id, case_version, text, category, category_label, priority,
        risk, product, status, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text=excluded.text,
        category=excluded.category,
        category_label=excluded.category_label,
        priority=excluded.priority,
        risk=excluded.risk,
        product=excluded.product,
        status=excluded.status,
        source=excluded.source
    `);
    this.db.exec("BEGIN");
    try {
      for (const query of this.querySeed) {
        insert.run(
          query.id,
          caseConfig.id,
          caseConfig.version,
          query.text,
          query.category,
          query.categoryLabel,
          query.priority,
          query.risk ? 1 : 0,
          query.product,
          query.status,
          query.source,
          now(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  seedPersonalQueries(caseConfig = this.caseConfig) {
    const baselineKey = `query_seed_baseline:${caseConfig.id}`;
    const previousSeeds = parseJson(this.getMeta(baselineKey), null);
    const previousById = new Map(
      (Array.isArray(previousSeeds) ? previousSeeds : this.queryBaseline)
        .map((query) => [query.id, queryFields(query)]),
    );
    const select = this.db.prepare("SELECT * FROM queries WHERE id=?");
    const insert = this.db.prepare(`
      INSERT INTO queries (
        id, case_id, case_version, text, category, category_label, priority,
        risk, product, status, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const update = this.db.prepare(`
      UPDATE queries SET
        case_version=?, text=?, category=?, category_label=?, priority=?,
        risk=?, product=?, status=?, source=?
      WHERE id=? AND case_id=?
    `);
    this.db.exec("BEGIN");
    try {
      for (const query of this.querySeed) {
        const incoming = queryFields(query);
        const existing = select.get(query.id);
        if (!existing) {
          insert.run(
            query.id, caseConfig.id, caseConfig.version,
            ...QUERY_FIELDS.map((field) => incoming[field]), now(),
          );
          continue;
        }
        // Startup may refresh shipped defaults, but must preserve user edits.
        // An unknown ID or a row owned by another case is never a migration target.
        const previous = previousById.get(query.id);
        if (!previous || existing.case_id !== caseConfig.id) continue;
        const merged = Object.fromEntries(QUERY_FIELDS.map((field) => [
          field,
          existing[field] === previous[field] ? incoming[field] : existing[field],
        ]));
        update.run(
          caseConfig.version, ...QUERY_FIELDS.map((field) => merged[field]),
          query.id, caseConfig.id,
        );
      }
      this.setMeta(baselineKey, asJson(this.querySeed));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertQueries(queries, caseConfig = this.caseConfig) {
    const insert = this.db.prepare(`
      INSERT INTO queries (
        id, case_id, case_version, text, category, category_label, priority,
        risk, product, status, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        case_version=excluded.case_version,
        text=excluded.text,
        category=excluded.category,
        category_label=excluded.category_label,
        priority=excluded.priority,
        risk=excluded.risk,
        product=excluded.product,
        status=excluded.status,
        source=excluded.source
    `);
    this.db.exec("BEGIN");
    try {
      for (const query of queries) {
        insert.run(
          query.id,
          caseConfig.id,
          caseConfig.version,
          query.text,
          query.category,
          query.categoryLabel,
          query.priority,
          query.risk ? 1 : 0,
          query.product ?? null,
          query.status,
          query.source,
          now(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listQueries({ category, risk, limit = 1000 } = {}) {
    const where = [];
    const params = [];
    if (category) {
      where.push("q.category=?");
      params.push(category);
    }
    if (risk !== undefined) {
      where.push("q.risk=?");
      params.push(risk ? 1 : 0);
    }
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT q.*,
        (SELECT count(*) FROM samples s WHERE s.query_id=q.id AND s.status='success') AS sample_count,
        (SELECT captured_at FROM samples s WHERE s.query_id=q.id ORDER BY captured_at DESC LIMIT 1) AS last_captured_at
      FROM queries q
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END,
        category, id
      LIMIT ?
    `).all(...params);
    return rows.map((row) => ({ ...row, risk: Boolean(row.risk) }));
  }

  createRun({ provider, dataMode, platform, model, requestedLimit, plannedSamples, notes = [] }) {
    const id = `run-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO runs (
        id, case_id, provider, data_mode, platform, model, status,
        requested_limit, planned_samples, started_at, notes_json
      ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
    `).run(
      id,
      this.caseConfig.id,
      provider,
      dataMode,
      platform,
      model ?? null,
      requestedLimit,
      plannedSamples,
      now(),
      asJson(notes),
    );
    return id;
  }

  finishRun(id, { status, successful, failed, notes = [] }) {
    this.db.prepare(`
      UPDATE runs SET
        status=?,
        successful_samples=?,
        failed_samples=?,
        finished_at=?,
        notes_json=?
      WHERE id=?
    `).run(status, successful, failed, now(), asJson(notes), id);
  }

  insertSample({
    runId,
    query,
    platform,
    model,
    provider,
    dataMode,
    prompt,
    answer,
    citations,
    analysis,
    raw,
    screenshotUri,
    status,
    error,
  }) {
    const id = `sample-${randomUUID()}`;
    const capturedAt = now();
    this.db.prepare(`
      INSERT INTO samples (
        id, run_id, query_id, platform, model, provider, data_mode, prompt,
        answer, citations_json, analysis_json, raw_json, evidence_hash,
        screenshot_uri, status, error, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      runId,
      query.id,
      platform,
      model ?? null,
      provider,
      dataMode,
      prompt,
      answer ?? "",
      asJson(citations ?? []),
      asJson(analysis ?? {}),
      raw === undefined ? null : asJson(raw),
      analysis?.evidenceHash ?? (answer ? sha256(`${query.id}\n${answer}`) : null),
      screenshotUri ?? null,
      status,
      error ?? null,
      capturedAt,
    );

    if (status === "success" && analysis?.brandNegative) {
      const claim = analysis.negativeBrandSentences?.[0]?.text
        ?? "品牌负向提及";
      this.db.prepare(`
        INSERT INTO incidents (
          id, sample_id, query_id, severity, kind, claim, source_urls_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `).run(
        `incident-${randomUUID()}`,
        id,
        query.id,
        query.priority === "P0" ? "P0" : "P1",
        analysis.negativeCitation ? "brand_negative_citation" : "brand_negative_mention",
        claim.slice(0, 500),
        asJson((analysis.riskyCitations ?? []).map((citation) => citation.url)),
        capturedAt,
      );
    }
    return id;
  }

  updateSampleAnalysis(sampleId, { analysis, citations }) {
    const row = this.db.prepare(`
      SELECT s.id, s.query_id, q.priority
      FROM samples s JOIN queries q ON q.id=s.query_id
      WHERE s.id=?
    `).get(sampleId);
    if (!row) throw new Error(`样本不存在：${sampleId}`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        UPDATE samples SET analysis_json=?, citations_json=?, evidence_hash=?
        WHERE id=?
      `).run(asJson(analysis), asJson(citations ?? []), analysis.evidenceHash ?? null, sampleId);
      this.db.prepare("DELETE FROM incidents WHERE sample_id=?").run(sampleId);
      if (analysis.brandNegative) {
        const claim = analysis.negativeBrandSentences?.[0]?.text ?? "品牌负向提及";
        this.db.prepare(`
          INSERT INTO incidents (
            id, sample_id, query_id, severity, kind, claim, source_urls_json, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
        `).run(
          `incident-${randomUUID()}`,
          sampleId,
          row.query_id,
          row.priority === "P0" ? "P0" : "P1",
          analysis.negativeCitation ? "brand_negative_citation" : "brand_negative_mention",
          claim.slice(0, 500),
          asJson((analysis.riskyCitations ?? []).map((citation) => citation.url)),
          now(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRuns(limit = 20) {
    return this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, notes: parseJson(row.notes_json, []) }));
  }

  listSamples({ runId, queryId, platform, negative, limit = 500 } = {}) {
    const where = [];
    const params = [];
    if (runId) {
      where.push("s.run_id=?");
      params.push(runId);
    }
    if (queryId) {
      where.push("s.query_id=?");
      params.push(queryId);
    }
    if (platform) {
      where.push("s.platform=?");
      params.push(platform);
    }
    if (negative) {
      where.push("json_extract(s.analysis_json, '$.brandNegative')=1");
    }
    params.push(limit);
    return this.db.prepare(`
      SELECT s.*, COALESCE(json_extract(s.analysis_json, '$.query'), q.text) AS query_text,
        q.category, q.priority
      FROM samples s JOIN queries q ON q.id=s.query_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY s.captured_at DESC LIMIT ?
    `).all(...params).map((row) => ({
      ...row,
      dataMode: row.data_mode,
      evidenceHash: row.evidence_hash,
      screenshotUri: row.screenshot_uri,
      citations: parseJson(row.citations_json, []),
      analysis: parseJson(row.analysis_json, {}),
      raw: parseJson(row.raw_json, null),
    }));
  }

  listIncidents({ status = "open", limit = 200 } = {}) {
    return this.db.prepare(`
      SELECT i.*, COALESCE(json_extract(s.analysis_json, '$.query'), q.text) AS query_text,
        s.platform, s.answer
      FROM incidents i
      JOIN queries q ON q.id=i.query_id
      JOIN samples s ON s.id=i.sample_id
      ${status ? "WHERE i.status=?" : ""}
      ORDER BY i.created_at DESC LIMIT ?
    `).all(...(status ? [status, limit] : [limit])).map((row) => ({
      ...row,
      sourceUrls: parseJson(row.source_urls_json, []),
    }));
  }

  createArticle({ topicId, title, slug, markdown, queryIds, dataMode, status = "draft" }) {
    const id = `article-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO articles (
        id, topic_id, title, slug, markdown, query_ids_json, status,
        data_mode, evidence_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      topicId,
      title,
      slug,
      markdown,
      asJson(queryIds),
      status,
      dataMode,
      sha256(markdown),
      now(),
    );
    return id;
  }

  listArticles(limit = 100) {
    return this.db.prepare("SELECT * FROM articles ORDER BY created_at DESC LIMIT ?").all(limit)
      .map((row) => ({ ...row, queryIds: parseJson(row.query_ids_json, []) }));
  }

  getArticle(id) {
    const row = this.db.prepare("SELECT * FROM articles WHERE id=?").get(id);
    return row ? { ...row, queryIds: parseJson(row.query_ids_json, []) } : null;
  }

  createPublication({ articleId, channel, status = "queued", receipt = {} }) {
    const id = `publication-${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO publications (
        id, article_id, channel, status, receipt_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, articleId, channel, status, asJson(receipt), now());
    return id;
  }

  completePublication(id, { url, receipt, error = null }) {
    this.db.prepare(`
      UPDATE publications SET
        status=?,
        url=?,
        receipt_json=?,
        published_at=?,
        error=?
      WHERE id=?
    `).run(error ? "failed" : "published", url ?? null, asJson(receipt), error ? null : now(), error, id);
  }

  listPublications(limit = 100) {
    return this.db.prepare(`
      SELECT p.*, a.title AS article_title, a.slug
      FROM publications p JOIN articles a ON a.id=p.article_id
      ORDER BY p.created_at DESC LIMIT ?
    `).all(limit).map((row) => ({ ...row, receipt: parseJson(row.receipt_json, {}) }));
  }

  close() {
    this.db.close();
  }
}
