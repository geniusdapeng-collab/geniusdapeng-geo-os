#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContentOpsAdapters, contentOpsAdapterBindings } from '../src/content-ops-worker/adapters.mjs';
import { ContentOpsWorker, localGrantHash, validateLocalGrant } from '../src/content-ops-worker/worker.mjs';
import { WorkerLocalStore, LocalSourceRegistry } from '../src/content-ops-worker/local-store.mjs';
import { WorkerHttpTransport } from '../src/content-ops-worker/transport.mjs';
import { boundedResponseBytes, bytesHash, decodeJson, fail, identifier, integer, normalizedOrigin, record,
  requireCondition, safeError, sha256, text, WORKER_PROTOCOL } from '../src/content-ops-worker/protocol.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMANDS = new Set(['bindings', 'doctor', 'grant-hash', 'pair', 'run', 'status']);
const HELP = `Content preparation worker (outbound only)\n\nCommands:\n  bindings\n  doctor --config /absolute/private/worker.json\n  grant-hash --grant /absolute/private/local-grant.json\n  pair --config /absolute/private/worker.json --challenge-id ID --confirm-local-owner\n  run --config /absolute/private/worker.json [--watch] [--recover-stale-lock]\n  status --config /absolute/private/worker.json\n\nCredentials are process-only: CONTENT_OPS_WORKER_TOKEN, CONTENT_OPS_MODEL_API_KEY,\nCONTENT_OPS_PAIRING_CHALLENGE. No credential file discovery or publishing.\n`;

