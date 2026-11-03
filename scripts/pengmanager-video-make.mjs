/** Owner-only local entry. The broad Agent/MCP surface does not run this command. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createVideoRuntime, VideoRuntimeError } from '../src/video-runtime/index.mjs';
import { runtimeConfig, requireEngineModule, verifiedPortraitReuseManifest, SCOPE } from '../src/video-runtime/config.mjs';
import { localJson, wait } from '../src/video-runtime/process.mjs';
import { advanceVideoMakeDelivery, approvedVideoMakeAuthority, createNativeVideoMake, createVideoMakeStore, identifyVideoMake, readPrivateVideoJson } from '../src/video-runtime/video-make.mjs';

const rootDir = path.resolve(import.meta.dirname, '..');
const fail = (code, message) => { throw new VideoRuntimeError(code, message); };
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const envLimit = (env, key, max, integer = true) => {
  const value = Number(env[key]);
  return positive(value) && (!integer || Number.isSafeInteger(value)) && value <= max;
};

function argumentsOf(args) {
  const [action, ...tail] = args;
  if (!['start', 'status', 'resume', 'deliver', 'identify'].includes(action)) fail('VIDEO_MAKE_ARGUMENT_INVALID', 'Use start|resume|deliver|identify with the exact brief JSON on stdin, or status <receipt-id>. Optional --data-dir PATH.');
  const id = action === 'status' ? tail.shift() : null;
  if (action === 'status' && !/^[a-f0-9]{64}$/.test(id ?? '')) fail('VIDEO_MAKE_ID_INVALID', 'Use the exact video make receipt ID.');
  if (tail.length !== 0 && (tail.length !== 2 || tail[0] !== '--data-dir' || !tail[1] || action === 'identify')) {
    fail('VIDEO_MAKE_ARGUMENT_INVALID', 'Optional --data-dir PATH must be the final two arguments.');
  }
  return { action, id, dataDir: tail[1] };
}

async function requestFromStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 16 * 1024) fail('VIDEO_MAKE_REQUEST_INVALID', 'Brief JSON exceeded 16 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return fail('VIDEO_MAKE_REQUEST_INVALID', 'The brief must be a complete JSON object on stdin.'); }
}

async function qualify(config, native, authority, pipeline) {
  const { env } = config;
  const { creative, render } = authority;
  if (env.PIPELINE_COORDINATOR !== 'enforce' || !['all', pipeline].includes(env.PIPELINE_SCOPE)
    || !envLimit(env, 'VM_CREATIVE_BUDGET_CNY', creative.maxCny, false)
    || !envLimit(env, 'VM_CREATIVE_MAX_CALLS', creative.maxCalls)
    || !envLimit(env, 'VM_CREATIVE_MAX_TOKENS', creative.maxTokens)
    || !envLimit(env, 'VM_CREATIVE_MAX_WALL_MS', creative.maxWallMs)) return 'NATIVE_CREATIVE_BUDGET_REQUIRED';
  const status = await native.onboarding();
  if (status?.dataMode !== 'real' || status.workspaceId !== SCOPE.workspaceId || status.llm?.real !== true
    || status.formalActivationRecorded === false) return 'NATIVE_REAL_MODE_REQUIRED';
  let price;
  try { price = JSON.parse(env.VM_CREATIVE_MODEL_PRICES || '{}')[status.llm.model]; }
  catch { return 'NATIVE_CREATIVE_PRICE_REQUIRED'; }
  if (!positive(price?.inputCnyPerMillion) || !positive(price?.outputCnyPerMillion)) return 'NATIVE_CREATIVE_PRICE_REQUIRED';
  const catalog = await native.catalog();
  const model = catalog?.models?.find(model => model.id === render.modelId && model.available === true && model.availability === 'wired'
    && (model.effectiveProviderModel ?? model.providerModel) === render.providerModel);
  if (!model) return 'NATIVE_RENDER_MODEL_UNVERIFIED';
  const seconds = model.limits?.durationSec?.min;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) return 'NATIVE_RENDER_DURATION_UNVERIFIED';
  const quote = await native.estimate({ modelId: render.modelId, seconds });
  if (quote?.model?.id !== render.modelId || quote?.allowed !== true || !positive(quote.estimate?.cny)
    || !positive(quote.spend?.caps?.dailyCapCny) || !positive(quote.spend?.caps?.monthlyCapCny)
    || quote.estimate.cny > render.maxEstimatedCny) return 'NATIVE_RENDER_PRICE_OR_CAP_UNVERIFIED';
  return null;
}

async function run() {
  const { action, id, dataDir } = argumentsOf(process.argv.slice(2));
  const request = action === 'status' ? null : await requestFromStdin();
  const identity = request && identifyVideoMake(request);
  if (action === 'identify') return identity;
  const base = runtimeConfig({ rootDir, dataDir });
  const store = createVideoMakeStore(base.dataRoot);
  const row = store.read(id ?? identity.id);
  if (action !== 'start' && !row) fail('VIDEO_MAKE_NOT_FOUND', 'No local owner receipt for the requested ID or brief.');
  if (row?.operations.at(-1)?.state === 'pending') {
    return { schemaVersion: row.schemaVersion, id: row.id, system: row.system, durationSeconds: row.durationSeconds,
      intentSha256: row.intentSha256, state: 'blocked', code: 'NATIVE_MUTATION_OUTCOME_UNKNOWN', operation: row.operations.at(-1).kind,
      ...(row.projectId && { projectId: row.projectId, runId: row.runId }) };
  }
  const policyFile = path.join(base.dataRoot, 'video-make-authority.json');
  const readAuthority = ({ forReadback = false } = {}) => approvedVideoMakeAuthority(
    readPrivateVideoJson(policyFile, { optional: true }), identity ?? row, forReadback ? Number.MIN_SAFE_INTEGER : Date.now());
  const authority = readAuthority({ forReadback: action === 'status' });
  const policyHash = authority?.sha256;
  if (action === 'start' && !row && !authority) {
    return { schemaVersion: 'pengmanager.video-make/v1', ...identity, state: 'blocked', code: 'OWNER_PRODUCTION_AUTHORITY_REQUIRED' };
  }
  const portraitReuseManifestPath = authority?.portraitManifest ? path.join(base.dataRoot, authority.portraitManifest) : undefined;
  const config = runtimeConfig({ rootDir, dataDir: base.dataRoot, portraitReuseManifestPath });
  if (authority) {
    const environmentKeys = ['PIPELINE_COORDINATOR', 'PIPELINE_SCOPE', 'VM_CREATIVE_BUDGET_CNY', 'VM_CREATIVE_MAX_CALLS',
      'VM_CREATIVE_MAX_TOKENS', 'VM_CREATIVE_MAX_WALL_MS', 'VM_CREATIVE_MODEL_PRICES', 'VM_CREATIVE_EXTERNAL_PRICES'];
    authority.sha256 = createHash('sha256').update(JSON.stringify([authority.sha256, config.portraitReuseManifest?.sha256 ?? null,
      environmentKeys.map(key => config.env[key] ?? null)])).digest('hex');
  }
  const runtime = createVideoRuntime({ rootDir, dataDir: config.dataRoot, portraitReuseManifestPath, serveWorkbench: config.serveWorkbench,
    logger: message => process.stderr.write('[video] ' + message + '\n') });
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const startup = await runtime.start();
    if (!startup.ready || !startup.dbHealth?.owned) fail('NATIVE_OWNER_RUNTIME_REQUIRED', 'The owned local PostgreSQL and native service must be ready.');
    const session = await runtime.nativeSession();
    if (session.identity?.tenantId !== SCOPE.tenantId || session.identity?.workspaceId !== SCOPE.workspaceId || session.identity?.role !== 'owner') {
      fail('NATIVE_SESSION_SCOPE_MISMATCH', 'The current private owner session is outside PengManager scope.');
    }
    const api = 'http://127.0.0.1:' + config.ports.backend;
    async function query(route, input, method = 'GET') {
      const queryString = method === 'GET' && input !== undefined ? '?input=' + encodeURIComponent(JSON.stringify(input)) : '';
      const envelope = await localJson(api + '/trpc/' + route + queryString, { method, ...(method === 'POST' ? { body: input } : {}),
        headers: { authorization: 'Bearer ' + session.token }, timeoutMs: 60_000, signal: stop.signal });
      return envelope.result?.data?.json ?? envelope.result?.data;
    }
    const { tsImport } = requireEngineModule(config, 'tsx/esm/api');
    const loadStudio = name => tsImport(pathToFileURL(path.join(config.engineRoot, 'packages', 'video-studio', 'src', name + '.ts')).href, import.meta.url);
    const [{ routeVideoPipeline }, { ProductionClient }] = await Promise.all(['pipeline-router', 'production-client'].map(loadStudio));
    const production = new ProductionClient({ api, token: session.token, timeoutMs: 60_000 });
    const native = {
      start: input => query('video.studio.start', input, 'POST'),
      resume: input => query('video.studio.resume', input, 'POST'),
      status: runId => query('video.studio.status', { runId }),
      archive: projectId => query('video.studio.archive', { projectId }),
      shots: projectId => production.shots(projectId),
      onboarding: () => query('onboarding.status'),
      catalog: () => query('video.gen.catalog', { kind: 'video', limit: 200, includeUnavailable: false }),
      estimate: input => query('video.gen.estimate', input),
    };
    let delivery;
    const assertApproved = async ({ authority, pipeline }) => {
      if (readAuthority()?.sha256 !== policyHash) return 'FROZEN_OWNER_AUTHORITY_CHANGED';
      verifiedPortraitReuseManifest(config);
      const blocker = await qualify(config, native, authority, pipeline);
      if (blocker) return blocker;
      if (readAuthority()?.sha256 !== policyHash) return 'FROZEN_OWNER_AUTHORITY_CHANGED';
      verifiedPortraitReuseManifest(config);
      delivery ??= await loadStudio('native-project-delivery');
      if (typeof delivery.runNativeProjectDelivery !== 'function') return 'NATIVE_DELIVERY_MODULE_MISSING';
      return null;
    };
    const callDelivery = async (method, handoff, render, post) => {
      const params = { ...render.params };
      const selection = render.referenceSelection;
      if (selection) {
        const source = await production.shots(handoff.projectId);
        if (source.sourceStageRunId !== handoff.sourceStageRunId || source.sourceAttempt !== handoff.sourceAttempt
          || source.promptsSha256 !== handoff.promptsSha256) fail('NATIVE_ARCHIVE_MISMATCH', 'The current native source changed.');
        const refs = [];
        if (selection.character) {
          const candidates = source.characterReferences?.filter(row => row.characterId === selection.character.characterId && row.angle === selection.character.angle);
          if (candidates?.length !== 1 || !/^portrait:sha256:[a-f0-9]{64}$/.test(candidates[0].ref)) fail('NATIVE_REFERENCE_REQUIRED', 'The approved character reference is missing or ambiguous.');
          refs.push(candidates[0].ref);
        }
        if (selection.productId) {
          const candidates = source.productReferences?.filter(row => row.productId === selection.productId);
          if (candidates?.length !== 1 || !/^product:sha256:[a-f0-9]{64}$/.test(candidates[0].ref)) fail('NATIVE_REFERENCE_REQUIRED', 'The approved product reference is missing or ambiguous.');
          refs.push(candidates[0].ref);
        }
        if (refs.length) params.referenceImageUrls = refs;
      }
      const previous = process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT;
      process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = config.dataRoot;
      try {
        delivery ??= await loadStudio('native-project-delivery');
        if (typeof delivery[method] !== 'function') fail('NATIVE_DELIVERY_MODULE_MISSING', 'The native delivery method is unavailable.');
        return await delivery[method]({ client: production, dataRoot: config.dataRoot,
          workspaceId: SCOPE.workspaceId, handoff, render: { modelId: render.modelId, providerModel: render.providerModel,
            maxEstimatedCny: render.maxEstimatedCny, params }, post });
      } finally {
        if (previous === undefined) delete process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT;
        else process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = previous;
      }
    };
    const downstream = (handoff, render, post) => advanceVideoMakeDelivery({
      receipt: { schemaVersion: 'pengmanager.video-make/v1', ...identity, projectId: handoff.projectId, runId: handoff.runId },
      inspect: () => callDelivery('inspectNativeProjectDelivery', handoff, render, post),
      checkAdmission: () => assertApproved({ authority, pipeline: handoff.pipeline }),
      run: () => callDelivery('runNativeProjectDelivery', handoff, render, post),
    });
    const make = createNativeVideoMake({ store, native, selectRoute: routeVideoPipeline, qualifyStart: assertApproved, downstream });
    if (action === 'status') {
      const result = await make.status(id);
      if (result.state !== 'render_ready') return result;
      if (!authority) return { ...result, deliveryInspection: 'OWNER_PRODUCTION_AUTHORITY_REQUIRED' };
      const delivered = await callDelivery('inspectNativeProjectDelivery', result.handoff, authority.render, authority.post);
      return { ...result, delivery: delivered, state: delivered.state === 'not-started' ? result.state : delivered.state };
    }
    if (action === 'deliver') return await make.deliver(request, authority);
    let result = await make[action](request, authority);
    const deadline = Date.now() + (authority?.creative.maxWallMs ?? 0) + 30_000;
    while (result.state === 'running' && Date.now() < deadline) {
      await wait(3000, stop.signal);
      result = await make.status(identity.id);
    }
    if (result.state === 'running') return { ...result, state: 'blocked', code: 'NATIVE_WAIT_DEADLINE_READBACK_REQUIRED' };
    if (result.state === 'render_ready') return await make.deliver(request, authority);
    return result;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    await runtime.stop();
  }
}

try {
  const result = await run();
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.state === 'blocked') process.exitCode = 2;
} catch (cause) {
  process.stdout.write(JSON.stringify({ schemaVersion: 'pengmanager.video-make/v1', state: 'blocked',
    code: typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(cause.code) ? cause.code : 'NATIVE_VIDEO_MAKE_FAILED' }) + '\n');
  process.exitCode = 2;
}
