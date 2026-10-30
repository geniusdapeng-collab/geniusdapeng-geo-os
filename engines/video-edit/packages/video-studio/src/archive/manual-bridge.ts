import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { assertInsideRoot, type ArchiveStore, type PipelineKind } from "./store.js";
import { updateContextBundle } from "./context-bundle.js";

export const MANUAL_BRIDGE_SCHEMA_VERSION = "pengmanager.video-manual-bridge/v1";
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MIN_FAILED_ATTEMPTS = 3;

export class ManualBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ManualBridgeError";
  }
}

export interface ManualBridgeFile {
  path: string;
  sha256: string;
}

export interface ManualBridgeFailureAttempt {
  attempt: number;
  subtaskKey: string;
  status: "failed";
  errorClass: string | null;
  errorMsg: string;
  evidencePath: string;
  evidenceSha256: string;
}

export interface ManualBridgeRequest {
  schemaVersion: typeof MANUAL_BRIDGE_SCHEMA_VERSION;
  idempotencyKey?: string;
  projectId: string;
  stageId: string;
  subtaskKey: string;
  failureCode: string;
  reason: string;
  inputArtifacts: ManualBridgeFile[];
  schema: ManualBridgeFile;
  output: ManualBridgeFile;
  validation: {
    passed: true;
    validatorId: string;
    command: string;
    exitCode: 0;
    completedAt: string;
    evidence: ManualBridgeFile;
  };
  fidelity: {
    usesOnlyUpstreamFacts: true;
    fabricatedFacts: false;
    formatConforms: true;
    dataFidelityStatus: "verified" | "partially_verified" | "unverified";
    unresolvedFacts: string[];
    deviations: string[];
  };
  externalEffects: {
    providerCalls: 0;
    paidProviderCalls: 0;
    publications: 0;
    irreversibleActions: 0;
  };
  downstream: {
    handoffReceipt: ManualBridgeFile;
  };
  deliveryDisclosure: {
    stageLabel: string;
    statement: string;
  };
}

export interface ManualBridgeRecord {
  schemaVersion: typeof MANUAL_BRIDGE_SCHEMA_VERSION;
  bridgeId: string;
  projectId: string;
  pipelineKind: PipelineKind;
  stageId: string;
  subtaskKey: string;
  failureCode: string;
  idempotencyKey?: string;
  trigger: {
    failedAttempts: number;
    attempts: ManualBridgeFailureAttempt[];
  };
  manualBridge: {
    actor: "Codex";
    reason: string;
    inputArtifacts: ManualBridgeFile[];
    schema: ManualBridgeFile;
    output: ManualBridgeFile;
  };
  validation: ManualBridgeRequest["validation"];
  fidelity: ManualBridgeRequest["fidelity"];
  externalEffects: ManualBridgeRequest["externalEffects"];
  downstream: {
    accepted: true;
    handoffReceipt: ManualBridgeFile;
  };
  deliveryDisclosure: ManualBridgeRequest["deliveryDisclosure"] & {
    requiredInFinalReport: true;
  };
  createdAt: string;
  receiptPath: string;
  receiptSha256: string;
}

export interface ManualBridgeEligibility {
  eligible: boolean;
  requiredFailures: number;
  stageId: string;
  failureCode: string;
  attempts: Array<{
    attempt: number;
    errorClass: string | null;
    errorMsg: string;
  }>;
  reason: string;
}

function text(value: unknown, label: string, minimum = 1): string {
  if (typeof value !== "string" || value.trim().length < minimum || /[\r\n\0]/.test(value)) {
    throw new ManualBridgeError("MANUAL_BRIDGE_INVALID", `${label} 必须是不含换行的文本，至少 ${minimum} 个字符`);
  }
  return value.trim();
}

