import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const stateFile = resolve(
  rootDir,
  process.env.LIVE_STATE_FILE || "var/live-deepseek-state.json",
);
const limit = Number(process.env.LIVE_QUERY_LIMIT || 12);
const store = new JsonStore({ filePath: stateFile });
await store.open(() => loadSeedState(dataDir));
const service = new GeoOsService({ store });
const unused = {
  async health() {
    return { configured: false };
  },
};
const live = new LivePipelineService({
  service,
  deepSeek: new DeepSeekAdapter(),
  github: unused,
  geoEvidence: unused,
  videoEdit: unused,
});

const result = await live.collectDeepSeek({ limit });
const timestamp = new Date().toISOString();
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const evidenceDir = join(rootDir, "var", "evidence");
const receiptDir = join(rootDir, "docs", "evidence");
await Promise.all([
  mkdir(evidenceDir, { recursive: true }),
  mkdir(receiptDir, { recursive: true }),
]);

await writeFile(
  join(evidenceDir, `deepseek-live-${date}-full.json`),
  `${JSON.stringify({ timestamp, stateFile, result }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o600 },
);

const sanitized = {
  schemaVersion: "pengstack.live-receipt/v1",
  kind: "deepseek-search-chat-baseline",
  completedAt: timestamp,
  model: "deepseek-flash",
  provider: "DeepSeek Search + Chat/Responses API",
  stateFile: relative(rootDir, stateFile),
  requested: result.requested,
  successful: result.successful,
  failed: result.failed,
  metrics: result.metrics,
  receiptHash: result.receiptHash,
  queries: result.results.map((item) => ({
    queryId: item.queryId,
    status: item.status,
    observationId: item.observationId ?? null,
    answerHash: item.answerHash ?? null,
    searchResponseHash: item.evidence?.searchResponseHash ?? null,
    completionResponseHash: item.evidence?.completionResponseHash ?? null,
    completionSurface: item.evidence?.completionSurface ?? null,
    citationCount: item.evidence?.citations?.length ?? 0,
    error: item.error ?? null,
  })),
};
await writeFile(
  join(receiptDir, `deepseek-live-${date}.json`),
  `${JSON.stringify(sanitized, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify(sanitized, null, 2));
if (result.failed > 0) {
  process.exitCode = 1;
}
