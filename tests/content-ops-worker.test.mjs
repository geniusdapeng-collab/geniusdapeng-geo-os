import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SingleRequestModel } from '../src/content-ops-worker/model.mjs';
import { ContentOpsWorker, localGrantHash } from '../src/content-ops-worker/worker.mjs';
import { WorkerLocalStore, LocalSourceRegistry } from '../src/content-ops-worker/local-store.mjs';
import { WorkerHttpTransport } from '../src/content-ops-worker/transport.mjs';
import { bytesHash, dataHash, decodeJson, ContentOpsWorkerError } from '../src/content-ops-worker/protocol.mjs';

// Fixtures exercise local execution/HTTP only. No social platform, real key,
// supplier billing, publication or production status is asserted here.
const TIME = Date.parse('2026-10-26T12:00:00.000Z');
const HASH = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const ROOT = path.resolve(import.meta.dirname, '..');
function directory(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm-worker-test-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function modelConfig(extra = {}) {
  return { endpoint: 'https://supplier.invalid/chat/completions', apiKey: 'isolated-fixture-credential', provider: 'fixture', model: 'fixture-model',
    contextTokenLimit: 8192, contextProof: { kind: 'provider_documented_context', sourceUrl: 'https://supplier.invalid/docs', sha256: HASH,
      verifiedAt: new Date(TIME).toISOString() }, pricingSnapshotHash: OTHER, currency: 'USD', maxOutputTokens: 512, ...extra };
}
const textResult = { title: '真实完整测试稿', summary: '只在隔离测试内使用', body: '隔离事实正文。',
  blocks: [{ type: 'paragraph', text: '隔离事实正文。' }], claimMappings: [{ claimId: 'C1', quote: '隔离事实正文。', location: 'body' }], disclosure: { aiUse: 'copyedit' } };
function envelope(value = textResult, extra = {}) {
  return { id: 'fixture-request-1', model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 25, completion_tokens: 30, total_tokens: 55 }, ...extra };
}

test('single-request model requires verified token/pricing bounds before any provider dispatch', () => {
  let calls = 0; const adapter = new SingleRequestModel(modelConfig({ contextProof: null, fetchImpl: () => { calls++; } }));
  assert.equal(adapter.readiness().ready, false);
  assert.throws(() => adapter.prepare('text.adapt', { claims: [{ id: 'C1' }] })); assert.equal(calls, 0);
  assert.equal(new SingleRequestModel(modelConfig({ endpoint: 'http://supplier.invalid/chat' })).readiness().ready, false);
});

test('actual loopback HTTP performs one JSON POST with full prompt and an entire documented context reserve', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(envelope()));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const adapter = new SingleRequestModel(modelConfig({ endpoint: `http://127.0.0.1:${server.address().port}/chat`, allowLoopbackHttp: true }));
  assert.doesNotMatch(JSON.stringify(adapter), /isolated-fixture-credential/);
  const call = adapter.prepare('text.adapt', { claims: [{ id: 'C1' }], source: '完整来源资料' });
  assert.equal(call.upperBound.inputTokens, 8192); assert.equal(call.upperBound.outputTokens, 512);
  const result = await call.execute(); assert.equal(result.value.body, textResult.body); assert.equal(result.usage.costMicros, null);
  assert.equal(result.usageUnknown, false); assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.stream, false); assert.equal(requests[0].body.tools, undefined);
  assert.match(requests[0].body.messages[1].content, /完整来源资料/u);
  await assert.rejects(call.execute(), { code: 'DISPATCH_REPLAY_BLOCKED' }); assert.equal(requests.length, 1);
});

test('ambiguous supplier timeout and HTTP failure never retry or fail over', async () => {
  for (const mode of ['network', 'http']) {
    let calls = 0; const adapter = new SingleRequestModel(modelConfig({ fetchImpl: async () => {
      calls++; if (mode === 'network') throw new Error('private-cookie-and-provider-body');
      return new Response('{"error":"private-supplier-message"}', { status: 503 });
    } }));
    await assert.rejects(adapter.prepare('text.adapt', { claims: [{ id: 'C1' }] }).execute(), error => {
      assert.equal(error.code, 'MODEL_RESULT_UNKNOWN'); assert.equal(error.unknown, true);
      assert.doesNotMatch(error.message, /private-/); return true;
    }); assert.equal(calls, 1);
  }
});

