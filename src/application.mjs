import { join, resolve } from "node:path";
import { JsonStore } from "./storage/json-store.mjs";
import { loadSeedState, migratePengManagerIdentity, migrateEditorialState } from "./services/bootstrap.mjs";
import { GeoOsService } from "./services/geo-os-service.mjs";
import { LivePipelineService } from "./services/live-pipeline.mjs";
import { createGeoOsServer } from "./http/server.mjs";
import { DeepSeekAdapter } from "./adapters/deepseek.mjs";
import { GitHubAdapter } from "./adapters/github.mjs";
import { VideoEditAdapter } from "./adapters/video-edit.mjs";
import { PersonalGeoEngine } from "./engines/geo-evidence.mjs";
import { VideoMediaEngine } from "./engines/video-media.mjs";
import { createVideoRuntime } from "./video-runtime/index.mjs";
import { createAdminAuth } from "./security/admin-auth.mjs";
import { createWorkloomLaunch } from "./security/workloom-launch.mjs";
import { AccountOperationsService } from "./services/account-operations.mjs";
import { createMacFinalContentBackup } from "./services/final-content-backup.mjs";
import { EditorialService } from "./services/editorial-service.mjs";
import { MediaAssets } from "./services/media-assets.mjs";
import { createWebsiteReadback } from "./services/website-readback.mjs";
import { createEditorialBackup } from "./services/editorial-backup.mjs";
import { ProductionArtifacts } from "./services/production-artifacts.mjs";
import { migrateContentOpsState } from "./services/content-ops-migration.mjs";
import { ContentOpsService } from "./services/content-ops-service.mjs";
import { contentOpsAdapterBindings } from "./content-ops-worker/adapters.mjs";
import { randomUUID } from "node:crypto";

const defaultRoot = resolve(import.meta.dirname, "..");

