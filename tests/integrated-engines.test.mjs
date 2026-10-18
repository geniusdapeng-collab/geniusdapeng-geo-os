import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import { VideoMediaEngine } from "../src/engines/video-media.mjs";

const rootDir = resolve(import.meta.dirname, "..");

test("integrated personal GEO engine seeds queries and produces a 100-sample fixture run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pengstack-integrated-geo-"));
  const controlQueries = JSON.parse(
    await readFile(join(rootDir, "data", "seed", "queries.json"), "utf8"),
  );
  const engine = new PersonalGeoEngine({
    rootDir: directory,
    databasePath: join(directory, "geo.sqlite"),
    controlQueries,
  });
  try {
    assert.ok(engine.listQueries({ limit: 2000 }).length >= 100);
    const run = await engine.runVisibility({
      provider: "fixture",
      limit: 100,
    });
    assert.equal(run.planned, 100);
    assert.equal(run.successful, 100);
    assert.equal(run.failed, 0);
    assert.ok(run.metrics.brandNegativeSamples > 0);
    const articles = engine.generateArticles();
    assert.equal(articles.created.length, 10);
  } finally {
    engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("integrated video media engine reports bundled capabilities", async () => {
  const engine = new VideoMediaEngine({ rootDir });
  const health = await engine.health();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "in-process-video-edit-engine");
  assert.ok(health.capabilities.includes("post-production"));
  assert.ok(health.capabilities.includes("cover"));
});
