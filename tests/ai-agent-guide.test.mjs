import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, access, realpath, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MCP_INSTRUCTIONS, readAiAgentGuide } from '../src/ai-agent-guide.mjs';
import { createPengManagerAgent } from '../src/agent.mjs';
import { modelEnvironmentArgs, validatedModelEnvFile } from '../src/ai-workbench-paths.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pm guide 空格-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function child(script, args, cwd, dataDir, input = '', nodeArgs = []) {
  return new Promise((resolve, reject) => {
    const processChild = spawn(process.execPath, [...nodeArgs, path.join(root, script), ...args], {
      cwd, env: { ...process.env, PENGMANAGER_VIDEO_DATA_DIR: dataDir,
        WORKLOOM_ACCESS_TOKEN: '', WORKLOOM_C_TOKEN: '', LLM_API_KEY: 'synthetic-key-must-not-appear', DEEPSEEK_API_KEY: '', ARK_API_KEY: '', VOLCENGINE_ARK_API_KEY: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    processChild.stdout.setEncoding('utf8');
    processChild.stderr.setEncoding('utf8');
    processChild.stdout.on('data', bytes => { stdout += bytes; });
    processChild.stderr.on('data', bytes => { stderr += bytes; });
    processChild.on('error', reject);
    processChild.on('close', code => resolve({ code, stdout, stderr }));
    processChild.stdin.end(input);
  });
}

test('guide contains complete current documents and exact byte hashes without runtime startup or private writes', async t => {
  const directory = await temporary(t), dataDir = path.join(directory, 'uncreated runtime');
  const guide = readAiAgentGuide({ rootDir: root, dataDir });
  assert.equal(guide.productId, 'pengmanager-system');
  assert.equal(guide.support.shellRequiredForProduction, true);
  assert.equal(guide.support.pureMcpProductionSupported, false);
  assert.equal(guide.providerCallsPerformed, false);
  assert.equal(guide.productionVerified, false);
  assert.equal(guide.documents.length, 5);
  for (const doc of guide.documents) {
    const bytes = await readFile(path.join(root, doc.path));
    assert.equal(doc.markdown, new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    assert.equal(doc.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(doc.bytes, bytes.length);
  }
  assert.deepEqual(guide.cli.standardVideo.argsPrefix, [path.join(root, 'scripts/video-standard.mjs')]);
  assert.deepEqual(guide.cli.standardVideo.dataArgs, ['--data-dir', dataDir]);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});

test('model env handoff preserves only explicit private paths in order and rejects invalid metadata', async t => {
  const directory = await realpath(await temporary(t)), fixtureRoot = path.join(directory, 'checkout');
  await mkdir(fixtureRoot);
  const files = [path.join(directory, '模型 one.env'), path.join(directory, 'two.env')];
  for (const file of files) await writeFile(file, 'SYNTHETIC_MODEL_VALUE=private-value-not-for-output\n', { mode: 0o600 });
  const args = modelEnvironmentArgs(fixtureRoot, ['--inspect=0', '--env-file', files[0], '--env-file=' + files[1]]);
  assert.deepEqual(args, files.map(file => '--env-file=' + file));
  const multiple = readAiAgentGuide({ rootDir: root, dataDir: path.join(directory, 'unused'), execArgv: args });
  assert.deepEqual(multiple.cli.standardVideo.argsPrefix.slice(0, 2), args);
  assert.equal(multiple.cli.config.args, null);
  assert.equal(multiple.cli.config.code, 'MULTIPLE_MODEL_ENV_FILES_REQUIRE_EXPLICIT_CONFIG');
  assert.throws(() => modelEnvironmentArgs(fixtureRoot, ['--env-file-if-exists=' + files[0]]), { code: 'MODEL_ENV_FILE_INVALID' });
  assert.throws(() => modelEnvironmentArgs(fixtureRoot, ['--env-file']), { code: 'MODEL_ENV_FILE_INVALID' });
  for (const invalid of ['relative.env', fixtureRoot, path.join(directory, 'missing.env')]) {
    assert.throws(() => validatedModelEnvFile(fixtureRoot, invalid), { code: 'MODEL_ENV_FILE_INVALID' });
  }
  const linked = path.join(directory, 'linked.env');
  await symlink(files[0], linked);
  assert.throws(() => validatedModelEnvFile(fixtureRoot, linked), { code: 'MODEL_ENV_FILE_INVALID' });
  const inRepo = path.join(fixtureRoot, 'model.env');
  await writeFile(inRepo, 'SYNTHETIC_MODEL_VALUE=private-value\n', { mode: 0o600 });
  assert.throws(() => validatedModelEnvFile(fixtureRoot, inRepo), { code: 'MODEL_ENV_FILE_INVALID' });
  if (process.platform !== 'win32') {
    await chmod(files[0], 0o644);
    assert.throws(() => validatedModelEnvFile(fixtureRoot, files[0]), { code: 'MODEL_ENV_FILE_INVALID' });
  }
});

test('actual MCP env-file startup returns executable owner CLI args without copying model values', async t => {
  const directory = await realpath(await temporary(t)), dataDir = path.join(directory, 'uncreated');
  const file = path.join(directory, 'model 空格.env');
  const secret = 'synthetic-model-value-not-in-guide';
  await writeFile(file, 'PM_GUIDE_MODEL_VALUE=' + secret + '\n', { mode: 0o600 });
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pengmanager_agent_guide', arguments: {} } };
  const result = await child('scripts/agent-mcp.mjs', [], directory, dataDir, JSON.stringify(request) + '\n', ['--env-file=' + file]);
  assert.equal(result.code, 0, result.stderr);
  const response = JSON.parse(result.stdout), guide = JSON.parse(response.result.content[0].text);
  assert.equal(response.result.isError, false);
  assert.deepEqual(guide.cli.standardVideo.argsPrefix, ['--env-file=' + file, path.join(root, 'scripts/video-standard.mjs')]);
  assert.deepEqual(guide.modelEnvironment.nodeArgs, ['--env-file=' + file]);
  assert.equal(guide.modelEnvironment.inheritedByHostShell, false);
  assert.ok(!result.stdout.includes(secret));
  const plan = await new Promise((resolve, reject) => {
    const processChild = spawn(guide.cli.standardVideo.command,
      [...guide.cli.standardVideo.argsPrefix, 'plan', ...guide.cli.standardVideo.dataArgs, ...guide.cli.standardVideo.inputArgs],
      { cwd: directory, env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    processChild.stdout.setEncoding('utf8'); processChild.stderr.setEncoding('utf8');
    processChild.stdout.on('data', value => { stdout += value; }); processChild.stderr.on('data', value => { stderr += value; });
    processChild.once('error', reject); processChild.once('close', code => resolve({ code, stdout, stderr }));
    processChild.stdin.end(JSON.stringify({ intent: '做一支 17 秒视频' }));
  });
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).requestedDurationSec, 17);
  assert.equal(JSON.parse(plan.stdout).complete, false);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});

test('missing, redirected, empty and invalid UTF-8 instructions fail closed', async t => {
  const directory = await temporary(t);
  const invoke = () => readAiAgentGuide({ rootDir: directory, dataDir: path.join(directory, 'unused') });
  assert.throws(invoke, { code: 'AGENT_GUIDE_UNAVAILABLE' });
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, '# unrelated');
  await symlink(outside, path.join(directory, 'AGENTS.md'));
  assert.throws(invoke, { code: 'AGENT_GUIDE_UNAVAILABLE' });
  await rm(path.join(directory, 'AGENTS.md'));
  await writeFile(path.join(directory, 'AGENTS.md'), '');
  assert.throws(invoke, { code: 'AGENT_GUIDE_UNAVAILABLE' });
  await writeFile(path.join(directory, 'AGENTS.md'), Buffer.from([0xff]));
  assert.throws(invoke, { code: 'AGENT_GUIDE_UNAVAILABLE' });
});

test('guide rejects input fields before runtime access and is registered as read-only', async t => {
  const directory = await temporary(t);
  const runtime = new Proxy({}, { get() { throw new Error('guide must not call runtime'); } });
  const agent = await createPengManagerAgent({ rootDir: root, dataDir: path.join(directory, 'uncreated'), runtimeFactory: () => runtime });
  assert.equal(agent.toolId('pengmanager_agent_guide'), 'pengmanager.agent.guide');
  assert.equal(agent.tools().find(tool => tool.name === 'pengmanager_agent_guide').annotations.readOnlyHint, true);
  for (const input of [null, [], { path: '/etc/passwd' }, { startNative: true }]) {
    await assert.rejects(agent.invoke('pengmanager.agent.guide', input), { code: 'INVALID_INPUT' });
  }
  assert.equal((await agent.invoke('pengmanager.agent.guide')).providerCallsPerformed, false);
  await agent.stop();
});

test('actual CLI guide and MCP handshake/calls work from an unrelated directory with the same private path', async t => {
  const directory = await temporary(t), dataDir = path.join(directory, 'not-created');
  const cli = await child('scripts/agent.mjs', ['guide', '--data-dir', dataDir], directory, dataDir);
  assert.equal(cli.code, 0, cli.stderr);
  const guide = JSON.parse(cli.stdout);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pengmanager_agent_guide', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pengmanager_agent_guide', arguments: { arbitraryPath: '/etc/passwd' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pengmanager_video_workflow', arguments: { intent: '做一条 17 秒视频' } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pengmanager_video_workflow', arguments: { intent: '做一条视频' } } },
  ];
  const mcp = await child('scripts/agent-mcp.mjs', [], directory, dataDir, requests.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.equal(mcp.code, 0, mcp.stderr);
  const responses = mcp.stdout.trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual(responses.map(row => row.id), [1, 2, 3, 4, 5]);
  assert.equal(responses[0].result.instructions, MCP_INSTRUCTIONS);
  assert.match(MCP_INSTRUCTIONS.slice(0, 512), /pengmanager_agent_guide/);
  assert.deepEqual(JSON.parse(responses[1].result.content[0].text), guide);
  assert.equal(JSON.parse(responses[2].result.content[0].text).error.code, 'INVALID_INPUT');
  assert.equal(JSON.parse(responses[3].result.content[0].text).requestedDurationSec, 17);
  assert.equal(JSON.parse(responses[3].result.content[0].text).complete, false);
  assert.equal(JSON.parse(responses[4].result.content[0].text).error.code, 'STANDARD_VIDEO_DURATION_REQUIRED');
  assert.ok(!cli.stdout.includes('synthetic-key-must-not-appear'));
  assert.ok(!mcp.stdout.includes('synthetic-key-must-not-appear'));
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});
