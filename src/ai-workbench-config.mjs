import fs from 'node:fs';
import path from 'node:path';
import { runtimeConfig } from './video-runtime/config.mjs';
import { clientRuntimeEnvironment, validatedModelEnvFile } from './ai-workbench-paths.mjs';

export const AI_WORKBENCH_SERVER = 'pengmanager-video';
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };

function executable(file) {
  try {
    if (typeof file !== 'string' || !file.isWellFormed() || file.includes('\0') || !path.isAbsolute(file)) throw new Error('Invalid path.');
    const canonical = fs.realpathSync(file);
    if (!fs.statSync(canonical).isFile()) throw new Error('Invalid executable.');
    fs.accessSync(canonical, fs.constants.X_OK);
    return canonical;
  } catch { fail('NODE_EXECUTABLE_INVALID', 'Use an existing absolute Node.js executable path.'); }
}

/** Config export is read-only; only an explicit private env-file path is carried. */
export function buildAiWorkbenchConfig({ rootDir, dataDir, nodePath = process.execPath, modelEnvFile } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('NODE_VERSION_UNSUPPORTED', 'PengManager requires Node.js 24 or higher.');
  if (dataDir !== undefined && (typeof dataDir !== 'string' || !dataDir.isWellFormed() || dataDir.includes('\0') || !path.isAbsolute(dataDir))) {
    fail('PRIVATE_DATA_REQUIRED', 'Use an absolute private runtime directory outside this checkout.');
  }
  let config;
  try {
    config = runtimeConfig({ rootDir, dataDir, serveWorkbench: false });
    const metadata = JSON.parse(fs.readFileSync(path.join(config.rootDir, 'package.json'), 'utf8'));
    if (metadata.name !== 'pengmanager-system') throw new Error('Wrong product.');
    for (const relative of ['scripts/agent-mcp.mjs', 'scripts/video-standard.mjs']) {
      const file = path.join(config.rootDir, relative);
      if (!fs.statSync(file).isFile() || fs.realpathSync(file) !== file) throw new Error('Invalid entry.');
    }
  } catch (error) {
    if (error?.code === 'PRIVATE_DATA_REQUIRED' || error?.code === 'PORT_INVALID' || error?.code === 'PORT_CONFLICT') throw error;
    fail('AI_WORKBENCH_CHECKOUT_INVALID', 'Use this PengManager checkout with its registered MCP and standard CLI entrypoints.');
  }
  const command = executable(nodePath);
  if (fs.existsSync(config.dataRoot)) {
    const stat = fs.lstatSync(config.dataRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
      fail('PRIVATE_DIRECTORY_PERMISSIONS', 'The existing video runtime must be an ordinary owner-only directory.');
    }
  }
  const modelFile = modelEnvFile === undefined ? null : validatedModelEnvFile(config.rootDir, modelEnvFile);
  const args = [...(modelFile ? ['--env-file=' + modelFile] : []), path.join(config.rootDir, 'scripts/agent-mcp.mjs')];
  const env = clientRuntimeEnvironment(config, { explicitPortsOnly: true });
  const server = { command, args, cwd: config.rootDir, env };
  // TOML also requires DEL to be escaped; JSON leaves that code point literal.
  const quote = value => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
  const codexToml = [
    '[mcp_servers.' + AI_WORKBENCH_SERVER + ']',
    'command = ' + quote(command),
    'args = [' + args.map(quote).join(', ') + ']',
    'cwd = ' + quote(config.rootDir),
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 180',
    '',
    '[mcp_servers.' + AI_WORKBENCH_SERVER + '.env]',
    ...Object.entries(env).map(([key, value]) => key + ' = ' + quote(value)),
    '',
  ].join('\n');
  const qoderConfig = { mcpServers: { [AI_WORKBENCH_SERVER]: { type: 'stdio', ...server } } };
  const genericConfig = { mcpServers: { [AI_WORKBENCH_SERVER]: server } };
  return {
    schemaVersion: 'pengmanager.ai-workbench-config/v1', productId: 'pengmanager-system', serverName: AI_WORKBENCH_SERVER,
    rootDir: config.rootDir, dataDir: config.dataRoot, command, args, cwd: server.cwd, env,
    modelEnvFile: modelFile, codexToml, qoderConfig, genericConfig,
    providerCallsPerformed: false, configurationWritten: false,
  };
}
