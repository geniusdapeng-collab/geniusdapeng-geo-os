import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createContentOpsAdapters, contentOpsAdapterBindings, contentOpsSourceClosure } from '../src/content-ops-worker/adapters.mjs';
import { SingleRequestModel } from '../src/content-ops-worker/model.mjs';
import { localGrantHash } from '../src/content-ops-worker/worker.mjs';
import { bytesHash, dataHash } from '../src/content-ops-worker/protocol.mjs';
import { inspectProductionArtifact } from '../src/services/production-artifacts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..'), TIME = Date.parse('2026-10-26T12:00:00.000Z'), HASH = 'a'.repeat(64);
const modelOutput = { title: '完整隔离正文', summary: '用于本机接口测试。', body: '这是一份完整隔离测试正文，不代表真实客户、发布或经营效果。',
  blocks: [{ type: 'paragraph', text: '这是一份完整隔离测试正文，不代表真实客户、发布或经营效果。' }], claimMappings: [], disclosure: { aiUse: 'copyedit' } };
function rootDirectory(t) { const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm-adapter-test-')); fs.chmodSync(root, 0o700); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const ordinaryInput = () => ({ target: { targetKey: 'target', requestedCreationMode: 'ai_assisted_draft', nativeForm: 'article', locale: 'zh-CN',
  structure: [{ key: 'main', purpose: 'Preserve source facts.' }], inputFiles: [], settings: { kind: 'article' }, languagePlan: { sourceLocale: 'zh-CN', subtitleMode: 'none' } },