test('invalid, duplicate, truncated or unsupported model outputs retain real usage and never become candidates', async () => {
  for (const value of [envelope(undefined, { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }),
    envelope(undefined, { choices: [{ finish_reason: 'stop', message: { content: '{"title":"a","title":"b"}' } }] }),
    envelope({ ...textResult, claimMappings: [{ claimId: 'UNAPPROVED', quote: '隔离事实正文。', location: 'body' }] })]) {
    let calls = 0; const adapter = new SingleRequestModel(modelConfig({ fetchImpl: async () => { calls++; return new Response(JSON.stringify(value)); } }));
    await assert.rejects(adapter.prepare('text.adapt', { claims: [{ id: 'C1' }] }).execute(), error => {
      assert.equal(error.metering.inputTokens, 25); assert.equal(error.metering.costMicros, null);
      assert.equal(error.usageReceipt.providerRequestId, 'fixture-request-1'); return true;
    }); assert.equal(calls, 1);
  }
});
test('multiple thread/card/document outputs require distinct closed native content rather than repeated complete bodies', async () => {
  const input = { claims: [{ id: 'C1' }], target: { outputs: [
    { outputKey: 'first', kind: 'text' }, { outputKey: 'second', kind: 'text' },
  ] } };
  const first = { outputKey: 'first', title: 'First', body: 'First complete native information task.', alt: '', caption: '' };
  const second = { outputKey: 'second', title: 'Second', body: 'A different complete native information task.', alt: '', caption: '' };
  for (const [nativeContent, code] of [[undefined, 'NATIVE_CONTENT_REQUIRED'], [[first], 'NATIVE_CONTENT_REQUIRED'],
    [[first, first], 'NATIVE_CONTENT_INVALID'], [[first, { ...second, body: `  ${first.body}  ` }], 'NATIVE_CONTENT_DUPLICATE'],
    [[first, { ...second, outputKey: 'UNDECLARED' }], 'NATIVE_CONTENT_INVALID'], [[first, { ...second, argv: ['unsafe'] }], 'UNKNOWN_FIELD']]) {
    const value = { ...textResult, ...(nativeContent === undefined ? {} : { nativeContent }) };
    const adapter = new SingleRequestModel(modelConfig({ fetchImpl: async () => new Response(JSON.stringify(envelope(value))) }));
    await assert.rejects(adapter.prepare('text.adapt', input).execute(), { code });
  }
  const adapter = new SingleRequestModel(modelConfig({ fetchImpl: async () => new Response(JSON.stringify(envelope({ ...textResult, nativeContent: [first, second] }))) }));
  const result = await adapter.prepare('text.polish', input).execute(); assert.deepEqual(result.value.nativeContent, [first, second]);
});

test('unverified usage stays unknown and a text checker cannot attest image/video inspection', async () => {
  const check = { checkedPackageHash: HASH, findings: [], coverage: { deterministic: 'checked', semantic: 'checked', media: 'checked', artistic: 'checked' }, assessment: 'Full text was checked.' };
  const adapter = new SingleRequestModel(modelConfig({ fetchImpl: async () => new Response(JSON.stringify(envelope(check, { usage: null }))) }));
  const result = await adapter.prepare('quality.final', { packageHash: HASH, package: { artifactRefs: [{ mime: 'image/png' }] } }).execute();
  assert.equal(result.usageUnknown, true); assert.equal(result.usage, null); assert.equal(result.value.coverage.media, 'unverified');
  const text = await adapter.prepare('quality.final', { packageHash: HASH, package: { artifactRefs: [{ mime: 'text/markdown' }] } }).execute();
  assert.equal(text.value.coverage.media, 'checked');
});
test('a provider cannot silently replace the configured model or omit its request identity', async () => {
  const changed = new SingleRequestModel(modelConfig({ fetchImpl: async () => new Response(JSON.stringify(envelope(textResult, { model: 'different-unapproved-model' }))) }));
  await assert.rejects(changed.prepare('text.adapt', { claims: [{ id: 'C1' }] }).execute(), error => {
    assert.equal(error.code, 'MODEL_IDENTITY_CHANGED'); assert.equal(error.unknown, true); return true;
  });
  const missing = new SingleRequestModel(modelConfig({ fetchImpl: async () => new Response(JSON.stringify(envelope(textResult, { id: null }))) }));
  assert.equal((await missing.prepare('text.adapt', { claims: [{ id: 'C1' }] }).execute()).usageUnknown, true);
});

