#!/usr/bin/env node
/** Target-owned tool lifecycle. Secrets are returned only in the in-memory environment. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultEngine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaults = { compositor: 19773, color: 19774, bgm: 19775, subtitle: 19776, post: 19777, voice: 19778, voiceEngine: 19779, loommate: 19780 };
const bridgeSpecs = [
  { id: "color", upper: "COLOR", factory: "createColorBridgeExecutor", prefixes: ["colorread", "colorwrite"] },
  { id: "bgm", upper: "BGM", factory: "createBgmBridgeExecutor", prefixes: ["bgmread", "bgmwrite"] },
  { id: "subtitle", upper: "SUBTITLE", factory: "createSubtitleBridgeExecutor", prefixes: ["subtitleread", "subtitlewrite"] },
  { id: "post", upper: "POST", factory: "createPostBridgeExecutor", prefixes: ["postread", "postwrite"] },
  { id: "voice", upper: "VOICE", factory: "createVoiceBridgeExecutor", prefixes: ["voiceread", "voicewrite"] },
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exists = (file) => fs.existsSync(file);
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const contained = (root, file) => { const relative = path.relative(root, file); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function canonicalWithMissing(input) {
  let current = path.resolve(input); const missing = [];
  while (!exists(current)) { missing.unshift(path.basename(current)); const parent = path.dirname(current); if (parent === current) throw new Error("PENGMANAGER_TOOLS_PATH_INVALID"); current = parent; }
  return path.join(fs.realpathSync(current), ...missing);
}
function killOwned(child, signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function atomicJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try { await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" }); await fsp.rename(temporary, file); }
  finally { await fsp.rm(temporary, { force: true }); }
}
async function portAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => reject(new Error(`PENGMANAGER_TOOL_PORT_IN_USE:${port}:${error.code}`)));
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolve()));
  });
}

/** Buffer whole UTF-8 lines so a secret split across arbitrary child chunks is never emitted in fragments. */
export function createRedactedLineSink({ redact, write, onError, maxLineBytes = 65_536 }) {
  const decoder = new StringDecoder("utf8"); let pending = "", failed = false, ended = false;
  const fail = (error) => { if (failed) return; failed = true; pending = ""; onError(error); };
  const emit = (line) => { try { write(redact(line)); } catch (error) { fail(error); } };
  const consume = (text) => {
    if (failed) return; pending += text;
    for (;;) {
      const index = pending.indexOf("\n"); if (index < 0) break;
      const line = pending.slice(0, index + 1); pending = pending.slice(index + 1);
      if (Buffer.byteLength(line) > maxLineBytes) return fail(new Error("TOOL_LOG_LINE_TOO_LONG"));
      emit(line); if (failed) return;
    }
    if (Buffer.byteLength(pending) > maxLineBytes) fail(new Error("TOOL_LOG_LINE_TOO_LONG"));
  };
  return {
    push(chunk) { if (!ended && !failed) consume(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))); },
    end() { if (ended) return; ended = true; consume(decoder.end()); if (!failed && pending) { emit(`${pending}\n`); pending = ""; } },
  };
}