function readPrivateJson(file, label) {
  requireCondition(typeof file === 'string' && path.isAbsolute(file), 'WORKER_CONFIG_INVALID', `${label} needs an explicit absolute path.`);
  const stat = fs.lstatSync(file);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_000_000
    && (process.platform === 'win32' || (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid())),
  'WORKER_CONFIG_PERMISSIONS', `${label} must be an owner-only ordinary JSON file.`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd), named = fs.lstatSync(file);
    requireCondition(before.ino === after.ino && before.dev === after.dev && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ino === named.ino && before.dev === named.dev && !named.isSymbolicLink(), 'WORKER_CONFIG_CHANGED', `${label} changed while being read.`);
    return decodeJson(bytes);
  } finally { fs.closeSync(fd); }
}
function argumentsFor(argv) {
  const command = argv.shift();
  if (command === '--help' || command === '-h' || !command) return { help: true };
  requireCondition(COMMANDS.has(command), 'WORKER_ARGUMENT_INVALID', 'The worker command is unsupported.');
  const options = {};
  while (argv.length) {
    const key = argv.shift();
    requireCondition(['--config', '--grant', '--challenge-id', '--confirm-local-owner', '--watch', '--recover-stale-lock', '--interval-ms'].includes(key)
      && !Object.hasOwn(options, key), 'WORKER_ARGUMENT_INVALID', 'A worker option is duplicated or unsupported.');
    if (['--confirm-local-owner', '--watch', '--recover-stale-lock'].includes(key)) options[key] = true;
    else { requireCondition(argv.length && !argv[0].startsWith('--'), 'WORKER_ARGUMENT_INVALID', 'A worker option needs its value.'); options[key] = argv.shift(); }
  }
  return { command, options };
}
function configFor(file) {
  const config = readPrivateJson(file, 'Worker configuration');
  record(config, 'Worker configuration', ['schema', 'origin', 'workerId', 'dataDir', 'grantFile', 'sourcesRoot', 'sources',
    'model', 'renderer', 'media', 'currency', 'allowLoopbackHttp']);
  requireCondition(config.schema === 'pengmanager.worker-config/v1', 'WORKER_CONFIG_INVALID', 'The worker configuration schema is invalid.');
  identifier(config.workerId); normalizedOrigin(config.origin, { allowLoopbackHttp: config.allowLoopbackHttp === true });
  requireCondition(path.isAbsolute(config.dataDir ?? '') && path.isAbsolute(config.grantFile ?? ''), 'WORKER_CONFIG_INVALID', 'The worker data and grant locations must be explicit absolute paths.');
  if (config.model !== undefined) record(config.model, 'Local model configuration', ['endpoint', 'provider', 'model', 'contextTokenLimit',
    'contextProof', 'pricingSnapshotHash', 'currency', 'maxOutputTokens', 'timeoutMs']);
  if (config.renderer !== undefined) record(config.renderer, 'Local renderer configuration', ['ffmpegPath', 'workRoot', 'maxRenderMs', 'maxTempBytes']);
  if (config.media !== undefined) record(config.media, 'Local media configuration', ['ffmpegPath', 'ffprobePath', 'workRoot', 'maxRenderMs', 'maxTempBytes']);
  return config;
}
function localGrantFor(config, { pendingPairing = false } = {}) {
  const grant = readPrivateJson(config.grantFile, 'Local owner grant');
  if (!grant.grantId && !pendingPairing) {
    const receipt = readPrivateJson(path.join(config.dataDir, 'pairing-receipt.json'), 'Pairing receipt');
    requireCondition(receipt.workerId === config.workerId && receipt.localGrantHash === grant.localGrantHash
      && receipt.scopeHash === grant.scopeHash, 'WORKER_SCOPE_DENIED', 'The stored pairing receipt does not match this exact local owner grant.');
    grant.grantId = receipt.grantId;
  }
  validateLocalGrant(grant, { origin: config.origin, workerId: config.workerId, allowLoopbackHttp: config.allowLoopbackHttp === true, pendingPairing });
  return grant;
}
function exclusiveReceipt(file, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  try {
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    requireCondition(bytesHash(Buffer.from(JSON.stringify(readPrivateJson(file, 'Existing pairing receipt')) + '\n')) === bytesHash(bytes),
      'PAIRING_RECEIPT_CONFLICT', 'The existing pairing receipt belongs to a different grant; it was preserved.');
  }
}
async function pair(config, grant, options, env) {
  requireCondition(options['--confirm-local-owner'] === true, 'LOCAL_APPROVAL_REQUIRED', 'Pairing requires the explicit local owner confirmation flag.');
  identifier(options['--challenge-id'], 'Pairing challenge ID'); const challenge = text(env.CONTENT_OPS_PAIRING_CHALLENGE, 'One-time pairing challenge', { max: 1024 });
  const credential = text(env.CONTENT_OPS_WORKER_TOKEN, 'Independent worker credential', { max: 128 });
  requireCondition(/^[A-Za-z0-9_-]{43,128}$/.test(credential), 'WORKER_CREDENTIAL_INVALID', 'The independent worker credential must be a random base64url value.');
  const origin = normalizedOrigin(config.origin, { allowLoopbackHttp: config.allowLoopbackHttp === true });
  const payload = { challengeId: options['--challenge-id'], challenge, localGrantHash: grant.localGrantHash,
    scopeHash: grant.scopeHash, credentialHash: bytesHash(Buffer.from(credential)) };
  let response;
  try { response = await fetch(new URL('/api/content-ops/worker/pairing/confirm', origin), { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': `pair_${grant.localGrantHash.slice(0, 60)}` },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) }); }
  catch { fail('PAIRING_RESULT_UNKNOWN', 'The pairing response is unknown; recover the existing challenge before creating another credential.', { unknown: true }); }
  const bytes = await boundedResponseBytes(response, 100_000);
  requireCondition(response.ok, 'PAIRING_REJECTED', 'The cloud rejected this exact one-time pairing confirmation.');
  const receipt = decodeJson(bytes); identifier(receipt.grantId);
  requireCondition(receipt.workerId === config.workerId && receipt.scopeHash === grant.scopeHash
    && receipt.localGrantHash === grant.localGrantHash, 'WORKER_SCOPE_DENIED', 'The pairing response differs from the exact local owner approval.');
  exclusiveReceipt(path.join(config.dataDir, 'pairing-receipt.json'), receipt);
  return { status: 'paired', workerId: receipt.workerId, grantId: receipt.grantId, scopeHash: receipt.scopeHash,
    localGrantHash: receipt.localGrantHash, expiresAt: receipt.expiresAt, credentialStored: false };
}
async function main() {
  const args = argumentsFor(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return; }
  const { command, options } = args;
  if (command === 'bindings') { requireCondition(!Object.keys(options).length, 'WORKER_ARGUMENT_INVALID', 'bindings accepts no other options.'); console.log(JSON.stringify({ schema: WORKER_PROTOCOL, bindings: await contentOpsAdapterBindings({ rootDir: ROOT }) })); return; }
  if (command === 'grant-hash') {
    const grant = readPrivateJson(options['--grant'], 'Local owner grant'); console.log(JSON.stringify({ schema: WORKER_PROTOCOL, localGrantHash: localGrantHash(grant) })); return;
  }
  const config = configFor(options['--config']);
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let store;
  try {
    store = new WorkerLocalStore({ dataDir: config.dataDir, rootDir: ROOT });
    const adapters = await createContentOpsAdapters({ rootDir: ROOT, currency: config.currency,
      modelConfig: { ...config.model, apiKey: process.env.CONTENT_OPS_MODEL_API_KEY, allowLoopbackHttp: config.allowLoopbackHttp === true },
      rendererOptions: { ...config.renderer, workRoot: config.renderer?.workRoot ?? store.root },
      mediaOptions: { ...config.media, workRoot: config.media?.workRoot ?? store.root } });
    if (command === 'doctor') { console.log(JSON.stringify({ schema: WORKER_PROTOCOL, status: 'diagnosed', credentialsPrinted: false,
      adapters: await adapters.readiness(), journalAttempts: store.listAttempts().length })); return; }
    if (command === 'status') { console.log(JSON.stringify({ schema: WORKER_PROTOCOL, workerId: config.workerId,
      attempts: store.listAttempts().map(({ attemptId, taskId, status, error }) => ({ attemptId, taskId, status, ...(error ? { error } : {}) })) })); return; }
    const grant = localGrantFor(config, { pendingPairing: command === 'pair' });
    store.acquire({ recoverStale: options['--recover-stale-lock'] === true });
    if (command === 'pair') { console.log(JSON.stringify(await pair(config, grant, options, process.env))); return; }
    const transport = new WorkerHttpTransport({ origin: config.origin, credential: process.env.CONTENT_OPS_WORKER_TOKEN,
      workerId: config.workerId, grantId: grant.grantId, scopeHash: grant.scopeHash, allowLoopbackHttp: config.allowLoopbackHttp === true });
    const sourceRegistry = config.sourcesRoot ? new LocalSourceRegistry({ root: config.sourcesRoot, sources: config.sources ?? [] }) : null;
    const worker = new ContentOpsWorker({ transport, store, adapters, localGrant: grant, origin: config.origin,
      workerId: config.workerId, sourceRegistry, signal: controller.signal, allowLoopbackHttp: config.allowLoopbackHttp === true });
    const interval = integer(options['--interval-ms'] === undefined ? 5000 : Number(options['--interval-ms']), 'Worker polling interval', 1000, 60_000);
    do {
      const result = await worker.runOnce(); console.log(JSON.stringify(result));
      if (['needs_reconcile', 'not_ready', 'failed_known'].includes(result.status)) { process.exitCode = result.status === 'not_ready' ? 2 : 3; break; }
      if (!options['--watch'] || controller.signal.aborted) break;
      await new Promise(resolve => { const timer = setTimeout(done, interval); function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); } controller.signal.addEventListener('abort', done, { once: true }); });
    } while (!controller.signal.aborted);
  } finally { store?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

main().catch(error => { console.error(JSON.stringify({ schema: WORKER_PROTOCOL, status: 'error', error: safeError(error) })); process.exitCode = 1; });
