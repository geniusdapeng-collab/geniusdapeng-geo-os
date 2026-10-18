import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { GeoStore, defaultDatabasePath } from "./lib/store.mjs";
import { GeoEvidenceService } from "./lib/service.mjs";
import { createGeoStudioServer } from "./server.mjs";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }
    const [rawKey, inline] = item.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) {
      result[key] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.log(`GeoEvidence Studio

Usage:
  node apps/geo-evidence-studio/cli.mjs init [--db PATH]
  node apps/geo-evidence-studio/cli.mjs run [--provider fixture|deepseek|deepseek-search|manual-import]
      [--limit 20] [--category brand] [--query-id ID]... [--file answers.jsonl]
      [--concurrency 2] [--db PATH]
  node apps/geo-evidence-studio/cli.mjs articles [--topic selection-guide] [--force]
  node apps/geo-evidence-studio/cli.mjs publish --article-id ID [--channel local|webhook]
      [--webhook-url URL] --approved-by NAME
  node apps/geo-evidence-studio/cli.mjs report [--run-id ID] [--out DIR]
  node apps/geo-evidence-studio/cli.mjs reanalyze --run-id ID
  node apps/geo-evidence-studio/cli.mjs export-queries [--out FILE]
  node apps/geo-evidence-studio/cli.mjs serve [--port 4317] [--host 127.0.0.1]

Notes:
  - Real DeepSeek calls require DEEPSEEK_API_KEY in the environment.
  - Fixture results are explicitly labelled and never count as production evidence.
`);
}

function queryIds(args) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--query-id" && process.argv[index + 1]) values.push(process.argv[index + 1]);
    if (process.argv[index].startsWith("--query-id=")) values.push(process.argv[index].split("=").slice(1).join("="));
  }
  return values.length ? values : undefined;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const rootDir = resolve(args.root ?? process.cwd());
const dbPath = resolve(args.db ?? defaultDatabasePath(rootDir));

if (command === "help" || args.help) {
  usage();
  process.exit(0);
}

if (command === "serve") {
  const app = createGeoStudioServer({ rootDir, dbPath });
  const host = args.host ?? "127.0.0.1";
  const port = number(args.port, 4317);
  const address = await app.listen({ host, port });
  console.log(`GeoEvidence Studio: http://${host}:${address.port}`);
  console.log(`SQLite: ${app.dbPath}`);
} else {
  const store = new GeoStore(dbPath);
  const service = new GeoEvidenceService(store, { rootDir });
  try {
    if (command === "init") {
      print({
        database: store.path,
        queryCount: store.listQueries({ limit: 1000 }).length,
        case: "future-frontdesk",
      });
    } else if (command === "run") {
      const result = await service.runObservations({
        provider: args.provider ?? "fixture",
        limit: number(args.limit, 20),
        category: args.category,
        queryIds: queryIds(args),
        file: args.file,
        concurrency: number(args.concurrency, 2),
        platform: args.platform,
        model: args.model,
        baseUrl: args.baseUrl,
      });
      print(result);
    } else if (command === "articles") {
      print(service.generateArticles({
        topicIds: args.topic ? [args.topic] : undefined,
        force: Boolean(args.force),
        dataMode: args.dataMode ?? "draft",
      }));
    } else if (command === "publish") {
      if (!args.articleId) throw new Error("publish 需要 --article-id");
      print(await service.publishArticle({
        articleId: args.articleId,
        channel: args.channel ?? "local",
        webhookUrl: args.webhookUrl,
        approvedBy: args.approvedBy,
      }));
    } else if (command === "report") {
      print(await service.writeReport({ runId: args.runId, outDir: args.out }));
    } else if (command === "reanalyze") {
      if (!args.runId) throw new Error("reanalyze 需要 --run-id");
      print(service.reanalyzeRun(args.runId));
    } else if (command === "export-queries") {
      const output = resolve(args.out ?? `${rootDir}/outputs/geo-evidence-studio/future-frontdesk-queries.csv`);
      await mkdir(resolve(output, ".."), { recursive: true });
      const queries = store.listQueries({ limit: 1000 });
      const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
      const csv = [
        ["id", "category", "priority", "risk", "product", "status", "query"],
        ...queries.map((query) => [
          query.id,
          query.category,
          query.priority,
          query.risk,
          query.product ?? "",
          query.status,
          query.text,
        ]),
      ].map((row) => row.map(quote).join(",")).join("\n");
      await writeFile(output, `${csv}\n`, "utf8");
      print({ output, queries: queries.length });
    } else if (command === "summary") {
      print(service.summary({ runId: args.runId }));
    } else {
      usage();
      process.exitCode = 2;
    }
  } finally {
    store.close();
  }
}
