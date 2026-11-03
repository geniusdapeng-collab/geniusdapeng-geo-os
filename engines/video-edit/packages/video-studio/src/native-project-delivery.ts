/** Owner-only bridge from the authenticated production archive to the existing local post workbench. */
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertProductionSource, ProductionClient, ProductionClientError, reconcileServiceProject, renderServiceProject,
  type ProductionProjectResult, type ProductionSourceIdentity,
} from "./production-client.js";
import { verifyNativeRenderSources } from "./native-render-sources.js";
import { fingerprintArtifact, productionHash, type ArtifactFingerprint } from "./production-lineage.js";

const ENGINE_ROOT = path.resolve(import.meta.dirname, "../../..");
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const SCHEMA = "pengmanager.native-project-delivery/v1";

export interface NativeDeliveryHandoff extends ProductionSourceIdentity {
  system: "pengmanager"; pipeline: "marketing" | "narrative"; runId: string; intentSha256: string; durationSeconds: number;
}
export interface NativePostPlan {
  title: string;
  platform: string;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  resolution: "720p" | "1080p" | "2160p";
  fps: number;
  preserveColor?: boolean;
  subtitles?: "burn" | "sidecar" | "both";
  cover?: boolean;
  music?: { path: string; sha256: string; licenseReceiptSha256: string };
}
interface RenderJournal {
  schemaVersion: typeof SCHEMA; requestSha256: string; render: ProductionProjectResult | null; preDispatchError?: string;
}

