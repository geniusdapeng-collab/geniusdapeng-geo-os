import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const controlQueries = JSON.parse(
  await readFile(join(rootDir, "data", "seed", "queries.json"), "utf8"),
);
const engine = new PersonalGeoEngine({
  rootDir,
  ...(process.env.GEO_ENGINE_DB
    ? { databasePath: join(rootDir, process.env.GEO_ENGINE_DB) }
    : {}),
  controlQueries,
});

try {
  const run = await engine.runVisibility({
    provider: "deepseek-search",
    limit: controlQueries.length,
    queryIds: controlQueries.map((query) => query.id),
    platform: "deepseek",
  });
  const articles = engine.generateArticles({
    dataMode: "draft",
  });
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const evidenceDir = join(rootDir, "var", "geo-engine", "evidence");
  const receiptDir = join(rootDir, "docs", "evidence");
  await Promise.all([
    mkdir(evidenceDir, { recursive: true }),
    mkdir(receiptDir, { recursive: true }),
  ]);
  const fullPath = join(evidenceDir, `personal-geo-${run.runId}.json`);
  await writeFile(
    fullPath,
    `${JSON.stringify({ run, articles }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const receipt = {
    schemaVersion: "pengstack.live-receipt/v1",
    kind: "integrated-personal-geo-engine",
    completedAt: new Date().toISOString(),
    engine: {
      mode: "in-process-personal-geo-engine",
      upstreamCommit: "06b47a15fd114541bd3147dc5c07b944c36bc8da",
      caseId: "pengstack-personal-geo",
      database: relative(rootDir, engine.store.path),
    },
    run: {
      runId: run.runId,
      status: run.status,
      provider: run.provider,
      dataMode: run.dataMode,
      planned: run.planned,
      successful: run.successful,
      failed: run.failed,
      metrics: run.metrics,
      receipt: run.receipt,
      responseHash: run.responseHash,
      samples: run.samples.map((sample) => ({
        sampleId: sample.id,
        queryId: sample.query_id,
        status: sample.status,
        model: sample.model,
        evidenceHash: sample.evidenceHash,
        citationCount: sample.citations.length,
        error: sample.error ?? null,
      })),
    },
    articles: {
      created: articles.created.length,
      total: articles.totalArticles,
      ids: articles.created.map((article) => article.id),
    },
    fullEvidence: relative(rootDir, fullPath),
  };
  const receiptPath = join(receiptDir, `personal-geo-live-${date}.json`);
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(receipt, null, 2));
  if (run.failed > 0) process.exitCode = 1;
} finally {
  engine.close();
}
