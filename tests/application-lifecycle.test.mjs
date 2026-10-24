import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPengManagerApplication } from "../src/application.mjs";

async function applicationFixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-application-"));
  const calls = { start: 0, stop: 0, geoClose: 0, errors: [] };
  const runtime = {
    async status() { return { state: "error", ready: false }; },
    async capabilities() { throw new Error("private-runtime-configuration"); },
    async start() { calls.start += 1; throw new Error("private-provider-message"); },
    async stop() { calls.stop += 1; },
    ...options.runtime,
  };
  const app = await createPengManagerApplication({
    rootDir: resolve(import.meta.dirname, ".."), env: { PORT: "4318", DATA_FILE: join(directory, "state.json") },
    videoRuntime: options.runtimeFactory ? undefined : runtime, runtimeFactory: options.runtimeFactory,
    geoEngine: { close() { calls.geoClose += 1; }, summary() { return { preserved: true }; } },
    mediaEngine: {}, livePipeline: {}, logger: { log() {}, error(message) { calls.errors.push(message); } },
  });
  t.after(async () => { try { await app.stop(); } finally { await rm(directory, { recursive: true, force: true }); } });
  return { app, calls };
}

test("one root lifecycle keeps original identity, JSON ledger and GEO available when video startup fails", async t => {
  const { app, calls } = await applicationFixture(t);
  const before = app.store.snapshot();
  const address = await app.listen({ port: 0 });
  await app.videoStart;
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.service, "pengmanager-system");
  const bootstrap = await (await fetch(`${base}/api/bootstrap`)).json();
  assert.equal(bootstrap.entity.nameEn, "PengManager");
  assert.deepEqual(app.store.snapshot(), before);
  assert.equal((await fetch(`${base}/api/geo/engine/summary`)).status, 200);
  assert.equal((await (await fetch(`${base}/api/video-runtime/status`)).json()).ready, false);
  assert.equal((await fetch(`${base}/api/video-runtime/capabilities`)).status, 503);
  assert.equal(calls.start, 1);
  assert.doesNotMatch(calls.errors.join(" "), /private-/);
  await Promise.all([app.stop(), app.stop()]);
  assert.equal(calls.stop, 1);
  assert.equal(calls.geoClose, 1);
  assert.equal(app.server.listening, false);
  await assert.rejects(app.listen({ port: 0 }), /APPLICATION_STOPPED/);
});

test("shutdown during pending runtime start cancels through the supervisor and waits before closing GEO", async t => {
  let release;
  const pending = new Promise(done => { release = done; });
  const sequence = [];
  const { app } = await applicationFixture(t, { runtime: {
    async start() { sequence.push("start"); await pending; sequence.push("start-settled"); },
    async stop() { sequence.push("stop"); release(); await pending; },
  } });
  await app.listen({ port: 0 });
  await Promise.resolve();
  await Promise.all([app.stop(), app.stop()]);
  assert.deepEqual(sequence, ["start", "stop", "start-settled"]);
  assert.equal(app.server.listening, false);
});

test("shutdown concurrent with HTTP listen does not create a late orphan listener or start video", async t => {
  const { app, calls } = await applicationFixture(t);
  const pendingListen = app.listen({ port: 0 });
  await app.stop();
  await pendingListen;
  assert.equal(app.server.listening, false);
  assert.equal(calls.start, 0);
  assert.equal(calls.stop, 1);
  assert.equal(calls.geoClose, 1);
});

test("runtime construction failure is a safe visible video error and leaves the original dashboard working", async t => {
  const { app, calls } = await applicationFixture(t, { runtimeFactory() { throw new Error("private-data-path"); } });
  const address = await app.listen({ port: 0 });
  await app.videoStart;
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await fetch(`${base}/api/bootstrap`)).status, 200);
  const current = await (await fetch(`${base}/api/video-runtime/status`)).json();
  assert.equal(current.state, "error");
  assert.equal(current.ready, false);
  assert.doesNotMatch(JSON.stringify(current) + calls.errors.join(" "), /private-/);
});
