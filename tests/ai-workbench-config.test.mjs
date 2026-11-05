import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, mkdir, rm, chmod, symlink, access, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { buildAiWorkbenchConfig } from '../src/ai-workbench-config.mjs';
import { parseAiWorkbenchArgs } from '../scripts/ai-workbench.mjs';

const root = path.resolve(import.meta.dirname, '..');
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'pm config 空格-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, dataDir: path.join(directory, 'data "quotes"'), modelEnvFile: path.join(directory, 'model "中文".env') };
}
function execute(command, args, { cwd, env = {}, input = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
const configCli = (args, options) => execute(process.execPath, [path.join(root, 'scripts/ai-workbench.mjs'), ...args], options);

test('config export produces canonical client settings and no state or credential copies', async t => {
  const { directory, dataDir } = await fixture(t);
  const result = await configCli(['config', '--data-dir', dataDir], { cwd: directory, env: {
    GH_TOKEN: 'synthetic-github-value-never-export', LLM_API_KEY: 'synthetic-model-value-never-export',
    PENGMANAGER_VIDEO_BACKEND_PORT: '28797', PENGMANAGER_VIDEO_PG_PORT: '26432',
  } });
  assert.equal(result.code, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schemaVersion, 'pengmanager.ai-workbench-config/v1');
  assert.equal(value.rootDir, await realpath(root));
  assert.equal(value.dataDir, dataDir);
  assert.deepEqual(value.args, [path.join(root, 'scripts/agent-mcp.mjs')]);
  assert.equal(value.cwd, root);
  assert.equal(value.env.PENGMANAGER_VIDEO_BACKEND_PORT, '28797');
  assert.equal(value.env.PENGMANAGER_VIDEO_PG_PORT, '26432');
  assert.equal(Object.keys(value.env).length, 3);
  assert.ok(Object.keys(value.env).every(key => key === 'PENGMANAGER_VIDEO_DATA_DIR' || /^PENGMANAGER_VIDEO_[A-Z_]+_PORT$/.test(key)));
  assert.equal(value.modelEnvFile, null);
  assert.equal(value.providerCallsPerformed, false);
  assert.equal(value.configurationWritten, false);
  assert.equal(value.qoderConfig.mcpServers['pengmanager-video'].type, 'stdio');
  assert.equal(value.genericConfig.mcpServers['pengmanager-video'].command, process.execPath);
  assert.ok(value.codexToml.includes('PENGMANAGER_VIDEO_DATA_DIR = ' + JSON.stringify(dataDir)));
  assert.ok(!result.stdout.includes('synthetic-github-value-never-export'));
  assert.ok(!result.stdout.includes('synthetic-model-value-never-export'));
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
  await assert.rejects(access(path.join(directory, '.codex')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(directory, '.qoder')), { code: 'ENOENT' });
});

test('all client projections agree and configured env-file remains only an absolute path', async t => {
  const { directory, dataDir, modelEnvFile } = await fixture(t);
  const secret = 'synthetic-model-file-value-never-export';
  await writeFile(modelEnvFile, 'PM_MODEL_VALUE=' + secret + '\n', { mode: 0o600 });
  const bundle = buildAiWorkbenchConfig({ rootDir: root, dataDir, modelEnvFile });
  assert.deepEqual(bundle.args, ['--env-file=' + modelEnvFile, path.join(root, 'scripts/agent-mcp.mjs')]);
  for (const client of ['codex', 'qoder', 'generic']) {
    const result = await configCli(['config', '--client', client, '--data-dir', dataDir, '--model-env-file', modelEnvFile], { cwd: directory });
    assert.equal(result.code, 0, result.stderr);
    if (client === 'codex') assert.equal(result.stdout, bundle.codexToml);
    else assert.deepEqual(JSON.parse(result.stdout), client === 'qoder' ? bundle.qoderConfig : bundle.genericConfig);
    assert.ok(!result.stdout.includes(secret));
  }
  assert.equal(await readFile(modelEnvFile, 'utf8'), 'PM_MODEL_VALUE=' + secret + '\n');
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});

test('TOML escapes DEL in a legal path while JSON retains its exact value', async t => {
  const { directory } = await fixture(t), dataDir = path.join(directory, 'private-' + String.fromCharCode(127));
  const config = buildAiWorkbenchConfig({ rootDir: root, dataDir });
  assert.equal(config.codexToml.includes(String.fromCharCode(127)), false);
  assert.ok(config.codexToml.includes('\\u007f'));
  assert.equal(JSON.parse(JSON.stringify(config.qoderConfig)).mcpServers['pengmanager-video'].env.PENGMANAGER_VIDEO_DATA_DIR, dataDir);
  const actual = await configCli(['config', '--client', 'codex', '--data-dir', dataDir], { cwd: directory });
  assert.equal(actual.code, 0, actual.stderr);
  assert.equal(actual.stdout, config.codexToml);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});

test('generated Qoder stdio settings launch actual MCP from an unrelated cwd and hand off exact instance coordinates', async t => {
  const { directory, dataDir, modelEnvFile } = await fixture(t);
  await writeFile(modelEnvFile, 'PM_MODEL_VALUE=synthetic-model-file-value\n', { mode: 0o600 });
  const generated = await configCli(['config', '--client', 'qoder', '--data-dir', dataDir, '--model-env-file', modelEnvFile],
    { cwd: directory, env: { PENGMANAGER_VIDEO_BACKEND_PORT: '28797' } });
  assert.equal(generated.code, 0, generated.stderr);
  const config = JSON.parse(generated.stdout).mcpServers['pengmanager-video'];
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pengmanager_agent_guide', arguments: {} } },
  ];
  const actual = await execute(config.command, config.args, { cwd: directory, env: config.env, input: requests.map(row => JSON.stringify(row)).join('\n') + '\n' });
  assert.equal(actual.code, 0, actual.stderr);
  const responses = actual.stdout.trim().split('\n').map(row => JSON.parse(row));
  assert.equal(responses[0].result.serverInfo.name, 'pengmanager-system');
  assert.ok(responses[1].result.tools.some(tool => tool.name === 'pengmanager_agent_guide'));
  assert.equal(responses[2].result.isError, false);
  const guide = JSON.parse(responses[2].result.content[0].text);
  assert.equal(guide.dataDir, dataDir);
  for (const [key, value] of Object.entries(config.env)) assert.equal(guide.cli.standardVideo.env[key], value);
  assert.equal(guide.cli.standardVideo.env.PENGMANAGER_VIDEO_BACKEND_PORT, '28797');
  assert.equal(Object.keys(guide.cli.standardVideo.env).length, 12);
  assert.deepEqual(guide.cli.standardVideo.argsPrefix, ['--env-file=' + modelEnvFile, path.join(root, 'scripts/video-standard.mjs')]);
  assert.equal(guide.productionVerified, false);
  assert.ok(!actual.stdout.includes('synthetic-model-file-value'));
  const exported = await execute(guide.cli.config.command, guide.cli.config.args, { cwd: directory, env: guide.cli.config.env });
  assert.equal(exported.code, 0, exported.stderr);
  const repeated = JSON.parse(exported.stdout);
  assert.deepEqual(repeated.env, guide.cli.standardVideo.env);
  assert.deepEqual(repeated.args, config.args);
  assert.equal(repeated.dataDir, dataDir);
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});

test('invalid arguments and unsupported target selection fail without echoing input values', async t => {
  const { directory } = await fixture(t);
  for (const args of [[], ['run'], ['config', '--client', 'unknown'], ['config', '--client'], ['config', '--client', 'codex', '--client', 'qoder'],
    ['config', '--token', 'synthetic-secret-input'], ['config', '--data-dir', 'relative'], ['config', '--model-env-file', 'missing']]) {
    const result = await configCli(args, { cwd: directory });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.ok(JSON.parse(result.stderr).error.code);
    assert.ok(!result.stderr.includes('synthetic-secret-input'));
  }
  assert.equal(parseAiWorkbenchArgs(['config']).client, 'all');
  const help = await configCli(['--help'], { cwd: directory });
  assert.equal(help.code, 0); assert.match(help.stdout, /--client/);
});

test('an env-file port remains effective when no process override was exported', async t => {
  const { directory, dataDir, modelEnvFile } = await fixture(t);
  await writeFile(modelEnvFile, 'PENGMANAGER_VIDEO_BACKEND_PORT=28798\n', { mode: 0o600 });
  const generated = await configCli(['config', '--client', 'generic', '--data-dir', dataDir, '--model-env-file', modelEnvFile], { cwd: directory });
  assert.equal(generated.code, 0, generated.stderr);
  const server = JSON.parse(generated.stdout).mcpServers['pengmanager-video'];
  assert.equal(Object.hasOwn(server.env, 'PENGMANAGER_VIDEO_BACKEND_PORT'), false);
  const actual = await execute(server.command, server.args, { cwd: directory, env: server.env,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pengmanager_agent_guide', arguments: {} } }) + '\n' });
  assert.equal(actual.code, 0, actual.stderr);
  const guide = JSON.parse(JSON.parse(actual.stdout).result.content[0].text);
  assert.equal(guide.cli.standardVideo.env.PENGMANAGER_VIDEO_BACKEND_PORT, '28798');
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});

test('checkout, executable, data-directory and private model-file boundaries fail explicitly', async t => {
  const { directory, dataDir, modelEnvFile } = await fixture(t);
  const base = { rootDir: root, dataDir };
  assert.throws(() => buildAiWorkbenchConfig({ ...base, rootDir: directory }), { code: 'AI_WORKBENCH_CHECKOUT_INVALID' });
  for (const nodePath of ['node', directory, path.join(directory, 'missing-node')]) {
    assert.throws(() => buildAiWorkbenchConfig({ ...base, nodePath }), { code: 'NODE_EXECUTABLE_INVALID' });
  }
  const nonExecutable = path.join(directory, 'not-executable');
  await writeFile(nonExecutable, '# fixture\n', { mode: 0o600 });
  if (process.platform !== 'win32') assert.throws(() => buildAiWorkbenchConfig({ ...base, nodePath: nonExecutable }), { code: 'NODE_EXECUTABLE_INVALID' });
  for (const invalid of [root, path.join(root, 'var', 'private'), path.dirname(root)]) {
    assert.throws(() => buildAiWorkbenchConfig({ ...base, dataDir: invalid }), { code: 'PRIVATE_DATA_REQUIRED' });
  }
  await mkdir(dataDir, { mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(dataDir, 0o755);
    assert.throws(() => buildAiWorkbenchConfig(base), { code: 'PRIVATE_DIRECTORY_PERMISSIONS' });
    await chmod(dataDir, 0o700);
  }
  assert.throws(() => buildAiWorkbenchConfig({ ...base, modelEnvFile }), { code: 'MODEL_ENV_FILE_INVALID' });
  await writeFile(modelEnvFile, 'PM_MODEL_VALUE=synthetic-secret\n', { mode: 0o600 });
  const link = path.join(directory, 'model-link.env');
  await symlink(modelEnvFile, link);
  assert.throws(() => buildAiWorkbenchConfig({ ...base, modelEnvFile: link }), { code: 'MODEL_ENV_FILE_INVALID' });
  if (process.platform !== 'win32') {
    await chmod(modelEnvFile, 0o644);
    assert.throws(() => buildAiWorkbenchConfig({ ...base, modelEnvFile }), { code: 'MODEL_ENV_FILE_INVALID' });
  }
});

test('config supports an executable Node path containing spaces and quotes without a shell', async t => {
  const { directory, dataDir } = await fixture(t), nodePath = path.join(directory, 'node "空格"');
  await copyFile(process.execPath, nodePath); await chmod(nodePath, 0o700);
  const config = buildAiWorkbenchConfig({ rootDir: root, dataDir, nodePath });
  const actual = await execute(config.command, config.args, { cwd: directory, env: config.env,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n' });
  assert.equal(actual.code, 0, actual.stderr);
  assert.deepEqual(JSON.parse(actual.stdout), { jsonrpc: '2.0', id: 1, result: {} });
  await assert.rejects(access(dataDir), { code: 'ENOENT' });
});
