import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, statfs } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ApiError } from "../domain/errors.mjs";
import { verifyEventChain } from "../storage/json-store.mjs";

const SCHEMA = "pengmanager.editorial-backup/v1";
const NATIVE_SCHEMA = "pengmanager.editorial-backup/v2";
const BACKUP_ID = /^EDB-[a-f0-9]{32}$/;
const ASSET_ID = /^MED-[a-f0-9]{32}$/;
const ARTIFACT_ID = /^ART-[a-f0-9]{32}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_STATE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const ownerUid = process.getuid?.();
const tails = new WeakMap();
const digest = data => createHash("sha256").update(data).digest("hex");
const fail = (code, message) => { throw new ApiError(503, code, message); };
const ordinary = (info, directory = false) => (directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink()
  && (ownerUid === undefined || info.uid === ownerUid) && (info.mode & 0o077) === 0 && (directory || info.nlink === 1);

function paths(store) {
  if (!store?.filePath || typeof store.snapshot !== "function") throw new TypeError("A JsonStore is required for editorial backup.");
  const data = dirname(resolve(store.filePath));
  return { data, backups: join(data, "backups"), editorial: join(data, "backups", "editorial") };
}
async function checkAncestors(path) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail("EDITORIAL_BACKUP_UNSAFE_PATH", "备份目录含有不受支持的链接或路径。");
  }
}
async function privateDirectory(path, create = false) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  if (!ordinary(await lstat(path), true)) fail("EDITORIAL_BACKUP_UNSAFE_PATH", "备份目录权限或所有者不安全。");
}
async function directories(store, create = false) {
  const result = paths(store);
  await checkAncestors(result.data);
  await privateDirectory(result.backups, create);
  await privateDirectory(result.editorial, create);
  return result;
}
function snapshotState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![1, 2, 3].includes(value.schemaVersion)
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.events)
    || !verifyEventChain(value.events).valid || (value.mediaAssets !== undefined && !Array.isArray(value.mediaAssets))) {
    fail("EDITORIAL_BACKUP_INVALID_STATE", "当前状态或事件链无法作为可恢复备份。");
  }
  const state = structuredClone(value);
  const identifiers = new Set();
  for (const asset of state.mediaAssets ?? []) {
    if (!ASSET_ID.test(asset?.id ?? "") || identifiers.has(asset.id) || !SHA.test(asset.sha256 ?? "")
      || !Number.isSafeInteger(asset.size) || asset.size < 1) fail("EDITORIAL_BACKUP_INVALID_ASSET", "注册素材的标识、摘要或大小无效。");
    identifiers.add(asset.id);
  }
  if (state.productionArtifacts !== undefined && !Array.isArray(state.productionArtifacts)) fail("EDITORIAL_BACKUP_INVALID_ARTIFACT", "附件集合无效。");
  for (const artifact of state.productionArtifacts ?? []) {
    if (!ARTIFACT_ID.test(artifact?.id ?? "") || identifiers.has(artifact.id) || !SHA.test(artifact.sha256 ?? "") ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 1) fail("EDITORIAL_BACKUP_INVALID_ARTIFACT", "登记附件的标识、摘要或大小无效。");
    identifiers.add(artifact.id);
  }
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, "utf8");
  if (bytes.length > MAX_STATE_BYTES) fail("EDITORIAL_BACKUP_TOO_LARGE", "状态文件超过备份工具的安全读取上限。");
  return { state, bytes };
}
async function privateFile(path, maximum = Infinity) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!ordinary(info) || info.size > maximum) fail("EDITORIAL_BACKUP_UNSAFE_FILE", "备份文件类型、权限或大小不安全。");
    return { handle, size: info.size };
  } catch (error) { await handle.close(); throw error; }
}
async function writeImmutable(path, bytes) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o400); }
  finally { await handle.close(); }
}
async function copyVerified(source, target, expected, mode = 0o400) {
  const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  try {
    while (offset < expected.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, expected.size - offset), offset);
      if (!bytesRead) fail("EDITORIAL_BACKUP_COPY_FAILED", "备份源文件不完整。");
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk); await output.writeFile(chunk); offset += bytesRead;
    }
    const info = await source.stat();
    if (info.size !== expected.size || hash.digest("hex") !== expected.sha256) fail("EDITORIAL_BACKUP_HASH_MISMATCH", "备份复制的文件与注册摘要不符。");
    await output.sync(); await output.chmod(mode);
  } finally { await output.close(); }
}
async function hashFile(handle, size) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) fail("EDITORIAL_BACKUP_HASH_MISMATCH", "备份文件不完整。");
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest("hex");
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function receipt(manifest, manifestSha256) {
  return { backupId: manifest.backupId, schema: manifest.schema, stage: manifest.stage, releaseId: manifest.releaseId,
    createdAt: manifest.createdAt, sourceRevision: manifest.sourceRevision, manifestSha256,
    stateSha256: manifest.files[0].sha256, assetCount: manifest.assetCount, artifactCount: manifest.artifactCount ?? 0, totalBytes: manifest.totalBytes };
}

