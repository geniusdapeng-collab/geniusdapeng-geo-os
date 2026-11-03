import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { SOURCE_FILE_COUNT, SOURCE_MAIN, VideoRuntimeError } from './video-runtime/config.mjs';
import { identifyVideoMake } from './video-runtime/video-make.mjs';

const PRODUCT = 'pengmanager-system';
const ENGINE_PRODUCT = 'workloom-ai-video-edit';
const ENGINE_REPOSITORY = 'https://github.com/geniusdapeng-collab/WorkLoom-video-edit';
const ENGINE_ROOT = 'engines/video-edit';
const SNAPSHOT = 'upstreams/workloom-video-edit.snapshot.json';
const OWNER_ENTRYPOINT = 'scripts/pengmanager-video-make.mjs';
const WORKBENCH_GUIDE = 'docs/ai-video-workbench-guide.md';
const MAX_INTENT_LENGTH = 2_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const MIN_DURATION_SECONDS = 5;
const MAX_DURATION_SECONDS = 180;
const OPERATIONS = ['produce', 'repair', 'deliver'];
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA1 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const provenanceError = (message, cause) => new VideoRuntimeError('VIDEO_INTAKE_PROVENANCE_INVALID', message, { cause });

export const VIDEO_INTAKE = {
  id: 'pengmanager.video.intake',
  title: '核对鹏经理视频制作需求',
  description: '为视频制作、返修或交付核对当前鹏经理指南和内置引擎来源，生成原始需求摘要并返回本机原生接续信息。零模型调用，零项目写入。',
  operation: 'read',
  risk: 'low',
  dataMode: 'unverified',
  inputSchema: {
    type: 'object',
    required: ['intent'],
    additionalProperties: false,
    properties: {
      intent: { type: 'string', minLength: 1, maxLength: MAX_INTENT_LENGTH, description: '本次用户的原始视频需求，保留原文。' },
      operation: { type: 'string', enum: OPERATIONS },
      projectId: { type: 'string', pattern: PROJECT_ID.source },
      durationSeconds: { type: 'integer', minimum: MIN_DURATION_SECONDS, maximum: MAX_DURATION_SECONDS },
    },
  },
};

function requestFrom(input) {
  const invalid = () => new VideoRuntimeError('INVALID_INPUT', '需要有效的原始视频需求（最多 2,000 字符），可提供制作方式、现有项目 ID 和 5 至 180 秒的整数时长。');
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !Object.hasOwn(VIDEO_INTAKE.inputSchema.properties, key))) throw invalid();
  const { intent, operation = 'produce', projectId, durationSeconds } = input;
  if (typeof intent !== 'string' || !intent.trim() || !intent.isWellFormed() || intent.includes('\0') || intent.length > MAX_INTENT_LENGTH
    || !OPERATIONS.includes(operation)
    || (projectId !== undefined && (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)))
    || (durationSeconds !== undefined && (!Number.isSafeInteger(durationSeconds) || durationSeconds < MIN_DURATION_SECONDS || durationSeconds > MAX_DURATION_SECONDS))
    || Buffer.byteLength(JSON.stringify({ intent, operation, projectId, durationSeconds }), 'utf8') > MAX_REQUEST_BYTES) throw invalid();
  const request = {
    system: 'pengmanager', operation, projectId: projectId ?? null, durationSeconds: durationSeconds ?? null, intentSha256: sha256(intent),
  };
  return { ...request, sha256: sha256(JSON.stringify(request)) };
}

function readRepositoryFile(root, relativePath, maxBytes) {
  const file = path.join(root, relativePath);
  let descriptor;
  try {
    const named = lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || realpathSync(file) !== file || named.size < 1 || named.size > maxBytes) throw new Error('Invalid repository file.');
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) throw new Error('Repository file changed while opening.');
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    const current = fstatSync(descriptor);
    if (length !== opened.size || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw new Error('Repository file changed while reading.');
    return bytes.subarray(0, length);
  } catch (error) {
    throw provenanceError(`无法安全读取当前仓库文件 ${relativePath}。`, error);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function jsonFrom(bytes, relativePath) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { throw provenanceError(`当前仓库文件 ${relativePath} 不是合法 JSON。`, error); }
}

function readGit(root, ...args) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_NAMESPACE']) delete env[key];
  return execFileSync('git', ['-C', root, ...args], { env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 256 * 1024 });
}

function currentHead(root) {
  try {
    const head = readGit(root, 'rev-parse', '--verify', 'HEAD').toString('utf8').trim();
    const top = readGit(root, 'rev-parse', '--show-toplevel').toString('utf8').trim();
    if (realpathSync(top) === root && SHA1.test(head)) return head;
  } catch (error) {
    throw provenanceError('无法回读鹏经理 Git 工作树身份。', error);
  }
  throw provenanceError('当前目录不是鹏经理 Git 工作树的根目录。');
}

function ownerEntrypointDigest(root, head) {
  try {
    const bytes = readRepositoryFile(root, OWNER_ENTRYPOINT, 128 * 1024);
    const committed = readGit(root, 'show', `${head}:${OWNER_ENTRYPOINT}`);
    return bytes.equals(committed) ? sha256(bytes) : null;
  } catch {
    return null;
  }
}

