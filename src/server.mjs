import { join, resolve } from "node:path";
import { JsonStore } from "./storage/json-store.mjs";
import { loadSeedState, migratePengManagerIdentity } from "./services/bootstrap.mjs";
import { GeoOsService } from "./services/geo-os-service.mjs";
import { LivePipelineService } from "./services/live-pipeline.mjs";
import { createGeoOsServer } from "./http/server.mjs";
import { DeepSeekAdapter } from "./adapters/deepseek.mjs";
import { GitHubAdapter } from "./adapters/github.mjs";
import { VideoEditAdapter } from "./adapters/video-edit.mjs";
import { PersonalGeoEngine } from "./engines/geo-evidence.mjs";
import { VideoMediaEngine } from "./engines/video-media.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4318);
const dataFile = resolve(rootDir, process.env.DATA_FILE || "var/state.json");
const dataDir = join(rootDir, "data", "seed");
const publicDir = join(rootDir, "public");
const configuredHosts = process.env.ALLOWED_HOSTS
  ?.split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const allowedHosts = configuredHosts?.length
  ? configuredHosts
  : ["127.0.0.1", "localhost", "::1", "[::1]"];

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const store = new JsonStore({ filePath: dataFile });
await store.open(() => loadSeedState(dataDir));
await migratePengManagerIdentity(store, dataDir);

const service = new GeoOsService({ store });
const geoEngine = new PersonalGeoEngine({
  rootDir,
  ...(process.env.GEO_ENGINE_DB
    ? { databasePath: resolve(rootDir, process.env.GEO_ENGINE_DB) }
    : {}),
  controlQueries: store.snapshot().queries,
});
const mediaEngine = new VideoMediaEngine({ rootDir });
const livePipeline = new LivePipelineService({
  service,
  deepSeek: new DeepSeekAdapter(),
  github: new GitHubAdapter(),
  geoEngine,
  videoEdit: new VideoEditAdapter({
    upstreamRoot: join(rootDir, "engines", "video-edit"),
  }),
  mediaEngine,
});
const server = createGeoOsServer({
  service,
  livePipeline,
  geoEngine,
  publicDir,
  allowedHosts,
});

server.listen(port, host, () => {
  console.log(`鹏经理系统 · PengManager System: http://${host}:${port}`);
  console.log(`Local state: ${dataFile}`);
});

function shutdown(signal) {
  console.log(`received ${signal}; shutting down`);
  server.close((error) => {
    geoEngine.close();
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

export { server, service, store, geoEngine, mediaEngine };
