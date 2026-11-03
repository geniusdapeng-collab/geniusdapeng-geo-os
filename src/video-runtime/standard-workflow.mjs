import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { atomicJson, privateDirectory, SCOPE, VideoRuntimeError } from './config.mjs';

const PLAN_SCHEMA = 'workloom.standard-video-intent/v1';
const RECEIPT_SCHEMA = 'pengmanager.standard-video-start/v1';
const WORKFLOW_ID = 'pengmanager.video.workflow';
const SHA = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new VideoRuntimeError(code, message); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

export const standardWorkflowDescriptor = {
  id: WORKFLOW_ID, title: '把一句话交给鹏经理的标准视频管线',
  description: '制作、生成、营销或叙事视频时先调用：冻结原话与明确秒数，返回正式 Studio 输入和后续证据要求。只读，不启动、渲染、付费或批准。',
  operation: 'read', risk: 'low', dataMode: 'unverified',
  inputSchema: { type: 'object', required: ['intent'], additionalProperties: false, properties: {
    intent: { type: 'string', minLength: 1, maxLength: 2000 },
    durationSec: { type: 'integer', minimum: 5, maximum: 180 },
  } },
};

/** The native router, not the calling agent, decides marketing or narrative. */
export function standardVideoIntent(value) {
  if (!isObject(value) || Object.keys(value).some(key => !['intent', 'durationSec'].includes(key))
    || typeof value.intent !== 'string' || !value.intent.trim() || value.intent.length > 2000) {
    fail('STANDARD_VIDEO_INTENT_INVALID', '提供 1–2000 字符的用户原话，不接受自写片单、路线或供应商请求。');
  }
  // Avoid interpreting “01:30”, “2.5 秒”, “-30 秒” or part of a longer
  // number as the requested whole-film duration. Competing mentions require
  // the caller to extract a grounded total, rather than guessing 30.
  const normalized = value.intent.normalize('NFKC');
  const matches = [...normalized.matchAll(/(?<![\d.:+-])(\d+)\s*(?:秒(?:钟)?|seconds?\b)/giu)]
    .map(match => Number(match[1]));
  const digit = char => '零一二三四五六七八九'.indexOf(char === '两' ? '二' : char);
  for (const [, whole, hundred, tens, units] of normalized.matchAll(/(?<![零一二三四五六七八九十百两])((一百)?([二三四五六七八九]?十)?(零?[一二三四五六七八九两])?)\s*秒(?:钟)?/gu)) {
    if (!whole || hundred && units && !tens && !units.startsWith('零')) continue;
    matches.push((hundred ? 100 : 0) + (tens ? (tens.length === 1 ? 1 : digit(tens[0])) * 10 : 0) + (units ? digit(units.at(-1)) : 0));
  }
  const distinct = [...new Set(matches)];
  const duration = value.durationSec ?? (distinct.length === 1 ? distinct[0] : undefined);
  if (!Number.isInteger(duration) || duration < 5 || duration > 180 || distinct.length > 0 && !distinct.includes(duration)) {
    fail('STANDARD_VIDEO_DURATION_REQUIRED', '需要用户明确的全片整数秒数（5–180）；有多个秒数时，显式提供原话中的目标全片时长。');
  }
  const input = { intent: value.intent, route: 'auto', metadata: { brief: { duration } } };
  return {
    schemaVersion: PLAN_SCHEMA, productId: 'pengmanager-system', intentSha256: sha256(value.intent),
    requestedDurationSec: duration, startProcedure: 'video.studio.start', input,
    launched: false, productionAuthorized: false, complete: false,
    gates: ['native-route', 'current-preproduction', 'native-qualification-and-render', 'official-post-and-media-verification'],
  };
}

function receiptPath(config, id, create = false) {
  if (!SHA.test(id ?? '')) fail('STANDARD_VIDEO_JOB_ID_INVALID', '使用本次标准作业返回的 SHA-256 作业号。');
  const dir = path.join(config.dataRoot, 'standard-video-runs');
  if (create) { privateDirectory(config.dataRoot); privateDirectory(dir); }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || fs.realpathSync(dir) !== dir || process.platform !== 'win32' && (stat.mode & 0o077 || stat.uid !== process.getuid?.())) fail('STANDARD_VIDEO_RECEIPT_INVALID', '作业目录不能经过符号链接。');
  return path.join(dir, `${id}.json`);
}