function readProvenance(root) {
  const readJson = relativePath => jsonFrom(readRepositoryFile(root, relativePath, 1024 * 1024), relativePath);
  if (readJson('package.json')?.name !== PRODUCT) throw provenanceError('当前仓库的产品身份不是鹏经理。');
  const pin = readJson('upstreams/workloom-video-edit.pin.json');
  if (pin?.repository !== ENGINE_REPOSITORY || pin.engineRoot !== ENGINE_ROOT || pin.snapshot !== SNAPSHOT
    || pin.commit !== SOURCE_MAIN || pin.sourceFileCount !== SOURCE_FILE_COUNT || !SHA1.test(pin.tree ?? '') || !SHA256.test(pin.snapshotSha256 ?? '')) {
    throw provenanceError('内置视频引擎 pin 与当前鹏经理运行时声明不一致。');
  }
  const snapshotBytes = readRepositoryFile(root, SNAPSHOT, 8 * 1024 * 1024);
  if (sha256(snapshotBytes) !== pin.snapshotSha256) throw provenanceError('内置视频引擎文件清单与 pin 摘要不一致。');
  const snapshot = jsonFrom(snapshotBytes, SNAPSHOT);
  if (snapshot?.schemaVersion !== 'pengmanager.edit-snapshot/v1' || snapshot.source?.repository !== pin.repository
    || snapshot.source.commit !== pin.commit || snapshot.source.tree !== pin.tree || snapshot.sourceFileCount !== pin.sourceFileCount
    || !Array.isArray(snapshot.files) || snapshot.files.length !== pin.sourceFileCount || !Array.isArray(snapshot.targetOwnedFiles)) {
    throw provenanceError('内置视频引擎文件清单的来源身份或文件数量不一致。');
  }
  const pinnedFile = relativePath => {
    const matches = [...snapshot.files, ...snapshot.targetOwnedFiles].filter(item => item?.path === relativePath);
    const bytes = readRepositoryFile(root, `${ENGINE_ROOT}/${relativePath}`, 128 * 1024);
    if (matches.length !== 1 || matches[0].targetSha256 !== sha256(bytes)) throw provenanceError(`内置视频引擎文件 ${relativePath} 与 pin 字节证据不一致。`);
    return bytes;
  };
  const product = jsonFrom(pinnedFile('product.manifest.json'), 'product.manifest.json');
  if (product?.schemaVersion !== 'workloom.product/v1' || product.productId !== ENGINE_PRODUCT || product.repository !== 'workloom-ai/WorkLoom-video-edit' || product.defaultBundle !== 'geo-growth') {
    throw provenanceError('内置视频引擎的产品身份与鹏经理当前接入不符。');
  }
  const workbench = pinnedFile(WORKBENCH_GUIDE);
  const guideVersion = workbench.toString('utf8').match(/^> guideVersion: (\d{4}-\d{2}-\d{2}\.\d+)\s*$/mu)?.[1];
  if (!guideVersion) throw provenanceError('内置视频工作台指南缺少版本。');
  const hostGuide = relativePath => ({ path: relativePath, sha256: sha256(readRepositoryFile(root, relativePath, 256 * 1024)) });
  return {
    repository: {
      productId: PRODUCT, head: currentHead(root), embeddedProductId: ENGINE_PRODUCT,
      engineCommit: pin.commit, engineTree: pin.tree, snapshotSha256: pin.snapshotSha256,
    },
    guides: {
      instructions: hostGuide('AGENTS.md'),
      agent: hostGuide('docs/AI-AGENT-GUIDE.md'),
      quickstart: hostGuide('docs/CODEX-VIDEO-QUICKSTART.md'),
      workbench: { path: `${ENGINE_ROOT}/${WORKBENCH_GUIDE}`, guideVersion, sha256: sha256(workbench) },
    },
  };
}

export function createVideoIntake({ rootDir, input }) {
  const request = requestFrom(input);
  const root = realpathSync(rootDir);
  const provenance = readProvenance(root);
  const existingProject = request.projectId !== null || request.operation !== 'produce';
  const missing = [];
  if (!existingProject && request.durationSeconds === null) missing.push('durationSeconds');
  if (existingProject && request.projectId === null) missing.push('projectId');
  const ownerRequestId = existingProject || missing.length ? null : identifyVideoMake({
    system: request.system, intent: input.intent, durationSeconds: request.durationSeconds,
  }).id;
  const ownerEntrypoint = path.join(root, OWNER_ENTRYPOINT);
  const stat = lstatSync(ownerEntrypoint, { throwIfNoEntry: false });
  const entrypointPresent = stat?.isFile() === true && !stat.isSymbolicLink() && realpathSync(ownerEntrypoint) === ownerEntrypoint;
  const entrypointSha256 = entrypointPresent ? ownerEntrypointDigest(root, provenance.repository.head) : null;
  const blockers = [
    ...(!entrypointPresent ? ['NATIVE_ENTRYPOINT_UNAVAILABLE'] : []),
    ...(entrypointPresent && !entrypointSha256 ? ['NATIVE_ENTRYPOINT_UNVERIFIED'] : []),
    ...(missing.length ? ['CONTRACT_FIELDS_REQUIRED'] : []),
    ...(existingProject ? ['EXISTING_PROJECT_RECEIPT_REQUIRED'] : []),
  ];
  return {
    schemaVersion: 'pengmanager.video-intake/v1',
    status: blockers.length ? 'blocked' : 'intake_ready',
    ...provenance,
    provenanceSha256: sha256(JSON.stringify(provenance)),
    request,
    nativeHandoff: {
      kind: existingProject ? 'existing_project' : 'owner_start',
      ownerEntrypoint: OWNER_ENTRYPOINT, entrypointPresent, entrypointSha256, ownerRequestId, blockers, missing, authorizationGranted: false,
      required: ['native-owner-session', 'current-project-contract', 'scope-and-budget-approval'],
    },
    providerCallsPerformed: false,
    productionVerified: false,
  };
}
