import fs from 'node:fs';
import path from 'node:path';

const portNames = { postgres: 'PG', backend: 'BACKEND', web: 'WEB', compositor: 'COMPOSITOR', color: 'COLOR', bgm: 'BGM',
  subtitle: 'SUBTITLE', post: 'POST', voice: 'VOICE', voiceEngine: 'VOICE_ENGINE', loommate: 'LOOMMATE' };

/** Only public instance coordinates cross back into a host shell. */
export function clientRuntimeEnvironment(config, { explicitPortsOnly = false } = {}) {
  return { PENGMANAGER_VIDEO_DATA_DIR: config.dataRoot, ...Object.fromEntries(Object.entries(portNames)
    .map(([service, key]) => ['PENGMANAGER_VIDEO_' + key + '_PORT', String(config.ports[service])])
    .filter(([key]) => !explicitPortsOnly || config.env[key] !== undefined)) };
}

/** Validate metadata only. The generator and guide never read model secrets. */
export function validatedModelEnvFile(rootDir, file) {
  const reject = () => {
    const error = new Error('Use an existing, owner-only ordinary model environment file outside this checkout, with an absolute path and no symbolic links.');
    error.code = 'MODEL_ENV_FILE_INVALID';
    throw error;
  };
  try {
    if (typeof file !== 'string' || !file.isWellFormed() || file.includes('\0') || !path.isAbsolute(file) || path.resolve(file) !== file) reject();
    const root = fs.realpathSync(rootDir), canonical = fs.realpathSync(file);
    const relative = path.relative(root, canonical);
    if (canonical !== file || relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) reject();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 1024 * 1024
      || process.platform !== 'win32' && (stat.mode & 0o077 || !(stat.mode & 0o400) || typeof process.getuid === 'function' && stat.uid !== process.getuid())) reject();
    return canonical;
  } catch (error) {
    if (error?.code === 'MODEL_ENV_FILE_INVALID') throw error;
    reject();
  }
}

/** Preserve explicit Node env-file paths, never arbitrary Node flags or env values. */
export function modelEnvironmentArgs(rootDir, execArgv = process.execArgv) {
  const files = [];
  for (let index = 0; index < execArgv.length; index++) {
    const arg = execArgv[index];
    if (arg === '--env-file') files.push(validatedModelEnvFile(rootDir, execArgv[++index]));
    else if (arg.startsWith('--env-file=')) files.push(validatedModelEnvFile(rootDir, arg.slice('--env-file='.length)));
    else if (arg === '--env-file-if-exists' || arg.startsWith('--env-file-if-exists=')) {
      const error = new Error('Use explicit --env-file with an existing private file before transferring model configuration to the owner CLI.');
      error.code = 'MODEL_ENV_FILE_INVALID';
      throw error;
    }
  }
  return files.map(file => '--env-file=' + file);
}