function existingReceipt(file, jobId, config) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 10_000 || process.platform !== 'win32' && (stat.mode & 0o077)) {
      fail('STANDARD_VIDEO_RECEIPT_INVALID', '本机回执必须是普通私有文件。');
    }
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!isObject(value) || value.schemaVersion !== RECEIPT_SCHEMA || value.jobId !== jobId || value.sourceMain !== config.sourceMain
      || value.backendPort !== config.ports.backend || value.workspaceId !== SCOPE.workspaceId || !SHA.test(value.intentSha256 ?? '')
      || !Number.isInteger(value.requestedDurationSec) || value.requestedDurationSec < 5 || value.requestedDurationSec > 180
      || !['pending', 'clarify', 'routed', 'special-route'].includes(value.state)
      || value.state === 'routed' && (!ID.test(value.runId ?? '') || !ID.test(value.projectId ?? '')
        || !['narrative', 'marketing'].includes(value.pipeline))) {
      fail('STANDARD_VIDEO_RECEIPT_INVALID', '回执与当前引擎、端口、工作区或作业不一致。');
    }
    return value;
  } finally { fs.closeSync(fd); }
}

export function standardVideoExecutor(config) {
  const token = () => {
    const value = config.env.WORKLOOM_ACCESS_TOKEN;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{8,8192}$/u.test(value)) {
      fail('STANDARD_VIDEO_NATIVE_SESSION_REQUIRED', '需要已启动的同一鹏经理本机实例和实际原生会话；云端 Agent bearer 不可替代。');
    }
    return value;
  };
  async function rpc(procedure, input, method = 'GET') {
    const endpoint = new URL(`http://127.0.0.1:${config.ports.backend}/trpc/${procedure}`);
    if (method === 'GET' && input !== undefined) endpoint.searchParams.set('input', JSON.stringify(input));
    const bearer = token();
    const bytes = method === 'POST' ? Buffer.from(JSON.stringify(input)) : undefined;
    if (bytes?.includes(bearer)) fail('STANDARD_VIDEO_CREDENTIAL_IN_INPUT', '原话不得包含会话令牌。');
    const headers = { authorization: `Bearer ${bearer}`, accept: 'application/json',
      ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}) };
    // A new, direct TCP connection to the configured loopback instance. Do not
    // inherit an HTTP proxy or follow redirects carrying the member bearer.
    const response = await new Promise((resolve, reject) => {
      const req = request(endpoint, { method, headers, agent: false, signal: AbortSignal.timeout(bytes ? 45_000 : 15_000) }, resolve);
      req.once('error', reject);
      req.end(bytes);
    });
    if (!(response.statusCode >= 200 && response.statusCode < 300)) {
      response.destroy();
      fail('STANDARD_VIDEO_NATIVE_REJECTED', `正式视频入口拒绝请求（HTTP ${response.statusCode}）。`);
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 8 * 1024 * 1024) fail('STANDARD_VIDEO_RESPONSE_INVALID', '正式视频回执超过 8 MiB。');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks, length);
    if (raw.includes(bearer)) fail('STANDARD_VIDEO_RESPONSE_INVALID', '正式视频回执含凭据，拒绝读取。');
    const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!isObject(envelope.result) || envelope.error || !Object.hasOwn(envelope.result, 'data')) fail('STANDARD_VIDEO_RESPONSE_INVALID', '正式视频入口未返回有效回执。');
    const data = envelope.result.data?.json ?? envelope.result.data;
    if (JSON.stringify(data)?.includes(bearer)) fail('STANDARD_VIDEO_RESPONSE_INVALID', '正式视频回执含凭据，拒绝读取。');
    return data;
  }
  async function verifySession() {
    const me = await rpc('members.me');
    if (me?.identity?.tenantId !== SCOPE.tenantId || me?.identity?.workspaceId !== SCOPE.workspaceId) {
      fail('STANDARD_VIDEO_SCOPE_MISMATCH', '原生会话没有绑定鹏经理本机视频工作区。');
    }
  }
  return {
    async start(value) {
      const plan = standardVideoIntent(value);
      const wire = JSON.stringify(plan.input);
      if (wire.includes(token())) fail('STANDARD_VIDEO_CREDENTIAL_IN_INPUT', '原话不得包含会话令牌。');
      const jobId = sha256(wire);
      await verifySession();
      const file = receiptPath(config, jobId, true);
      const base = { schemaVersion: RECEIPT_SCHEMA, jobId, sourceMain: config.sourceMain,
        workspaceId: SCOPE.workspaceId, backendPort: config.ports.backend, intentSha256: plan.intentSha256,
        requestedDurationSec: plan.requestedDurationSec, complete: false };
      let fd;
      try { fd = fs.openSync(file, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return existingReceipt(file, jobId, config); throw error; }
      try { fs.writeFileSync(fd, JSON.stringify({ ...base, state: 'pending' }) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      if (process.platform !== 'win32') {
        const dir = fs.openSync(path.dirname(file), 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
      // The current Studio endpoint lacks a replay guarantee. Persist the pending
      // receipt before dispatch and retain it unchanged if the outcome is unknown.
      let native;
      try { native = await rpc('video.studio.start', plan.input, 'POST'); }
      catch { fail('STANDARD_VIDEO_START_RECONCILE', `作业 ${jobId} 已留存待对账回执；先核对原生项目，禁止重提。`); }
      let receipt;
      if (native?.kind === 'clarify') {
        receipt = { ...base, state: 'clarify', next: 'resolve-native-route',
          missing: Array.isArray(native.missing) ? native.missing.filter(key => ID.test(key)).slice(0, 12) : [] };
      } else if (native?.kind === 'routed' && ID.test(native.projectId ?? '') && native.pipeline === 'explainer' && !native.runId) {
        receipt = { ...base, state: 'special-route', projectId: native.projectId, pipeline: native.pipeline, next: 'open-native-explainer-project' };
      } else if (native?.kind === 'routed' && ID.test(native.projectId ?? '') && ID.test(native.runId ?? '')
        && ['marketing', 'narrative'].includes(native.pipeline)) {
        receipt = { ...base, state: 'routed', projectId: native.projectId, runId: native.runId,
          pipeline: native.pipeline, next: 'status' };
      } else {
        fail('STANDARD_VIDEO_START_RECONCILE', `作业 ${jobId} 的正式启动回执不完整；先核对原生项目，禁止重提。`);
      }
      atomicJson(file, receipt);
      return receipt;
    },
    async status(jobId) {
      const file = receiptPath(config, jobId);
      const receipt = existingReceipt(file, jobId, config);
      if (receipt.state !== 'routed') return { ...receipt, complete: false,
        ...(receipt.state === 'pending' ? { next: 'reconcile-original-start' } : {}) };
      await verifySession();
      const state = await rpc('video.studio.status', { runId: receipt.runId });
      if (state?.runId !== receipt.runId || state.projectId !== receipt.projectId) fail('STANDARD_VIDEO_STATUS_MISMATCH', '当前原生运行与启动回执不一致。');
      const outcome = { ...receipt, studioStatus: state.status, complete: false };
      if (state.status !== 'finished' || state.pendingApprovalId) return { ...outcome,
        next: state.pendingApprovalId ? 'resolve-native-approval' : state.status === 'running' ? 'status' : 'inspect-native-stage' };
      const archive = await rpc('video.studio.archive', { projectId: receipt.projectId });
      if (archive?.projectId !== receipt.projectId || archive.archiveExists !== true || archive.pendingApprovalId
        || !Array.isArray(archive.stages) || !Array.isArray(archive.manualBridges) || archive.manualBridges.length > 0) {
        fail('STANDARD_VIDEO_ARCHIVE_UNVERIFIED', '当前正式档案不可核对、有待审批或含人工搭桥；不能认作严格管线。');
      }
      const latest = archive.stages.filter(row => row?.stageId === 'preproduction').sort((a, b) => b.attempt - a.attempt)[0];
      const shots = await rpc('video.production.shots', { projectId: receipt.projectId });
      if (latest?.runId !== receipt.runId || latest.status !== 'done' || !Number.isInteger(latest.attempt) || latest.attempt < 1
        || latest.outputRef !== `stages/preproduction/attempt-${latest.attempt}.output.json` || !SHA.test(latest.outputSha256 ?? '')
        || shots?.projectId !== receipt.projectId || shots.sourceAttempt !== latest.attempt || !SHA.test(shots.promptsSha256 ?? '')
        || !Array.isArray(shots.shots) || shots.shots.length === 0 || new Set(shots.shots.map(row => row?.shotId)).size !== shots.shots.length
        || shots.shots.some(row => !ID.test(row?.shotId ?? '') || !Number.isInteger(row.durationSec) || row.durationSec < 1 || !SHA.test(row.promptSha256 ?? ''))
        || shots.shots.reduce((seconds, row) => seconds + row.durationSec, 0) !== receipt.requestedDurationSec) {
        fail('STANDARD_VIDEO_SHOTS_UNVERIFIED', '当前片单未绑定本次成功档案、出现缺镜/摘要漂移，或总秒数与用户要求不符。');
      }
      return { ...outcome, stage: 'preproduction-verified', sourceAttempt: latest.attempt,
        archiveSha256: latest.outputSha256, promptsSha256: shots.promptsSha256, shotCount: shots.shots.length,
        next: 'video.production.qualifyShot' };
    },
  };
}
