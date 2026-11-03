import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { advanceVideoMakeDelivery, approvedVideoMakeAuthority, createNativeVideoMake, createVideoMakeStore, identifyVideoMake, readPrivateVideoJson } from '../src/video-runtime/video-make.mjs';

const request = { system: 'pengmanager', intent: '苏州平江路清晨人文故事片', durationSeconds: 30 };
const identity = identifyVideoMake(request);
const liveAuthority = {
  schemaVersion: 'pengmanager.video-make-authority/v1',
  approvedRequests: [{ ...identity, validUntil: '2099-01-01T00:00:00Z',
    metadata: { platform: 'douyin' }, creative: { maxCny: 10, maxCalls: 20, maxTokens: 1_000_000, maxWallMs: 120_000 },
    render: { modelId: 'video-model', providerModel: 'provider-model', maxEstimatedCny: 15, params: { aspectRatio: '9:16' } },
    post: { title: '平江路', platform: 'douyin', aspect: '9:16', resolution: '1080p', fps: 30 } }],
};
const authority = approvedVideoMakeAuthority(liveAuthority, identity);
const archive = (stage = {}) => ({ projectId: 'VID-10', archiveExists: true, stages: [
  { runId: 'RUN-1', stageId: 'preproduction', attempt: 1, status: 'done', outputRef: 'stages/preproduction/attempt-1.output.json', outputSha256: 'a'.repeat(64), ...stage },
] });
const shots = { projectId: 'VID-10', sourceStageRunId: 'STAGE-1', sourceAttempt: 1, promptsSha256: 'b'.repeat(64),
  shots: [{ durationSec: 10 }, { durationSec: 20 }] };

function fixture(t, overrides = {}) {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pengmanager-video-make-')));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const store = createVideoMakeStore(dataRoot);
  const calls = [];
  let view = archive(), status = { projectId: 'VID-10', runId: 'RUN-1', status: 'finished' };
  const native = {
    start: async input => {
      calls.push(['start', input]);
      assert.equal(store.read(identity.id).operations.at(-1).state, 'pending');
      return { kind: 'routed', projectId: 'VID-10', runId: 'RUN-1', pipeline: 'narrative' };
    },
    resume: async input => {
      calls.push(['resume', input]);
      assert.equal(store.read(identity.id).operations.at(-1).state, 'pending');
      view = archive({ runId: 'RUN-2', status: 'running', attempt: 2 });
      status = { ...status, runId: 'RUN-2', status: 'running' };
      return { kind: 'resumed', stage: 'preproduction', runId: 'RUN-2' };
    },
    status: async () => status,
    archive: async () => view,
    shots: async () => shots,
    ...overrides.native,
  };
  const make = createNativeVideoMake({ store, native, selectRoute: async () => ({ route: 'narrative' }), qualifyStart: async () => null, ...overrides, native });
  return { dataRoot, make, store, calls, view: value => { view = value; }, status: value => { status = value; } };
}

test('binds exact intent, system, and native supported duration', () => {
  assert.notEqual(identifyVideoMake({ ...request, durationSeconds: 31 }).id, identity.id);
  assert.notEqual(identifyVideoMake({ ...request, intent: request.intent + ' ' }).id, identity.id);
  for (const partial of [{ durationSeconds: 4 }, { durationSeconds: 180.5 }, { system: 'growthtest' }, { model: 'injected' }]) {
    assert.throws(() => identifyVideoMake({ ...request, ...partial }), { code: 'VIDEO_MAKE_REQUEST_INVALID' });
  }
  assert.equal(authority.metadata.brief.duration, 30);
  assert.equal(approvedVideoMakeAuthority(liveAuthority, identity, Date.parse('2100-01-01')), null);
  assert.equal(approvedVideoMakeAuthority({ ...liveAuthority, approvedRequests: [...liveAuthority.approvedRequests, ...liveAuthority.approvedRequests] }, identity), null);
});

test('missing owner authority, wrong pipeline and current quote block before POST', async t => {
  const missing = fixture(t);
  assert.equal((await missing.make.start(request, null)).code, 'OWNER_PRODUCTION_AUTHORITY_REQUIRED');
  assert.deepEqual(missing.calls, []);
  const unclear = fixture(t, { selectRoute: async () => ({ route: 'clarify' }) });
  assert.equal((await unclear.make.start(request, authority)).code, 'NATIVE_ROUTE_CLARIFICATION_REQUIRED');
  const explainer = fixture(t, { selectRoute: async () => ({ route: 'explainer' }) });
  assert.equal((await explainer.make.start(request, authority)).code, 'NATIVE_EXPLAINER_HANDOFF_REQUIRED');
  const unpriced = fixture(t, { qualifyStart: async () => 'NATIVE_RENDER_PRICE_OR_CAP_UNVERIFIED' });
  assert.equal((await unpriced.make.start(request, authority)).code, 'NATIVE_RENDER_PRICE_OR_CAP_UNVERIFIED');
  assert.equal(unpriced.store.read(identity.id), null);
  assert.deepEqual([...unclear.calls, ...explainer.calls, ...unpriced.calls], []);
});

