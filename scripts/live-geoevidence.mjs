import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveDeepSeekApiKey } from "../src/adapters/auth.mjs";
import { GeoEvidenceAdapter } from "../src/adapters/geoevidence.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const upstreamRoot = resolve(
  process.env.GEO_EVIDENCE_ROOT ||
    join(rootDir, "..", "upstreams", "geo-evidence-studio"),
);
const serverScript = join(upstreamRoot, "apps", "geo-evidence-studio", "server.mjs");
const port = Number(process.env.GEO_EVIDENCE_LIVE_PORT || 44317);
const dbPath = join(rootDir, "var", "live-geoevidence", "geo-evidence.sqlite");
const evidenceRoot = join(rootDir, "var", "live-geoevidence", "root");
const receiptDir = join(rootDir, "docs", "evidence");
await Promise.all([
  mkdir(join(rootDir, "var", "live-geoevidence"), { recursive: true }),
  mkdir(evidenceRoot, { recursive: true }),
  mkdir(receiptDir, { recursive: true }),
]);

const apiKey = resolveDeepSeekApiKey();
const child = spawn(process.execPath, [serverScript], {
  cwd: upstreamRoot,
  env: {
    ...process.env,
    PORT: String(port),
    GEO_STUDIO_HOST: "127.0.0.1",
    GEO_STUDIO_DB: dbPath,
    GEO_STUDIO_ROOT: evidenceRoot,
    DEEPSEEK_API_KEY: apiKey,
    DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || "http://127.0.0.1:8788",
    DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL || "deepseek-flash",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk).slice(0, 4_000);
});

const baseUrl = `http://127.0.0.1:${port}`;
const adapter = new GeoEvidenceAdapter({ baseUrl });

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const health = await adapter.health();
    if (health.ok) {
      ready = true;
      break;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (!ready) {
    throw new Error(`GeoEvidence 服务未就绪：${stderr.slice(-1_000)}`);
  }

  const queries = await adapter.listQueries();
  const queryId =
    process.env.GEO_EVIDENCE_QUERY_ID ||
    queries.find((query) => query.id === "ffd-brand-001")?.id ||
    queries[0]?.id;
  if (!queryId) {
    throw new Error("GeoEvidence 没有可用查询。");
  }

  const run = await adapter.runVisibility({
    provider: "deepseek-search",
    limit: 1,
    queryId,
    platform: "deepseek",
  });
  const commit = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: upstreamRoot })
  ).stdout.trim();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const receipt = {
    schemaVersion: "pengstack.live-receipt/v1",
    kind: "geoevidence-production-adapter",
    completedAt: new Date().toISOString(),
    upstream: {
      repository: "geniusdapeng-collab/geo-evidence-studio",
      commit,
    },
    queryId,
    provider: "deepseek-search",
    run,
  };
  await writeFile(
    join(receiptDir, `geoevidence-live-${date}.json`),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolveWait) => setTimeout(resolveWait, 3_000)),
  ]);
  if (!child.killed) {
    child.kill("SIGKILL");
  }
}
