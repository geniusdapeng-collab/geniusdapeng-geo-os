import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { acquireLock, privateDirectory, VideoRuntimeError } from './config.mjs';

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const SCHEMA = 'pengmanager.video-make/v1';
const POLICY_SCHEMA = 'pengmanager.video-make-authority/v1';
const ACTIVE = new Set(['queued', 'running', 'waiting']);
const RECOVERABLE = new Set(['failed', 'interrupted']);
const STAGE = 'preproduction';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && ID.test(value);
const digest = text => createHash('sha256').update(text).digest('hex');
const error = (code, message) => new VideoRuntimeError(code, message);
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function identifyVideoMake(request) {
  if (!object(request) || Object.keys(request).some(key => !['system', 'intent', 'durationSeconds'].includes(key))
    || request.system !== 'pengmanager' || typeof request.intent !== 'string' || !request.intent.isWellFormed() || !request.intent.trim() || request.intent.length > 2000
    || !Number.isSafeInteger(request.durationSeconds) || request.durationSeconds < 5 || request.durationSeconds > 180) {
    throw error('VIDEO_MAKE_REQUEST_INVALID', 'Provide the exact brief, system pengmanager, and an integer duration from 5 to 180 seconds.');
  }
  const intentSha256 = digest(request.intent);
  const { system, durationSeconds } = request;
  return { id: digest(stable({ system, intentSha256, durationSeconds })), system, intentSha256, durationSeconds };
}