test('official route and frozen metadata dispatch once; native archive and shots bind handoff', async t => {
  const f = fixture(t);
  const started = await f.make.start(request, authority);
  assert.equal(started.state, 'render_ready');
  assert.deepEqual(started.handoff, { system: 'pengmanager', projectId: 'VID-10', runId: 'RUN-1', pipeline: 'narrative', intentSha256: identity.intentSha256,
    durationSeconds: 30, sourceStageRunId: 'STAGE-1', sourceAttempt: 1, promptsSha256: 'b'.repeat(64), outputSha256: 'a'.repeat(64) });
  assert.deepEqual(f.calls, [['start', { route: 'narrative', intent: request.intent, metadata: authority.metadata }]]);
  assert.equal((await f.make.start(request, authority)).state, 'render_ready');
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(path.join(f.dataRoot, 'video-make', identity.id + '.json'), 'utf8').includes(request.intent), false);
});

test('concurrent same request is serialized without another native dispatch', async t => {
  let release, entered;
  const wait = new Promise(resolve => { release = resolve; });
  const posting = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { native: { start: async () => { entered(); await wait; return { kind: 'routed', projectId: 'VID-10', runId: 'RUN-1', pipeline: 'narrative' }; } } });
  const pending = f.make.start(request, authority);
  await posting;
  try { await assert.rejects(f.make.start(request, authority), { code: 'RUNTIME_BUSY' }); }
  finally { release(); }
  assert.equal((await pending).state, 'render_ready');
});

for (const [kind, reply] of [['lost', new Error('private route error')], ['malformed', { kind: 'routed', projectId: 'VID-10', pipeline: 'narrative' }]]) {
  test(kind + ' native acknowledgement survives restart as unknown, never auto-repeats', async t => {
    let calls = 0;
    const f = fixture(t, { native: { start: async () => { calls++; if (reply instanceof Error) throw reply; return reply; } } });
    assert.equal((await f.make.start(request, authority)).code, 'NATIVE_MUTATION_OUTCOME_UNKNOWN');
    assert.equal((await f.make.status(identity.id)).code, 'NATIVE_MUTATION_OUTCOME_UNKNOWN');
    assert.equal((await f.make.start(request, authority)).code, 'NATIVE_MUTATION_OUTCOME_UNKNOWN');
    assert.equal((await f.make.resume(request, authority)).code, 'NATIVE_MUTATION_OUTCOME_UNKNOWN');
    assert.equal(calls, 1);
  });
}

test('only exact failed native run can resume, with frozen authority; new receipt binds new run', async t => {
  const f = fixture(t);
  await f.make.start(request, authority);
  f.view(archive({ status: 'failed', errorClass: 'CREATIVE_FAILED' }));
  f.status({ projectId: 'VID-10', runId: 'RUN-1', status: 'failed' });
  assert.equal((await f.make.status(identity.id)).resumable, true);
  assert.equal((await f.make.resume(request, { ...authority, sha256: 'c'.repeat(64) })).code, 'FROZEN_OWNER_AUTHORITY_CHANGED');
  assert.equal((await f.make.resume(request, authority)).runId, 'RUN-2');
  assert.deepEqual(f.calls[1], ['resume', { projectId: 'VID-10', intent: request.intent, metadata: authority.metadata }]);
  assert.equal((await f.make.resume(request, authority)).state, 'running');
  assert.equal(f.calls.length, 2);
});

test('explicit resume reconciles a stale native stage after runtime restart', async t => {
  const f = fixture(t);
  await f.make.start(request, authority);
  f.view(archive({ status: 'running' }));
  f.status(null);
  const stale = await f.make.status(identity.id);
  assert.equal(stale.code, 'NATIVE_PREPRODUCTION_INTERRUPTED');
  assert.equal(stale.resumable, true);
  assert.equal((await f.make.start(request, authority)).code, 'NATIVE_PREPRODUCTION_INTERRUPTED');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.make.resume(request, authority)).runId, 'RUN-2');
});

test('approval, unsettled usage and archive receipt mismatch remain blocked', async t => {
  const f = fixture(t);
  await f.make.start(request, authority);
  f.view({ ...archive(), pendingApprovalId: 'APR-1' });
  assert.equal((await f.make.resume(request, authority)).code, 'NATIVE_APPROVAL_REQUIRED');
  f.view(archive({ status: 'failed' }));
  f.status({ projectId: 'VID-10', runId: 'RUN-1', status: 'reconciling' });
  assert.equal((await f.make.resume(request, authority)).code, 'NATIVE_USAGE_RECONCILIATION_REQUIRED');
  f.status(null);
  f.view(archive({ status: 'failed', errorClass: 'RECEIPT_UNVERIFIED' }));
  assert.equal((await f.make.resume(request, authority)).resumable, false);
  f.view(archive({ runId: 'RUN-2' }));
  assert.equal((await f.make.status(identity.id)).code, 'NATIVE_RUN_SCOPE_CHANGED');
  assert.equal(f.calls.length, 1);
});

