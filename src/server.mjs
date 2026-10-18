import { join, resolve } from "node:path";
import { JsonStore } from "./storage/json-store.mjs";
import { loadSeedState } from "./services/bootstrap.mjs";
import { GeoOsService } from "./services/geo-os-service.mjs";
import { LivePipelineService } from "./services/live-pipeline.mjs";
import { createGeoOsServer } from "./http/server.mjs";
import { DeepSeekAdapter } from "./adapters/deepseek.mjs";
import { GitHubAdapter } from "./adapters/github.mjs";
import { GeoEvidenceAdapter } from "./adapters/geoevidence.mjs";
import { VideoEditAdapter } from "./adapters/video-edit.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4318);
const dataFile = resolve(rootDir, process.env.DATA_FILE || "var/state.json");
const dataDir = join(rootDir, "data", "seed");
const publicDir = join(rootDir, "public");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535.");
}

const store = new JsonStore({ filePath: dataFile });
await store.open(() => loadSeedState(dataDir));

const service = new GeoOsService({ store });
const livePipeline = new LivePipelineService({
  service,
  deepSeek: new DeepSeekAdapter(),
  github: new GitHubAdapter(),
  geoEvidence: new GeoEvidenceAdapter(),
  videoEdit: new VideoEditAdapter(),
});
const server = createGeoOsServer({ service, livePipeline, publicDir });

server.listen(port, host, () => {
  console.log(`天才大鹏 control center: http://${host}:${port}`);
  console.log(`Local state: ${dataFile}`);
});

function shutdown(signal) {
  console.log(`received ${signal}; shutting down`);
  server.close((error) => {
    process.exitCode = error ? 1 : 0;
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

export { server, service, store };
