import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { standardVideoExecutor, standardVideoIntent } from '../src/video-runtime/standard-workflow.mjs';

const root = path.resolve(import.meta.dirname, '..');
const token = 'synthetic-pengmanager-member';
const publishedSourceMain = 'a544ab8b068790bfb14b7977efc81b33897fc9de';
const raw = ' 用鹏经理把 820RR 做成十七秒的营销片。 ';
const statusRow = { runId: 'RUN-17', projectId: 'VID-17', status: 'finished', pendingApprovalId: null };
const archive = { projectId: 'VID-17', archiveExists: true, pendingApprovalId: null, manualBridges: [], stages: [
  { stageId: 'preproduction', runId: 'RUN-17', attempt: 1, status: 'done', outputRef: 'stages/preproduction/attempt-1.output.json', outputSha256: 'a'.repeat(64) },
] };
const shots = { projectId: 'VID-17', sourceAttempt: 1, promptsSha256: 'b'.repeat(64), shots: [
  { shotId: 'S-1', durationSec: 8, promptSha256: 'c'.repeat(64) },
  { shotId: 'S-2', durationSec: 9, promptSha256: 'd'.repeat(64) },
] };

async function cli(args, { input, env = {}, command = 'scripts/video-standard.mjs' } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], { cwd: root,
      env: { ...process.env, WORKLOOM_ACCESS_TOKEN: '', WORKLOOM_C_TOKEN: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, out, err,
      get result() { return JSON.parse(out); }, get error() { return JSON.parse(err).error; } }));
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}
async function fixture(t, { previousState = 'routed', statusData = statusRow,
  scope = { tenantId: 'tenant-pengmanager-video', workspaceId: 'ws-pengmanager-video' },
  archiveData = archive, shotsData = shots } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'peng-video-standard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let input = url.searchParams.has('input') ? JSON.parse(url.searchParams.get('input')) : undefined;
    if (req.method === 'POST') { let body = ''; for await (const part of req) body += part; input = JSON.parse(body); }
    calls.push({ path: url.pathname, method: req.method, input, authorized: req.headers.authorization === `Bearer ${token}` });
    if (!calls.at(-1).authorized) { res.writeHead(401).end('{}'); return; }
    const values = {
      '/trpc/members.me': { identity: scope },
      '/trpc/video.studio.status': statusData, '/trpc/video.studio.archive': archiveData, '/trpc/video.production.shots': shotsData,
    };
    if (!Object.hasOwn(values, url.pathname)) { res.writeHead(404).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ result: { data: values[url.pathname] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { WORKLOOM_ACCESS_TOKEN: token, PENGMANAGER_VIDEO_BACKEND_PORT: String(server.address().port) };
  const invoke = (action, input, environment = {}) => cli([action, '--input-file', '-', '--data-dir', directory], { input, env: { ...env, ...environment } });
  const startCli = (input, environment) => invoke('start', input, environment);
  const statusCli = (job, environment = {}) => cli(['status', '--job', job, '--data-dir', directory], { env: { ...env, ...environment } });
  // Seed the exact published v1 key and receipt format, independent of the new CLI.
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const jobId = hash(JSON.stringify({ intent: raw, route: 'auto', metadata: { brief: { duration: 17 } } }));
  const previous = { schemaVersion: 'pengmanager.standard-video-start/v1', jobId, sourceMain: publishedSourceMain,
    workspaceId: 'ws-pengmanager-video', backendPort: server.address().port, intentSha256: hash(raw), requestedDurationSec: 17,
    complete: false, state: previousState,
    ...(previousState === 'routed' ? { projectId: 'VID-17', runId: 'RUN-17', pipeline: 'marketing', next: 'status' } : {}),
    ...(previousState === 'clarify' ? { missing: ['product'], next: 'resolve-native-route' } : {}),
  };
  if (previousState) {
    await mkdir(path.join(directory, 'standard-video-runs'), { mode: 0o700 });
    await writeFile(path.join(directory, 'standard-video-runs', jobId + '.json'), JSON.stringify(previous) + '\n', { mode: 0o600 });
  }
  const upgradedExecutor = standardVideoExecutor({ dataRoot: await realpath(directory), sourceMain: 'f'.repeat(40),
    ports: { backend: server.address().port }, env });
  return { calls, directory, jobId, previous, invoke, startCli, statusCli, upgradedExecutor };
}

test('the one-sentence plan is read-only, exact, and does not default an explicit request to 30', async () => {
  const out = await cli(['plan', '--input-file', '-'], { input: { intent: raw } });
  assert.equal(out.code, 0, out.err);
  assert.equal(out.result.input.intent, raw);
  assert.equal(out.result.input.metadata.brief.duration, 17);
  assert.equal(out.result.input.route, 'auto');
  assert.equal(out.result.productionAuthorized, false);
  assert.equal(out.result.complete, false);
  for (const intent of ['做一个视频', '做 30 秒，每镜 10 秒', '做 2.5 秒', '做 -30 秒', '做 181 秒']) {
    assert.throws(() => standardVideoIntent({ intent }), { code: 'STANDARD_VIDEO_DURATION_REQUIRED' });
  }
  assert.equal(standardVideoIntent({ intent: '做 ３０ 秒，每镜 １０ 秒', durationSec: 30 }).requestedDurationSec, 30);
  assert.throws(() => standardVideoIntent({ intent: '做 30 秒', durationSec: 17 }), { code: 'STANDARD_VIDEO_DURATION_REQUIRED' });
  assert.throws(() => standardVideoIntent({ intent: raw, shots: [] }), { code: 'STANDARD_VIDEO_INTENT_INVALID' });
});

test('standard CLI retains the old job ID and status reads only the current preproduction', async t => {
  const { calls, directory, previous, startCli, statusCli } = await fixture(t);
  const started = await startCli({ intent: raw });
  assert.equal(started.code, 0, started.err);
  const first = started.result;
  assert.deepEqual(first, previous);
  assert.deepEqual(calls, []);
  const repeated = await startCli({ intent: raw });
  assert.deepEqual(repeated.result, first);
  const checked = await statusCli(first.jobId);
  assert.equal(checked.code, 0, checked.err);
  assert.equal(checked.result.stage, 'preproduction-verified');
  assert.equal(checked.result.next, 'video.production.qualifyShot');
  assert.equal(checked.result.complete, false);
  assert.equal(checked.result.promptsSha256, 'b'.repeat(64));
  assert.equal(calls.some(row => row.method === 'POST'), false);
  assert.ok(calls.every(row => row.authorized));
  const file = await readFile(path.join(directory, 'standard-video-runs', `${first.jobId}.json`), 'utf8');
  assert.ok(!file.includes(token) && !file.includes(raw));
});

test('pending legacy receipt never resubmits and points resume and delivery to the old job', async t => {
  const { calls, invoke, startCli, statusCli } = await fixture(t, { previousState: 'pending' });
  const original = await startCli({ intent: raw });
  assert.equal(original.result.state, 'pending');
  const checked = await statusCli(original.result.jobId);
  assert.equal(checked.result.next, 'reconcile-original-start');
  for (const mode of ['resume', 'deliver']) {
    const denied = await invoke(mode, { intent: raw });
    assert.equal(denied.code, 2, denied.err);
    assert.equal(denied.result.jobId, original.result.jobId);
    assert.equal(denied.result.previousState, 'pending');
    assert.equal(denied.result.code, 'STANDARD_VIDEO_LEGACY_PROJECT_READBACK_REQUIRED');
  }
  assert.deepEqual(calls, []);
});

test('an engine pin refresh still permits verified readback of the published v1 receipt', async t => {
  const { calls, jobId, previous, upgradedExecutor } = await fixture(t);
  assert.deepEqual(upgradedExecutor.lookup(jobId), previous);
  const checked = await upgradedExecutor.status(jobId);
  assert.equal(checked.stage, 'preproduction-verified');
  assert.equal(checked.sourceMain, publishedSourceMain);
  assert.ok(calls.every(row => row.method === 'GET' && row.authorized));
});

test('wrong workspace stops legacy readback; clarification does not look like a real project', async t => {
  const other = await fixture(t, { scope: { tenantId: 'tenant-other', workspaceId: 'ws-other' } });
  const denied = await other.statusCli(other.jobId);
  assert.equal(denied.error.code, 'STANDARD_VIDEO_SCOPE_MISMATCH');
  assert.deepEqual(other.calls.map(row => row.path), ['/trpc/members.me']);
  const unclear = await fixture(t, { previousState: 'clarify' });
  const result = (await unclear.startCli({ intent: raw })).result;
  assert.equal(result.state, 'clarify');
  assert.deepEqual(result.missing, ['product']);
  assert.ok(!result.runId);
  assert.equal(result.complete, false);
});

test('standard work rejects manual bridging, stale source attempts and a different total duration', async t => {
  const badCases = [
    [{ archiveData: { ...archive, manualBridges: [{ bridgeId: 'existing' }] } }, 'STANDARD_VIDEO_ARCHIVE_UNVERIFIED'],
    [{ shotsData: { ...shots, sourceAttempt: 2 } }, 'STANDARD_VIDEO_SHOTS_UNVERIFIED'],
    [{ shotsData: { ...shots, shots: [shots.shots[0], { ...shots.shots[1], durationSec: 8 }] } }, 'STANDARD_VIDEO_SHOTS_UNVERIFIED'],
  ];
  for (const [settings, code] of badCases) {
    const { calls, startCli, statusCli } = await fixture(t, settings);
    const first = (await startCli({ intent: raw })).result;
    const denied = await statusCli(first.jobId);
    assert.equal(denied.code, 1);
    assert.equal(denied.error.code, code);
    assert.equal(calls.some(row => row.method === 'POST'), false);
  }
});

test('a proxy and a credential echo cannot receive or create a reusable native receipt', async t => {
  let proxyRequests = 0;
  const producer = await fixture(t);
  const denied = await producer.startCli({ intent: `做 17 秒 ${token}` });
  assert.equal(denied.error.code, 'STANDARD_VIDEO_CREDENTIAL_IN_INPUT');
  assert.deepEqual(producer.calls, []);
  const proxy = await new Promise(resolve => {
    const server = createServer((_req, res) => { proxyRequests++; res.writeHead(501).end('{}'); });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const direct = await producer.statusCli(producer.jobId, { HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: '', NODE_USE_ENV_PROXY: '1' });
  assert.equal(direct.code, 0, direct.err);
  assert.equal(proxyRequests, 0);
  const echo = await fixture(t, { statusData: { ...statusRow, leaked: token } });
  const rejected = await echo.statusCli(echo.jobId);
  assert.equal(rejected.error.code, 'STANDARD_VIDEO_RESPONSE_INVALID');
  const retained = (await echo.startCli({ intent: raw })).result;
  assert.deepEqual(retained, echo.previous);
  assert.ok(!JSON.stringify(retained).includes(token));
});

test('fresh standard start needs private owner authority even when a legacy native bearer is supplied', async t => {
  const { calls, startCli, invoke, jobId } = await fixture(t, { previousState: null });
  const result = await startCli({ intent: raw });
  assert.equal(result.code, 2, result.err);
  assert.equal(result.result.schemaVersion, 'pengmanager.standard-video-production/v1');
  assert.equal(result.result.code, 'OWNER_PRODUCTION_AUTHORITY_REQUIRED');
  assert.equal(result.result.complete, false);
  assert.notEqual(result.result.jobId, jobId);
  assert.equal((await invoke('deliver', { intent: raw })).result.code, 'VIDEO_MAKE_NOT_FOUND');
  assert.deepEqual(calls, []);
});

test('registered local Agent capability returns only the same native handoff plan', async () => {
  const reply = await cli(['invoke', 'pengmanager.video.workflow', '--input-file', '-'], { input: { intent: raw }, command: 'scripts/agent.mjs' });
  assert.equal(reply.code, 0, reply.err);
  assert.deepEqual(reply.result, standardVideoIntent({ intent: raw }));
});