function safeSegment(value: unknown, label: string): string {
  const raw = text(value, label);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(raw) || raw === "." || raw === "..") {
    throw new ManualBridgeError("MANUAL_BRIDGE_INVALID", `${label} 只能使用字母、数字、点、下划线和连字符`);
  }
  return raw;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function inspectFile(root: string, file: ManualBridgeFile, label: string): Promise<ManualBridgeFile> {
  if (!file || typeof file !== "object" || Array.isArray(file)) throw new ManualBridgeError("MANUAL_BRIDGE_INVALID", `${label} 必须是文件回执`);
  const rel = text(file.path, `${label}.path`);
  if (path.isAbsolute(rel) || rel.includes("\\") || path.posix.normalize(rel) !== rel) {
    throw new ManualBridgeError("MANUAL_BRIDGE_PATH_INVALID", `${label} 必须是档案根内的规范相对路径`);
  }
  const abs = assertInsideRoot(root, rel);
  let parent = root;
  for (const part of rel.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    try {
      const parentStat = await fs.lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
        throw new ManualBridgeError("MANUAL_BRIDGE_PATH_INVALID", `${label} 的目录链不能包含符号链接或普通文件`);
      }
    } catch (error) {
      if (error instanceof ManualBridgeError) throw error;
      throw new ManualBridgeError("MANUAL_BRIDGE_FILE_MISSING", `${label} 的目录链不存在`);
    }
  }
  let stat;
  try { stat = await fs.lstat(abs); }
  catch { throw new ManualBridgeError("MANUAL_BRIDGE_FILE_MISSING", `${label} 文件不存在`); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) {
    throw new ManualBridgeError("MANUAL_BRIDGE_FILE_INVALID", `${label} 必须是 1 字节至 8 MiB 的普通文件`);
  }
  const bytes = await fs.readFile(abs);
  const actual = digest(bytes);
  if (file.sha256 !== actual) throw new ManualBridgeError("MANUAL_BRIDGE_HASH_MISMATCH", `${label} 的 SHA-256 与当前字节不一致`);
  return { path: rel, sha256: actual };
}

async function readEvents(store: ArchiveStore): Promise<Record<string, unknown>[]> {
  const raw = await store.readText("events.jsonl");
  if (!raw) return [];
  return raw.split("\n").flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
}

export async function inspectManualBridgeEligibility(
  store: ArchiveStore,
  input: { stageId: string; failureCode: string },
): Promise<ManualBridgeEligibility> {
  const stageId = safeSegment(input.stageId, "stageId");
  const failureCode = text(input.failureCode, "failureCode", 3).slice(0, 160);
  const events = await readEvents(store);
  const byAttempt = new Map<number, { attempt: number; errorClass: string | null; errorMsg: string }>();
  let latestStatus: { attempt: number; kind: string; errorMsg: string } | undefined;
  let unverifiedExternal = "";
  for (const event of events) {
    if (event.stageId !== stageId || !Number.isSafeInteger(event.attempt) || Number(event.attempt) < 1) continue;
    const kind = String(event.kind ?? "");
    if (["stage.start", "stage.done", "stage.failed", "stage.interrupted"].includes(kind)) {
      latestStatus = { attempt: Number(event.attempt), kind, errorMsg: String(event.errorMsg ?? "") };
    }
    if (kind !== "stage.failed") continue;
    const errorMsg = String(event.errorMsg ?? "");
    if (!errorMsg.includes(failureCode)) continue;
    const errorClass = typeof event.errorClass === "string" ? event.errorClass : null;
    if (errorClass === "RECEIPT_UNVERIFIED") unverifiedExternal = errorMsg;
    byAttempt.set(Number(event.attempt), { attempt: Number(event.attempt), errorClass, errorMsg: errorMsg.slice(0, 500) });
  }
  const attempts = [...byAttempt.values()].sort((a, b) => a.attempt - b.attempt);
  if (unverifiedExternal) {
    return { eligible: false, requiredFailures: MIN_FAILED_ATTEMPTS, stageId, failureCode, attempts,
      reason: `存在外部结果未核实：${unverifiedExternal.slice(0, 200)}` };
  }
  if (attempts.length < MIN_FAILED_ATTEMPTS) {
    return { eligible: false, requiredFailures: MIN_FAILED_ATTEMPTS, stageId, failureCode, attempts,
      reason: `同一细分环节仅记录 ${attempts.length} 次失败，至少需要 ${MIN_FAILED_ATTEMPTS} 次` };
  }
  const latestFailure = attempts.at(-1)!;
  if (!latestStatus || latestStatus.kind !== "stage.failed" || latestStatus.attempt !== latestFailure.attempt
    || !latestStatus.errorMsg.includes(failureCode)) {
    return { eligible: false, requiredFailures: MIN_FAILED_ATTEMPTS, stageId, failureCode, attempts,
      reason: "该细分环节不是当前最新失败；运行中、已成功或已切换到其他失败时禁止补旧环节" };
  }
  return { eligible: true, requiredFailures: MIN_FAILED_ATTEMPTS, stageId, failureCode, attempts,
    reason: `同一细分环节已有 ${attempts.length} 次可核对失败，可申请一次受审计人工搭桥` };
}