/** Policy/receipts are kept inside the existing owner-only runtime, outside source. */
export function readPrivateVideoJson(file, { optional = false, maxBytes = 512 * 1024 } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const state = fs.fstatSync(fd);
    if (!state.isFile() || state.nlink !== 1 || state.size < 1 || state.size > maxBytes || fs.realpathSync(file) !== file
      || (process.platform !== 'win32' && ((state.mode & 0o077) || (process.getuid && state.uid !== process.getuid())))) {
      throw error('VIDEO_MAKE_PRIVATE_FILE_INVALID', 'Video make requires a bounded, owner-only ordinary file in its private runtime.');
    }
    const bytes = Buffer.alloc(state.size + 1);
    let n = 0;
    while (n < bytes.length) {
      const count = fs.readSync(fd, bytes, n, bytes.length - n, null);
      if (!count) break;
      n += count;
    }
    if (n !== state.size) throw error('VIDEO_MAKE_PRIVATE_FILE_INVALID', 'Private video make file changed during read.');
    return JSON.parse(bytes.subarray(0, n).toString('utf8'));
  } catch (cause) {
    if (optional && cause.code === 'ENOENT') return null;
    if (cause instanceof VideoRuntimeError) throw cause;
    throw error('VIDEO_MAKE_PRIVATE_FILE_INVALID', 'Could not verify the private video make file.');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function approvedVideoMakeAuthority(policy, identity, now = Date.now()) {
  if (!policy || policy.schemaVersion !== POLICY_SCHEMA || !Array.isArray(policy.approvedRequests)) return null;
  const matches = policy.approvedRequests.filter(row => row?.intentSha256 === identity.intentSha256 && row.durationSeconds === identity.durationSeconds);
  if (matches.length !== 1) return null;
  const value = matches[0];
  if (!(Date.parse(value.validUntil) > now) || !object(value.metadata) || !object(value.render)
    || !object(value.creative) || !positive(value.creative.maxCny)
    || ![value.creative.maxCalls, value.creative.maxTokens, value.creative.maxWallMs].every(n => Number.isSafeInteger(n) && n > 0)
    || value.creative.maxWallMs > 2_147_483_647
    || !object(value.post) || typeof value.post.title !== 'string' || !value.post.title.trim()
    || typeof value.post.platform !== 'string' || !value.post.platform.trim()
    || !['9:16', '16:9', '1:1', '4:5'].includes(value.post.aspect)
    || !['720p', '1080p', '2160p'].includes(value.post.resolution)
    || !Number.isSafeInteger(value.post.fps) || value.post.fps < 1 || value.post.fps > 120
    || !object(value.render.params) || value.render.params.aspectRatio !== value.post.aspect
    || (value.render.referenceSelection !== undefined && (!object(value.render.referenceSelection)
      || value.render.params.referenceImageUrls !== undefined
      || (value.render.referenceSelection.character !== undefined && (!object(value.render.referenceSelection.character)
        || !identifier(value.render.referenceSelection.character.characterId) || !identifier(value.render.referenceSelection.character.angle)))
      || (value.render.referenceSelection.productId !== undefined && !identifier(value.render.referenceSelection.productId))))
    || !identifier(value.render.modelId) || !identifier(value.render.providerModel) || !positive(value.render.maxEstimatedCny)
    || (value.metadata.brief !== undefined && !object(value.metadata.brief))
    || (value.metadata.brief?.duration !== undefined && Number(value.metadata.brief.duration) !== identity.durationSeconds)
    || (value.metadata.durationSec !== undefined && value.metadata.durationSec !== identity.durationSeconds)
    || (value.portraitManifest !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(value.portraitManifest))) return null;
  const metadata = { ...value.metadata, durationSec: identity.durationSeconds,
    brief: { ...value.metadata.brief, duration: identity.durationSeconds } };
  return { metadata, creative: value.creative, render: value.render, post: value.post, portraitManifest: value.portraitManifest ?? null, sha256: digest(stable(value)) };
}

export function createVideoMakeStore(dataRoot) {
  const parent = privateDirectory(dataRoot);
  const root = privateDirectory(path.join(parent, 'video-make'));
  if (root !== path.join(parent, 'video-make')) throw error('VIDEO_MAKE_PRIVATE_FILE_INVALID', 'The video make receipt directory is redirected.');
  const file = id => {
    if (!SHA.test(id)) throw error('VIDEO_MAKE_ID_INVALID', 'Use the exact video make ID from its receipt.');
    return path.join(root, id + '.json');
  };
  const read = id => {
    const receipt = readPrivateVideoJson(file(id), { optional: true });
    if (receipt && (receipt.schemaVersion !== SCHEMA || receipt.id !== id || !Array.isArray(receipt.operations)
      || !SHA.test(receipt.intentSha256) || !SHA.test(receipt.authoritySha256) || !['marketing', 'narrative'].includes(receipt.pipeline)
      || receipt.system !== 'pengmanager' || !Number.isSafeInteger(receipt.durationSeconds) || receipt.durationSeconds < 1
      || receipt.operations.length === 0 || receipt.operations.some((operation, index) => operation?.kind !== (index ? 'resume' : 'start')
        || !['pending', 'acknowledged', 'noaction', 'busy', 'awaiting_approval', 'clarify'].includes(operation?.state)
        || (operation.state === 'acknowledged' && (!identifier(operation.runId) || !identifier(operation.projectId)))))) {
      throw error('VIDEO_MAKE_RECEIPT_INVALID', 'The existing owner receipt is invalid. Preserve it for reconciliation.');
    }
    const acknowledged = receipt?.operations.filter(operation => operation.state === 'acknowledged');
    const last = acknowledged?.at(-1);
    if (receipt && (receipt.runId !== last?.runId || receipt.projectId !== last?.projectId
      || acknowledged.some(operation => operation.projectId !== receipt.projectId))) {
      throw error('VIDEO_MAKE_RECEIPT_INVALID', 'The local receipt changed its acknowledged native scope.');
    }
    return receipt;
  };
  function write(receipt) {
    const target = file(receipt.id);
    const temporary = target + '.' + randomBytes(12).toString('hex') + '.tmp';
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(receipt) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
      if (process.platform !== 'win32') {
        const directory = fs.openSync(root, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  return {
    read, write,
    async locked(id, run) {
      const lockRoot = privateDirectory(file(id) + '.state');
      const release = acquireLock({ dataRoot: lockRoot });
      try { return await run(); } finally { release(); }
    },
  };
}

function receiptResult(identity, state, fields = {}) {
  const { id, intentSha256, durationSeconds } = identity;
  return { schemaVersion: SCHEMA, id, system: 'pengmanager', intentSha256, durationSeconds, state, ...fields };
}

export async function advanceVideoMakeDelivery({ receipt, inspect, checkAdmission, run }) {
  const current = await inspect();
  if (current.state === 'delivered') return { ...receipt, state: current.state, delivery: current };
  if (current.state === 'not-started' || (current.state === 'blocked' && current.blockingCode)) {
    const blocker = await checkAdmission();
    if (blocker) return { ...receipt, state: 'blocked', code: blocker };
  }
  // Existing accepted or ambiguous operations may already consume the cap.
  const result = await run();
  return { ...receipt, state: result.state, delivery: result };
}

function nativeIdentity(receipt, status, archive, shots) {
  if (status && status.projectId !== receipt.projectId) return null;
  if (!archive || archive.projectId !== receipt.projectId || !Array.isArray(archive.stages)) return null;
  const current = archive.stages.filter(row => row?.stageId === STAGE).sort((a, b) => b.attempt - a.attempt)[0];
  if (!current || current.runId !== receipt.runId || current.status !== 'done' || archive.archiveExists !== true
    || !Number.isSafeInteger(current.attempt) || current.attempt < 1
    || current.outputRef !== `stages/preproduction/attempt-${current.attempt}.output.json` || !SHA.test(current.outputSha256)) return null;
  if (shots?.projectId !== receipt.projectId || !identifier(shots.sourceStageRunId) || shots.sourceAttempt !== current.attempt || !SHA.test(shots.promptsSha256)
    || !Array.isArray(shots.shots) || shots.shots.reduce((seconds, shot) => seconds + shot.durationSec, 0) !== receipt.durationSeconds) return null;
  return { system: 'pengmanager', projectId: receipt.projectId, runId: receipt.runId, pipeline: receipt.pipeline, intentSha256: receipt.intentSha256,
    durationSeconds: receipt.durationSeconds, sourceStageRunId: shots.sourceStageRunId, sourceAttempt: shots.sourceAttempt,
    promptsSha256: shots.promptsSha256, outputSha256: current.outputSha256 };
}

/** No generic RPC. All mutations and reads are bound by the caller to the current owned native runtime. */
export function createNativeVideoMake({ store, native, selectRoute, qualifyStart, downstream }) {
  async function readCurrent(row) {
    const latest = row.operations.at(-1);
    if (latest.state === 'pending') return receiptResult(row, 'blocked', {
      code: 'NATIVE_MUTATION_OUTCOME_UNKNOWN', operation: latest.kind,
      ...(row.projectId && { projectId: row.projectId, runId: row.runId }),
    });
    if (!row.runId) return receiptResult(row, 'blocked', { code: 'NATIVE_ROUTE_CLARIFICATION_REQUIRED' });
    let status, archive;
    try {
      [status, archive] = await Promise.all([native.status(row.runId), native.archive(row.projectId)]);
    } catch {
      return receiptResult(row, 'blocked', { code: 'NATIVE_READBACK_UNAVAILABLE', projectId: row.projectId, runId: row.runId });
    }
    const ids = { projectId: row.projectId, runId: row.runId, pipeline: row.pipeline };
    const current = archive?.projectId === row.projectId && Array.isArray(archive.stages)
      ? archive.stages.filter(stage => stage?.stageId === STAGE).sort((a, b) => b.attempt - a.attempt)[0] : null;
    if ((status && (status.projectId !== row.projectId || (status.legacy !== false && status.runId !== row.runId)))
      || (current && current.runId !== row.runId)) return receiptResult(row, 'blocked', { code: 'NATIVE_RUN_SCOPE_CHANGED', ...ids });
    if (archive?.pendingApprovalId || status?.pendingApprovalId || status?.blocker?.kind === 'approval') return receiptResult(row, 'blocked', { code: 'NATIVE_APPROVAL_REQUIRED', ...ids });
    if (status?.status === 'reconciling' || status?.blocker?.kind === 'unknown_operation') return receiptResult(row, 'blocked', { code: 'NATIVE_USAGE_RECONCILIATION_REQUIRED', ...ids });
    if (current?.status === 'done') {
      try {
        const handoff = nativeIdentity(row, status, archive, await native.shots(row.projectId));
        if (handoff) return receiptResult(row, 'render_ready', { ...ids, handoff });
      } catch {
        return receiptResult(row, 'blocked', { code: 'NATIVE_SHOTS_UNVERIFIED', ...ids });
      }
      return receiptResult(row, 'blocked', { code: 'NATIVE_ARCHIVE_MISMATCH', ...ids });
    }
    if (current?.status === 'running' && (!status || (status.legacy === false
      && (!status.leaseExpiresAt || Date.parse(status.leaseExpiresAt) <= Date.now())))) {
      // A stopped process may leave a running stage. Native resume owns the lease
      // and unknown-cost checks, so only an explicit resume may reconcile it.
      return receiptResult(row, 'blocked', { code: 'NATIVE_PREPRODUCTION_INTERRUPTED', ...ids, resumable: true });
    }
    if (ACTIVE.has(status?.status) || current?.status === 'running'
      || (!status && !current && Date.now() - Date.parse(latest.acknowledgedAt) < 60_000)) return receiptResult(row, 'running', ids);
    if (RECOVERABLE.has(current?.status)) {
      const failureCode = typeof current.errorClass === 'string' && /^[A-Z][A-Z0-9_]{0,119}$/.test(current.errorClass) ? current.errorClass : null;
      return receiptResult(row, 'blocked', { code: 'NATIVE_PREPRODUCTION_FAILED', ...ids, failureCode, resumable: failureCode !== 'RECEIPT_UNVERIFIED' });
    }
    return receiptResult(row, 'blocked', { code: 'NATIVE_PREPRODUCTION_UNVERIFIED', ...ids });
  }

  async function dispatch(row, kind, input) {
    const operation = { kind, state: 'pending', requestedAt: new Date().toISOString() };
    row.operations.push(operation);
    store.write(row); // Persist before POST. An interruption cannot become a new start.
    let reply;
    try { reply = await native[kind](input); }
    catch { return readCurrent(row); }
    if (kind === 'start' && reply?.kind === 'clarify') {
      operation.state = 'clarify';
    } else if (kind === 'resume' && ['busy', 'noaction', 'awaiting_approval'].includes(reply?.kind)) {
      operation.state = reply.kind;
      store.write(row);
      return receiptResult(row, 'blocked', { code: reply.kind === 'awaiting_approval' ? 'NATIVE_APPROVAL_REQUIRED' : reply.kind === 'busy' ? 'NATIVE_RESUME_BUSY' : 'NATIVE_RESUME_NO_ACTION',
        projectId: row.projectId, runId: row.runId });
    } else {
      const valid = identifier(reply?.runId) && (kind === 'start'
        ? reply.kind === 'routed' && reply.pipeline === row.pipeline && identifier(reply.projectId)
        : reply.kind === 'resumed' && reply.stage === STAGE && reply.runId !== row.runId);
      if (!valid) return readCurrent(row);
      row.runId = reply.runId;
      row.projectId = kind === 'start' ? reply.projectId : row.projectId;
      Object.assign(operation, { state: 'acknowledged', runId: row.runId, projectId: row.projectId, acknowledgedAt: new Date().toISOString() });
    }
    store.write(row);
    return readCurrent(row);
  }

  return {
    async start(request, authority) {
      const identity = identifyVideoMake(request);
      return store.locked(identity.id, async () => {
        const existing = store.read(identity.id);
        if (existing) return readCurrent(existing);
        if (!authority) return receiptResult(identity, 'blocked', { code: 'OWNER_PRODUCTION_AUTHORITY_REQUIRED' });
        const decision = await selectRoute({ text: request.intent, metadata: authority.metadata });
        if (!['marketing', 'narrative'].includes(decision?.route)) return receiptResult(identity, 'blocked', {
          code: decision?.route === 'explainer' ? 'NATIVE_EXPLAINER_HANDOFF_REQUIRED' : 'NATIVE_ROUTE_CLARIFICATION_REQUIRED',
        });
        const blocker = await qualifyStart({ authority, pipeline: decision.route });
        if (blocker) return receiptResult(identity, 'blocked', { code: blocker });
        if (!SHA.test(authority.sha256)) throw error('VIDEO_MAKE_AUTHORITY_INVALID', 'Owner policy fingerprint is missing.');
        const row = { schemaVersion: SCHEMA, ...identity, pipeline: decision.route, authoritySha256: authority.sha256, operations: [] };
        return dispatch(row, 'start', { route: row.pipeline, intent: request.intent, metadata: authority.metadata });
      });
    },
    async status(id) {
      const row = store.read(id);
      if (!row) throw error('VIDEO_MAKE_NOT_FOUND', 'No local owner receipt for the requested ID.');
      return readCurrent(row);
    },
    async resume(request, authority) {
      const identity = identifyVideoMake(request);
      return store.locked(identity.id, async () => {
        const row = store.read(identity.id);
        if (!row) throw error('VIDEO_MAKE_NOT_FOUND', 'No local owner receipt for the requested brief.');
        const result = await readCurrent(row);
        if (result.resumable !== true) return result;
        if (authority?.sha256 !== row.authoritySha256) return receiptResult(row, 'blocked', { code: 'FROZEN_OWNER_AUTHORITY_CHANGED' });
        const blocker = await qualifyStart({ authority, pipeline: row.pipeline });
        if (blocker) return receiptResult(row, 'blocked', { code: blocker });
        return dispatch(row, 'resume', { projectId: row.projectId, intent: request.intent, metadata: authority.metadata });
      });
    },
    async deliver(request, authority) {
      const identity = identifyVideoMake(request);
      return store.locked(identity.id, async () => {
        const row = store.read(identity.id);
        if (!row) throw error('VIDEO_MAKE_NOT_FOUND', 'No local owner receipt for the requested brief.');
        const result = await readCurrent(row);
        if (result.state !== 'render_ready' || !downstream) return result;
        if (authority?.sha256 !== row.authoritySha256) return receiptResult(row, 'blocked', { code: 'FROZEN_OWNER_AUTHORITY_CHANGED' });
        return downstream(result.handoff, authority.render, authority.post);
      });
    },
  };
}