// Construction does not listen or start services. CLI and tests share the same
// lifecycle, including a failed video startup and a concurrent shutdown.
export async function createPengManagerApplication({
  rootDir = defaultRoot, env = process.env, videoRuntime, runtimeFactory = createVideoRuntime,
  logger = console, geoEngine: suppliedGeoEngine, mediaEngine: suppliedMediaEngine,
  livePipeline: suppliedLivePipeline,
  finalContentBackup = createMacFinalContentBackup(),
  httpDrainTimeoutMs = 10_000,
} = {}) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 4318);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535.");
  if (!Number.isSafeInteger(httpDrainTimeoutMs) || httpDrainTimeoutMs < 1 || httpDrainTimeoutMs > 30_000) throw new Error("HTTP drain timeout must be between 1 and 30000 ms.");
  const dataFile = resolve(rootDir, env.DATA_FILE || "var/state.json");
  const dataDir = join(rootDir, "data", "seed");
  const configuredHosts = env.ALLOWED_HOSTS?.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const allowedHosts = configuredHosts?.length ? configuredHosts : ["127.0.0.1", "localhost", "::1", "[::1]"];
  const auth = createAdminAuth({ env, host, allowedHosts });
  const workloomLaunch = createWorkloomLaunch({ env });
  const store = new JsonStore({ filePath: dataFile, writerLock: true });
  await store.open(() => loadSeedState(dataDir));
  let constructedGeo = null;
  let constructedRuntime = null;
  try {
  await migratePengManagerIdentity(store, dataDir);
  const publicOrigin = env.PUBLIC_ORIGIN || `http://${host === "::1" ? "[::1]" : host}:${port}`;
  await migrateEditorialState(store, { publicOrigin });
  const service = new GeoOsService({ store, finalContentBackup });
  let editorial;
  const mediaAssets = new MediaAssets({ store, publicAssetAuthorizer: (id, hash) => editorial?.isAssetPublic(id, hash) === true });
  await mediaAssets.initialize();
  const productionArtifacts = new ProductionArtifacts({ store }); await productionArtifacts.initialize();
  const editorialBackup = createEditorialBackup({ store, mediaAssets, productionArtifacts });
  await migrateContentOpsState(store, { beforeMigration: () => editorialBackup.captureCurrent() });
  const contentOps = new ContentOpsService({ store, artifactStore: productionArtifacts,
    adapterBindings: await contentOpsAdapterBindings({ rootDir }) });
  await contentOps.recover({ actor: "system", method: "local", idempotencyKey: randomUUID() });
  editorial = new EditorialService({ store, geoService: service, mediaAssets, productionArtifacts, publicOrigin,
    verifyReadback: createWebsiteReadback({ origin: publicOrigin, allowLoopback: env.NODE_ENV !== "production" && !env.PUBLIC_ORIGIN }),
    beforeActivation: editorialBackup });
  if (finalContentBackup) {
    await finalContentBackup.prepare();
    for (const content of store.snapshot().content) await service.backupFinalContent(content);
  }
  const accountOperations = new AccountOperationsService({ service, productionArtifacts, mediaAssets });
  const geoEngine = suppliedGeoEngine ?? new PersonalGeoEngine({
    rootDir, ...(env.GEO_ENGINE_DB ? { databasePath: resolve(rootDir, env.GEO_ENGINE_DB) } : {}),
    controlQueries: store.snapshot().queries,
  });
  constructedGeo = geoEngine;
  const mediaEngine = suppliedMediaEngine ?? new VideoMediaEngine({ rootDir });
  let runtime = videoRuntime;
  if (!runtime) {
    try { runtime = runtimeFactory({ rootDir, env, logger: () => undefined }); }
    catch {
      // Installation/configuration failure stays visible without exposing raw
      // provider errors or taking the existing JSON/GEO workflows offline.
      runtime = {
        async status() { return { ready: false, state: "error" }; },
        async capabilities() { throw new Error("VIDEO_RUNTIME_CONFIGURATION_INVALID"); },
        async start() { throw new Error("VIDEO_RUNTIME_CONFIGURATION_INVALID"); },
        async stop() { return { ready: false, state: "stopped" }; },
      };
    }
  }
  constructedRuntime = runtime;
  const livePipeline = suppliedLivePipeline ?? new LivePipelineService({
    service, deepSeek: new DeepSeekAdapter(), github: new GitHubAdapter(), geoEngine,
    videoEdit: new VideoEditAdapter({ upstreamRoot: join(rootDir, "engines", "video-edit") }), mediaEngine,
  });
  const server = createGeoOsServer({ service, livePipeline, geoEngine, videoRuntime: runtime,
    publicDir: join(rootDir, "public"), allowedHosts, auth, accountOperations, editorial, mediaAssets, contentOps, productionArtifacts,
    workloomLaunch,
    publicWebsite: env.PUBLIC_WEBSITE === "1", mediaRenderEnabled: env.ENABLE_MEDIA_RENDER !== "false" });
  let stopPromise = null;
  let videoStart = null;
  let listenPromise = null;
  let listening = false;
  let stopping = false;
  return {
    server, service, store, geoEngine, mediaEngine, auth, accountOperations, editorial, mediaAssets, editorialBackup, contentOps, productionArtifacts,
    videoRuntime: runtime, finalContentBackup, workloomLaunch,
    get videoStart() { return videoStart; },
    async listen(options = {}) {
      if (stopping) throw new Error("APPLICATION_STOPPED");
      if (listening) return server.address();
      if (listenPromise) return listenPromise;
      listenPromise = (async () => {
        await new Promise((done, reject) => {
          server.once("error", reject);
          server.listen(options.port ?? port, options.host ?? host, () => { server.removeListener("error", reject); done(); });
        });
        listening = true;
        logger.log?.(`鹏经理系统 · PengManager System: http://${options.host ?? host}:${server.address().port}`);
        videoStart = Promise.resolve().then(() => stopping || env.ENABLE_MEDIA_RENDER === "false" ? false : runtime.start()).then(
          result => result,
          () => { logger.error?.("视频工作台启动未完成；现有控制台继续运行，请查看视频工作台状态并运行本地诊断。"); return false; },
        );
        return server.address();
      })().finally(() => { listenPromise = null; });
      return listenPromise;
    },
    async stop() {
      if (stopPromise) return stopPromise;
      stopping = true;
      server.beginShutdown();
      stopPromise = (async () => {
        // A signal arriving while listen() is pending must not leave a late
        // HTTP listener behind after shutdown has already completed.
        if (listenPromise) await Promise.allSettled([listenPromise]);
        const closeHttp = new Promise((done, reject) => {
          if (!server.listening) return done();
          const deadline = setTimeout(() => server.closeAllConnections(), httpDrainTimeoutMs);
          deadline.unref();
          server.close(error => { clearTimeout(deadline); error ? reject(error) : done(); });
          server.closeIdleConnections?.();
        });
        const results = await Promise.allSettled([closeHttp, Promise.resolve().then(() => runtime.stop())]);
        await videoStart;
        try { await geoEngine.close(); } catch (error) { results.push({ status: "rejected", reason: error }); }
        try { await store.close(); } catch (error) { results.push({ status: "rejected", reason: error }); }
        listening = false;
        if (results.some(result => result.status === "rejected")) throw new Error("APPLICATION_SHUTDOWN_FAILED");
      })();
      return stopPromise;
    },
  };
  } catch (error) {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => constructedRuntime?.stop()),
      Promise.resolve().then(() => constructedGeo?.close()),
      store.close(),
    ]);
    if (cleanup.some(result => result.status === "rejected")) logger.error?.("应用初始化失败，部分资源关闭未完成，请检查进程和状态锁。");
    throw error;
  }
}
