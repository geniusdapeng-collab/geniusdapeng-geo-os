import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bytesHash, dataHash, decodeJson, fail, identifier, integer, isRecord, jsonValue, record, requireCondition, sha256 } from './protocol.mjs';

const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const MIME_EXTENSIONS = Object.freeze({
  'application/json': 'json', 'text/plain': 'txt', 'text/markdown': 'md', 'text/html': 'html',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'text/vtt': 'vtt', 'application/x-ipynb+json': 'ipynb', 'text/x-diff': 'diff',
  'application/octet-stream': 'bin',
});
function ordinaryDirectory(directory, { privateMode = false } = {}) {
  const stat = fs.lstatSync(directory);
  requireCondition(stat.isDirectory() && !stat.isSymbolicLink(), 'PRIVATE_DIRECTORY_INVALID', 'The worker directory must be an ordinary directory.');
  if (privateMode && process.platform !== 'win32') requireCondition((stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid()),
  'PRIVATE_DIRECTORY_PERMISSIONS', 'The worker directory must be owned by this user and use private permissions.');
  return fs.realpathSync(directory);
}
function parentChain(root, directory) {
  requireCondition(inside(root, directory), 'LOCAL_PATH_DENIED', 'The local path is outside its approved root.');
  let cursor = root; ordinaryDirectory(cursor);
  for (const part of path.relative(root, directory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part); ordinaryDirectory(cursor);
    requireCondition(inside(root, fs.realpathSync(cursor)), 'LOCAL_PATH_DENIED', 'The local path resolves outside its approved root.');
  }
}
function fileBytes(root, file, { expectedHash, maxBytes = 50 * 1024 * 1024 } = {}) {
  parentChain(root, path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd);
    requireCondition(before.isFile() && before.size <= maxBytes, 'LOCAL_SOURCE_INVALID', 'The input must be a bounded regular file.');
    const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    requireCondition(!named.isSymbolicLink() && named.isFile() && before.dev === after.dev && before.ino === after.ino
      && before.dev === named.dev && before.ino === named.ino && before.size === after.size
      && before.mtimeMs === after.mtimeMs && bytes.length === before.size,
    'LOCAL_SOURCE_CHANGED', 'The input changed while its bytes were being read.');
    if (expectedHash) requireCondition(bytesHash(bytes) === sha256(expectedHash), 'ARTIFACT_HASH_MISMATCH', 'The current input bytes do not match their approved hash.');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function artifactUsage(root, maxEntries = 10_000) {
  let bytes = 0, entries = 0; const pending = [root];
  while (pending.length) {
    const directory = pending.pop(); ordinaryDirectory(directory, { privateMode: true });
    for (const name of fs.readdirSync(directory)) {
      requireCondition(++entries <= maxEntries, 'WORKSPACE_QUOTA_EXCEEDED', 'The worker artifact entry limit was reached.');
      const file = path.join(directory, name), stat = fs.lstatSync(file);
      requireCondition(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'LOCAL_PATH_DENIED', 'The private artifact tree contains an unsupported entry.');
      if (stat.isDirectory()) pending.push(file); else bytes += stat.size;
      requireCondition(Number.isSafeInteger(bytes), 'WORKSPACE_QUOTA_EXCEEDED', 'The private artifact size is outside its allowed range.');
    }
  }
  return bytes;
}

/** Only constructor-supplied IDs resolve local sources; task data never supplies a path. */
export class LocalSourceRegistry {
  constructor({ root, sources = [] }) {
    this.root = ordinaryDirectory(path.resolve(root)); this.entries = new Map();
    requireCondition(Array.isArray(sources) && sources.length <= 1024, 'LOCAL_SOURCE_INVALID', 'The local input registry exceeds its limit.');
    for (const value of sources) {
      const row = record(value, 'Local source', ['id', 'relativePath', 'sha256', 'bytes', 'mime', 'role']);
      identifier(row.id); sha256(row.sha256); integer(row.bytes, 'Source bytes', 1, 500 * 1024 * 1024);
      requireCondition(typeof row.relativePath === 'string' && row.relativePath.split(/[\\/]/).every(part => part && part !== '.' && part !== '..')
        && !path.isAbsolute(row.relativePath) && !row.relativePath.includes('\0'), 'LOCAL_PATH_DENIED', 'Local sources require an approved relative path.');
      requireCondition(!this.entries.has(row.id), 'LOCAL_SOURCE_INVALID', 'Local input IDs must be unique.');
      this.entries.set(row.id, Object.freeze({ ...row }));
    }
  }
  read({ id, sha256: expected, bytes: expectedBytes }, { maxBytes = 50 * 1024 * 1024 } = {}) {
    identifier(id); sha256(expected); const source = this.entries.get(id);
    requireCondition(source && source.sha256 === expected && (expectedBytes === undefined || expectedBytes === source.bytes),
      'LOCAL_SOURCE_MISSING', 'This exact local source has not been approved for this worker.');
    const bytes = fileBytes(this.root, path.resolve(this.root, source.relativePath), { expectedHash: source.sha256, maxBytes });
    requireCondition(bytes.length === source.bytes, 'ARTIFACT_HASH_MISMATCH', 'The approved source size changed.');
    return { bytes, id, mime: source.mime, role: source.role, sha256: source.sha256, sourceProof: { id, sha256: source.sha256, bytes: bytes.length, sourceUntouched: true } };
  }
}

/** A private durable journal, not a second cloud budget ledger. */
export class WorkerLocalStore {
  constructor({ dataDir, rootDir, clock = () => Date.now(), maxTempBytes = 500 * 1024 * 1024, maxJournalBytes = 16 * 1024 * 1024 }) {
    this.clock = clock; this.maxTempBytes = integer(maxTempBytes, 'Temporary byte limit', 1);
    this.maxJournalBytes = integer(maxJournalBytes, 'Journal byte limit', 1024, 100 * 1024 * 1024);
    const requested = path.resolve(dataDir);
    requireCondition(requested !== path.parse(requested).root, 'PRIVATE_DIRECTORY_INVALID', 'The worker cannot use a filesystem root.');
    if (rootDir) {
      const repo = fs.realpathSync(rootDir);
      requireCondition(!inside(repo, requested) && !inside(requested, repo), 'PRIVATE_DIRECTORY_INVALID', 'Worker data must be outside the checkout.');
    }
    let ancestor = requested;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const canonical = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, requested));
    if (rootDir) {
      const repo = fs.realpathSync(rootDir);
      requireCondition(!inside(repo, canonical) && !inside(canonical, repo), 'PRIVATE_DIRECTORY_INVALID', 'Worker data must be outside the actual checkout.');
    }
    fs.mkdirSync(canonical, { recursive: true, mode: 0o700 });
    this.root = ordinaryDirectory(canonical, { privateMode: true });
    this.journalPath = path.join(this.root, 'journal.json'); this.lockPath = path.join(this.root, 'worker.lock.json');
    this.artifactRoot = path.join(this.root, 'artifacts');
    fs.mkdirSync(this.artifactRoot, { mode: 0o700, recursive: true }); ordinaryDirectory(this.artifactRoot, { privateMode: true });
    if (fs.existsSync(this.journalPath)) {
      const stat = fs.lstatSync(this.journalPath);
      requireCondition(stat.isFile() && !stat.isSymbolicLink() && (process.platform === 'win32' || !(stat.mode & 0o077)),
        'PRIVATE_STATE_PERMISSIONS', 'The worker journal must be an owner-only ordinary file.');
      this.state = decodeJson(fileBytes(this.root, this.journalPath, { maxBytes: this.maxJournalBytes }), { maxBytes: this.maxJournalBytes, maxArray: 20_000 });
      requireCondition(this.state.schema === 'pengmanager.worker-journal/v1' && isRecord(this.state.attempts)
        && Number.isSafeInteger(this.state.revision), 'WORKER_STATE_INVALID', 'The worker journal schema is invalid.');
    } else this.state = { schema: 'pengmanager.worker-journal/v1', revision: 0, attempts: {} };
    this.lockToken = null;
  }
  acquire({ recoverStale = false } = {}) {
    requireCondition(!this.lockToken, 'WORKER_BUSY', 'This worker already owns its local journal.');
    const token = randomUUID(); const owner = { pid: process.pid, token, startedAt: new Date(this.clock()).toISOString() };
    try { writeExclusive(this.lockPath, JSON.stringify(owner)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!recoverStale) fail('WORKER_BUSY', 'Another worker owns this private journal.');
      // Serialise explicit stale-lock recovery itself. Two recoverers must not
      // both validate the old PID and then rename a freshly acquired new lock.
      const recovery = path.join(this.root, 'lock-recovery');
      try { fs.mkdirSync(recovery, { mode: 0o700 }); }
      catch (recoveryError) {
        if (recoveryError.code === 'EEXIST') fail('WORKER_RECOVERY_BUSY', 'A concurrent or interrupted private lock recovery must be resolved before taking over this journal.');
        throw recoveryError;
      }
      const recoveryOwner = path.join(recovery, 'owner.json');
      try {
        writeExclusive(recoveryOwner, JSON.stringify(owner)); syncDirectory(recovery); syncDirectory(this.root);
        const currentBytes = fileBytes(this.root, this.lockPath, { maxBytes: 4096 });
        const current = decodeJson(currentBytes);
        requireCondition(Number.isSafeInteger(current.pid) && current.pid > 0 && typeof current.token === 'string', 'WORKER_LOCK_INVALID', 'The existing worker lock is invalid.');
        try { process.kill(current.pid, 0); fail('WORKER_BUSY', 'The previous worker process is still active.'); }
        catch (aliveError) { if (aliveError.code !== 'ESRCH') throw aliveError; }
        requireCondition(bytesHash(fileBytes(this.root, this.lockPath, { maxBytes: 4096 })) === bytesHash(currentBytes),
          'WORKER_LOCK_CHANGED', 'The local lock owner changed during recovery.');
        fs.renameSync(this.lockPath, path.join(this.root, `recovered-lock-${randomUUID()}.json`));
        writeExclusive(this.lockPath, JSON.stringify(owner));
      } finally {
        if (fs.existsSync(recoveryOwner)) {
          const found = decodeJson(fileBytes(this.root, recoveryOwner, { maxBytes: 4096 }));
          requireCondition(found.token === token && found.pid === process.pid, 'WORKER_LOCK_CHANGED', 'The private recovery guard changed owner.');
          fs.unlinkSync(recoveryOwner);
        }
        fs.rmdirSync(recovery); syncDirectory(this.root);
      }
    }
    this.lockToken = token; syncDirectory(this.root); return this;
  }
  #assertOwner() {
    requireCondition(this.lockToken, 'WORKER_LOCK_REQUIRED', 'A worker must own its journal before changing it.');
    const owner = decodeJson(fileBytes(this.root, this.lockPath, { maxBytes: 4096 }));
    requireCondition(owner.token === this.lockToken && owner.pid === process.pid, 'WORKER_LOCK_CHANGED', 'The private journal owner changed.');
  }
  #save(next) {
    this.#assertOwner(); jsonValue(next, { maxBytes: this.maxJournalBytes, maxArray: 20_000 });
    const tmp = path.join(this.root, `.journal-${randomUUID()}.tmp`);
    writeExclusive(tmp, JSON.stringify(next) + '\n');
    try {
      if (fs.existsSync(this.journalPath)) requireCondition(!fs.lstatSync(this.journalPath).isSymbolicLink(), 'PRIVATE_STATE_PERMISSIONS', 'The worker journal cannot become a symbolic link.');
      fs.renameSync(tmp, this.journalPath); syncDirectory(this.root); this.state = next;
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  }
  updateAttempt(attemptId, update) {
    identifier(attemptId, 'Attempt ID'); record(update, 'Attempt update'); jsonValue(update);
    const previous = this.state.attempts[attemptId] ?? null;
    if (previous) for (const key of ['taskId', 'epoch', 'taskHash', 'resolvedInputHash']) {
      if (update[key] !== undefined) requireCondition(update[key] === previous[key], 'WORKER_STATE_CONFLICT', 'A durable attempt cannot change its frozen identity.');
    }
    const next = structuredClone(this.state); next.revision++;
    next.attempts[attemptId] = { ...(previous ?? {}), ...structuredClone(update), updatedAt: new Date(this.clock()).toISOString() };
    this.#save(next); return structuredClone(next.attempts[attemptId]);
  }
  getAttempt(attemptId) { identifier(attemptId); return structuredClone(this.state.attempts[attemptId] ?? null); }
  listAttempts() { return Object.entries(this.state.attempts).map(([attemptId, value]) => ({ attemptId, ...structuredClone(value) })); }
  writeArtifact(attemptId, outputKey, bytes, mime) {
    this.#assertOwner(); identifier(attemptId); identifier(outputKey, 'Output key');
    requireCondition(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'ARTIFACT_INVALID', 'Worker outputs must contain actual bytes.');
    const buffer = Buffer.from(bytes); requireCondition(buffer.length > 0 && buffer.length <= this.maxTempBytes,
      'WORKSPACE_QUOTA_EXCEEDED', 'The output exceeds the private workspace byte limit.');
    requireCondition(Object.hasOwn(MIME_EXTENSIONS, mime), 'NATIVE_ARTIFACT_TYPE_UNSUPPORTED', 'This output MIME is not supported by the worker.');
    // Count actual owned files, including an interrupted output not yet in JSON.
    const currentBytes = artifactUsage(this.root);
    const sha = bytesHash(buffer); const name = `${outputKey}-${sha}.${MIME_EXTENSIONS[mime]}`;
    const directory = path.join(this.artifactRoot, attemptId); fs.mkdirSync(directory, { mode: 0o700, recursive: true }); ordinaryDirectory(directory, { privateMode: true });
    const target = path.join(directory, name);
    if (!fs.existsSync(target)) {
      requireCondition(currentBytes + buffer.length <= this.maxTempBytes, 'WORKSPACE_QUOTA_EXCEEDED', 'The private worker workspace has reached its byte limit.');
      writeExclusive(target, buffer); syncDirectory(directory);
    }
    const actual = fileBytes(this.artifactRoot, target, { expectedHash: sha, maxBytes: this.maxTempBytes });
    requireCondition(actual.length === buffer.length, 'ARTIFACT_HASH_MISMATCH', 'An existing output differs from these current bytes.');
    return { outputKey, relativePath: `${attemptId}/${name}`, sha256: sha, bytes: actual.length, mime };
  }
  readArtifact(reference) {
    record(reference, 'Artifact reference'); sha256(reference.sha256); integer(reference.bytes, 'Artifact size', 1, this.maxTempBytes);
    const parts = String(reference.relativePath ?? '').split('/');
    requireCondition(parts.length === 2 && parts.every(part => part && !part.includes('..') && !part.includes('\\')),
      'LOCAL_PATH_DENIED', 'The output reference is outside the attempt workspace.');
    identifier(parts[0]); requireCondition(/^[A-Za-z0-9_.:-]+$/.test(parts[1]), 'LOCAL_PATH_DENIED', 'The output reference is invalid.');
    const bytes = fileBytes(this.artifactRoot, path.join(this.artifactRoot, ...parts), { expectedHash: reference.sha256, maxBytes: this.maxTempBytes });
    requireCondition(bytes.length === reference.bytes, 'ARTIFACT_HASH_MISMATCH', 'The output size does not match its receipt.'); return bytes;
  }
  close() {
    if (!this.lockToken) return;
    this.#assertOwner(); fs.unlinkSync(this.lockPath); syncDirectory(this.root); this.lockToken = null;
  }
  snapshotHash() { return dataHash(this.state); }
  temporaryBytes() { return artifactUsage(this.root); }
}