async function capture({ store, mediaAssets, productionArtifacts, clock, stage, release, inputState }) {
  let temporary, temporaryInfo, published = false;
  try {
    const { state, bytes } = snapshotState(inputState);
    if (stage === "pre_activation") {
      const candidate = state.websiteReleases?.find(row => row.id === release?.id);
      if (!candidate || candidate.status !== "approved" || !SHA.test(candidate.snapshotHash ?? "") || candidate.snapshotHash !== release.snapshotHash) {
        fail("EDITORIAL_BACKUP_CANDIDATE_MISMATCH", "备份必须包含当前已批准的准确公开候选。");
      }
    }
    const assets = state.mediaAssets ?? [];
    const artifacts = state.productionArtifacts ?? [];
    const native = state.schemaVersion === 3 || artifacts.length > 0;
    if (assets.length && typeof mediaAssets?.openVerifiedAsset !== "function") fail("EDITORIAL_BACKUP_MEDIA_UNAVAILABLE", "完整备份需要注册素材的受控字节读取服务。");
    if (artifacts.length && typeof productionArtifacts?.openBackupArtifact !== "function") fail("EDITORIAL_BACKUP_ARTIFACTS_UNAVAILABLE", "完整备份需要私有附件的受控字节读取服务。");
    const roots = await directories(store, true);
    const assetBytes = [...assets, ...artifacts].reduce((total, asset) => total + asset.size, 0);
    if (!Number.isSafeInteger(assetBytes)) fail("EDITORIAL_BACKUP_INVALID_ASSET", "注册素材总大小无效。");
    const disk = await statfs(roots.editorial);
    if (disk.bavail * disk.bsize < bytes.length + assetBytes + 64 * 1024 * 1024) fail("EDITORIAL_BACKUP_NO_SPACE", "备份空间不足；请先保全现有备份并释放空间，再公开激活。");
    const backupId = `EDB-${randomBytes(16).toString("hex")}`;
    temporary = join(roots.editorial, `.creating-${backupId}`);
    const target = join(roots.editorial, backupId);
    await mkdir(temporary, { mode: 0o700 }); temporaryInfo = await lstat(temporary);
    await mkdir(join(temporary, "media-assets"), { mode: 0o700 });
    await mkdir(join(temporary, "media-assets", "objects"), { mode: 0o700 });
    await mkdir(join(temporary, "media-assets", "staging"), { mode: 0o700 });
    if (native) {
      await mkdir(join(temporary, "worker-artifacts"), { mode: 0o700 });
      await mkdir(join(temporary, "worker-artifacts", "objects"), { mode: 0o700 });
      await mkdir(join(temporary, "worker-artifacts", "staging"), { mode: 0o700 });
    }
    await writeImmutable(join(temporary, "state.json"), bytes);
    const files = [{ path: "state.json", kind: "state", size: bytes.length, sha256: digest(bytes) }];
    for (const asset of assets) {
      const opened = await mediaAssets.openVerifiedAsset(asset.id, { sha256: asset.sha256, state, forceVerify: true });
      try {
        if (opened.asset.id !== asset.id || opened.asset.sha256 !== asset.sha256 || opened.asset.size !== asset.size) fail("EDITORIAL_BACKUP_INVALID_ASSET", "素材读取结果与当前状态不符。");
        await copyVerified(opened.handle, join(temporary, "media-assets", "objects", `${asset.id}.bin`), asset);
        files.push({ path: `media-assets/objects/${asset.id}.bin`, kind: "media", assetId: asset.id, size: asset.size, sha256: asset.sha256 });
      } finally { await opened.handle.close(); }
    }
    for (const artifact of artifacts) {
      const opened = await productionArtifacts.openBackupArtifact(artifact.id, { sha256: artifact.sha256, state });
      try {
        if (opened.artifact.id !== artifact.id || opened.artifact.sha256 !== artifact.sha256 || opened.artifact.size !== artifact.size) fail("EDITORIAL_BACKUP_INVALID_ARTIFACT", "附件读取结果与当前状态不符。");
        await copyVerified(opened.handle, join(temporary, "worker-artifacts", "objects", `${artifact.id}.bin`), artifact);
        files.push({ path: `worker-artifacts/objects/${artifact.id}.bin`, kind: "artifact", artifactId: artifact.id, size: artifact.size, sha256: artifact.sha256 });
      } finally { await opened.handle.close(); }
    }
    const manifest = { schema: native ? NATIVE_SCHEMA : SCHEMA, backupId, stage, releaseId: release?.id ?? null, candidateSnapshotHash: release?.snapshotHash ?? null, createdAt: clock().toISOString(),
      sourceRevision: state.revision, sourceSchemaVersion: state.schemaVersion, assetCount: assets.length,
      ...(native ? { artifactCount: artifacts.length } : {}),
      totalBytes: bytes.length + assetBytes, files };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBytes.length > MAX_MANIFEST_BYTES) fail("EDITORIAL_BACKUP_TOO_LARGE", "备份清单超过安全读取上限。");
    await writeImmutable(join(temporary, "manifest.json"), manifestBytes);
    await syncDirectory(join(temporary, "media-assets", "objects"));
    if (native) { await syncDirectory(join(temporary, "worker-artifacts", "objects")); await syncDirectory(join(temporary, "worker-artifacts")); }
    await syncDirectory(join(temporary, "media-assets")); await syncDirectory(temporary);
    // The random target is never an operator-supplied path. Refuse collisions.
    try { await lstat(target); fail("EDITORIAL_BACKUP_COLLISION", "备份标识冲突，请重试。"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, target); published = true;
    await syncDirectory(roots.editorial);
    const result = receipt(manifest, digest(manifestBytes));
    await verifyEditorialBackup({ store, backupId, expectedManifestSha256: result.manifestSha256 });
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "EDITORIAL_BACKUP_FAILED", "完整内容与媒体备份失败；尚未满足公开激活条件。");
  } finally {
    if (temporary && temporaryInfo && !published) {
      const current = await lstat(temporary).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (current && ordinary(current, true) && current.ino === temporaryInfo.ino && current.dev === temporaryInfo.dev) {
        await rm(temporary, { recursive: true });
      }
    }
  }
}