test('downstream receives exact completed attempt only, never mismatched duration or prompt authority', async t => {
  let delivered, capConsumed = false;
  const f = fixture(t, { qualifyStart: async () => capConsumed ? 'NATIVE_RENDER_PRICE_OR_CAP_UNVERIFIED' : null,
    downstream: async (handoff, render) => { delivered = { handoff, render }; return { state: 'downstream-control' }; } });
  await f.make.start(request, authority);
  capConsumed = true; // Recovery stays possible after an existing job consumes the full available cap.
  f.view(archive({ outputSha256: null }));
  assert.equal((await f.make.deliver(request, authority)).code, 'NATIVE_ARCHIVE_MISMATCH');
  assert.equal(delivered, undefined);
  f.view(archive());
  assert.equal((await f.make.deliver(request, authority)).state, 'downstream-control');
  assert.equal(delivered.handoff.promptsSha256, shots.promptsSha256);
  assert.equal(delivered.render.modelId, authority.render.modelId);
  const wrong = fixture(t, { native: { shots: async () => ({ ...shots, shots: [{ durationSec: 29 }] }) } });
  assert.equal((await wrong.make.start(request, authority)).code, 'NATIVE_ARCHIVE_MISMATCH');
});

test('delivery rechecks owner admission before a pre-dispatch retry', async () => {
  const calls = [];
  const receipt = { id: identity.id };
  const inspect = async () => ({ state: 'blocked', blockingCode: 'NATIVE_RENDER_MODEL_CHANGED' });
  const run = async () => { calls.push('render'); return { state: 'running' }; };
  const denied = await advanceVideoMakeDelivery({ receipt, inspect, run,
    checkAdmission: async () => { calls.push('admission'); return 'FROZEN_OWNER_AUTHORITY_CHANGED'; },
  });
  assert.deepEqual(denied, { ...receipt, state: 'blocked', code: 'FROZEN_OWNER_AUTHORITY_CHANGED' });
  assert.deepEqual(calls, ['admission']);

  const accepted = await advanceVideoMakeDelivery({ receipt, inspect, run,
    checkAdmission: async () => { calls.push('admission'); return null; },
  });
  assert.equal(accepted.state, 'running');
  assert.deepEqual(calls, ['admission', 'admission', 'render']);
});

test('delivery resumes recorded tasks without requiring a quote for a new submission', async () => {
  const current = { state: 'running', render: { shots: [{ jobId: 'job-existing', taskId: 'task-existing' }] } };
  const result = await advanceVideoMakeDelivery({
    receipt: { id: identity.id }, inspect: async () => current, run: async () => current,
    checkAdmission: async () => assert.fail('existing supplier task must go through original receipt reconciliation'),
  });
  assert.deepEqual(result.delivery, current);
});

test('private owner receipt reader rejects permissions and symlinks', t => {
  const { dataRoot } = fixture(t);
  const file = path.join(dataRoot, 'authorized.json');
  fs.writeFileSync(file, '{}', { mode: 0o600 });
  assert.deepEqual(readPrivateVideoJson(file), {});
  const alias = path.join(dataRoot, 'alias.json');
  fs.symlinkSync(file, alias);
  assert.throws(() => readPrivateVideoJson(alias), { code: 'VIDEO_MAKE_PRIVATE_FILE_INVALID' });
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPrivateVideoJson(file), { code: 'VIDEO_MAKE_PRIVATE_FILE_INVALID' });
  }
});

test('owner CLI identifies and fails closed without authority before runtime start', t => {
  const { dataRoot } = fixture(t);
  const script = new URL('../scripts/pengmanager-video-make.mjs', import.meta.url);
  const call = (...args) => spawnSync(process.execPath, [script.pathname, ...args], { input: JSON.stringify(request), encoding: 'utf8' });
  const identified = call('identify');
  assert.equal(identified.status, 0, identified.stderr);
  assert.deepEqual(JSON.parse(identified.stdout), identity);
  const existingOnly = call('deliver', '--data-dir', dataRoot);
  assert.equal(existingOnly.status, 2, existingOnly.stderr);
  assert.equal(JSON.parse(existingOnly.stdout).code, 'VIDEO_MAKE_NOT_FOUND');
  const missing = call('start', '--data-dir', dataRoot);
  assert.equal(missing.status, 2, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).code, 'OWNER_PRODUCTION_AUTHORITY_REQUIRED');
});