test('private journal excludes checkout aliases, enforces single owner and preserves exact source bytes', t => {
  const root = directory(t), alias = path.join(root, 'checkout-link'); fs.symlinkSync(ROOT, alias);
  assert.throws(() => new WorkerLocalStore({ dataDir: path.join(alias, 'var/worker-forbidden'), rootDir: ROOT }), { code: 'PRIVATE_DIRECTORY_INVALID' });
  const dataDir = path.join(root, 'data'); const store = new WorkerLocalStore({ dataDir, rootDir: ROOT }).acquire(); t.after(() => { if (fs.existsSync(store.root)) store.close(); });
  assert.throws(() => new WorkerLocalStore({ dataDir, rootDir: ROOT }).acquire(), { code: 'WORKER_BUSY' });
  store.updateAttempt('ATT-1', { taskId: 'TASK-1', epoch: 1, taskHash: HASH, resolvedInputHash: OTHER });
  assert.throws(() => store.updateAttempt('ATT-1', { taskHash: OTHER }), { code: 'WORKER_STATE_CONFLICT' });
  const source = path.join(root, 'source.txt'); fs.writeFileSync(source, 'original source', { mode: 0o600 });
  const registry = new LocalSourceRegistry({ root, sources: [{ id: 'source', relativePath: 'source.txt', sha256: bytesHash(Buffer.from('original source')), bytes: 15, mime: 'text/plain', role: 'transcript' }] });
  const ref = { id: 'source', sha256: bytesHash(Buffer.from('original source')), bytes: 15 };
  assert.equal(registry.read(ref).bytes.toString(), 'original source');
  fs.writeFileSync(source, 'tampered source'); assert.throws(() => registry.read(ref), { code: 'ARTIFACT_HASH_MISMATCH' });
  fs.unlinkSync(source); fs.symlinkSync(path.join(root, 'data/journal.json'), source); assert.throws(() => registry.read(ref));
});

