import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { atomicJson, inside, privateDirectory, requireEngineModule, VideoRuntimeError } from './config.mjs';
import { assertActive, portIsOpen, requireFreePort, runCommand } from './process.mjs';

export function databaseUrls(config, state) {
  const url = (name, password) => { const value = new URL('postgres://127.0.0.1/workloom'); value.username = name; value.password = password; value.port = String(config.ports.postgres); return value.toString(); };
  return { DATABASE_URL: url('postgres', state.credentials.owner), DATABASE_APP_URL: url('workloom_app', state.credentials.app), DATABASE_GATEWAY_URL: url('workloom_gateway', state.credentials.gateway), APP_DB_PASSWORD: state.credentials.app, GATEWAY_DB_PASSWORD: state.credentials.gateway };
}
const binName = name => process.platform === 'win32' ? `${name}.exe` : name;
export function postgresBin(config, name) { return path.join(config.pgRoot, 'bin', binName(name)); }
function assertPrefix(prefix) {
  const root = fs.realpathSync(prefix);
  for (const name of ['postgres', 'pg_ctl', 'initdb', 'pg_config']) if (!fs.statSync(path.join(root, 'bin', binName(name))).isFile()) throw new VideoRuntimeError('POSTGRES_INCOMPLETE', 'PostgreSQL tools are incomplete.');
  if (fs.existsSync(path.join(root, 'PG_VERSION')) || fs.existsSync(path.join(root, 'global'))) throw new VideoRuntimeError('POSTGRES_DATA_NOT_TOOL', 'A PostgreSQL data directory cannot be used as a tool installation.');
  return root;
}
async function assertInternalLinks(root, directory = root) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) { const target = await fsp.realpath(file); if (!inside(root, target)) throw new VideoRuntimeError('POSTGRES_EXTERNAL_LINK', 'The supplied PostgreSQL tool package has a link outside its own installation.'); }
    else if (entry.isDirectory()) await assertInternalLinks(root, file);
  }
}
export async function installPostgres(config, { sourceRoot, signal, safe } = {}) {
  assertActive(signal);
  if (fs.existsSync(config.pgRoot)) {
    const stat=fs.lstatSync(config.pgRoot),root=assertPrefix(config.pgRoot);
    if(!stat.isDirectory()||stat.isSymbolicLink()||!inside(config.dataRoot,root))throw new VideoRuntimeError('POSTGRES_SOURCE_INVALID','Managed PostgreSQL tools must be copied inside this private runtime, without external installation links.');
    await assertInternalLinks(root);return;
  }
  const source = sourceRoot || config.env.PENGMANAGER_POSTGRES_HOME;
  if (!source) throw new VideoRuntimeError('POSTGRES_INSTALL_REQUIRED', 'Install a PostgreSQL 17 tool package with pgvector using video-setup --postgres-root <installation>. The tool files will be copied into PengManager private storage.');
  const origin = assertPrefix(path.resolve(source));
  if (inside(config.rootDir, origin) && !inside(config.engineRoot, origin)) throw new VideoRuntimeError('POSTGRES_SOURCE_INVALID', 'PostgreSQL tool source must be an explicit installation, not another application worktree.');
  await assertInternalLinks(origin);
  const version = await runCommand(path.join(origin, 'bin', binName('postgres')), ['--version'], { signal, safe });
  if (!/PostgreSQL\) 17\./.test(version.stdout)) throw new VideoRuntimeError('POSTGRES_VERSION_UNSUPPORTED', 'This complete Edit snapshot requires the PostgreSQL 17 baseline.');
  const staging = path.join(config.dataRoot, 'tools', `.postgres-install-${randomBytes(6).toString('hex')}`);
  privateDirectory(staging);
  try {
    for (const part of ['bin', 'lib', 'share']) {
      assertActive(signal);
      const from = path.join(origin, part);
      if (!fs.existsSync(from)) throw new VideoRuntimeError('POSTGRES_INCOMPLETE', 'PostgreSQL bin/lib/share package is required.');
      await fsp.cp(from, path.join(staging, part), { recursive: true, dereference: true, errorOnExist: true });
    }
    for (const name of ['COPYRIGHT', 'LICENSE', 'LICENSE.txt']) if (fs.existsSync(path.join(origin, name))) await fsp.copyFile(path.join(origin, name), path.join(staging, name));
    assertActive(signal); assertPrefix(staging);
    atomicJson(path.join(staging, 'pengmanager-tool.json'), { schemaVersion: 'pengmanager.postgresql-tool/v1', version: version.stdout.trim(), copiedParts: ['bin', 'lib', 'share'], installedAt: new Date().toISOString(), sourceDataCopied: false });
    await fsp.rename(staging, config.pgRoot);
  } finally { if (fs.existsSync(staging)) await fsp.rm(staging, { recursive: true, force: true }); }
}
export function postmasterIdentity(config) {
  const lines = fs.readFileSync(path.join(config.pgData, 'postmaster.pid'), 'utf8').split(/\r?\n/);
  const pid = Number(lines[0]), port = Number(lines[3]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || port !== config.ports.postgres || fs.realpathSync(lines[1]) !== fs.realpathSync(config.pgData)) throw new VideoRuntimeError('POSTGRES_OWNERSHIP_MISMATCH', 'PostgreSQL process metadata does not match this managed data directory and port.');
  return { pid, port };
}
export function createPostgresManager(config, credentialRecord, safe) {
  const { Client } = requireEngineModule(config, 'pg');
  const state = credentialRecord.value;
  let started = false;
  const helperPromise = import(pathToFileURL(path.join(config.engineRoot, 'scripts', 'desktop-bootstrap-db.mjs')).href);
  const helperEnv = mode => ({ WORKLOOM_PG_BOOTSTRAP_MODE: mode, WORKLOOM_PG_PORT: String(config.ports.postgres), WORKLOOM_PG_ADMIN_PASSWORD: state.credentials.owner, WORKLOOM_PG_APP_PASSWORD: state.credentials.app, WORKLOOM_PG_GATEWAY_PASSWORD: state.credentials.gateway, WORKLOOM_PG_LEGACY_PASSWORDS_JSON: '[]', WORKLOOM_EXPECTED_PGDATA: config.pgData, WORKLOOM_EXPECTED_HBA_FILE: path.join(config.pgData, 'pg_hba.conf'), ...(state.cluster ? { WORKLOOM_EXPECTED_SYSTEM_IDENTIFIER: state.cluster.systemIdentifier } : {}) });
  async function inspect(mode = 'inspect') {
    const { bootstrapDatabase } = await helperPromise;
    const identity = await bootstrapDatabase({ Client, env: helperEnv(mode) });
    if (state.cluster && (state.cluster.systemIdentifier !== identity.systemIdentifier || state.cluster.dataDirectory !== identity.dataDirectory || state.cluster.port !== identity.port)) throw new VideoRuntimeError('POSTGRES_CLUSTER_CHANGED', 'The persisted PostgreSQL cluster identity changed.');
    if (!state.cluster) { state.cluster = identity; atomicJson(credentialRecord.file, state); }
    return identity;
  }
  return {
    async start({ signal } = {}) {
      assertActive(signal); assertPrefix(config.pgRoot);
      if (!fs.existsSync(path.join(config.pgData, 'PG_VERSION'))) {
        if (state.cluster) throw new VideoRuntimeError('POSTGRES_CLUSTER_MISSING', 'The bound PostgreSQL cluster is missing; refusing to replace it with a new cluster.');
        if (fs.existsSync(config.pgData) && fs.readdirSync(config.pgData).length) throw new VideoRuntimeError('POSTGRES_PARTIAL_DATA', 'PostgreSQL data directory is nonempty without PG_VERSION; preserve it for recovery.');
        await requireFreePort(config.ports.postgres);
        const staging = path.join(config.dataRoot, `.postgres-init-${randomBytes(6).toString('hex')}`);
        const passwordFile = path.join(config.dataRoot, `.init-password-${randomBytes(6).toString('hex')}`);
        fs.writeFileSync(passwordFile, state.credentials.owner + '\n', { mode: 0o600, flag: 'wx' });
        try {
          await runCommand(postgresBin(config, 'initdb'), ['-D', staging, '-U', 'postgres', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${passwordFile}`, '-E', 'UTF8', '--locale=C'], { signal, safe, log: path.join(config.logs, 'postgres-init.log') });
          assertActive(signal);
          if (fs.existsSync(config.pgData)) fs.rmdirSync(config.pgData);
          fs.renameSync(staging, config.pgData);
        } finally { if (fs.existsSync(passwordFile)) fs.unlinkSync(passwordFile); if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
      }
      privateDirectory(config.pgData);
      const running = await runCommand(postgresBin(config, 'pg_ctl'), ['status', '-D', config.pgData], { safe, signal, timeoutMs: 5000 }).then(() => true, error => { if (error.code === 'PROCESS_FAILED') return false; throw error; });
      if (running) {
        postmasterIdentity(config);
        // A previous supervisor may have crashed. Inspect the bound cluster before reusing it.
        await inspect();
      } else {
        await requireFreePort(config.ports.postgres);
        const hba = '# PengManager owned PostgreSQL: authenticated loopback only\nlocal all all scram-sha-256\nhost all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n';
        fs.writeFileSync(path.join(config.pgData, 'pg_hba.conf'), hba, { mode: 0o600 });
        const log = path.join(config.logs, 'postgres-control.log');
        // pg_ctl can have started postmaster before its own acknowledgement is cancelled.
        // Cleanup must inspect this owned directory even if that command promise rejects.
        started = true;
        await runCommand(postgresBin(config, 'pg_ctl'), ['-D', config.pgData, '-l', path.join(config.logs, 'postgres.log'), '-o', `-p ${config.ports.postgres} -h 127.0.0.1 -c unix_socket_directories= -c password_encryption=scram-sha-256 -c log_min_error_statement=panic -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0`, '-w', '-t', '30', 'start'], { signal, safe, daemon: true, log, timeoutMs: 40000 });
        started = true;
        postmasterIdentity(config); await inspect();
      }
      assertActive(signal); started = true;
      await inspect('prepare');
      assertActive(signal); await inspect('verify');
      return { ok: true, owned: true, port: config.ports.postgres };
    },
    async health() {
      if (!fs.existsSync(path.join(config.pgData, 'postmaster.pid')) || !await portIsOpen(config.ports.postgres)) return { ok: false, owned: false };
      try { postmasterIdentity(config); await inspect(); return { ok: true, owned: true, port: config.ports.postgres }; }
      catch (error) { return { ok: false, owned: false, errorSafe: safe(error) }; }
    },
    async stop() {
      if (!started) return;
      if (!fs.existsSync(path.join(config.pgData, 'postmaster.pid'))) { started = false; return; }
      postmasterIdentity(config); await inspect();
      await runCommand(postgresBin(config, 'pg_ctl'), ['-D', config.pgData, 'stop', '-m', 'fast', '-w', '-t', '30'], { safe, daemon: true, log: path.join(config.logs, 'postgres-control.log'), timeoutMs: 40000 });
      started = false;
    },
    databaseUrls: () => databaseUrls(config, state),
  };
}