/** A real pre-activation backup gate; it performs no JsonStore mutation. */
export function createEditorialBackup({ store, mediaAssets, productionArtifacts, clock = () => new Date() } = {}) {
  paths(store);
  const run = (stage, release, state) => {
    const previous = tails.get(store) ?? Promise.resolve();
    const task = previous.then(() => capture({ store, mediaAssets, productionArtifacts, clock, stage, release, inputState: state }));
    tails.set(store, task.catch(() => undefined));
    return task;
  };
  const beforeActivation = async (release, state) => {
    if (!release || typeof release.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(release.id)) fail("EDITORIAL_BACKUP_INVALID_RELEASE", "备份缺少明确的候选修订。");
    return run("pre_activation", release, structuredClone(state));
  };
  beforeActivation.captureCurrent = async () => run("current", null, store.snapshot());
  return beforeActivation;
}

async function inspectBackup({ store, backupId, expectedManifestSha256 }) {
  if (!BACKUP_ID.test(backupId ?? "") || (expectedManifestSha256 !== undefined && !SHA.test(expectedManifestSha256))) fail("EDITORIAL_BACKUP_INVALID_ID", "备份标识或预期清单摘要无效。");
  const roots = await directories(store);
  const directory = join(roots.editorial, backupId);
  await privateDirectory(directory);
  const manifestFile = await privateFile(join(directory, "manifest.json"), MAX_MANIFEST_BYTES);
  let manifest, manifestSha256;
  try {
    const bytes = await manifestFile.handle.readFile(); manifestSha256 = digest(bytes);
    if (expectedManifestSha256 !== undefined && expectedManifestSha256 !== manifestSha256) fail("EDITORIAL_BACKUP_HASH_MISMATCH", "备份清单与保存的回执不符。");
    manifest = JSON.parse(bytes.toString("utf8"));
  } finally { await manifestFile.handle.close(); }
  const native = manifest?.schema === NATIVE_SCHEMA;
  if (![SCHEMA, NATIVE_SCHEMA].includes(manifest?.schema) || manifest.backupId !== backupId || !["pre_activation", "current"].includes(manifest.stage)
    || !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.assetCount) || manifest.assetCount < 0
    || (native && (!Number.isSafeInteger(manifest.artifactCount) || manifest.artifactCount < 0))
    || (!native && (manifest.artifactCount !== undefined || manifest.sourceSchemaVersion === 3))
    || manifest.files.length !== manifest.assetCount + (native ? manifest.artifactCount : 0) + 1 || manifest.files[0]?.path !== "state.json" || manifest.files[0].kind !== "state") {
    fail("EDITORIAL_BACKUP_INVALID_MANIFEST", "备份清单结构无效。");
  }
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || (manifest.stage === "pre_activation" ? typeof manifest.releaseId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(manifest.releaseId)
      || !SHA.test(manifest.candidateSnapshotHash ?? "") : manifest.releaseId !== null || manifest.candidateSnapshotHash !== null)) {
    fail("EDITORIAL_BACKUP_INVALID_MANIFEST", "备份时间或候选修订记录无效。");
  }
  await privateDirectory(join(directory, "media-assets"));
  await privateDirectory(join(directory, "media-assets", "objects"));
  await privateDirectory(join(directory, "media-assets", "staging"));
  if (native) for (const path of ["worker-artifacts", "worker-artifacts/objects", "worker-artifacts/staging"]) await privateDirectory(join(directory, path));
  const names = new Set(); let state, total = 0;
  for (const entry of manifest.files) {
    if (!entry || !Number.isSafeInteger(entry.size) || entry.size < 1 || !SHA.test(entry.sha256 ?? "") || names.has(entry.path)
      || (entry.kind === "state" ? entry.path !== "state.json" : entry.kind === "media" ? !ASSET_ID.test(entry.assetId ?? "")
        || entry.path !== `media-assets/objects/${entry.assetId}.bin` : !native || entry.kind !== "artifact" || !ARTIFACT_ID.test(entry.artifactId ?? "")
        || entry.path !== `worker-artifacts/objects/${entry.artifactId}.bin`)) fail("EDITORIAL_BACKUP_INVALID_MANIFEST", "备份文件条目无效。");
    names.add(entry.path); total += entry.size;
    const opened = await privateFile(join(directory, entry.path), entry.kind === "state" ? MAX_STATE_BYTES : entry.size);
    try {
      if (opened.size !== entry.size || await hashFile(opened.handle, opened.size) !== entry.sha256) fail("EDITORIAL_BACKUP_HASH_MISMATCH", "备份文件摘要或大小不符。");
      if (entry.kind === "state") {
        const bytes = Buffer.alloc(entry.size); let offset = 0;
        while (offset < bytes.length) {
          const read = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) fail("EDITORIAL_BACKUP_HASH_MISMATCH", "备份状态不完整。");
          offset += read.bytesRead;
        }
        state = snapshotState(JSON.parse(bytes.toString("utf8"))).state;
      }
    } finally { await opened.handle.close(); }
  }
  const assets = state.mediaAssets ?? [];
  const artifacts = state.productionArtifacts ?? [];
  if (manifest.stage === "pre_activation" && !state.websiteReleases?.some(row => row.id === manifest.releaseId
    && row.status === "approved" && row.snapshotHash === manifest.candidateSnapshotHash)) fail("EDITORIAL_BACKUP_CANDIDATE_MISMATCH", "备份的候选修订与清单不一致。");
  if (assets.length !== manifest.assetCount || artifacts.length !== (manifest.artifactCount ?? 0) || total !== manifest.totalBytes || state.revision !== manifest.sourceRevision
    || state.schemaVersion !== manifest.sourceSchemaVersion || assets.some(asset => !manifest.files.some(entry => entry.kind === "media"
      && entry.assetId === asset.id && entry.sha256 === asset.sha256 && entry.size === asset.size)) || artifacts.some(artifact => !manifest.files.some(entry => entry.kind === "artifact"
      && entry.artifactId === artifact.id && entry.sha256 === artifact.sha256 && entry.size === artifact.size))) fail("EDITORIAL_BACKUP_INCOMPLETE", "备份状态与完整素材清单不一致。");
  const expectedObjects = manifest.files.filter(entry => entry.kind === "media").map(entry => `${entry.assetId}.bin`).sort();
  if (JSON.stringify((await readdir(join(directory, "media-assets", "objects"))).sort()) !== JSON.stringify(expectedObjects)
    || (await readdir(join(directory, "media-assets", "staging"))).length
    || JSON.stringify((await readdir(join(directory, "media-assets"))).sort()) !== JSON.stringify(["objects", "staging"])
    || JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(native ? ["manifest.json", "media-assets", "state.json", "worker-artifacts"] : ["manifest.json", "media-assets", "state.json"])) {
    fail("EDITORIAL_BACKUP_UNKNOWN_FILE", "备份目录含有未登记文件，拒绝恢复。");
  }
  if (native && (JSON.stringify((await readdir(join(directory, "worker-artifacts", "objects"))).sort()) !== JSON.stringify(artifacts.map(row => `${row.id}.bin`).sort())
    || (await readdir(join(directory, "worker-artifacts", "staging"))).length
    || JSON.stringify((await readdir(join(directory, "worker-artifacts"))).sort()) !== JSON.stringify(["objects", "staging"]))) {
    fail("EDITORIAL_BACKUP_UNKNOWN_FILE", "备份附件目录含有未登记文件，拒绝恢复。");
  }
  return { directory, manifest, manifestSha256, state };
}