async function existingReceipts(store: ArchiveStore): Promise<ManualBridgeRecord[]> {
  const root = assertInsideRoot(store.root, "manual-bridges");
  const output: ManualBridgeRecord[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const current = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(current);
      else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const bytes = await fs.readFile(current);
          const parsed = JSON.parse(bytes.toString("utf8")) as ManualBridgeRecord;
          if (parsed.schemaVersion === MANUAL_BRIDGE_SCHEMA_VERSION && typeof parsed.bridgeId === "string"
            && parsed.manualBridge && typeof parsed.manualBridge === "object") {
            output.push({ ...parsed, receiptSha256: digest(bytes) });
          }
        } catch { /* malformed files stay visible to filesystem tools, never become valid receipts */ }
      }
    }
  }
  await walk(root);
  return output.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listManualBridges(store: ArchiveStore): Promise<ManualBridgeRecord[]> {
  return existingReceipts(store);
}

export async function recordManualBridge(store: ArchiveStore, request: ManualBridgeRequest): Promise<ManualBridgeRecord> {
  if (request.schemaVersion !== MANUAL_BRIDGE_SCHEMA_VERSION) throw new ManualBridgeError("MANUAL_BRIDGE_SCHEMA_INVALID", "不支持的人工搭桥 schema");
  if (request.projectId !== store.projectId) throw new ManualBridgeError("MANUAL_BRIDGE_PROJECT_MISMATCH", "人工搭桥项目与档案不一致");
  const manifest = await store.readManifest();
  if (!manifest || manifest.projectId !== request.projectId) throw new ManualBridgeError("MANUAL_BRIDGE_ARCHIVE_INVALID", "制片档案 manifest 缺失或不属于当前项目");
  const stageId = safeSegment(request.stageId, "stageId");
  const subtaskKey = safeSegment(request.subtaskKey, "subtaskKey");
  const failureCode = text(request.failureCode, "failureCode", 3).slice(0, 160);
  const eligibility = await inspectManualBridgeEligibility(store, { stageId, failureCode });
  if (!eligibility.eligible) throw new ManualBridgeError("MANUAL_BRIDGE_NOT_ELIGIBLE", eligibility.reason);

  const reason = text(request.reason, "reason", 20);
  if (!Array.isArray(request.inputArtifacts) || request.inputArtifacts.length === 0) {
    throw new ManualBridgeError("MANUAL_BRIDGE_INPUT_REQUIRED", "人工搭桥必须绑定至少一份当前上游输入");
  }
  const inputArtifacts = await Promise.all(request.inputArtifacts.map((file, index) => inspectFile(store.root, file, `inputArtifacts[${index}]`)));
  const schema = await inspectFile(store.root, request.schema, "schema");
  const output = await inspectFile(store.root, request.output, "output");
  const validationEvidence = await inspectFile(store.root, request.validation.evidence, "validation.evidence");
  const handoffReceipt = await inspectFile(store.root, request.downstream?.handoffReceipt, "downstream.handoffReceipt");

  const validatorId = text(request.validation.validatorId, "validation.validatorId");
  const command = text(request.validation.command, "validation.command");
  const completedAt = text(request.validation.completedAt, "validation.completedAt");
  if (request.validation.passed !== true || request.validation.exitCode !== 0) {
    throw new ManualBridgeError("MANUAL_BRIDGE_VALIDATION_FAILED", "人工搭桥必须已通过原有 schema/交叉字段校验");
  }
  if (request.fidelity.usesOnlyUpstreamFacts !== true || request.fidelity.formatConforms !== true || request.fidelity.fabricatedFacts !== false) {
    throw new ManualBridgeError("MANUAL_BRIDGE_FIDELITY_FAILED", "人工搭桥未满足只使用上游事实、格式合规且无编造事实");
  }
  if (!["verified", "partially_verified", "unverified"].includes(request.fidelity.dataFidelityStatus)
    || !Array.isArray(request.fidelity.unresolvedFacts) || !Array.isArray(request.fidelity.deviations)
    || (request.fidelity.dataFidelityStatus === "verified" && request.fidelity.unresolvedFacts.length > 0)) {
    throw new ManualBridgeError("MANUAL_BRIDGE_FIDELITY_INVALID", "人工搭桥事实真实性声明无效");
  }
  for (const key of ["providerCalls", "paidProviderCalls", "publications", "irreversibleActions"] as const) {
    if (request.externalEffects?.[key] !== 0) throw new ManualBridgeError("MANUAL_BRIDGE_SIDE_EFFECT_FORBIDDEN", `人工搭桥不得产生 ${key}`);
  }

  const bridgeId = `MB-${digest(`${request.projectId}\0${stageId}\0${subtaskKey}\0${output.sha256}`).slice(0, 16)}`;
  let handoff: Record<string, unknown>;
  try { handoff = JSON.parse(await fs.readFile(assertInsideRoot(store.root, handoffReceipt.path), "utf8")) as Record<string, unknown>; }
  catch { throw new ManualBridgeError("MANUAL_BRIDGE_HANDOFF_INVALID", "下游交接回执不是有效 JSON"); }
  if (handoff.accepted !== true || handoff.bridgeId !== bridgeId || handoff.outputSha256 !== output.sha256) {
    throw new ManualBridgeError("MANUAL_BRIDGE_HANDOFF_INVALID", "下游尚未按当前 bridgeId 与输出摘要接受该产物");
  }

  const prior = (await existingReceipts(store)).filter(item => item.stageId === stageId && item.subtaskKey === subtaskKey);
  const same = prior.find(item => item.bridgeId === bridgeId && item.manualBridge.output.sha256 === output.sha256);
  if (same) return same;
  if (prior.length > 0) throw new ManualBridgeError("MANUAL_BRIDGE_CONFLICT", "同一细分环节已经存在另一份已接受的人工搭桥，拒绝重复兜底");

  const attempts: ManualBridgeFailureAttempt[] = [];
  for (const attempt of eligibility.attempts) {
    const evidencePath = `manual-bridges/evidence/${stageId}/attempt-${attempt.attempt}.json`;
    const evidence = {
      schemaVersion: "pengmanager.video-manual-bridge-failure/v1",
      projectId: request.projectId,
      stageId,
      subtaskKey,
      failureCode,
      ...attempt,
    };
    const written = await store.writeJsonAtomic(evidencePath, evidence);
    attempts.push({ attempt: attempt.attempt, subtaskKey, status: "failed", errorClass: attempt.errorClass,
      errorMsg: attempt.errorMsg, evidencePath, evidenceSha256: written.sha256 });
  }

  const createdAt = new Date().toISOString();
  const receiptPath = `manual-bridges/${stageId}/${subtaskKey}/${bridgeId}.json`;
  const recordWithoutHash: Omit<ManualBridgeRecord, "receiptSha256"> = {
    schemaVersion: MANUAL_BRIDGE_SCHEMA_VERSION,
    bridgeId,
    projectId: request.projectId,
    pipelineKind: manifest.pipelineKind,
    stageId,
    subtaskKey,
    failureCode,
    ...(request.idempotencyKey ? { idempotencyKey: text(request.idempotencyKey, "idempotencyKey", 8) } : {}),
    trigger: { failedAttempts: attempts.length, attempts },
    manualBridge: { actor: "Codex", reason, inputArtifacts, schema, output },
    validation: { passed: true, validatorId, command, exitCode: 0, completedAt, evidence: validationEvidence },
    fidelity: {
      usesOnlyUpstreamFacts: true,
      fabricatedFacts: false,
      formatConforms: true,
      dataFidelityStatus: request.fidelity.dataFidelityStatus,
      unresolvedFacts: request.fidelity.unresolvedFacts.map(String),
      deviations: request.fidelity.deviations.map(String),
    },
    externalEffects: { providerCalls: 0, paidProviderCalls: 0, publications: 0, irreversibleActions: 0 },
    downstream: { accepted: true, handoffReceipt },
    deliveryDisclosure: {
      requiredInFinalReport: true,
      stageLabel: text(request.deliveryDisclosure?.stageLabel, "deliveryDisclosure.stageLabel"),
      statement: text(request.deliveryDisclosure?.statement, "deliveryDisclosure.statement", 20),
    },
    createdAt,
    receiptPath,
  };
  const written = await store.writeJsonAtomic(receiptPath, recordWithoutHash);
  const record: ManualBridgeRecord = { ...recordWithoutHash, receiptSha256: written.sha256 };
  await store.appendJsonl("events.jsonl", {
    kind: "manual-bridge.recorded",
    bridgeId,
    projectId: request.projectId,
    stageId,
    subtaskKey,
    failureCode,
    failedAttempts: attempts.length,
    receiptPath,
    receiptSha256: written.sha256,
    outputPath: output.path,
    outputSha256: output.sha256,
    dataFidelityStatus: request.fidelity.dataFidelityStatus,
    fabricatedFacts: false,
  });
  await updateContextBundle(store, {
    decisions: [`人工搭桥 ${bridgeId}：${stageId}/${subtaskKey}，失败 ${attempts.length} 次，输出 ${output.sha256.slice(0, 12)}…；数据真实性=${request.fidelity.dataFidelityStatus}，无编造事实`],
    nextSteps: [`下游使用 ${output.path}；最终交付必须披露 ${record.deliveryDisclosure.statement}`],
  });
  return record;
}