export function createToolRuntime({ engineRoot = defaultEngine, dataRoot, env = process.env, ports = {}, logger = () => {}, signal, workspaceId = "ws-pengmanager-video" } = {}) {
  if (!dataRoot || !path.isAbsolute(dataRoot) || path.resolve(dataRoot) === path.parse(dataRoot).root) throw new Error("PENGMANAGER_TOOLS_DATA_ROOT_REQUIRED");
  engineRoot = fs.realpathSync(path.resolve(engineRoot)); dataRoot = canonicalWithMissing(dataRoot);
  if (contained(engineRoot, dataRoot)) throw new Error("PENGMANAGER_TOOLS_PRIVATE_DATA_MUST_BE_OUTSIDE_ENGINE");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(workspaceId)) throw new Error("PENGMANAGER_TOOLS_WORKSPACE_INVALID");
  const selectedPorts = { ...defaults, ...ports };
  const values = Object.values(selectedPorts);
  if (values.some((n) => !Number.isInteger(n) || n < 1024 || n > 65535) || new Set(values).size !== values.length) throw new Error("PENGMANAGER_TOOLS_PORTS_INVALID_OR_DUPLICATE");
  const toolsRoot = path.join(dataRoot, "tools"), binDir = path.join(toolsRoot, "bin"), voiceDir = path.join(toolsRoot, "voice");
  const whiteboardDir = path.join(toolsRoot, "whiteboard"), compositorDir = path.join(toolsRoot, "compositor"), talkcraftDir = path.join(toolsRoot, "talkcraft"), npmDir = path.join(toolsRoot, "npm");
  const ownToken = randomBytes(32).toString("hex"), processes = new Map(), runningCommands = new Set(), failures = new Map();
  let stopped = false, operationTail = Promise.resolve(), stopTail = Promise.resolve(), epoch = 0, environment = {};
  const lock = json(path.join(engineRoot, "pengmanager-toolchain.lock.json"));
  const baseEnv = { ...env, PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? process.env.PATH ?? "/usr/bin:/bin"}`,
    NODE_USE_ENV_PROXY: env.NODE_USE_ENV_PROXY ?? "1", NO_PROXY: `127.0.0.1,localhost,::1${env.NO_PROXY ? `,${env.NO_PROXY}` : ""}`,
    HF_HOME: path.join(voiceDir, "models"), HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_XET: "1", UV_LINK_MODE: "copy",
    UV_DEFAULT_INDEX: "https://pypi.org/simple", PIP_INDEX_URL: "https://pypi.org/simple",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    NPM_CONFIG_USERCONFIG: path.join(toolsRoot, "npm-user.npmrc"), NPM_CONFIG_GLOBALCONFIG: path.join(toolsRoot, "npm-global.npmrc"),
    NPM_CONFIG_CACHE: path.join(toolsRoot, "cache/npm"), UV_CACHE_DIR: path.join(toolsRoot, "cache/uv"), XDG_CACHE_HOME: path.join(toolsRoot, "cache"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
  };
  const redact = (value) => {
    let text = String(value);
    for (const [key, secret] of Object.entries({ ...baseEnv, WORKLOOM_BRIDGE_TOKEN: ownToken })) if (/(?:TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL)|_PROXY$/i.test(key) && typeof secret === "string" && secret.length >= 8) text = text.replaceAll(secret, "[redacted]");
    return text;
  };
  function aborted() { if (stopped || signal?.aborted) throw new Error("PENGMANAGER_TOOLS_ABORTED"); }
  async function initialize() {
    aborted();
    for (const directory of [toolsRoot, binDir, voiceDir, whiteboardDir, compositorDir, talkcraftDir, npmDir, path.join(toolsRoot, "logs"), path.join(toolsRoot, "cache")]) {
      if (exists(directory) && (await fsp.lstat(directory)).isSymbolicLink()) throw new Error("PENGMANAGER_TOOLS_PRIVATE_PATH_SYMLINK");
    }
    await fsp.mkdir(toolsRoot, { recursive: true, mode: 0o700 });
    const marker = path.join(toolsRoot, "pengmanager-tools-root.json");
    if (exists(marker) && json(marker).schemaVersion !== "pengmanager.tools-root/v1") throw new Error("PENGMANAGER_TOOLS_DATA_ROOT_IDENTITY_MISMATCH");
    if (exists(marker) && json(marker).workspaceId !== workspaceId) throw new Error("PENGMANAGER_TOOLS_WORKSPACE_IDENTITY_MISMATCH");
    await atomicJson(marker, { schemaVersion: "pengmanager.tools-root/v1", workspaceId });
    for (const directory of [binDir, voiceDir, whiteboardDir, compositorDir, talkcraftDir, path.join(toolsRoot, "logs")]) await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of [baseEnv.NPM_CONFIG_USERCONFIG, baseEnv.NPM_CONFIG_GLOBALCONFIG]) {
      if (exists(file) && (await fsp.lstat(file)).isSymbolicLink()) throw new Error("PENGMANAGER_TOOLS_PRIVATE_PATH_SYMLINK");
      await fsp.writeFile(file, "", { mode: 0o600 });
    }
  }
  function run(command, args, { cwd = engineRoot, timeoutMs = 30 * 60_000, extraEnv = {} } = {}) {
    aborted();
    return new Promise((resolve, reject) => {
      let tail = "", done = false, timedOut = false, logError;
      const child = spawn(command, args, { cwd, env: { ...baseEnv, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
      runningCommands.add(child);
      const timer = setTimeout(() => { timedOut = true; killOwned(child); const force = setTimeout(() => killOwned(child, "SIGKILL"), 5000); force.unref(); }, timeoutMs);
      const append = (line) => { tail = (tail + line).slice(-24_000); logger(line.trimEnd()); };
      const failure = (error) => { logError = error; killOwned(child); };
      const stdout = createRedactedLineSink({ redact, write: append, onError: failure }), stderr = createRedactedLineSink({ redact, write: append, onError: failure });
      child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
      const finish = (error, code, exitSignal) => {
        if (done) return; done = true; clearTimeout(timer); runningCommands.delete(child); stdout.end(); stderr.end();
        if (error || logError || code !== 0) reject(new Error(redact(`TOOL_COMMAND_FAILED:${path.basename(command)}:${timedOut ? `timeout-${timeoutMs}ms` : logError?.message ?? error?.message ?? exitSignal ?? code}:${tail.slice(-1600)}`)));
        else resolve(tail);
      };
      child.once("error", (error) => finish(error)); child.once("close", (code, exitSignal) => finish(null, code, exitSignal));
    });
  }
  const uv = env.PENGMANAGER_UV_BIN || path.join(os.homedir(), ".local/bin/uv");
  const bootstrapPython = env.PENGMANAGER_PYTHON || "python3.12";
  const python = path.join(voiceDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const whiteboardPython = path.join(whiteboardDir, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const tsx = path.join(engineRoot, "node_modules/tsx/dist/cli.mjs");
  const ffmpeg = path.join(binDir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const ffprobe = path.join(binDir, process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  async function installFfmpeg() {
    const pin = json(path.join(engineRoot, lock.ffmpeg.pinFile));
    const target = pin.targets[`${process.platform}-${process.arch}`];
    if (!target) throw new Error(`FFMPEG_PLATFORM_NOT_PINNED:${process.platform}-${process.arch}`);
    for (const [name, destination] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
      const spec = target[name];
      if (!/^[a-f0-9]{64}$/.test(spec.sha256)) throw new Error(`FFMPEG_TARGET_SHA_UNVERIFIED:${name}`);
      if (exists(destination) && hash(await fsp.readFile(destination)) === spec.sha256) continue;
      const source = env[`PENGMANAGER_${name.toUpperCase()}_SOURCE`];
      let bytes;
      if (source) bytes = await fsp.readFile(source);
      else {
        const archive = path.join(binDir, `${name}.download.gz`);
        try { await run("curl", ["--fail", "--location", "--retry", "2", "--connect-timeout", "30", "--max-time", "600", spec.url, "-o", archive]); bytes = gunzipSync(await fsp.readFile(archive)); }
        finally { await fsp.rm(archive, { force: true }); }
      }
      if (hash(bytes) !== spec.sha256) throw new Error(`FFMPEG_SHA_MISMATCH:${name}`);
      await fsp.writeFile(destination, bytes, { mode: 0o755 }); await fsp.chmod(destination, 0o755);
      await run(destination, ["-version"], { timeoutMs: 30_000 });
    }
  }
  async function installCompositor() {
    const kit = path.join(engineRoot, "vendor/compositor-kit"), pin = json(path.join(kit, "PINNED.json"));
    if (`${process.platform}-${process.arch}` !== pin.headless.platform) throw new Error(`COMPOSITOR_PLATFORM_REQUIRED:${pin.headless.platform}`);
    const bytes = await fsp.readFile(path.join(kit, pin.headless.file));
    if (hash(bytes) !== pin.headless.sha256) throw new Error("COMPOSITOR_PIN_MISMATCH");
    await fsp.writeFile(path.join(compositorDir, "compositor-cli"), bytes, { mode: 0o755 });
    await fsp.chmod(path.join(compositorDir, "compositor-cli"), 0o755);
    await run(path.join(compositorDir, "compositor-cli"), ["selftest", path.join(compositorDir, "selftest")], { timeoutMs: 120_000 });
  }
  async function installPython(directory, packages) {
    const py = path.join(directory, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    if (!exists(py)) await run(uv, ["venv", "--python", bootstrapPython, path.join(directory, "venv")]);
    await run(uv, ["pip", "install", "--python", py, ...packages]);
    return py;
  }
  async function installNpm() {
    const cli = path.join(npmDir, "bin/npm-cli.js");
    if (exists(cli) && json(path.join(npmDir, "package.json")).version === lock.npm.version) return cli;
    const archive = path.join(toolsRoot, "npm.download.tgz"), staging = path.join(toolsRoot, `npm.installing-${randomBytes(6).toString("hex")}`);
    try {
      await run("curl", ["--fail", "--location", "--retry", "2", "--connect-timeout", "30", "--max-time", "600", lock.npm.tarball, "-o", archive]);
      const integrity = `sha512-${createHash("sha512").update(await fsp.readFile(archive)).digest("base64")}`;
      if (integrity !== lock.npm.integrity) throw new Error("NPM_INSTALLATION_INTEGRITY_MISMATCH");
      await fsp.mkdir(staging, { mode: 0o700 });
      await run("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"]);
      if (json(path.join(staging, "package.json")).version !== lock.npm.version) throw new Error("NPM_INSTALLATION_VERSION_MISMATCH");
      await run(process.execPath, [path.join(staging, "bin/npm-cli.js"), "--version"], { timeoutMs: 30_000 });
      // This directory contains only our pinned installer dependency, never project/user data.
      await fsp.rm(npmDir, { recursive: true, force: true }); await fsp.rename(staging, npmDir);
      return cli;
    } finally { await fsp.rm(archive, { force: true }); await fsp.rm(staging, { recursive: true, force: true }); }
  }
  async function setupNow({ tools = ["ffmpeg", "compositor", "whiteboard", "voice", "asr", "loommate", "talkcraft"], downloadModels = true } = {}) {
    if (!Array.isArray(tools) || tools.some((id) => !["ffmpeg", "compositor", "whiteboard", "voice", "asr", "loommate", "talkcraft"].includes(id))) throw new Error("PENGMANAGER_TOOLS_UNKNOWN_INSTALL_TARGET");
    await initialize();
    const selected = new Set(tools), steps = [];
    if (selected.has("asr") || selected.has("loommate")) selected.add("voice");
    for (const id of ["ffmpeg", "compositor", "whiteboard", "voice", "loommate", "talkcraft"]) {
      if (!selected.has(id)) continue;
      try {
        if (id === "ffmpeg") await installFfmpeg();
        if (id === "compositor") await installCompositor();
        if (id === "whiteboard") { await installPython(whiteboardDir, ["-r", path.join(engineRoot, lock.whiteboard.requirements)]); await run(whiteboardPython, ["-c", "import cv2,numpy,av,PIL;print('whiteboard dependencies imported')"]); }
        if (id === "voice") {
          await installPython(voiceDir, Object.values(lock.pythonPackages));
          if (downloadModels) await run(python, [path.join(engineRoot, "scripts/pengmanager-models.py"), "voice", "--engine-root", engineRoot, "--station", voiceDir]);
          await run(python, ["-c", "import mlx_audio,mlx_whisper,soundfile;print('voice and ASR dependencies imported')"], { timeoutMs: 60_000 });
        }
        if (id === "loommate") await run(python, [path.join(engineRoot, "scripts/pengmanager-models.py"), "loommate", "--engine-root", engineRoot, "--station", voiceDir]);
        if (id === "talkcraft") {
          const npmCli = await installNpm();
          const source = path.join(toolsRoot, "talkcraft-source");
          if (!exists(path.join(source, ".git"))) await run("git", ["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "clone", "--depth", "1", "--template=", `${lock.talkcraft.repository}.git`, source]);
          await run("git", ["-C", source, "fetch", "--depth", "1", "origin", lock.talkcraft.commit]);
          await run("git", ["-C", source, "checkout", "--detach", "FETCH_HEAD"]);
          const grantPath = path.join(talkcraftDir, "LICENSE-GRANT.md");
          if (exists(grantPath) && !(await fsp.lstat(grantPath)).isFile()) throw new Error("TALKCRAFT_EXISTING_GRANT_MUST_BE_REGULAR_FILE");
          const existingGrant = exists(grantPath) ? await fsp.readFile(grantPath) : null;
          try {
            await run(process.execPath, [tsx, "scripts/tools/talkcraft-engine-install.mts", "--source", source, "--with-runtime"], {
              extraEnv: { TALKCRAFT_ENGINE_DIR: talkcraftDir, TALKCRAFT_NPM_REGISTRY: "https://registry.npmjs.org", NPM_CLI_JS: npmCli },
            });
          } finally {
            // Preserve only the exact pre-existing owner grant when the native installer refreshes its owned engine directory.
            if (existingGrant) { await fsp.mkdir(talkcraftDir, { recursive: true, mode: 0o700 }); await fsp.writeFile(grantPath, existingGrant, { mode: 0o600 }); }
          }
        }
        failures.delete(id); steps.push({ id, ok: true });
      } catch (error) { const reason = redact(error.message); failures.set(id, reason); steps.push({ id, ok: false, reason }); if (stopped || signal?.aborted) throw error; }
    }
    const installationFile = path.join(toolsRoot, "installation.json");
    const previous = exists(installationFile) ? json(installationFile) : { steps: [] };
    const installedSteps = new Map((previous.steps ?? []).map((step) => [step.id, step]));
    for (const step of steps) installedSteps.set(step.id, step);
    await atomicJson(installationFile, { schemaVersion: "pengmanager.tools-installation/v1", at: new Date().toISOString(), steps: [...installedSteps.values()] });
    return { steps, ...(await status()) };
  }
  async function health(url, timeoutMs = 2500) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); const body = await response.json(); return response.ok && body.ok !== false; }
    catch (error) { if (signal?.aborted) throw error; return false; }
  }
  function modelInstallationCurrent() {
    const file = path.join(voiceDir, "models-installed.json"), modelRoot = path.join(voiceDir, "models");
    if (!exists(file)) return false;
    try {
      const receipt = json(file);
      if (receipt.schemaVersion !== "pengmanager.models/v1" || !Array.isArray(receipt.models) || receipt.models.length !== lock.models.length) return false;
      return lock.models.every((expected) => {
        const matches = receipt.models.filter((row) => row.id === expected.id && row.revision === expected.revision);
        if (matches.length !== 1 || !Array.isArray(matches[0].files)) return false;
        const recorded = matches[0], wantedPath = path.join(modelRoot, "hub", `models--${expected.id.replaceAll("/", "--")}`, "snapshots", expected.revision);
        if (recorded.path !== wantedPath || !exists(wantedPath) || fs.lstatSync(wantedPath).isSymbolicLink() || !contained(modelRoot, fs.realpathSync(wantedPath))) return false;
        const expectedFiles = { ...expected.files, ...(expected === lock.models[1] ? lock.asrProcessor?.files : {}),
          ...Object.fromEntries(Object.entries(expected.compatibilityAliases ?? {}).map(([alias, source]) => [alias, expected.files?.[source]])) };
        if (!Object.keys(expectedFiles).length) return false;
        return Object.entries(expectedFiles).every(([name, details]) => {
          const actualPath = path.join(wantedPath, name), rows = recorded.files.filter((row) => row.path === name);
          if (!details || !exists(actualPath) || !contained(wantedPath, fs.realpathSync(actualPath)) || fs.lstatSync(actualPath).isSymbolicLink()) return false;
          const stat = fs.statSync(actualPath);
          return stat.isFile() && stat.size === details.bytes && rows.length === 1 && rows[0].bytes === details.bytes && (!details.sha256 || rows[0].sha256 === details.sha256);
        });
      });
    } catch (error) {
      if (error instanceof SyntaxError || ["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return false;
      throw error;
    }
  }
  function serviceRow(id, label, installed, entrypoints, missing = []) {
    const child = processes.get(id)?.child;
    const running = !!child && child.exitCode === null && !child.signalCode;
    return { id, label, installed, ready: installed && (processes.has(id) ? running : !["compositor", "color", "bgm", "subtitle", "post", "voice", "voiceEngine", "loommate"].includes(id)), running,
      missing: [...missing, ...(failures.has(id) ? [failures.get(id)] : [])], entrypoints,
      productionVerified: false, readinessKind: "dependency-and-process-status" };
  }
  async function status() {
    const installationFile = path.join(toolsRoot, "installation.json"), receipt = exists(installationFile) ? json(installationFile) : { steps: [] };
    const installedSteps = new Map((receipt.steps ?? []).map((step) => [step.id, step]));
    const installed = (id) => installedSteps.get(id)?.ok === true;
    const ff = installed("ffmpeg") && exists(ffmpeg) && exists(ffprobe), comp = installed("compositor") && exists(path.join(compositorDir, "compositor-cli"));
    const models = installed("voice") && modelInstallationCurrent(), vp = exists(python), cpu = installed("loommate") && exists(path.join(voiceDir, "loommate-voice.json"));
    const talk = installed("talkcraft") && exists(path.join(talkcraftDir, "PINNED")) && exists(path.join(talkcraftDir, ".runtime-ready"));
    const scope = String(env.TALKCRAFT_LICENSE_SCOPE ?? "noncommercial");
    const grantFile = path.join(talkcraftDir, "LICENSE-GRANT.md"), grantStat = exists(grantFile) ? fs.lstatSync(grantFile) : null;
    const grant = !!grantStat?.isFile() && grantStat.size > 0, commercialReady = scope === "authorized" && grant;
    const rows = [serviceRow("ffmpeg", "FFmpeg / FFprobe", ff, [ffmpeg, ffprobe], ff ? [] : ["pinned binaries not installed"]),
      serviceRow("compositor", "Compositor 图像合成", comp, ["visualread.*", "visualwrite.*"], comp ? [] : ["target-owned headless engine missing"]),
      ...bridgeSpecs.map((bridge) => serviceRow(bridge.id, `${bridge.id} bridge`, bridge.id === "voice" ? vp && models : ff,
        bridge.prefixes.map((prefix) => `${prefix}.*`), bridge.id === "voice" && !models ? ["voice/ASR model installation incomplete"] : !ff ? ["FFmpeg dependencies missing"] : [])),
      serviceRow("voiceEngine", "本地 MLX TTS / ASR", vp && models, ["/v1/audio/speech", "/v1/audio/transcriptions"], !vp || !models ? ["target Python environment or pinned models missing"] : []),
      serviceRow("asr", "口播逐字稿 / 字级对齐", vp && models, ["scripts/tools/edit-talk-asr.mts", "apps/server/src/video/explainer/asr-aligner.ts"], !vp || !models ? ["local ASR environment/models missing"] : []),
      serviceRow("loommate", "普通话自然女声 CPU 工位", vp && cpu, ["/v1/audio/speech"], !cpu ? ["pinned Kokoro model/dependencies missing"] : []),
      serviceRow("whiteboard", "手绘白板渲染器", installed("whiteboard") && exists(whiteboardPython), ["video.whiteboard", "scripts/tools/whiteboard-film.mts"], installed("whiteboard") && exists(whiteboardPython) ? [] : ["target-owned Python dependencies not verified"]),
      { ...serviceRow("talkcraft", "口播解说片 / Remotion", talk, ["video.explainer", "scripts/tools/explainer-run.mts"], talk ? [] : ["pinned engine/runtime installation incomplete"]),
        license: { scope, commercialGrantPresent: grant, commercialReady, condition: "commercial generation requires authorized scope and actual LICENSE-GRANT.md" } },
    ];
    for (const row of rows) {
      const stepId = ["voiceEngine", "asr"].includes(row.id) ? "voice" : row.id;
      const failed = installedSteps.get(stepId);
      if (failed?.ok === false && failed.reason && !failures.has(row.id)) row.missing.push(redact(failed.reason));
      if (row.id === "talkcraft" && scope === "authorized" && !grant) { row.missing.push("commercial authorization grant missing"); row.ready = false; }
      if (row.id === "talkcraft" && !["noncommercial", "authorized"].includes(scope)) { row.missing.push("license scope invalid"); row.ready = false; }
      if (processes.has(row.id) && row.running) row.ready = row.installed && await health(processes.get(row.id).healthUrl, row.id === "voiceEngine" ? 4000 : 2500);
    }
    const missing = rows.filter((row) => !row.ready || row.missing.length).map((row) => ({ id: row.id,
      reasons: row.missing.length ? row.missing : ["owned service is not running or its health check failed"] }));
    return { schemaVersion: "pengmanager.tools-status/v1", dataRoot, tools: rows, missing, ready: rows.every((row) => row.ready && row.missing.length === 0),
      running: [...processes.keys()], sourceServiceReuse: false, providerCalls: 0, commercialTalkcraftReady: commercialReady };
  }
  async function stopService(id, entry) {
    if (!entry) return;
    killOwned(entry.child);
    const deadline = Date.now() + 5000;
    while (entry.child.exitCode === null && !entry.child.signalCode && Date.now() < deadline) await sleep(50);
    killOwned(entry.child, "SIGKILL");
    if (processes.get(id) === entry) processes.delete(id);
  }
  async function spawnService(id, command, args, extraEnv, url, { timeoutMs = 90_000 } = {}) {
    aborted();
    const previous = processes.get(id);
    if (previous?.child.exitCode === null && !previous.child.signalCode && await health(previous.healthUrl)) return;
    if (previous) await stopService(id, previous);
    await portAvailable(new URL(url).port * 1);
    aborted();
    const logFile = path.join(toolsRoot, "logs", `${id}.log`), log = fs.openSync(logFile, "a", 0o600); fs.fchmodSync(log, 0o600);
    const child = spawn(command, args, { cwd: engineRoot, env: { ...baseEnv, ...environment, ...extraEnv }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    processes.set(id, { child, healthUrl: url, logFile });
    let spawnError, logError, logClosed = false;
    const writeLine = (line) => { fs.writeSync(log, line); logger(line.trimEnd()); };
    const failLog = (error) => { logError = error; failures.set(id, `service log failure:${redact(error.message)}`); killOwned(child); };
    const stdout = createRedactedLineSink({ redact, write: writeLine, onError: failLog }), stderr = createRedactedLineSink({ redact, write: writeLine, onError: failLog });
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", () => { stdout.end(); stderr.end(); if (!logClosed) { logClosed = true; try { fs.closeSync(log); } catch (error) { failLog(error); } } });
    child.once("error", (error) => { spawnError = error; if (processes.get(id)?.child === child) failures.set(id, redact(error.message)); });
    child.once("exit", (code, reason) => { if (!stopped && processes.get(id)?.child === child && (code !== 0 || reason)) failures.set(id, `service exited:${code ?? reason}`); });
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      aborted(); if (spawnError || logError || child.exitCode !== null) break;
      if (await health(url) && !logError) { failures.delete(id); return; }
      await sleep(300);
    }
    await stopService(id, processes.get(id));
    throw new Error(`PENGMANAGER_TOOL_START_FAILED:${id}:${logError?.message ?? spawnError?.message ?? "health deadline"}; log=${logFile}`);
  }
  async function startNow() {
    await initialize(); const modules = [], base = { HF_HOME: baseEnv.HF_HOME, HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_DISABLE_XET: "1",
      FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe, WL_FFMPEG: ffmpeg, WL_FFPROBE: ffprobe,
      WHITEBOARD_FFMPEG: ffmpeg, WHITEBOARD_FFPROBE: ffprobe, WHITEBOARD_ENABLED: "1", WHITEBOARD_ENGINE_DIR: path.join(engineRoot, "vendor/srt-whiteboard"),
      WHITEBOARD_PYTHON: whiteboardPython, WHITEBOARD_JOBS_DIR: path.join(dataRoot, "whiteboard-jobs"),
      TALKCRAFT_ENGINE_DIR: talkcraftDir, TALKCRAFT_JOBS_DIR: path.join(dataRoot, "talkcraft-jobs"), TALKCRAFT_ENABLED: "1", TALKCRAFT_PYTHON: python,
      TALKCRAFT_ASR_BACKEND: "voice-station", TALKCRAFT_ASR_WORDS_BACKEND: "engine-http", TALKCRAFT_ASR_MODEL: lock.models[1].id,
      TALKCRAFT_ASR_ENGINE_URL: `http://127.0.0.1:${selectedPorts.voiceEngine}`, WL_PYTHON: python,
      WL_TALK_ASR_ENGINE_URL: `http://127.0.0.1:${selectedPorts.voiceEngine}`, WL_TALK_ASR_MODEL: lock.models[1].id,
      WORKLOOM_VOICE_STATION_DIR: voiceDir, WORKLOOM_VOICE_ENGINE: "mlx", WORKLOOM_VOICE_ENABLED: "1",
      WORKLOOM_VOICE_ENGINE_URL: `http://127.0.0.1:${selectedPorts.voiceEngine}`, WORKLOOM_LOOMMATE_ENGINE_URL: `http://127.0.0.1:${selectedPorts.loommate}`,
      WORKLOOM_VOICE_TTS_MODEL: lock.models[0].id, WORKLOOM_VOICE_ASR_MODEL: lock.models[1].id,
      WORKLOOM_BRIDGE_TOKEN: ownToken, WORKLOOM_VOICE_BRIDGE_TOKEN: ownToken, WORKLOOM_VISUAL_BRIDGE_TOKEN: ownToken,
      WORKLOOM_VISUAL_BRIDGE_TENANT: workspaceId, WORKLOOM_VOICE_BRIDGE_TENANT: workspaceId,
      WORKLOOM_VISUAL_BRIDGE_URL: `http://127.0.0.1:${selectedPorts.compositor}`, WORKLOOM_VISUAL_BRIDGE_SUPPORT_DIR: compositorDir,
      WORKLOOM_VISUAL_BRIDGE_OUT_DIR: path.join(compositorDir, "tenants", workspaceId, "out"),
      WORKLOOM_VOICE_ALLOWED_ROOTS: dataRoot, WORKLOOM_VOICE_CACHE_DIR: path.join(voiceDir, "deliveries", "voice-cache"),
      WORKLOOM_POST_WORK_DIR: path.join(dataRoot, "post-work"), WORKLOOM_POST_ALLOWED_ROOTS: `${dataRoot}${path.delimiter}${engineRoot}`,
    };
    environment = { ...base };
    const compConfig = path.join(compositorDir, "config.json");
    await atomicJson(compConfig, { cli: path.join(compositorDir, "compositor-cli"), host: "127.0.0.1", port: selectedPorts.compositor,
      work_dir: compositorDir, shared_roots: [path.join(engineRoot, "bundles"), dataRoot],
      tenants: [{ id: workspaceId, token_env: "WORKLOOM_VISUAL_BRIDGE_TOKEN", root: path.join(compositorDir, "tenants", workspaceId), quota_daily_renders: 50, max_disk_mb: 4096 }],
      vision: { base_url: env.LLM_BASE_URL ?? "", model: env.LLM_MODEL ?? "", api_key_env: "LLM_API_KEY" },
      image_gen: { base_url: env.ARK_BASE_URL ?? "", model: env.ARK_IMAGE_MODEL ?? env.SEEDREAM_MODEL ?? "", api_key_env: env.VOLCENGINE_ARK_API_KEY ? "VOLCENGINE_ARK_API_KEY" : "ARK_API_KEY" },
    });
    const begin = async (id, ready, callback) => {
      if (!ready) { failures.set(id, "dependency installation incomplete; run the target tools setup"); return; }
      try { await callback(); } catch (error) { failures.set(id, redact(error.message)); if (stopped || signal?.aborted) throw error; }
    };
    await begin("compositor", exists(path.join(compositorDir, "compositor-cli")), () => spawnService("compositor", env.PENGMANAGER_SYSTEM_PYTHON || "python3", [path.join(engineRoot, "vendor/compositor-kit/bridge.py"), "serve", "--config", compConfig], {}, `${base.WORKLOOM_VISUAL_BRIDGE_URL}/health`));
    modules.push(`${path.join(engineRoot, "bundles/geo-growth/connectors/visual-bridge/executor.ts")}::createVisualBridgeExecutor::visualread.*|visualwrite.*::${base.WORKLOOM_VISUAL_BRIDGE_URL}`);
    for (const bridge of bridgeSpecs) {
      const key = `WORKLOOM_${bridge.upper}_BRIDGE`, url = `http://127.0.0.1:${selectedPorts[bridge.id]}`;
      Object.assign(environment, { [`${key}_URL`]: url, [`${key}_PORT`]: String(selectedPorts[bridge.id]), [`${key}_HOST`]: "127.0.0.1", [`${key}_TOKEN`]: ownToken,
        [`${key}_TENANT`]: workspaceId, [`WORKLOOM_${bridge.upper}_JOBS_DIR`]: path.join(dataRoot, `${bridge.id}-jobs`) });
      const folder = path.join(engineRoot, `bundles/ai-video/connectors/${bridge.id}-bridge`);
      await begin(bridge.id, exists(ffmpeg) && exists(ffprobe), () => spawnService(bridge.id, process.execPath, [path.join(folder, "server.mjs")], {}, `${url}/health`));
      modules.push(`${path.join(folder, "executor.ts")}::${bridge.factory}::${bridge.prefixes.map((prefix) => `${prefix}.*`).join("|")}::${url}`);
    }
    if (exists(python) && modelInstallationCurrent()) await begin("voiceEngine", true, () => spawnService("voiceEngine", python, ["-m", "mlx_audio.server", "--host", "127.0.0.1", "--port", String(selectedPorts.voiceEngine)], {}, `${base.WORKLOOM_VOICE_ENGINE_URL}/v1/models`, { timeoutMs: 120_000 }));
    if (exists(python) && exists(path.join(voiceDir, "loommate-voice.json"))) {
      const spec = { ...json(path.join(engineRoot, "apps/server/src/voice/loommate-voice.json")), enginePort: selectedPorts.loommate }, specFile = path.join(voiceDir, "loommate-worker-spec.json");
      await atomicJson(specFile, spec);
      await begin("loommate", true, () => spawnService("loommate", python, [path.join(engineRoot, "scripts/loommate-voice-engine.py"), "--station-dir", voiceDir, "--spec", specFile], {}, `${base.WORKLOOM_LOOMMATE_ENGINE_URL}/health`, { timeoutMs: 120_000 }));
    }
    aborted();
    environment.WORKLOOM_TOOL_EXECUTOR_MODULES = modules.join(",");
    environment.WORKLOOM_TOOL_EXECUTOR_MODULE = "";
    return { environment: { ...environment }, ...(await status()) };
  }
  async function stopNow() {
    stopped = true;
    const children = [...runningCommands, ...[...processes.values()].map((entry) => entry.child)];
    for (const child of children) killOwned(child);
    const deadline = Date.now() + 5000;
    while (children.some((child) => child.exitCode === null && !child.signalCode) && Date.now() < deadline) await sleep(100);
    for (const child of children) killOwned(child, "SIGKILL");
    processes.clear(); runningCommands.clear(); environment = {};
    return { stopped: true, ownedProcesses: children.length };
  }
  function stop() {
    stopped = true; epoch++;
    stopTail = stopTail.catch(() => undefined).then(stopNow);
    return stopTail;
  }
  function enqueue(operation) {
    const requestedEpoch = epoch;
    const result = operationTail.catch(() => undefined).then(async () => {
      await stopTail;
      if (signal?.aborted || requestedEpoch !== epoch) throw new Error("PENGMANAGER_TOOLS_ABORTED");
      stopped = false;
      return operation();
    });
    operationTail = result;
    return result;
  }
  if (signal) signal.addEventListener("abort", () => { void stop().catch((error) => logger(redact(error.message))); }, { once: true });
  return { setup(options) { return enqueue(() => setupNow(options)); },
    start() { return enqueue(startNow); }, stop, status,
    paths: { dataRoot, toolsRoot, voiceDir, compositorDir, whiteboardDir, talkcraftDir, npmDir }, ports: selectedPorts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), command = args[0] ?? "status";
  const option = (key, fallback = "") => { const index = args.indexOf(key); return index < 0 ? fallback : args[index + 1]; };
  const dataRoot = path.resolve(option("--data-root", path.join(os.homedir(), "Library/Application Support/PengManager/video-runtime")));
  const controller = new AbortController();
  const runtime = createToolRuntime({ dataRoot, signal: controller.signal, logger: (line) => process.stderr.write(`${line}\n`) });
  const cancel = () => { controller.abort(); void runtime.stop().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); };
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
  const work = async () => {
    if (command === "setup") return runtime.setup({ ...(option("--tool") ? { tools: option("--tool").split(",") } : {}), downloadModels: !args.includes("--skip-models") });
    if (command === "status" || command === "doctor") return runtime.status();
    if (command === "start") {
      const result = await runtime.start();
      // Never print process credentials returned by the module API.
      const { environment: _secretEnvironment, ...publicResult } = result;
      process.stdout.write(`${JSON.stringify(publicResult, null, 2)}\n`);
      return null;
    }
    throw new Error(`UNKNOWN_TOOLS_COMMAND:${command}`);
  };
  work().then((result) => {
    if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === "setup" && result?.steps?.some((step) => !step.ok)) process.exitCode = 1;
  }).catch(async (error) => { process.stderr.write(`${error.message}\n`); await runtime.stop(); process.exitCode = controller.signal.aborted ? 0 : 1; });
}
