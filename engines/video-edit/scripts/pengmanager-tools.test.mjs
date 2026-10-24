import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { createToolRuntime, createRedactedLineSink } from "./pengmanager-tools.mjs";

// These explicit artificial services prove supervisor behavior only. They are not media/tool production evidence.
const ids = ["compositor", "color", "bgm", "subtitle", "post", "voice", "voiceEngine", "loommate"];
async function freePort() {
  const server = net.createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pengmanager-tools-fixture-")));
  const engineRoot = path.join(root, "engine"), dataRoot = path.join(root, "data"), markerRoot = path.join(root, "health-controls");
  await fs.mkdir(engineRoot); await fs.mkdir(markerRoot); const ports = {};
  for (const id of ids) { let port; do { port = await freePort(); } while (Object.values(ports).includes(port)); ports[id] = port; }
  await fs.writeFile(path.join(engineRoot, "pengmanager-toolchain.lock.json"), JSON.stringify({ models: [{ id: "fixture-tts" }, { id: "fixture-asr" }], ffmpeg: { pinFile: "missing-fixture-pin.json" } }));
  for (const id of ["color", "bgm", "subtitle", "post", "voice"]) {
    const directory = path.join(engineRoot, `bundles/ai-video/connectors/${id}-bridge`); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "server.mjs"), `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:!fs.existsSync(path.join(process.env.PENGMANAGER_FIXTURE_HEALTH,'${id}')),pid:process.pid}));});
server.listen(Number(process.env.WORKLOOM_${id.toUpperCase()}_BRIDGE_PORT),'127.0.0.1');
if(process.env.PENGMANAGER_FIXTURE_TEST_SECRET){const s=process.env.PENGMANAGER_FIXTURE_TEST_SECRET;process.stdout.write(s.slice(0,Math.floor(s.length/2)));setTimeout(()=>process.stdout.write(s.slice(Math.floor(s.length/2))+' 🙂\\n'),15);}
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  }
  const env = { PATH: process.env.PATH, PENGMANAGER_FIXTURE_HEALTH: markerRoot };
  const create = (options = {}) => createToolRuntime({ engineRoot, dataRoot, ports, env, workspaceId: "ws-fixture", ...options });
  async function markFfmpeg() {
    const bin = path.join(dataRoot, "tools/bin"); await fs.mkdir(bin, { recursive: true });
    for (const name of ["ffmpeg", "ffprobe"]) await fs.writeFile(path.join(bin, name), "explicit artificial fixture binary; never executed\n");
    await fs.writeFile(path.join(dataRoot, "tools/installation.json"), JSON.stringify({ steps: [{ id: "ffmpeg", ok: true }] }));
  }
  async function portIsFree(port) { try { const server = net.createServer(); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); }); await new Promise((resolve) => server.close(resolve)); return true; } catch { return false; } }
  return { root, engineRoot, dataRoot, markerRoot, ports, env, create, markFfmpeg, portIsFree, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("failed setup chain can recover; durable failed installation stays truthful", async () => {
  const f = await fixture(), runtime = f.create();
  try {
    await assert.rejects(runtime.setup({ tools: ["unknown"] }), /UNKNOWN_INSTALL_TARGET/);
    assert.deepEqual((await runtime.setup({ tools: [] })).steps, []);
    const failure = await runtime.setup({ tools: ["ffmpeg"] }); assert.equal(failure.steps[0].ok, false);
    assert.equal(failure.tools.find((row) => row.id === "ffmpeg").installed, false);
    const after = await f.create().status(); assert.equal(after.ready, false);
    assert.ok(after.tools.find((row) => row.id === "ffmpeg").missing.some((reason) => reason.includes("missing-fixture-pin")));
    assert.deepEqual((await runtime.setup({ tools: [] })).steps, []);
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("line sink masks cross-chunk secrets and preserves split UTF-8 before disk/logger emission", () => {
  const secret = "explicit-test-only-secret-123456", output = [], failures = [];
  const sink = createRedactedLineSink({ redact: (line) => line.replaceAll(secret, "[redacted]"), write: (line) => output.push(line), onError: (error) => failures.push(error) });
  const data = Buffer.from(`🙂 ${secret}\ntrailing ${secret}`);
  for (let index = 0; index < data.length; index++) sink.push(data.subarray(index, index + 1));
  assert.deepEqual(output, ["🙂 [redacted]\n"]); sink.end(); sink.end();
  assert.deepEqual(output, ["🙂 [redacted]\n", "trailing [redacted]\n"]); assert.deepEqual(failures, []);
});

test("line sink bounds an unfinished line and reports output failure without flushing raw fragments", () => {
  const writes = [], errors = [];
  const sink = createRedactedLineSink({ redact: (line) => line, write: (line) => writes.push(line), onError: (error) => errors.push(error.message), maxLineBytes: 8 });
  sink.push(Buffer.from("123456789")); sink.push(Buffer.from("tail\n")); sink.end();
  assert.deepEqual(writes, []); assert.deepEqual(errors, ["TOOL_LOG_LINE_TOO_LONG"]);
  const broken = createRedactedLineSink({ redact: () => "[redacted]\n", write: () => { throw new Error("explicit fixture disk failure"); }, onError: (error) => errors.push(error.message) });
  broken.push(Buffer.from("fixture\n")); broken.end(); assert.equal(errors.at(-1), "explicit fixture disk failure");
});

test("real child service output split across chunks is redacted in owned logs and logger", async () => {
  const f = await fixture(), secret = "explicit-only-fixture-secret-cross-chunk-782639", lines = [];
  f.env.PENGMANAGER_FIXTURE_TEST_SECRET = secret;
  const runtime = f.create({ logger: (line) => lines.push(line) });
  try {
    await f.markFfmpeg(); await runtime.start(); await runtime.stop();
    for (const id of ["color", "bgm", "subtitle", "post", "voice"]) {
      const log = await fs.readFile(path.join(f.dataRoot, "tools/logs", `${id}.log`), "utf8");
      assert.ok(log.includes("[redacted] 🙂")); assert.equal(log.includes(secret), false);
      assert.equal(log.includes(secret.slice(0, Math.floor(secret.length / 2))), false);
      assert.equal(log.includes(secret.slice(Math.floor(secret.length / 2))), false);
      assert.equal((await fs.stat(path.join(f.dataRoot, "tools/logs", `${id}.log`))).mode & 0o777, 0o600);
    }
    assert.equal(lines.join("\n").includes(secret), false); assert.equal(lines.filter((line) => line.includes("[redacted]")).length, 5);
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("real installer child output is redacted before command tail and logger capture", async () => {
  const f = await fixture(), secret = "explicit-fixture-only-install-secret-17629", lines = [];
  f.env.PENGMANAGER_FIXTURE_TEST_SECRET = secret;
  const source = path.join(f.root, "artificial-binary.mjs");
  const bytes = Buffer.from(`#!${process.execPath}\nconst s=process.env.PENGMANAGER_FIXTURE_TEST_SECRET;process.stdout.write(s.slice(0,11));setTimeout(()=>process.stdout.write(s.slice(11)+' 🙂\\n'),5);\n`);
  await fs.writeFile(source, bytes, { mode: 0o755 }); f.env.PENGMANAGER_FFMPEG_SOURCE = source; f.env.PENGMANAGER_FFPROBE_SOURCE = source;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(f.engineRoot, "missing-fixture-pin.json"), JSON.stringify({ targets: { [`${process.platform}-${process.arch}`]: { ffmpeg: { sha256 }, ffprobe: { sha256 } } } }));
  const runtime = f.create({ logger: (line) => lines.push(line) });
  try {
    const result = await runtime.setup({ tools: ["ffmpeg"] }); assert.equal(result.steps[0].ok, true);
    assert.equal(lines.length, 2); assert.equal(lines.join("\n").includes(secret), false); assert.ok(lines.every((line) => line === "[redacted] 🙂"));
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("logging failure terminates each owned child rather than starting an unlogged service", async () => {
  const f = await fixture(); f.env.PENGMANAGER_FIXTURE_TEST_SECRET = "explicit-fixture-secret-log-failure";
  const runtime = f.create({ logger: () => { throw new Error("explicit fixture logger failed"); } });
  try {
    await f.markFfmpeg(); const result = await runtime.start();
    assert.equal(result.running.length, 0); assert.equal(result.ready, false);
    assert.ok(result.tools.find((row) => row.id === "color").missing.some((reason) => reason.includes("logger failed")));
    for (const id of ids) assert.equal(await f.portIsFree(f.ports[id]), true);
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("commercial readiness requires authorized scope and a nonempty regular grant, independently of presence", async () => {
  const f = await fixture(), runtime = f.create();
  try {
    await runtime.setup({ tools: [] }); const talk = path.join(f.dataRoot, "tools/talkcraft");
    await fs.writeFile(path.join(talk, "LICENSE-GRANT.md"), "EXPLICIT ARTIFICIAL TEST FIXTURE. NOT AN AUTHORIZATION.\n");
    const noncommercial = await runtime.status();
    assert.equal(noncommercial.tools.find((row) => row.id === "talkcraft").license.commercialGrantPresent, true);
    assert.equal(noncommercial.commercialTalkcraftReady, false);
    await fs.rm(path.join(talk, "LICENSE-GRANT.md"));
    const authorizedMissing = await f.create({ env: { ...f.env, TALKCRAFT_LICENSE_SCOPE: "authorized" } }).status();
    assert.equal(authorizedMissing.commercialTalkcraftReady, false);
    assert.ok(authorizedMissing.tools.find((row) => row.id === "talkcraft").missing.includes("commercial authorization grant missing"));
    const invalidScope = await f.create({ env: { ...f.env, TALKCRAFT_LICENSE_SCOPE: "unknown" } }).status();
    assert.equal(invalidScope.commercialTalkcraftReady, false);
    assert.ok(invalidScope.tools.find((row) => row.id === "talkcraft").missing.includes("license scope invalid"));
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("stop/start reuse, health failure recovery and missing dependency guard use owned child processes", async () => {
  const f = await fixture(), runtime = f.create();
  try {
    await f.markFfmpeg(); const first = await runtime.start();
    assert.equal(first.running.length, 5); assert.equal(first.ready, false);
    assert.equal(first.tools.find((row) => row.id === "voice").ready, false, "healthy artificial bridge cannot establish model installation");
    const url = `http://127.0.0.1:${f.ports.color}/health`, firstPid = (await (await fetch(url)).json()).pid;
    await fs.writeFile(path.join(f.markerRoot, "color"), "unhealthy fixture");
    assert.equal((await runtime.status()).tools.find((row) => row.id === "color").ready, false);
    await fs.rm(path.join(f.markerRoot, "color"));
    const healthyAgain = await runtime.start(); assert.equal(healthyAgain.running.length, 5);
    assert.equal((await (await fetch(url)).json()).pid, firstPid, "healthy existing service is reused");
    // Leave a process alive while making its current health response fail; the next start must replace it.
    await fs.writeFile(path.join(f.markerRoot, "color"), "unhealthy fixture");
    const pending = runtime.start();
    const clearAfterOwnedExit = (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { process.kill(firstPid, 0); } catch (error) { if (error.code === "ESRCH") break; throw error; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await fs.rm(path.join(f.markerRoot, "color"), { force: true });
    })();
    await Promise.all([pending, clearAfterOwnedExit]); const recoveredPid = (await (await fetch(url)).json()).pid; assert.notEqual(recoveredPid, firstPid);
    await runtime.stop(); for (const id of ids) assert.equal(await f.portIsFree(f.ports[id]), true, `${id} port released`);
    assert.equal((await runtime.start()).running.length, 5); await runtime.stop(); await runtime.stop();
    assert.deepEqual((await runtime.status()).running, []);
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("foreign port owner survives failed start and supervisor stop", async () => {
  const f = await fixture(), runtime = f.create(), foreign = net.createServer();
  await new Promise((resolve) => foreign.listen(f.ports.post, "127.0.0.1", resolve));
  try {
    await f.markFfmpeg(); const result = await runtime.start();
    assert.ok(result.tools.find((row) => row.id === "post").missing.some((reason) => reason.includes("PORT_IN_USE")));
    await runtime.stop(); assert.equal(foreign.listening, true); assert.equal(await f.portIsFree(f.ports.post), false);
    for (const id of ids.filter((id) => id !== "post")) assert.equal(await f.portIsFree(f.ports[id]), true);
  } finally { await runtime.stop(); await new Promise((resolve) => foreign.close(resolve)); await f.cleanup(); }
});

test("abort while starting cancels owned children without late spawn", async () => {
  const f = await fixture(), controller = new AbortController(), runtime = f.create({ signal: controller.signal });
  try {
    await f.markFfmpeg(); await fs.writeFile(path.join(f.markerRoot, "color"), "unhealthy fixture");
    const pending = runtime.start(); setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /ABORTED/); await runtime.stop();
    for (const id of ids) assert.equal(await f.portIsFree(f.ports[id]), true);
    await assert.rejects(runtime.start(), /ABORTED/);
  } finally { await runtime.stop(); await f.cleanup(); }
});

test("private root, symlink, workspace and port validation fail before service spawn", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.create({ dataRoot: f.engineRoot }), /MUST_BE_OUTSIDE_ENGINE/);
    const alias = path.join(f.root, "engine-alias"); await fs.symlink(f.engineRoot, alias);
    assert.throws(() => f.create({ dataRoot: path.join(alias, "private-data") }), /MUST_BE_OUTSIDE_ENGINE/);
    assert.throws(() => f.create({ workspaceId: "../escape" }), /WORKSPACE_INVALID/);
    assert.throws(() => f.create({ ports: { ...f.ports, voice: f.ports.color } }), /PORTS_INVALID_OR_DUPLICATE/);
    const runtime = f.create(); await runtime.setup({ tools: [] });
    await assert.rejects(f.create({ workspaceId: "ws-other" }).setup({ tools: [] }), /WORKSPACE_IDENTITY_MISMATCH/);
    const aliasTools = path.join(f.root, "alias-data"), foreign = path.join(f.root, "foreign"); await fs.mkdir(aliasTools); await fs.mkdir(foreign);
    await fs.symlink(foreign, path.join(aliasTools, "tools"));
    await assert.rejects(f.create({ dataRoot: aliasTools }).setup({ tools: [] }), /PRIVATE_PATH_SYMLINK/);
    await runtime.stop();
  } finally { await f.cleanup(); }
});

test("voice readiness requires the current pinned model receipt and regular owned model files", async () => {
  const f = await fixture(); let runtime;
  try {
    const bytes = Buffer.from("explicit artificial pinned bytes, not a real model"), sha256 = createHash("sha256").update(bytes).digest("hex");
    const models = ["fixture-tts", "fixture-asr"].map((id) => ({ id, revision: "fixture-revision", files: { "model.safetensors": { bytes: bytes.length, sha256 } }, ...(id === "fixture-asr" ? { compatibilityAliases: { "weights.safetensors": "model.safetensors" } } : {}) }));
    await fs.writeFile(path.join(f.engineRoot, "pengmanager-toolchain.lock.json"), JSON.stringify({ models, ffmpeg: { pinFile: "missing-fixture-pin.json" } }));
    runtime = f.create(); await runtime.setup({ tools: [] }); const voiceRoot = path.join(f.dataRoot, "tools/voice");
    await fs.mkdir(path.join(voiceRoot, "venv/bin"), { recursive: true }); await fs.writeFile(path.join(voiceRoot, "venv/bin/python"), "artificial fixture; never executed");
    await fs.writeFile(path.join(f.dataRoot, "tools/installation.json"), JSON.stringify({ steps: [{ id: "voice", ok: true }] }));
    const installed = { schemaVersion: "pengmanager.models/v1", models: [] };
    for (const model of models) {
      const modelPath = path.join(voiceRoot, "models/hub", `models--${model.id}`, "snapshots", model.revision); await fs.mkdir(modelPath, { recursive: true });
      await fs.writeFile(path.join(modelPath, "model.safetensors"), bytes);
      const files = [{ path: "model.safetensors", bytes: bytes.length, sha256 }];
      if (model.compatibilityAliases) { await fs.link(path.join(modelPath, "model.safetensors"), path.join(modelPath, "weights.safetensors")); files.push({ path: "weights.safetensors", bytes: bytes.length, sha256 }); }
      installed.models.push({ id: model.id, revision: model.revision, path: modelPath, files });
    }
    const marker = path.join(voiceRoot, "models-installed.json"), ready = async () => (await runtime.status()).tools.find((row) => row.id === "asr").installed;
    await fs.writeFile(marker, JSON.stringify(installed)); assert.equal(await ready(), true);
    await fs.writeFile(marker, JSON.stringify({ ...installed, models: installed.models.map((row) => ({ ...row, revision: "old-revision" })) })); assert.equal(await ready(), false);
    await fs.writeFile(marker, JSON.stringify(installed));
    const alias = path.join(installed.models[1].path, "weights.safetensors"); await fs.rm(alias); assert.equal(await ready(), false);
    await fs.symlink(path.join(installed.models[1].path, "model.safetensors"), alias); assert.equal(await ready(), false);
    await fs.writeFile(marker, "{malformed model receipt"); assert.equal(await ready(), false);
  } finally { await runtime?.stop(); await f.cleanup(); }
});
