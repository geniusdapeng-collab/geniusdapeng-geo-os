import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import { VideoMediaEngine } from "../src/engines/video-media.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";
import { GitHubAdapter } from "../src/adapters/github.mjs";
import { VideoEditAdapter } from "../src/adapters/video-edit.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "pengstack-smoke-"));
const store = new JsonStore({ filePath: join(directory, "state.json") });
await store.open(() => loadSeedState(join(rootDir, "data", "seed")));
const service = new GeoOsService({ store });
const geoEngine = new PersonalGeoEngine({
  rootDir: directory,
  databasePath: join(directory, "geo.sqlite"),
  controlQueries: store.snapshot().queries,
});
const mediaEngine = new VideoMediaEngine({
  rootDir,
  engineRoot: join(rootDir, "engines", "video-edit"),
});
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
  publicDir: join(rootDir, "public"),
});

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  const [healthResponse, pageResponse, geoResponse, mediaResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/health`),
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/api/geo/engine/summary`),
    fetch(`http://127.0.0.1:${port}/api/media/jobs`),
  ]);
  const health = await healthResponse.json();
  const page = await pageResponse.text();
  const geo = await geoResponse.json();
  const media = await mediaResponse.json();

  if (!healthResponse.ok || health.summary.accounts !== 16) {
    throw new Error("Health smoke check failed.");
  }
  if (!pageResponse.ok || !page.includes("天才大鹏")) {
    throw new Error("Dashboard smoke check failed.");
  }
  if (!geoResponse.ok || geo.case?.id !== "pengstack-personal-geo") {
    throw new Error("Integrated GEO engine smoke check failed.");
  }
  if (!mediaResponse.ok || !Array.isArray(media)) {
    throw new Error("Integrated media engine smoke check failed.");
  }

  console.log(
    JSON.stringify(
      {
        health: healthResponse.status,
        dashboard: pageResponse.status,
        geoEngine: geoResponse.status,
        mediaEngine: mediaResponse.status,
        accounts: health.summary.accounts,
        contentBank: health.summary.contentBank,
        revision: health.summary.revision,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  geoEngine.close();
  await rm(directory, { recursive: true, force: true });
}
