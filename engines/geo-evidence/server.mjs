import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GeoStore, defaultDatabasePath } from "./lib/store.mjs";
import { GeoEvidenceService } from "./lib/service.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "../..");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("请求体超过 2MB");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(request, token) {
  if (!token) return true;
  return request.headers.authorization === `Bearer ${token}`;
}

function serveStatic(request, response, publicDir, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = normalize(join(publicDir, relative));
  if (!target.startsWith(publicDir) || !existsSync(target) || !statSync(target).isFile()) {
    return false;
  }
  response.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": extname(target) === ".html" ? "no-store" : "public, max-age=300",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  createReadStream(target).pipe(response);
  return true;
}

export function createGeoStudioServer(options = {}) {
  const rootDir = resolve(options.rootDir ?? process.env.GEO_STUDIO_ROOT ?? defaultRoot);
  const dbPath = resolve(options.dbPath ?? process.env.GEO_STUDIO_DB ?? defaultDatabasePath(rootDir));
  const token = options.token ?? process.env.GEO_STUDIO_TOKEN ?? "";
  const publicDir = join(here, "public");
  const store = new GeoStore(dbPath);
  const service = new GeoEvidenceService(store, { rootDir });

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    try {
      if (url.pathname.startsWith("/api/") && !authorized(request, token)) {
        return sendJson(response, 401, { error: "unauthorized" });
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        return sendJson(response, 200, service.health());
      }
      if (request.method === "GET" && url.pathname === "/api/summary") {
        return sendJson(response, 200, service.summary({ runId: url.searchParams.get("runId") ?? undefined }));
      }
      if (request.method === "GET" && url.pathname === "/api/queries") {
        return sendJson(response, 200, {
          queries: store.listQueries({
            category: url.searchParams.get("category") ?? undefined,
            risk: url.searchParams.has("risk") ? url.searchParams.get("risk") === "true" : undefined,
            limit: Number(url.searchParams.get("limit") ?? 1000),
          }),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/samples") {
        return sendJson(response, 200, {
          samples: store.listSamples({
            runId: url.searchParams.get("runId") ?? undefined,
            queryId: url.searchParams.get("queryId") ?? undefined,
            platform: url.searchParams.get("platform") ?? undefined,
            negative: url.searchParams.get("negative") === "true",
            limit: Number(url.searchParams.get("limit") ?? 500),
          }),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/runs") {
        return sendJson(response, 200, { runs: store.listRuns(50) });
      }
      if (request.method === "GET" && url.pathname === "/api/incidents") {
        return sendJson(response, 200, {
          incidents: store.listIncidents({
            status: url.searchParams.get("status") ?? "open",
            limit: Number(url.searchParams.get("limit") ?? 200),
          }),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/articles") {
        return sendJson(response, 200, { articles: store.listArticles(1000) });
      }
      if (request.method === "GET" && url.pathname === "/api/publications") {
        return sendJson(response, 200, { publications: store.listPublications(1000) });
      }
      if (request.method === "POST" && url.pathname === "/api/run") {
        const body = await readJson(request);
        return sendJson(response, 200, await service.runObservations(body));
      }
      if (request.method === "POST" && url.pathname === "/api/articles/generate") {
        const body = await readJson(request);
        return sendJson(response, 200, service.generateArticles(body));
      }
      if (request.method === "POST" && url.pathname === "/api/publish") {
        const body = await readJson(request);
        return sendJson(response, 200, await service.publishArticle(body));
      }
      if (request.method === "POST" && url.pathname === "/api/report") {
        const body = await readJson(request);
        return sendJson(response, 200, await service.writeReport(body));
      }
      if (request.method === "POST" && url.pathname === "/api/tool") {
        const body = await readJson(request);
        return sendJson(response, 200, await service.handleTool(body.name, body.params, body.scope));
      }

      if (request.method === "GET" && serveStatic(request, response, publicDir, url.pathname)) return;
      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendJson(response, 400, { error: message });
    }
  });

  return {
    server,
    store,
    service,
    dbPath,
    async listen({ port = 4317, host = "127.0.0.1" } = {}) {
      await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolveListen);
      });
      return server.address();
    },
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
      store.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? process.env.GEO_STUDIO_PORT ?? 4317);
  const host = process.env.GEO_STUDIO_HOST ?? "127.0.0.1";
  const app = createGeoStudioServer();
  const address = await app.listen({ port, host });
  console.log(`GeoEvidence Studio: http://${host}:${address.port}`);
  console.log(`SQLite: ${app.dbPath}`);
}
