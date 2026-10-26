import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

export const SOURCE_MAIN = '8707ac5fb7503e48c698a5029bef860e52d93342';
export const SOURCE_FILE_COUNT = 3438;
export const SCOPE = Object.freeze({ tenantId: 'tenant-pengmanager-video', workspaceId: 'ws-pengmanager-video', slug: 'pengmanager-video', memberNo: 'MEM-001', memberId: 'mem-pengmanager-video-owner' });
export class VideoRuntimeError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'VideoRuntimeError'; this.code = code; }
}
export function inside(root, value) { const rel = path.relative(root, value); return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); }
export function defaultDataRoot(env = process.env, platform = process.platform) {
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'PengManager', 'video-runtime');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'PengManager', 'video-runtime');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'PengManager', 'video-runtime');
}
function port(value, fallback) {
  const raw = String(value ?? fallback);
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535) throw new VideoRuntimeError('PORT_INVALID', 'Video runtime ports must be integers from 1 to 65535.');
  return Number(raw);
}
const PORTRAIT_REUSE_MAX_BYTES = 8_000_000;
function portraitReuseSnapshot(dataRoot, file) {
  const invalid = () => { throw new VideoRuntimeError('PORTRAIT_REUSE_MANIFEST_INVALID', 'Portrait reuse requires a bounded owner-only ordinary manifest inside this private data directory, with no redirected path.'); };
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file === dataRoot || !inside(dataRoot, file)) invalid();
  let fd;
  try {
    const ordinary = (stat, directory) => (directory ? stat.isDirectory() : stat.isFile()) && !stat.isSymbolicLink()
      && (process.platform === 'win32' || !(stat.mode & 0o077) && (typeof process.getuid !== 'function' || stat.uid === process.getuid()));
    let directory = dataRoot;
    for (const part of ['', ...path.relative(dataRoot, path.dirname(file)).split(path.sep).filter(Boolean)]) {
      if (part) directory = path.join(directory, part);
      if (!ordinary(fs.lstatSync(directory), true) || fs.realpathSync(directory) !== directory) invalid();
    }
    const named = fs.lstatSync(file);
    if (!ordinary(named, false) || named.size < 1 || named.size > PORTRAIT_REUSE_MAX_BYTES || fs.realpathSync(file) !== file) invalid();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(fd);
    if (!ordinary(before, false) || before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size) invalid();
    const buffer = Buffer.alloc(before.size + 1); let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd), current = fs.lstatSync(file);
    if (size !== before.size || !ordinary(after, false) || !ordinary(current, false)
      || before.dev !== after.dev || before.ino !== after.ino || before.dev !== current.dev || before.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.size !== current.size
      || before.mtimeMs !== current.mtimeMs || fs.realpathSync(file) !== file) invalid();
    return Object.freeze({ path: file, bytes: size, sha256: createHash('sha256').update(buffer.subarray(0, size)).digest('hex') });
  } catch (error) {
    if (error instanceof VideoRuntimeError) throw error;
    throw new VideoRuntimeError('PORTRAIT_REUSE_MANIFEST_INVALID', 'The private portrait reuse manifest could not be verified.', { cause: error });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
/** Only an explicit owner runtime option selects a manifest; inherited env and HTTP metadata do not. */
export function verifiedPortraitReuseManifest(config) {
  if (!config.portraitReuseManifest) return '';
  const current = portraitReuseSnapshot(config.dataRoot, config.portraitReuseManifest.path);
  if (current.sha256 !== config.portraitReuseManifest.sha256 || current.bytes !== config.portraitReuseManifest.bytes) {
    throw new VideoRuntimeError('PORTRAIT_REUSE_MANIFEST_CHANGED', 'The selected portrait reuse manifest changed after the owner runtime configuration was frozen.');
  }
  return current.path;
}
export function runtimeConfig(options = {}) {
  if (!options.rootDir) throw new VideoRuntimeError('ROOT_REQUIRED', 'PengManager rootDir is required.');
  const rootDir = fs.realpathSync(path.resolve(options.rootDir));
  const engineRoot = fs.realpathSync(path.resolve(options.engineRoot || path.join(rootDir, 'engines', 'video-edit')));
  if (!inside(rootDir, engineRoot) || engineRoot === rootDir) throw new VideoRuntimeError('ENGINE_OUTSIDE_PRODUCT', 'The complete video engine must be inside this PengManager installation.');
  const env = { ...process.env, ...(options.env || {}) };
  const requestedData = path.resolve(options.dataDir || env.PENGMANAGER_VIDEO_DATA_DIR || defaultDataRoot(env));
  if (requestedData === path.parse(requestedData).root || inside(rootDir, requestedData) || inside(requestedData, rootDir)) {
    throw new VideoRuntimeError('PRIVATE_DATA_REQUIRED', 'Video credentials and PostgreSQL data must use a private directory outside the repository.');
  }
  let ancestor = requestedData;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonical = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, requestedData));
  if (inside(rootDir, canonical) || inside(canonical, rootDir)) throw new VideoRuntimeError('PRIVATE_DATA_REQUIRED', 'Video data directory resolves into the repository.');
  const portraitReuseManifest = options.portraitReuseManifestPath === undefined ? null : portraitReuseSnapshot(canonical, options.portraitReuseManifestPath);
  const ports = {
    postgres: port(options.ports?.postgres ?? env.PENGMANAGER_VIDEO_PG_PORT, 16432),
    backend: port(options.ports?.backend ?? env.PENGMANAGER_VIDEO_BACKEND_PORT, 18797),
    web: port(options.ports?.web ?? env.PENGMANAGER_VIDEO_WEB_PORT, 14318),
    compositor: port(options.ports?.compositor ?? env.PENGMANAGER_VIDEO_COMPOSITOR_PORT, 19773),
    color: port(options.ports?.color ?? env.PENGMANAGER_VIDEO_COLOR_PORT, 19774),
    bgm: port(options.ports?.bgm ?? env.PENGMANAGER_VIDEO_BGM_PORT, 19775),
    subtitle: port(options.ports?.subtitle ?? env.PENGMANAGER_VIDEO_SUBTITLE_PORT, 19776),
    post: port(options.ports?.post ?? env.PENGMANAGER_VIDEO_POST_PORT, 19777),
    voice: port(options.ports?.voice ?? env.PENGMANAGER_VIDEO_VOICE_PORT, 19778),
    voiceEngine: port(options.ports?.voiceEngine ?? env.PENGMANAGER_VIDEO_VOICE_ENGINE_PORT, 19779),
    loommate: port(options.ports?.loommate ?? env.PENGMANAGER_VIDEO_LOOMMATE_PORT, 19780),
  };
  if (new Set(Object.values(ports)).size !== Object.keys(ports).length) throw new VideoRuntimeError('PORT_CONFLICT', 'Each managed service requires a distinct port.');
  const serveWorkbench=options.serveWorkbench??env.PENGMANAGER_VIDEO_WORKBENCH==='1';
  if(typeof serveWorkbench!=='boolean')throw new VideoRuntimeError('WORKBENCH_OPTION_INVALID','serveWorkbench must be an explicit boolean when supplied.');
  return { rootDir, engineRoot, dataRoot: canonical, env, ports, node: process.execPath, portraitReuseManifest,
    serveWorkbench,
    webRoot: path.join(engineRoot, 'apps', 'web', 'dist'), pgRoot: path.join(canonical, 'tools', 'postgres'), pgData: path.join(canonical, 'postgres-data'), logs: path.join(canonical, 'logs'),
    sourceMain: SOURCE_MAIN, sourceFileCount: SOURCE_FILE_COUNT, logger: typeof options.logger === 'function' ? options.logger : () => undefined };
}
export function atomicJson(file, value, mode = 0o600) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new VideoRuntimeError('PRIVATE_DIRECTORY_INVALID', 'Managed private data directory must be an ordinary directory.');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new VideoRuntimeError('PRIVATE_DIRECTORY_PERMISSIONS', 'Managed private data directory must be accessible only to its owner (0700).');
  return fs.realpathSync(directory);
}
export function loadCredentials(config) {
  privateDirectory(config.dataRoot);
  for (const child of ['logs', 'work', 'media', 'tools']) privateDirectory(path.join(config.dataRoot, child));
  const file = path.join(config.dataRoot, 'private-state.json');
  if (!fs.existsSync(file)) {
    if (fs.existsSync(path.join(config.pgData, 'PG_VERSION'))) throw new VideoRuntimeError('CREDENTIALS_MISSING', 'An existing cluster has no credential state; refusing to create replacement credentials.');
    const secret = () => randomBytes(48).toString('base64url');
    atomicJson(file, { schemaVersion: 'pengmanager.video-private-state/v1', instanceId: randomBytes(16).toString('hex'), dataRoot: config.dataRoot,
      credentials: { owner: secret(), app: secret(), gateway: secret(), jwt: secret(), media: secret(), render: secret(), pii: secret(), audio: secret() }, cluster: null });
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077)) throw new VideoRuntimeError('PRIVATE_STATE_PERMISSIONS', 'Private runtime credential state must be a regular owner-only file.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schemaVersion !== 'pengmanager.video-private-state/v1' || value.dataRoot !== config.dataRoot || !/^[a-f0-9]{32}$/.test(value.instanceId || '')
    || !value.credentials || Object.keys(value.credentials).length !== 8 || Object.values(value.credentials).some(secret => typeof secret !== 'string' || !/^[A-Za-z0-9_-]{64}$/.test(secret))
    || new Set(Object.values(value.credentials)).size !== 8) throw new VideoRuntimeError('PRIVATE_STATE_INVALID', 'Private runtime credential state is invalid.');
  return { file, value };
}
export function requireEngineModule(config, name) {
  const require = createRequire(path.join(config.engineRoot, 'package.json'));
  const resolved = fs.realpathSync(require.resolve(name));
  if (!inside(config.engineRoot, resolved)) throw new VideoRuntimeError('DEPENDENCY_OUTSIDE_ENGINE', `Video dependency ${name} resolves outside the embedded engine.`);
  return require(name);
}
export function redactor(config, privateState) {
  const parts=value=>[value,...value.split(/\r?\n/).filter(line=>line.length>=6)];
  const values = [...Object.values(privateState?.credentials || {}), ...Object.entries(config.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|COOKIE/.test(key) && typeof value === 'string' && value.length >= 6).map(([, value]) => value)].flatMap(parts).sort((a, b) => b.length - a.length);
  const redact = value => { let text = String(value instanceof Error ? value.message : value); for (const secret of values) text = text.split(secret).join('[redacted]'); return text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]').replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[database-url]').slice(0, 4000); };
  redact.addSecrets = next => { for (const value of next) if (typeof value === 'string' && value.length >= 6)for(const part of parts(value))if(!values.includes(part))values.push(part); values.sort((a,b)=>b.length-a.length); };
  return redact;
}
export function acquireLock(config) {
  const directory = path.join(config.dataRoot, '.supervisor-lock');
  const token = randomBytes(24).toString('hex');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
  const claim = () => { fs.mkdirSync(directory, { mode: 0o700 }); atomicJson(path.join(directory, 'owner.json'), { pid: process.pid, token, startedAt: new Date().toISOString() }); };
  try { claim(); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const recovery = `${directory}.recovery`;
    try { fs.mkdirSync(recovery, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw new VideoRuntimeError('RUNTIME_BUSY', 'Another supervisor is recovering the runtime lock.'); throw e; }
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !/^[a-f0-9]{48}$/.test(owner.token || '')) throw new VideoRuntimeError('LOCK_INVALID', 'Runtime lock is malformed; refusing to steal it.');
      if (alive(owner.pid)) throw new VideoRuntimeError('RUNTIME_BUSY', 'Another PengManager video supervisor is already running.');
      fs.rmSync(directory, { recursive: true }); claim();
    } finally { fs.rmdirSync(recovery); }
  }
  return () => {
    if (!fs.existsSync(directory)) return;
    const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    if (owner.token !== token) throw new VideoRuntimeError('LOCK_OWNERSHIP_CHANGED', 'Runtime lock ownership changed; it was not removed.');
    fs.rmSync(directory, { recursive: true });
  };
}
export function textModelReadiness(env) {
  const provider = String(env.LLM_PROVIDER || (env.LLM_API_KEY ? 'openai' : 'mock')).trim();
  const missing = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'].filter(name => !String(env[name] || '').trim());
  if (provider === 'mock') missing.unshift('real-text-model-provider');
  return { provider, configured: missing.length === 0, missing };
}
export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