/** Verify every file against a saved receipt; no application/runtime is started. */
export async function verifyEditorialBackup(options) {
  try {
    const result = await inspectBackup(options);
    return { ...receipt(result.manifest, result.manifestSha256), filesVerified: result.manifest.files.length };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "EDITORIAL_BACKUP_VERIFY_FAILED", "备份校验失败，不能用于恢复。");
  }
}

/** Restore only into a nonexistent directory outside the live DATA tree. */
export async function restoreEditorialBackupToIsolatedDirectory({ store, backupId, expectedManifestSha256, targetDirectory }) {
  let targetCreated = false, target, targetInfo;
  try {
    const source = await inspectBackup({ store, backupId, expectedManifestSha256 });
    if (typeof targetDirectory !== "string" || !targetDirectory.trim()) fail("EDITORIAL_RESTORE_INVALID_TARGET", "恢复需要明确的全新隔离目录。");
    target = resolve(targetDirectory);
    const live = paths(store).data;
    if (target === live || target.startsWith(`${live}${sep}`) || live.startsWith(`${target}${sep}`)) fail("EDITORIAL_RESTORE_LIVE_TARGET", "隔离演练不能覆盖或位于在线数据目录内。");
    await checkAncestors(dirname(target));
    await mkdir(target, { mode: 0o700 }); targetCreated = true; targetInfo = await lstat(target);
    await mkdir(join(target, "media-assets"), { mode: 0o700 });
    await mkdir(join(target, "media-assets", "objects"), { mode: 0o700 });
    await mkdir(join(target, "media-assets", "staging"), { mode: 0o700 });
    if (source.manifest.schema === NATIVE_SCHEMA) {
      await mkdir(join(target, "worker-artifacts"), { mode: 0o700 });
      await mkdir(join(target, "worker-artifacts", "objects"), { mode: 0o700 });
      await mkdir(join(target, "worker-artifacts", "staging"), { mode: 0o700 });
    }
    for (const entry of source.manifest.files) {
      const opened = await privateFile(join(source.directory, entry.path), entry.size);
      try { await copyVerified(opened.handle, join(target, entry.path), entry, 0o600); }
      finally { await opened.handle.close(); }
    }
    await syncDirectory(join(target, "media-assets", "objects"));
    if (source.manifest.schema === NATIVE_SCHEMA) {
      await syncDirectory(join(target, "worker-artifacts", "objects")); await syncDirectory(join(target, "worker-artifacts"));
    }
    await syncDirectory(join(target, "media-assets")); await syncDirectory(target);
    // Compare the resulting tree's actual bytes too, independently of the copy.
    for (const entry of source.manifest.files) {
      const opened = await privateFile(join(target, entry.path), entry.size);
      try {
        if (opened.size !== entry.size || await hashFile(opened.handle, entry.size) !== entry.sha256) fail("EDITORIAL_RESTORE_HASH_MISMATCH", "隔离恢复的文件校验失败。");
      } finally { await opened.handle.close(); }
    }
    return { ...receipt(source.manifest, source.manifestSha256), restored: true, filesVerified: source.manifest.files.length, stateFile: "state.json" };
  } catch (error) {
    if (targetCreated && target && targetInfo) {
      const info = await lstat(target).catch(probe => { if (probe.code === "ENOENT") return null; throw probe; });
      if (info && ordinary(info, true) && info.ino === targetInfo.ino && info.dev === targetInfo.dev) await rm(target, { recursive: true });
    }
    if (error instanceof ApiError) throw error;
    if (error.code === "EEXIST") throw new ApiError(409, "EDITORIAL_RESTORE_TARGET_EXISTS", "隔离恢复目录必须尚不存在，现有内容已保留。");
    throw new ApiError(503, "EDITORIAL_RESTORE_FAILED", "隔离恢复失败，在线数据未被修改。");
  }
}