test('workspace quota counts interrupted files that have not reached the JSON manifest', t => {
  const root = directory(t), store = new WorkerLocalStore({ dataDir: path.join(root, 'data'), rootDir: ROOT, maxTempBytes: 2500 }).acquire(); t.after(() => { if (fs.existsSync(store.root)) store.close(); });
  store.writeArtifact('ATT-1', 'first', Buffer.alloc(1500, 65), 'text/plain');
  assert.throws(() => store.writeArtifact('ATT-1', 'second', Buffer.alloc(1500, 66), 'text/plain'), { code: 'WORKSPACE_QUOTA_EXCEEDED' });
  assert.equal(store.listAttempts().length, 0); // Both are before an attempt-manifest commit.
});
test('explicit dead-owner recovery preserves its old lock and a recovery guard prevents concurrent takeover', t => {
  const root = directory(t), dataDir = path.join(root, 'data'), store = new WorkerLocalStore({ dataDir, rootDir: ROOT });
  fs.writeFileSync(store.lockPath, JSON.stringify({ pid: 2147483647, token: 'dead-isolated-owner', startedAt: new Date(TIME).toISOString() }), { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(dataDir, 'lock-recovery'), { mode: 0o700 });
  assert.throws(() => store.acquire({ recoverStale: true }), { code: 'WORKER_RECOVERY_BUSY' });
  assert.equal(JSON.parse(fs.readFileSync(store.lockPath)).token, 'dead-isolated-owner');
  fs.rmdirSync(path.join(dataDir, 'lock-recovery')); store.acquire({ recoverStale: true });
  assert.equal(JSON.parse(fs.readFileSync(store.lockPath)).pid, process.pid);
  assert.equal(fs.readdirSync(dataDir).filter(name => name.startsWith('recovered-lock-')).length, 1); store.close();
});

function workerFixture(t, { failProvider = false, lostComplete = false, lateComplete = false, mutatePermit = false, usageUnknown = false, providerDelayMs = 0 } = {}) {
  const root = directory(t); let now = TIME;
  let store = new WorkerLocalStore({ dataDir: path.join(root, 'worker'), rootDir: ROOT, clock: () => now }).acquire();
  t.after(() => { if (fs.existsSync(store.root)) store.close(); });
  const binding = { kind: 'native.prepare', adapterId: 'native.prepare', version: '1.0.0', entrypointSha: HASH,
    validatorVersion: 'content-ops-worker/v1', fixedTransport: 'deterministic_local', nativeCapabilityId: null };
  const grant = { schema: 'pengmanager.worker-local-grant/v1', workerId: 'WORKER-1', grantId: 'GRANT-1', origin: 'https://cloud.invalid',
    workspaceId: 'workspace', projectIds: ['project'], jobIds: ['JOB-1'], targetKeys: ['target'], adapterBindings: [binding], scopeHash: OTHER,
    budgetAuthorizationHash: HASH, expiresAt: new Date(TIME + 86_400_000).toISOString(), ownerConfirmed: true, roles: ['worker'],
    limits: { maxTempBytes: 20_000_000, maxRenderSeconds: 60, maxNativeProcesses: 1, maxCalls: 10 } };
  grant.localGrantHash = localGrantHash(grant);
  const task = { schema: 'pengmanager.task-blueprint/v1', taskId: 'TASK-1', jobId: 'JOB-1', targetKey: 'target', kind: 'native.prepare',
    adapterBinding: binding, dependsOn: [], inputRefs: { sourceRefs: [], fileRefs: [], logicalInputs: [], inputRefs: [] },
    outputSpec: [{ outputKey: 'actual', role: 'text', allowedMimes: ['text/markdown'], maxBytes: 100_000, required: true }],
    permissionRequirements: {}, costClass: 'local_deterministic', budgetAuthorizationHash: HASH, timeoutMs: 60_000, compileInputHash: HASH };
  const taskHash = dataHash(task); task.taskHash = taskHash;
  const refs = { sourceRefs: [], fileRefs: [], dependencyRefs: [] };
  const lease = { task, attemptId: 'ATT-1', epoch: 1, leaseExpiresAt: new Date(TIME + 60_000).toISOString(), taskHash, blueprintHash: OTHER,
    resolvedInputRefs: refs, resolvedInputHash: dataHash({ taskHash, resolvedInputRefs: refs }), resolvedInputData: { original: 'full data' },
    scopeHash: OTHER, budgetAuthorizationHash: HASH, localGrantHash: grant.localGrantHash };
  const events = [], counters = { provider: 0, claim: 0, complete: 0, upload: 0, unknown: 0, settle: 0, heartbeat: 0 }, reservations = [];
  const transport = {
    async claimTask() { counters.claim++; events.push('claim'); return counters.claim === 1 ? structuredClone(lease) : null; },
    async heartbeatTask() { counters.heartbeat++; events.push('heartbeat'); return { ...structuredClone(lease), leaseExpiresAt: new Date(now + 60_000).toISOString() }; },
    async dispatchTask(id, input) { events.push('dispatch'); reservations.push(input); return { reservationId: 'RES-1', dispatchPermitId: 'PERMIT-1',
      attemptId: 'ATT-1', epoch: 1, requestHash: mutatePermit ? HASH : input.requestHash, scopeHash: OTHER, expiresAt: new Date(now + 60_000).toISOString(), dispatchRecorded: true, execute: true }; },
    async settleCall() { counters.settle++; events.push('settle'); }, async unknownCall() { counters.unknown++; events.push('unknown'); },
    async registerArtifact(id, metadata, bytes) { counters.upload++; events.push('upload'); assert.equal(bytesHash(bytes), metadata.sha256);
      return { artifactId: 'ART-fixture', sha256: metadata.sha256, outputKey: metadata.outputKey, committed: true, commitStatus: 'committed' }; },
    async completeTask(id, input) { counters.complete++; events.push('complete');
      assert.equal(input.resultManifest.executed, true); assert.equal(input.resultManifest.dryRun, false);
      if (lostComplete && counters.complete === 1) throw new ContentOpsWorkerError('CLOUD_RESULT_UNKNOWN', 'Lost completion response.', { unknown: true, retryable: true });
      return { taskId: id, attemptId: 'ATT-1', status: lateComplete ? 'quarantined' : 'succeeded' }; },
    async failTask(id, input) { events.push('fail'); return { status: input.unknown ? 'unknown' : 'failed_known' }; },
  };
  const adapters = { get() { return { binding, async readiness() { return { ready: true }; }, async execute({ runCall }) {
    const bytes = Buffer.from('# Real isolated output\n\nComplete actual bytes.\n');
    const result = await runCall('local.1', { provider: null, model: null, pricingSnapshotHash: null, requestHash: dataHash({ source: 'full data' }),
      upperBound: { inputTokens: 0, outputTokens: 0, renderSeconds: 0, tempBytes: 100_000, nativeProcesses: 0 },
      async execute() { counters.provider++; events.push('provider');
        assert.equal(store.getAttempt('ATT-1').calls[0].state, 'provider_inflight');
        if (providerDelayMs) await new Promise(resolve => setTimeout(resolve, providerDelayMs));
        if (failProvider) throw new ContentOpsWorkerError('FIXTURE_UNKNOWN', 'An isolated process lost its result.', { unknown: true });
        return { bytes, executed: true, dryRun: false, usageUnknown, usage: usageUnknown ? null : { inputTokens: 0, outputTokens: 0, costMicros: 0, currency: 'USD' },
          usageReceipt: { kind: 'local_execution_receipt', providerRequestId: null, sha256: bytesHash(bytes) }, evidence: { actual: true } }; } });
    return { outputs: [{ outputKey: 'actual', role: 'text', mime: 'text/markdown', bytes: result.bytes }], data: { complete: true },
      executionReceipts: [{ kind: 'isolated_native', executed: true, dryRun: false, sha256: bytesHash(bytes) }] };
  } }; }, async readiness() { return [{ ...binding, ready: true, proofHash: HASH, checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }]; } };
  const create = () => new ContentOpsWorker({ transport, store, adapters, localGrant: grant, origin: grant.origin, workerId: grant.workerId, clock: () => now, heartbeatIntervalMs: 1000 });
  return { get store() { return store; }, lease, grant, binding, create, counters, events, reservations,
    advance(ms) { now += ms; }, reopen() { store.close(); store = new WorkerLocalStore({ dataDir: path.join(root, 'worker'), rootDir: ROOT, clock: () => now }).acquire(); } };
}

function freezeFixtureLease(fixture) {
  const task = fixture.lease.task;
  task.taskHash = dataHash(Object.fromEntries(Object.entries(task).filter(([key]) => key !== 'taskHash')));
  fixture.lease.taskHash = task.taskHash;
  fixture.lease.resolvedInputHash = dataHash({ taskHash: task.taskHash, resolvedInputRefs: fixture.lease.resolvedInputRefs });
  fixture.grant.localGrantHash = localGrantHash(fixture.grant); fixture.lease.localGrantHash = fixture.grant.localGrantHash;
}

function authorBoundFixture(t) {
  const fixture = workerFixture(t), task = fixture.lease.task;
  const author = { id: 'AUTHOR-1', revision: 1, storyId: 'STORY-1', body: 'The exact genuine isolated author source.', authoredBy: 'isolated author' };
  author.hash = dataHash(author);
  const authorRef = { id: author.id, revision: author.revision, sha256: author.hash };
  const policy = { allowedAiActions: ['translate'], requiresAuthorContribution: true };
  const target = { targetKey: 'target', inputFiles: [], authorContributionRefs: [authorRef] };
  const fields = ['id', 'familyId', 'storyId', 'locale', 'format', 'editorialRevision', 'sourceEditionId', 'supersedesEditionId',
    'title', 'summary', 'body', 'blocks', 'claimIds', 'claimBindings', 'assetRefs'];
  const edition = { ...Object.fromEntries(fields.map(key => [key, null])), id: 'ED-1', storyId: 'STORY-1', locale: 'zh-CN',
    format: 'article', editorialRevision: 1, title: 'Exact source', summary: '', body: 'Complete source body.', blocks: [], claimIds: [], claimBindings: [], assetRefs: [] };
  edition.snapshotHash = dataHash({ schema: 'pengmanager.editorial-snapshot/v2', ...edition });
  const plan = { storyRef: { id: 'STORY-1' }, targets: [target], motherEditionRefs: [{ id: edition.id, revision: 1, sha256: edition.snapshotHash }], claimBindings: [] };
  task.kind = 'format.transform'; task.neutralTargetKeys = ['target']; task.neutralAuthorContributionRefs = [authorRef]; task.neutralPolicy = policy;
  task.transformSpec = { targetLocale: 'en-US', targetFormat: 'article', authority: { ...policy, authorContributionRefs: [authorRef] } };
  Object.assign(task.inputRefs, { planHash: dataHash(plan), planProjectionHash: dataHash(plan), targetHash: dataHash(target), effectivePolicyHash: dataHash(policy) });
  fixture.lease.resolvedInputData = { plan, target, effectivePolicy: policy, transformSpec: structuredClone(task.transformSpec),
    sourceEditions: [edition], claims: [], authorContributions: [author] };
  freezeFixtureLease(fixture); return fixture;
}

test('a shared neutral task requires local permission for every consumer before dispatch', async t => {
  for (const targets of [['target', 'second-consumer'], [], ['target', 'target']]) {
    const fixture = workerFixture(t); fixture.lease.task.kind = 'format.transform'; fixture.lease.task.neutralTargetKeys = targets;
    freezeFixtureLease(fixture);
    await assert.rejects(fixture.create().runOnce(), { code: 'WORKER_SCOPE_DENIED' });
    assert.equal(fixture.counters.provider, 0); assert.equal(fixture.reservations.length, 0);
  }
  const valid = workerFixture(t); valid.lease.task.kind = 'format.transform'; valid.lease.task.neutralTargetKeys = ['target', 'second-consumer'];
  valid.grant.targetKeys.push('second-consumer'); freezeFixtureLease(valid);
  assert.equal((await valid.create().runOnce()).status, 'completed'); assert.equal(valid.counters.provider, 1);
});

test('common author references require their exact complete resolved snapshots before any reservation', async t => {
  const mutations = [data => { data.authorContributions[0].body += ' Unapproved expansion.'; },
    data => { data.authorContributions = []; }, data => { data.authorContributions.push(structuredClone(data.authorContributions[0])); },
    data => { data.authorContributions[0].revision++; }, data => { data.transformSpec.authority.allowedAiActions = ['draft']; }];
  for (const mutate of mutations) {
    const fixture = authorBoundFixture(t); mutate(fixture.lease.resolvedInputData);
    await assert.rejects(fixture.create().runOnce(), { code: 'TASK_INPUT_CHANGED' });
    assert.equal(fixture.counters.provider, 0); assert.equal(fixture.reservations.length, 0);
  }
  const valid = authorBoundFixture(t); assert.equal((await valid.create().runOnce()).status, 'completed');
});

test('worker persists dispatch before execution, settles each request and uploads actual bytes before completion', async t => {
  const fixture = workerFixture(t); const result = await fixture.create().runOnce();
  assert.equal(result.status, 'completed'); assert.equal(fixture.counters.provider, 1); assert.equal(fixture.counters.settle, 1);
  assert.equal(fixture.counters.upload, 1); assert.equal(fixture.counters.complete, 1);
  assert.ok(fixture.events.indexOf('dispatch') < fixture.events.indexOf('provider'));
  assert.ok(fixture.events.indexOf('provider') < fixture.events.indexOf('settle'));
  assert.ok(fixture.events.indexOf('upload') < fixture.events.indexOf('complete'));
  const journal = fixture.store.getAttempt('ATT-1'); assert.equal(journal.status, 'completed');
  assert.match(fixture.store.readArtifact(journal.artifacts[0]).toString(), /Complete actual bytes/);
});

test('unknown execution retains reservation and durable attempts are never automatically re-executed', async t => {
  const fixture = workerFixture(t, { failProvider: true });
  assert.equal((await fixture.create().runOnce()).status, 'needs_reconcile'); assert.equal(fixture.counters.provider, 1); assert.equal(fixture.counters.unknown, 1);
  fixture.reopen(); assert.equal((await fixture.create().runOnce()).status, 'idle');
  assert.equal(fixture.counters.provider, 1); assert.equal(fixture.counters.upload, 0);
});
test('a completed output with missing metering is retained privately and cannot upload or unlock another task', async t => {
  const fixture = workerFixture(t, { usageUnknown: true }); const result = await fixture.create().runOnce();
  assert.equal(result.status, 'needs_reconcile'); assert.equal(result.error.code, 'USAGE_RECONCILIATION_REQUIRED');
  assert.equal(fixture.counters.unknown, 1); assert.equal(fixture.counters.upload, 0); assert.equal(fixture.counters.complete, 0);
  const output = fixture.store.getAttempt('ATT-1').calls[0].actualResult; assert.ok(output);
  assert.match(fixture.store.readArtifact(output).toString(), /Complete actual bytes/);
});
test('a long-running dispatched call renews its lease before returning a complete result', async t => {
  const fixture = workerFixture(t, { providerDelayMs: 1300 }); assert.equal((await fixture.create().runOnce()).status, 'completed');
  assert.ok(fixture.counters.heartbeat >= 5); assert.equal(fixture.counters.provider, 1);
});

test('restart after persisted dispatch intent requires reconciliation without running a provider', async t => {
  const fixture = workerFixture(t);
  fixture.store.updateAttempt('ATT-1', { taskId: 'TASK-1', epoch: 1, taskHash: fixture.lease.taskHash,
    resolvedInputHash: fixture.lease.resolvedInputHash, status: 'provider_inflight', lease: fixture.lease,
    calls: [{ callKey: 'local.1', state: 'provider_inflight', reservationId: 'RES-1' }] });
  fixture.reopen(); const result = await fixture.create().runOnce(); assert.equal(result.status, 'needs_reconcile');
  assert.equal(fixture.counters.provider, 0); assert.equal(fixture.counters.claim, 0);
});

test('lost completion response recovers the original receipt after restart without another execution or upload', async t => {
  const fixture = workerFixture(t, { lostComplete: true });
  assert.equal((await fixture.create().runOnce()).status, 'needs_sync');
  const original = fixture.store.getAttempt('ATT-1').resultManifest;
  fixture.advance(120_000); fixture.reopen();
  assert.equal((await fixture.create().runOnce()).status, 'completed');
  assert.equal(fixture.counters.provider, 1); assert.equal(fixture.counters.upload, 1); assert.equal(fixture.counters.complete, 2);
  assert.deepEqual(fixture.store.getAttempt('ATT-1').resultManifest, original);
});

test('wrong dispatch identity blocks execution and quarantined completion never becomes completed', async t => {
  const mismatch = workerFixture(t, { mutatePermit: true });
  assert.equal((await mismatch.create().runOnce()).status, 'needs_reconcile'); assert.equal(mismatch.counters.provider, 0);
  const late = workerFixture(t, { lateComplete: true }); const result = await late.create().runOnce();
  assert.equal(result.status, 'failed_known'); assert.equal(result.error.code, 'TASK_RESULT_QUARANTINED');
  assert.notEqual(late.store.getAttempt('ATT-1').status, 'completed');
});

test('local approval hash, exact source closure and epoch changes stop a claimed task', async t => {
  const fixture = workerFixture(t); fixture.grant.jobIds.push('UNAPPROVED');
  assert.throws(() => fixture.create(), { code: 'LOCAL_GRANT_CHANGED' }); fixture.grant.jobIds.pop();
  fixture.lease.task.adapterBinding = { ...fixture.binding, entrypointSha: OTHER };
  await assert.rejects(fixture.create().runOnce(), { code: 'ADAPTER_BINDING_CHANGED' }); assert.equal(fixture.counters.provider, 0);
});

test('HTTP worker source transport verifies actual bytes and never follows a redirected bearer request', async () => {
  let calls = 0; const bytes = Buffer.from('approved exact source');
  const transport = new WorkerHttpTransport({ origin: 'https://cloud.invalid', credential: 'x'.repeat(43), workerId: 'WORKER-1', grantId: 'GRANT-1', scopeHash: HASH,
    fetchImpl: async (url, init) => { calls++; assert.equal(init.redirect, 'error'); assert.match(String(url), /\/worker\/artifacts\/ART-1\/bytes$/);
      return new Response(bytes, { headers: { 'Content-Type': 'text/plain', 'Content-Length': String(bytes.length) } }); } });
  assert.doesNotMatch(JSON.stringify(transport), /xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/);
  assert.equal((await transport.readSource({ artifactId: 'ART-1', sha256: bytesHash(bytes), bytes: bytes.length })).bytes.toString(), bytes.toString());
  await assert.rejects(transport.readSource({ artifactId: 'ART-1', sha256: OTHER, bytes: bytes.length }), { code: 'ARTIFACT_HASH_MISMATCH' });
  assert.equal(calls, 2);
  assert.throws(() => decodeJson('{"same":1,"same":2}'), { code: 'DUPLICATE_JSON_KEY' });
});