effectivePolicy: { allowedAiActions: ['research', 'outline', 'draft', 'copyedit', 'translate'], requiresAuthorContribution: false, ruleBindingHash: HASH },
budget: { currency: 'USD' }, sourceEditions: [{ ...modelOutput, id: 'ED-1' }], claims: [], authorContributions: [], priorResults: [] });
function localModel(respond, requests) {
  return new SingleRequestModel({ endpoint: 'https://fixture.invalid/chat', apiKey: 'private-test-model-credential', provider: 'fixture', model: 'fixture-model',
    contextTokenLimit: 8192, contextProof: { kind: 'provider_documented_context', sourceUrl: 'https://fixture.invalid/docs', sha256: HASH, verifiedAt: new Date(TIME).toISOString() },
    pricingSnapshotHash: HASH, currency: 'USD', maxOutputTokens: 200, allowUnregisteredModel: true,
    async fetchImpl(url, init) { const request = JSON.parse(init.body); requests.push(request); const result = respond(request);
      return new Response(JSON.stringify({ id: `fixture-request-${requests.length}`, model: 'fixture-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 100 } })); } });
}
function leaseFor(binding, outputSpec = []) { return { task: { kind: binding.kind, adapterBinding: binding, outputSpec, inputRefs: { inputRefs: [] } }, resolvedInputRefs: {} }; }
const directCall = async (key, call) => await call.execute({ signal: new AbortController().signal });

test('fixed adapter bindings include actual full supporting source bytes and never trust a plan-selected executable', async () => {
  const closure = await contentOpsSourceClosure(), bindings = await contentOpsAdapterBindings();
  assert.equal(bindings.length, 17); assert.ok(bindings.some(binding => binding.kind === 'format.transform'));
  for (const name of ['worker.mjs', 'model.mjs', 'transport.mjs', 'renderers.mjs', 'media.mjs']) assert.ok(closure.files.some(file => file.path.endsWith(name)));
  assert.ok(closure.files.some(file => file.path === 'scripts/content-ops-worker.mjs'));
  for (const file of closure.files) assert.equal(bytesHash(fs.readFileSync(path.join(ROOT, file.path))), file.sha256);
  assert.ok(bindings.every(binding => binding.entrypointSha === closure.sha256));
  assert.equal(bindings.find(binding => binding.kind === 'video.assemble').fixedTransport, 'fixed_native_local');
});
test('a running ESM worker cannot advertise a new disk fingerprint while still holding cached older code', async t => {
  const copy = rootDirectory(t), closure = await contentOpsSourceClosure();
  for (const entry of closure.files) {
    const destination = path.join(copy, entry.path); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(ROOT, entry.path), destination, fs.constants.COPYFILE_EXCL);
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(copy, "node_modules"), "dir");
  const imported = await import(pathToFileURL(path.join(copy, 'src/content-ops-worker/adapters.mjs')).href);
  assert.equal((await imported.contentOpsAdapterBindings({ rootDir: copy })).length, 17);
  fs.appendFileSync(path.join(copy, 'src/content-ops-worker/model.mjs'), '\n// Deliberate isolated source drift.\n');
  await assert.rejects(imported.contentOpsAdapterBindings({ rootDir: copy }), { code: 'ADAPTER_SOURCE_CHANGED' });
  await assert.rejects(imported.createContentOpsAdapters({ rootDir: copy }), { code: 'ADAPTER_SOURCE_CHANGED' });
});

test('model adapters execute the exact isolated prepared data once and keep author-only outline/copyedit constraints', async () => {
  const requests = [], model = localModel(() => modelOutput, requests), adapters = await createContentOpsAdapters({ model, clock: () => TIME });
  const adapter = adapters.get('text.adapt'), input = ordinaryInput();
  input.effectivePolicy.allowedAiActions = ['copyedit']; input.target.requestedCreationMode = 'human_original_copyedit';
  await assert.rejects(adapter.execute({ lease: leaseFor(adapter.binding), input, runCall: directCall }), { code: 'AUTHOR_INPUT_REQUIRED' }); assert.equal(requests.length, 0);
  input.authorContributions = [{ id: 'AUTHOR-1', title: '本人原稿', body: '完整本人原稿与限定条件。' }];
  const result = await adapter.execute({ lease: leaseFor(adapter.binding), input, runCall: directCall });
  assert.equal(result.data.body, modelOutput.body); assert.deepEqual(result.outputs, []); assert.equal(result.executionReceipts[0].executed, true);
  assert.match(requests[0].messages[0].content, /Do not write a new draft/); assert.equal(requests.length, 1);
  const strategy = adapters.get('strategy.plan');
  await assert.rejects(strategy.execute({ lease: leaseFor(strategy.binding), input, runCall: directCall }), { code: 'UNKNOWN_FIELD' });
  assert.match(requests[1].messages[0].content, /Outline generation is forbidden/);
});

test('translate-only neutral work preserves source format without requiring unrelated draft or copyedit permission', async () => {
  const requests = [], input = ordinaryInput(); input.target.locale = 'en-US';
  input.effectivePolicy.allowedAiActions = ['translate']; input.sourceEditions[0].format = 'article'; input.sourceEditions[0].locale = 'zh-CN';
  input.transformSpec = { targetLocale: 'en-US', targetFormat: 'article' }; input.plan = { motherEditionRefs: [{ id: 'ED-1', revision: 1, sha256: HASH }] };
  const model = localModel(() => ({ ...modelOutput, locale: 'en-US', format: 'article', sourceRefs: input.plan.motherEditionRefs }), requests);
  const adapters = await createContentOpsAdapters({ model, clock: () => TIME }), adapter = adapters.get('format.transform');
  const result = await adapter.execute({ lease: leaseFor(adapter.binding), input, runCall: directCall });
  assert.equal(result.data.format, 'article'); assert.equal(requests.length, 1);
  const dispatched = JSON.parse(requests[0].messages[1].content);
  assert.equal(dispatched.workerPolicy.authorEditingOnly, false); assert.equal(dispatched.workerPolicy.translationOnly, true);
  assert.match(requests[0].messages[0].content, /permits translation of the complete supplied source only/);
  input.transformSpec.targetFormat = 'image_text';
  await assert.rejects(adapter.execute({ lease: leaseFor(adapter.binding), input, runCall: directCall }), { code: 'PLATFORM_POLICY_BLOCKED' });
  assert.equal(requests.length, 1);
  input.transformSpec.targetFormat = 'article'; input.effectivePolicy.requiresAuthorContribution = true;
  await assert.rejects(adapter.execute({ lease: leaseFor(adapter.binding), input, runCall: directCall }), { code: 'AUTHOR_INPUT_REQUIRED' });
  assert.equal(requests.length, 1);
});

test('final checker reads every actual text attachment and refuses to upgrade visual/media coverage', async () => {
  const requests = [], attachment = Buffer.from('# Full attachment\n\nEvery line is included in the independent check.\n');
  const input = ordinaryInput();
  input.package = { schema: 'pengmanager.publication-package/v3', title: modelOutput.title, summary: modelOutput.summary, body: modelOutput.body,
    orderedBlocks: modelOutput.blocks, nativeManifest: {}, artifactRefs: [{ id: 'ART-text', mime: 'text/markdown', sha256: bytesHash(attachment) }] };
  input.package.packageHash = dataHash(input.package); input.packageHash = input.package.packageHash; input.checkContextHash = HASH;
  const resultFor = request => { const source = JSON.parse(request.messages[1].content); return { checkedPackageHash: source.packageHash,
    findings: [], coverage: { deterministic: 'checked', semantic: 'checked', media: 'not_applicable', artistic: 'checked' }, assessment: 'Independent fixture full text check.' }; };
  const adapters = await createContentOpsAdapters({ model: localModel(resultFor, requests), clock: () => TIME });
  const adapter = adapters.get('quality.final'), lease = leaseFor(adapter.binding);
  lease.resolvedInputRefs.packageRef = { packageHash: input.packageHash, checkContextHash: HASH };
  const result = await adapter.execute({ lease, input, inputs: [{ id: 'ART-text', bytes: attachment, sha256: bytesHash(attachment), mime: 'text/markdown' }], runCall: directCall });
  assert.equal(result.data.dimensions.semantic, 'passed'); assert.equal(result.data.dimensions.media, 'passed');
  assert.match(JSON.parse(requests[0].messages[1].content).attachmentTexts[0].text, /Every line is included/);
  await assert.rejects(adapter.execute({ lease, input, inputs: [], runCall: directCall }), { code: 'ARTIFACT_MISSING' });
  input.package.artifactRefs.push({ id: 'ART-image', mime: 'image/png', sha256: bytesHash(Buffer.from('fixture-image-bytes')) });
  delete input.package.packageHash; input.package.packageHash = dataHash(input.package); input.packageHash = input.package.packageHash; lease.resolvedInputRefs.packageRef.packageHash = input.packageHash;
  const media = await adapter.execute({ lease, input, inputs: [{ id: 'ART-text', bytes: attachment, mime: 'text/markdown' },
    { id: 'ART-image', bytes: Buffer.from('fixture-image-bytes'), mime: 'image/png' }], runCall: directCall });
  assert.equal(media.data.dimensions.media, 'unverified'); assert.equal(media.data.dimensions.artistic, 'unverified');
});

test('static native notebook preparation preserves exact input bytes and never executes a cell', async t => {
  const root = rootDirectory(t), notebook = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Static original notebook'] },
    { cell_type: 'code', metadata: {}, source: ['throw new Error("must never execute")'], outputs: [], execution_count: null },
  ] }));
  const adapters = await createContentOpsAdapters({ currency: 'USD', rendererOptions: { workRoot: root }, mediaOptions: { workRoot: root } });
  const adapter = adapters.get('native.prepare'), input = ordinaryInput();
  input.target.nativeForm = 'notebook'; input.target.settings = { kind: 'notebook', executeCode: false };
  input.target.inputFiles = [{ artifactId: 'ART-notebook', sha256: bytesHash(notebook), role: 'notebook' }];
  const spec = { outputKey: 'notebook', kind: 'notebook', role: 'notebook', allowedMimes: ['application/x-ipynb+json'], maxBytes: 1_000_000, required: true };
  const result = await adapter.execute({ lease: leaseFor(adapter.binding, [spec]), input,
    inputs: [{ id: 'ART-notebook', sha256: bytesHash(notebook), bytes: notebook, mime: 'application/x-ipynb+json', sourceProof: { sourceUntouched: true } }], runCall: directCall });
  assert.deepEqual(result.outputs[0].bytes, notebook); assert.equal(result.data.outputs[0].executeCode, false);
  assert.equal((await inspectProductionArtifact(result.outputs[0].bytes, result.outputs[0].mime)).kind, 'notebook');
});

test('original VTT is parsed as a genuine timeline, while untimed or translated-as-original captions are rejected', async t => {
  const root = rootDirectory(t), caption = Buffer.from('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nOriginal exact text.\n');
  const adapters = await createContentOpsAdapters({ currency: 'USD', rendererOptions: { workRoot: root }, mediaOptions: { workRoot: root } });
  const adapter = adapters.get('caption.align'), input = ordinaryInput(); input.target.languagePlan.subtitleMode = 'original'; input.target.settings = { durationMs: 1000 };
  input.target.inputFiles = [{ artifactId: 'ART-caption', sha256: bytesHash(caption), role: 'timed_captions' }];
  const lease = leaseFor(adapter.binding, [{ outputKey: 'captions', kind: 'captions', role: 'captions', allowedMimes: ['text/vtt'], maxBytes: 1_000_000 }]);
  const inputs = [{ id: 'ART-caption', sha256: bytesHash(caption), bytes: caption, mime: 'text/vtt', sourceProof: { sourceUntouched: true } }];
  const result = await adapter.execute({ lease, input, inputs, runCall: directCall });
  assert.match(result.outputs[0].bytes.toString(), /00:00:00.000 --> 00:00:01.000/);
  assert.equal(result.data.outputs[0].alignmentPerformed, false);
  input.target.languagePlan.subtitleMode = 'translated';
  await assert.rejects(adapter.execute({ lease, input, inputs, runCall: directCall }), { code: 'CAPTION_TRANSLATION_REQUIRED' });
});

async function cli(args, { env = {}, cwd = ROOT } = {}) {
  const child = spawn(process.execPath, ['scripts/content-ops-worker.mjs', ...args], { cwd, env: { PATH: path.dirname(process.execPath), HOME: os.homedir(), LANG: 'C', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const [code] = await once(child, 'close'); return { code, stdout, stderr };
}
function privateJson(file, value) { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); }

test('CLI doctor and errors do not print process-only credentials or read an implicit environment file', async t => {
  const root = rootDirectory(t), config = path.join(root, 'worker.json');
  privateJson(config, { schema: 'pengmanager.worker-config/v1', origin: 'https://cloud.invalid', workerId: 'WORKER-1', dataDir: path.join(root, 'data'), grantFile: path.join(root, 'not-read-by-doctor.json') });
  const secret = 'private-fixture-secret-never-output', result = await cli(['doctor', '--config', config], { env: { CONTENT_OPS_MODEL_API_KEY: secret, CONTENT_OPS_WORKER_TOKEN: secret } });
  assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-secret-never-output/);
  const report = JSON.parse(result.stdout); assert.equal(report.credentialsPrinted, false); assert.ok(report.adapters.some(row => row.kind === 'voice.speak' && !row.ready));
  fs.chmodSync(config, 0o644); const denied = await cli(['doctor', '--config', config]); assert.equal(denied.code, 1);
  assert.equal(JSON.parse(denied.stderr).error.code, 'WORKER_CONFIG_PERMISSIONS');
});

test('CLI one-time pairing sends only a credential digest and stores a private nonsecret receipt', async t => {
  const root = rootDirectory(t), configPath = path.join(root, 'worker.json'), grantPath = path.join(root, 'grant.json');
  const requests = [], token = 'x'.repeat(43), challenge = 'isolated-once-challenge';
  let grant;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    assert.equal(req.url, '/api/content-ops/worker/pairing/confirm'); assert.equal(body.credentialHash, bytesHash(Buffer.from(token))); assert.equal(body.challenge, challenge);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ workerId: grant.workerId, grantId: 'GRANT-fixture',
      scopeHash: grant.scopeHash, localGrantHash: grant.localGrantHash, expiresAt: grant.expiresAt }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`, bindings = await contentOpsAdapterBindings();
  grant = { schema: 'pengmanager.worker-local-grant/v1', workerId: 'WORKER-1', origin, workspaceId: 'workspace', projectIds: ['project'], jobIds: ['JOB-1'], targetKeys: ['target'],
    adapterBindings: [bindings[0]], scopeHash: HASH, budgetAuthorizationHash: HASH, expiresAt: new Date(Date.now() + 60_000).toISOString(), roles: ['worker'], ownerConfirmed: true,
    limits: { maxTempBytes: 20_000_000, maxRenderSeconds: 60, maxNativeProcesses: 1, maxCalls: 10 } };
  grant.localGrantHash = localGrantHash(grant); privateJson(grantPath, grant);
  privateJson(configPath, { schema: 'pengmanager.worker-config/v1', origin, workerId: grant.workerId, dataDir: path.join(root, 'data'), grantFile: grantPath, allowLoopbackHttp: true });
  const result = await cli(['pair', '--config', configPath, '--challenge-id', 'PAIR-1', '--confirm-local-owner'],
    { env: { CONTENT_OPS_WORKER_TOKEN: token, CONTENT_OPS_PAIRING_CHALLENGE: challenge } });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).credentialStored, false); assert.equal(requests.length, 1);
  const file = path.join(root, 'data/pairing-receipt.json'), raw = fs.readFileSync(file, 'utf8');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.doesNotMatch(raw + result.stdout + result.stderr, /isolated-once-challenge|xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/);
  assert.equal(JSON.parse(raw).grantId, 'GRANT-fixture');
});
