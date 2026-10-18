import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { createGeoOsServer } from "../src/http/server.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const directory = await mkdtemp(join(tmpdir(), "pengstack-smoke-"));
const store = new JsonStore({ filePath: join(directory, "state.json") });
await store.open(() => loadSeedState(join(rootDir, "data", "seed")));
const service = new GeoOsService({ store });
const server = createGeoOsServer({
  service,
  publicDir: join(rootDir, "public"),
});

try {
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { port } = server.address();
  const [healthResponse, pageResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/api/health`),
    fetch(`http://127.0.0.1:${port}/`),
  ]);
  const health = await healthResponse.json();
  const page = await pageResponse.text();

  if (!healthResponse.ok || health.summary.accounts !== 16) {
    throw new Error("Health smoke check failed.");
  }
  if (!pageResponse.ok || !page.includes("天才大鹏")) {
    throw new Error("Dashboard smoke check failed.");
  }

  console.log(
    JSON.stringify(
      {
        health: healthResponse.status,
        dashboard: pageResponse.status,
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
  await rm(directory, { recursive: true, force: true });
}