function fail(code: string, message: string): never { throw new ProductionClientError(code, message); }
function realDirectory(file: string, privateMode = false): string {
  const resolved = path.resolve(file);
  const stat = lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(resolved) !== resolved
    || (privateMode && process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
    fail("PRIVATE_DELIVERY_PATH_INVALID", "Delivery requires the canonical owner-only native runtime directory");
  }
  return resolved;
}
function makeDirectory(parent: string, name: string): string {
  const target = path.join(parent, name);
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return realDirectory(target, true);
}
function readPrivateJson(file: string): unknown {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file || !stat.size || stat.size > 8 * 1024 * 1024
    || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
    fail("PRIVATE_DELIVERY_RECEIPT_INVALID", "The native delivery receipt is not a bounded owner-only file");
  }
  return JSON.parse(readFileSync(file, "utf8"));
}
function replaceJournal(file: string, value: RenderJournal): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}
function frozenInput(file: string, value: unknown): ArtifactFingerprint {
  const text = JSON.stringify(value) + "\n";
  try { writeFileSync(file, text, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (productionHash(readPrivateJson(file)) !== productionHash(value)) fail("POST_SOURCE_CHANGED", "The existing post input differs from the approved current archive");
  }
  return fingerprintArtifact(file);
}
function safeRender(result: ProductionProjectResult): ProductionProjectResult {
  return { ...result, shots: result.shots.map(({ resultUrl: _url, error, ...row }) =>
    ({ ...row, ...(error ? { error: error.replace(/https?:\/\/[^\s]+/gu, "[private-url]") } : {}) })) };
}
function pendingDeliveryState(render: ProductionProjectResult | null): "running" | "blocked" {
  if (!render || render.status === "running" || render.status === "done") return "running";
  return render.status === "unverified" && render.shots.length > 0
    && render.shots.every(row => row.jobId && row.taskId && row.mock === false && row.status !== "failed") ? "running" : "blocked";
}
function sameBytes(expected: ArtifactFingerprint): boolean {
  const current = fingerprintArtifact(expected.path);
  return current.realpath === expected.realpath && current.sha256 === expected.sha256 && current.bytes === expected.bytes;
}
function copyApprovedInput(original: ArtifactFingerprint, file: string): ArtifactFingerprint {
  try { copyFileSync(original.path, file, constants.COPYFILE_EXCL); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (realpathSync(file) !== file || !lstatSync(file).isFile()) {
    fail("NATIVE_POST_SOURCE_CHANGED", "The private post input must be an ordinary file");
  }
  const copy = fingerprintArtifact(file);
  if (copy.sha256 !== original.sha256 || copy.bytes !== original.bytes) fail("NATIVE_POST_SOURCE_CHANGED", "Private post copy differs from the approved original");
  return copy;
}
function localMediaEnv(dataRoot: string): NodeJS.ProcessEnv {
  const names = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "SYSTEMROOT", "WL_FFMPEG", "WL_FFPROBE", "WL_FONT_FILE"];
  return { ...Object.fromEntries(names.map(name => [name, process.env[name]])),
    WORKLOOM_VIDEO_ARTIFACT_ROOT: dataRoot, WORKLOOM_MEDIA_DIR: path.join(dataRoot, "media") };
}
async function formalLocalPost(dataRoot: string, home: string, args: string[], log: string): Promise<void> {
  const fd = openSync(log, "wx", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/tools/full-chain-film.mts", ...args],
        { cwd: ENGINE_ROOT, env: { ...localMediaEnv(dataRoot), HOME: home }, stdio: ["ignore", fd, fd], signal: AbortSignal.timeout(60 * 60_000) });
      child.once("error", reject);
      child.once("close", code => {
        if (code === 0) resolve();
        else reject(new ProductionClientError("NATIVE_POST_FAILED", "The existing local post workbench did not publish a verified mother; inspect the private log"));
      });
    });
  } finally { closeSync(fd); }
}
async function inspectMother(dataRoot: string, outDir: string, projectId: string, seconds: number, post: NativePostPlan,
  expectedClips: Array<{ id: string; origin: string; sha256: string }>) {
  const moduleUrl = pathToFileURL(path.join(ENGINE_ROOT, "bundles/geo-growth/capabilities/video.mjs")).href;
  const { deliveryInspect, deliveryQuality } = await import(moduleUrl);
  // This command runs in a dedicated owner-side process. Keep the capability
  // input scoped to that process's existing private artifact root.
  if (process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT !== dataRoot) {
    fail("POST_ARTIFACT_ROOT_MISMATCH", "Start the private delivery child with the current native artifact root");
  }
  const input = { projectId, outDir: path.relative(dataRoot, outDir) };
  const integrity = deliveryInspect(input);
  const quality = await deliveryQuality({ ...input, kind: "generation" });
  if (integrity.found !== true || integrity.integrity !== "verified" || quality.complete !== true
    || integrity.manifestPath !== quality.manifestPath || !SHA.test(quality.manifestSha256 ?? "")) {
    fail("NATIVE_MOTHER_UNVERIFIED", "The formal current publication pointer failed byte integrity or independent media checks");
  }
  const [delivered, ...duplicates] = integrity.files.filter((row: { label: string }) => row.label === "deliverable");
  if (!delivered?.path || delivered.state !== "verified" || duplicates.length) fail("NATIVE_MOTHER_UNVERIFIED", "Expected one verified master video");
  const master = fingerprintArtifact(path.join(dataRoot, delivered.path));
  const manifest = fingerprintArtifact(path.join(dataRoot, quality.manifestPath));
  if (master.path !== master.realpath || !master.path.startsWith(outDir + path.sep) || !/\.mp4$/i.test(master.path)
    || master.sha256 !== delivered.actualSha256 || manifest.sha256 !== quality.manifestSha256) {
    fail("NATIVE_MOTHER_UNVERIFIED", "The final deliverable moved or changed after technical verification");
  }
  const lineage = (JSON.parse(readFileSync(manifest.path, "utf8")) as {
    generationQuality?: {
      sources?: Array<{ id: string; origin: string; sha256: string }>;
      artifacts?: Array<{ id: string; sha256: string; requiredStages?: string[] }>;
      processing?: Array<{ stage: string; path: string; sha256: string }>;
    };
  }).generationQuality;
  const lineageSources = lineage?.sources?.map(({ id, origin, sha256 }) => ({ id, origin, sha256 }));
  const lineageMasters = lineage?.artifacts?.filter(row => row.id === "master");
  if (!lineageSources || productionHash(lineageSources) !== productionHash(expectedClips)
    || lineageMasters?.length !== 1 || lineageMasters[0]?.sha256 !== master.sha256 || !sameBytes(manifest)) {
    fail("NATIVE_MOTHER_SOURCE_MISMATCH", "The passed technical lineage does not bind this exact master to the accepted native shot copies in order");
  }
  const artifacts = new Set(lineage?.artifacts?.map(row => row.id));
  const hasPinnedMusic = !post.music || lineage?.processing?.some(proof => {
    if (proof.stage !== "bgm") return false;
    // The native technical inspector has already verified this proof file and its
    // actual consumed output lineage. Read the track identity from those bytes.
    const release = path.dirname(manifest.path), file = path.resolve(release, proof.path);
    if (!file.startsWith(release + path.sep) || realpathSync(file) !== file || fingerprintArtifact(file).sha256 !== proof.sha256) return false;
    const raw = JSON.parse(readFileSync(file, "utf8")) as { execution?: { trackSha256?: string } };
    return raw.execution?.trackSha256 === post.music?.sha256;
  });
  if ((post.cover && !artifacts.has("cover:master"))
    || (post.subtitles === "burn" && !lineageMasters?.[0]?.requiredStages?.includes("subtitles"))
    || (post.subtitles && post.subtitles !== "burn" && ![...artifacts].some(id => id.startsWith("subtitle:")))
    || (post.subtitles === "both" && !artifacts.has("softsub")) || !hasPinnedMusic) {
    fail("NATIVE_MOTHER_LAYERS_UNVERIFIED", "The current formal deliverable lacks a requested cover, subtitle or pinned music proof");
  }
  const measured = JSON.parse(execFileSync(process.env.WL_FFPROBE ?? "ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,duration:format=duration", "-of", "json", master.path,
  ], { encoding: "utf8", timeout: 30_000, maxBuffer: 1_048_576 })) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const video = measured.streams?.find(stream => stream.codec_type === "video");
  const hasAudio = measured.streams?.some(stream => stream.codec_type === "audio") === true;
  const [ratioWidth, ratioHeight] = post.aspect.split(":").map(Number);
  const [numerator, denominator] = (video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  const frameRate = numerator! / denominator!;
  const durationSec = Number(video?.duration ?? measured.format?.duration);
  if (!video?.width || !video.height || Math.abs(video.width / video.height - ratioWidth! / ratioHeight!) > 0.004
    || !Number.isFinite(frameRate) || Math.abs(frameRate - post.fps) > 0.001
    || !Number.isFinite(durationSec) || Math.abs(durationSec - seconds) > Math.max(0.12, 2 / post.fps) || !hasAudio) {
    fail("NATIVE_MOTHER_CONTRACT_MISMATCH", "Measured mother duration, frame rate, aspect or audio disagrees with the approved local delivery plan");
  }
  if (Math.min(video.width, video.height) !== Number(post.resolution.slice(0, -1))) {
    fail("NATIVE_MOTHER_RESOLUTION_MISMATCH", "Measured mother resolution disagrees with the approved local delivery plan");
  }
  return { master, manifest, measured: { durationSec, width: video.width, height: video.height, frameRate, hasAudio },
    technicalQuality: "passed" as const, artisticQuality: "unverified" as const };
}

/** Called with the active runtime's private session, never directly with agent-provided credentials. */
export interface NativeProjectDeliveryInput {
  client: ProductionClient; dataRoot: string; workspaceId: string; handoff: NativeDeliveryHandoff;
  render: { modelId: string; providerModel: string; maxEstimatedCny: number; params: Record<string, unknown> };
  post: NativePostPlan;
}
export async function runNativeProjectDelivery(input: NativeProjectDeliveryInput) {
  const { client, handoff, render, post } = input;
  const dataRoot = realDirectory(input.dataRoot, true);
  if (handoff.system !== "pengmanager" || !["marketing", "narrative"].includes(handoff.pipeline)
    || ![handoff.projectId, handoff.sourceStageRunId, handoff.runId, input.workspaceId].every(value => ID.test(value))
    || ![handoff.promptsSha256, handoff.intentSha256].every(value => SHA.test(value))
    || ![handoff.sourceAttempt, handoff.durationSeconds].every(value => Number.isSafeInteger(value) && value > 0)
    || !render.modelId.trim() || !render.providerModel.trim() || !Number.isFinite(render.maxEstimatedCny) || render.maxEstimatedCny < 0
    || !post.title.trim() || !post.platform.trim() || !["9:16", "16:9", "1:1", "4:5"].includes(post.aspect)
    || !["720p", "1080p", "2160p"].includes(post.resolution) || !Number.isSafeInteger(post.fps) || post.fps < 1 || post.fps > 120
    || (post.subtitles !== undefined && !["burn", "sidecar", "both"].includes(post.subtitles))
    || render.params.aspectRatio !== post.aspect) {
    fail("NATIVE_DELIVERY_PLAN_INVALID", "Exact native source, approved render limits and explicit local post contract are required");
  }
  if (process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT !== dataRoot) fail("POST_ARTIFACT_ROOT_MISMATCH", "Missing current private artifact root");
  if (post.music && (!path.isAbsolute(post.music.path) || !/\.(wav|flac|mp3|m4a|ogg|aac)$/i.test(post.music.path)
    || !SHA.test(post.music.licenseReceiptSha256) || realpathSync(post.music.path) !== post.music.path)) {
    fail("NATIVE_POST_MUSIC_UNVERIFIED", "Post requires the approved licensed track's canonical source");
  }
  const music = post.music ? fingerprintArtifact(post.music.path) : null;
  if (music && music.sha256 !== post.music?.sha256) fail("NATIVE_POST_MUSIC_UNVERIFIED", "The approved music bytes changed");
  const source = await client.shots(handoff.projectId);
  assertProductionSource(source, handoff);
  if (source.shots.reduce((total, shot) => total + shot.durationSec, 0) !== handoff.durationSeconds
    || source.shots.some(shot => !ID.test(shot.shotId))) fail("NATIVE_DELIVERY_SOURCE_INVALID", "The approved full ordered shot set is required");
  const requestSha256 = productionHash({ handoff, render, post });
  const job = makeDirectory(makeDirectory(makeDirectory(dataRoot, "native-deliveries"), handoff.projectId), `attempt-${handoff.sourceAttempt}-${handoff.sourceStageRunId}`);
  const runtimeConfigUrl = pathToFileURL(path.resolve(ENGINE_ROOT, "../../src/video-runtime/config.mjs")).href;
  const { acquireLock } = await import(runtimeConfigUrl);
  const release = acquireLock({ dataRoot: job }) as () => void;
  try {
    const journalPath = path.join(job, "render.json");
    let newJournal = true;
    const initial: RenderJournal = { schemaVersion: SCHEMA, requestSha256, render: null };
    try { writeFileSync(journalPath, JSON.stringify(initial) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      newJournal = false;
    }
    let renderResult: ProductionProjectResult;
    let hasProgress = false;
    const persist = (value: ProductionProjectResult): void =>
      { replaceJournal(journalPath, { schemaVersion: SCHEMA, requestSha256, render: safeRender(value) }); hasProgress = true; };
    const prior = newJournal ? initial : readPrivateJson(journalPath) as RenderJournal;
    if (prior?.schemaVersion !== SCHEMA || prior.requestSha256 !== requestSha256) fail("NATIVE_DELIVERY_REQUEST_CHANGED", "Existing native run has another immutable request");
    if (newJournal || (prior.preDispatchError && prior.render === null)) {
      try {
        const catalog = await client.request<{ models?: Array<{ id: string; effectiveProviderModel: string; available: boolean }> }>(
          "video.gen.catalog", { kind: "video", includeUnavailable: false, limit: 200 }, "GET");
        const selected = catalog?.models?.filter(row => row.id === render.modelId);
        if (selected?.length !== 1 || selected[0]?.available !== true || selected[0].effectiveProviderModel !== render.providerModel) {
          fail("NATIVE_RENDER_MODEL_CHANGED", "The approved supplier model no longer matches the current runnable media catalog");
        }
        renderResult = await renderServiceProject({ client, expectedSource: handoff, projectId: handoff.projectId, modelId: render.modelId,
          expectedProviderModel: render.providerModel, params: render.params, maxEstimatedCny: render.maxEstimatedCny, onProgress: persist });
      } catch (error) {
        // renderServiceProject persists the quoted snapshot before it can qualify
        // or submit. A read-only denial can safely be retried with the same plan.
        if (!hasProgress && error instanceof ProductionClientError) {
          replaceJournal(journalPath, { ...initial, preDispatchError: error.code });
        }
        throw error;
      }
    } else {
      if (!prior.render) fail("RECOVERY_REQUIRED", "Existing attempt has no settled local render receipt; inspect original native state before taking another action");
      renderResult = prior.render.status === "done" ? prior.render : await reconcileServiceProject({ client, expectedSource: handoff, previous: prior.render });
      persist(renderResult);
    }
    if (renderResult.status !== "done") return { schemaVersion: SCHEMA, projectId: handoff.projectId, state: pendingDeliveryState(renderResult),
      requestSha256, render: safeRender(renderResult), mother: null };
    const verify = () => verifyNativeRenderSources({ client, expectedSource: handoff, result: renderResult, providerModel: render.providerModel,
      workspaceId: input.workspaceId, mediaRoot: path.join(dataRoot, "media"), durationSeconds: handoff.durationSeconds });
    const accepted = await verify();
    if (accepted.some(item => !item.original.path.endsWith(".mp4"))) fail("NATIVE_POST_SOURCE_FORMAT", "The existing local film assembler requires native MP4 originals");
    const work = makeDirectory(job, "work");
    const clipDir = makeDirectory(makeDirectory(work, "clips"), handoff.projectId);
    const clips = accepted.map(item => ({ ...item, copy: copyApprovedInput(item.original, path.join(clipDir, `${item.shotId}.mp4`)) }));
    const pinnedMusic = music ? copyApprovedInput(music, path.join(work, `approved-bgm${path.extname(music.path).toLowerCase()}`)) : null;
    const provenance = frozenInput(path.join(job, "accepted-native-clips.json"), { schemaVersion: SCHEMA, requestSha256, handoff,
      clips: clips.map(({ actualCny: _cost, ...item }) => item) });
    const shotlist = frozenInput(path.join(job, "shotlist.json"), { projectId: handoff.projectId, title: post.title,
      durationSeconds: handoff.durationSeconds, aspect: post.aspect, resolution: post.resolution,
      shots: source.shots.map(shot => ({ ...shot.fields, shotId: shot.shotId, duration: shot.durationSec, prompt: shot.prompt })) });
    const emptyKeys = path.join(job, "post-without-model-keys.env");
    if (!existsSync(emptyKeys)) {
      try { writeFileSync(emptyKeys, "", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const keyStat = lstatSync(emptyKeys);
    if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.size !== 0 || realpathSync(emptyKeys) !== emptyKeys) {
      fail("NATIVE_POST_KEYS_INVALID", "Only an empty process-private model key file may enter formal post");
    }
    const outDir = makeDirectory(job, "delivery");
    const publishedDir = post.resolution === "2160p" ? makeDirectory(outDir, "uhd") : outDir;
    const expectedClips = clips.map(item => ({ id: item.shotId, origin: item.copy.path, sha256: item.copy.sha256 }));
    const inspect = () => inspectMother(dataRoot, publishedDir, handoff.projectId, handoff.durationSeconds, post, expectedClips);
    let mother: Awaited<ReturnType<typeof inspect>> | undefined;
    if (existsSync(path.join(publishedDir, "current.json"))) {
      try { mother = await inspect(); }
      catch (error) {
        if (!(error instanceof ProductionClientError) || error.code !== "NATIVE_MOTHER_RESOLUTION_MISMATCH") throw error;
        // The prior release is verified but used the source dimensions. Formal post will atomically publish a new release.
      }
    }
    if (!mother) {
      const stages = ["compose", ...(post.preserveColor ? ["color"] : []), ...(post.subtitles ? ["subtitle"] : []),
        ...(post.music ? ["bgm"] : []), ...(post.cover ? ["cover"] : []), ...(post.subtitles === "both" ? ["mux"] : []), "master"];
      await formalLocalPost(dataRoot, makeDirectory(job, "post-home"), ["--shots", shotlist.path, "--project", handoff.projectId, "--work-dir", work, "--out", outDir,
        "--keys-file", emptyKeys, "--assembly-mode", "post-only", "--assembly-reason", "原生服务签发已通过并独立核实原片字节，使用正式本地后期",
        "--route-kind", handoff.pipeline, "--platform", post.platform, "--aspect", post.aspect, "--resolution", post.resolution,
        "--fps", String(post.fps), "--stages", stages.join(","),
        // The approved native shots already sum to the full delivery length.
        // A requested still cover must not prepend an unapproved extra 0.6s.
        ...(post.cover ? ["--cover-intro-seconds", "0"] : []),
        ...(post.subtitles ? ["--subtitle-mode", post.subtitles] : []),
        ...(pinnedMusic ? ["--bgm-track", pinnedMusic.path] : [])], path.join(job, `post-workbench-${randomUUID()}.log`));
      mother = await inspect();
    }
    const current = await verify();
    const fileIdentity = (records: typeof current) => records.map(({ actualCny: _cost, ...item }) => item);
    if (productionHash(fileIdentity(current)) !== productionHash(fileIdentity(accepted))
      || ![provenance, shotlist, mother.master, mother.manifest, ...clips.map(item => item.copy)].every(sameBytes)
      || (music !== null && (!sameBytes(music) || !pinnedMusic || !sameBytes(pinnedMusic)))) fail("NATIVE_POST_SOURCE_CHANGED", "Current native sources or post inputs changed during composition");
    return { schemaVersion: SCHEMA, projectId: handoff.projectId, state: "delivered" as const, requestSha256, mother,
      sources: current.map(({ original, ...sourceReceipt }) => ({ ...sourceReceipt, sha256: original.sha256, bytes: original.bytes })) };
  } finally { release(); }
}

/** Read back the existing native delivery state without polling, submitting or editing local files. */
export async function inspectNativeProjectDelivery(input: NativeProjectDeliveryInput) {
  const { handoff, post, render } = input;
  const dataRoot = realDirectory(input.dataRoot, true);
  if (handoff.system !== "pengmanager" || !ID.test(handoff.projectId) || !ID.test(handoff.sourceStageRunId)
    || !Number.isSafeInteger(handoff.sourceAttempt) || handoff.sourceAttempt < 1) fail("NATIVE_DELIVERY_SOURCE_INVALID", "Invalid current owner handoff");
  const requestSha256 = productionHash({ handoff, render, post });
  const job = path.join(dataRoot, "native-deliveries", handoff.projectId, `attempt-${handoff.sourceAttempt}-${handoff.sourceStageRunId}`);
  const receipt = path.join(job, "render.json");
  if (!existsSync(receipt)) return { schemaVersion: SCHEMA, projectId: handoff.projectId, requestSha256, state: "not-started" as const, mother: null };
  realDirectory(job, true);
  const prior = readPrivateJson(receipt) as RenderJournal;
  if (prior?.schemaVersion !== SCHEMA || prior.requestSha256 !== requestSha256) fail("NATIVE_DELIVERY_REQUEST_CHANGED", "Existing native run has another immutable request");
  const outDir = path.join(job, "delivery", ...(post.resolution === "2160p" ? ["uhd"] : []));
  if (prior.render?.status !== "done" || !existsSync(path.join(outDir, "current.json"))) {
    return { schemaVersion: SCHEMA, projectId: handoff.projectId, requestSha256,
      state: prior.preDispatchError ? "blocked" as const : pendingDeliveryState(prior.render),
      ...(prior.preDispatchError ? { blockingCode: prior.preDispatchError } : {}),
      render: prior.render, mother: null };
  }
  realDirectory(outDir, true);
  const sources = await verifyNativeRenderSources({ client: input.client, expectedSource: handoff, result: prior.render, providerModel: render.providerModel,
    workspaceId: input.workspaceId, mediaRoot: path.join(dataRoot, "media"), durationSeconds: handoff.durationSeconds });
  try {
    const mother = await inspectMother(dataRoot, outDir, handoff.projectId, handoff.durationSeconds, post,
      sources.map(item => ({ id: item.shotId, origin: path.join(job, "work", "clips", handoff.projectId, `${item.shotId}.mp4`),
        sha256: item.original.sha256 })));
    return { schemaVersion: SCHEMA, projectId: handoff.projectId, requestSha256, state: "delivered" as const, mother,
      sources: sources.map(({ original, ...receipt }) => ({ ...receipt, sha256: original.sha256, bytes: original.bytes })) };
  } catch (error) {
    if (!(error instanceof ProductionClientError) || error.code !== "NATIVE_MOTHER_RESOLUTION_MISMATCH") throw error;
    return { schemaVersion: SCHEMA, projectId: handoff.projectId, requestSha256, state: "blocked" as const,
      postRecoveryCode: error.code, render: prior.render, mother: null };
  }
}
