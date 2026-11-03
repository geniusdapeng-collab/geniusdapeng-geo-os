import { constants } from "node:fs";
import { link, mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { PoolClient } from "pg";
import { getAppPool, withWorkspace, type TenantScope } from "@workloom/db";
import { DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS, DEEPSEEK_INPUT_TOKEN_BASIS,
  DEEPSEEK_REQUEST_BODY_LIMIT_BYTES } from "@workloom/base/model-router";
import {
  assertCreativeContract, compileCreativeContract, creativeCanonical, creativeHash, CreativeContractError,
  extractProductVisualAuthority, modelFailureEvidence,
  type CompileCreativeInput, type CreativeContract, type CreativeFinding, type CreativeScope, type CreativeShot, type PrdMarketingAuthority,
} from "@hyperreality/video-studio";
import { artifactManifestHash, assertArtifactEnvelope } from "@workloom/pipeline-control";
import { archiveWorkDir } from "./archive-host.js";
import type { CreativeExternalRequest } from "./creative-external-budget.js";
import { createMarketingGateEvidenceGuard } from "./marketing-gate-evidence.js";
import { compileLegacyShadowPlan } from "./pipeline/shadow.js";

export const CREATIVE_PLAN = "workloom.video-creative/v1";
const SHA = /^[a-f0-9]{64}$/;
const MICRO = 1_000_000;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const modelOperation = "creative.model";
const trackedOperations = [modelOperation, "creative.search", "creative.media"];
const byteHash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const scopeValues = (scope: CreativeScope) => [scope.tenantId, scope.workspaceId, scope.projectId];
export const creativeError = (code: string, message: string): never => { throw new CreativeContractError(code, message); };

export function creativeTx<T>(scope: CreativeScope, action: (client: PoolClient) => Promise<T>): Promise<T> {
  return withWorkspace(getAppPool(), scope, (_, client) => action(client));
}
async function appendCreativeEvent(client: PoolClient, scope: CreativeScope, runId: string, kind: string, payload: Record<string, unknown>) {
  await client.query(
    `INSERT INTO video_pipeline_outbox (id,tenant_id,workspace_id,run_id,event_kind,payload) VALUES ($1,$2,$3,$4,$5,$6)`,
    [randomUUID(), scope.tenantId, scope.workspaceId, runId, kind, creativeCanonical(payload)],
  );
}

export async function lockCreativeProject(client: PoolClient, scope: CreativeScope) {
  const result = await client.query<{ kind: string }>(
    `SELECT p.kind FROM video_projects p JOIN workspaces w ON w.id=p.workspace_id
     WHERE w.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 FOR UPDATE OF p`, scopeValues(scope),
  );
  return result.rows[0] ?? creativeError("CREATIVE_PROJECT_NOT_FOUND", "项目不存在或不可访问");
}

export async function latestCreativeContract(client: PoolClient, scope: CreativeScope): Promise<CreativeContract | null> {
  const result = await client.query<{ contract: CreativeContract }>(
    `SELECT contract FROM video_creative_contracts
     WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY revision DESC LIMIT 1`, scopeValues(scope),
  );
  return result.rows[0]?.contract ?? null;
}

export async function persistCreativeContract(
  client: PoolClient, input: CompileCreativeInput, latest: CreativeContract | null, actor: string,
): Promise<CreativeContract> {
  const sameRevision = latest && compileCreativeContract({ ...input, revision: latest.revision });
  if (latest && sameRevision?.hash === latest.hash) return sameRevision;
  const contract = compileCreativeContract({ ...input, revision: (latest?.revision ?? 0) + 1 });
  await insertCreativeContract(client, contract, latest, actor);
  return contract;
}

async function insertCreativeContract(client: PoolClient, contract: CreativeContract, latest: CreativeContract | null, actor: string) {
  await client.query(
    `INSERT INTO video_creative_contracts
     (tenant_id,workspace_id,project_id,revision,contract_hash,raw_intent_hash,supersedes_hash,contract,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [...scopeValues(contract.scope), contract.revision, contract.hash, contract.rawIntentHash, latest?.hash ?? null, creativeCanonical(contract), actor],
  );
}

type Price = { inputCnyPerMillion: number; outputCnyPerMillion: number };
interface Budget { maxMicros: number; maxCalls: number; maxTokens: number; maxWallMs: number; price: Price }
function budgetFor(model: string): Budget {
  const prices = process.env.VM_CREATIVE_MODEL_PRICES;
  const maxMicros = Math.floor(Number(process.env.VM_CREATIVE_BUDGET_CNY) * MICRO);
  const maxCalls = Number(process.env.VM_CREATIVE_MAX_CALLS);
  const maxTokens = Number(process.env.VM_CREATIVE_MAX_TOKENS);
  const maxWallMs = Number(process.env.VM_CREATIVE_MAX_WALL_MS);
  let price: Price | undefined;
  try {
    const parsed = JSON.parse(prices ?? "{}");
    if (parsed && Object.hasOwn(parsed, model)) price = parsed[model];
  } catch {
    creativeError("CREATIVE_BUDGET_UNCONFIGURED", "模型定价必须是有效 JSON");
  }
  if (!price || ![price.inputCnyPerMillion, price.outputCnyPerMillion].every(value =>
    typeof value === "number" && Number.isFinite(value) && value > 0)
    || ![maxMicros, maxCalls, maxTokens, maxWallMs].every(value => Number.isSafeInteger(value) && value > 0)
    || maxWallMs > 2_147_483_647) {
    return creativeError("CREATIVE_BUDGET_UNCONFIGURED", "需配置可信模型定价、金额、请求、令牌与时间上限");
  }
  return { maxMicros, maxCalls, maxTokens, maxWallMs, price };
}
function costMicros(input: number, output: number, price: Price) {
  return Math.ceil(input * price.inputCnyPerMillion + output * price.outputCnyPerMillion);
}
async function budgetTotals(client: PoolClient, scope: CreativeScope) {
  const result = await client.query<{ pending: boolean; calls: string; micros: string; tokens: string }>(
    `SELECT coalesce(bool_or(state IN ('reserved','dispatched','unknown')),false) AS pending, count(*) AS calls,
       coalesce(sum((cost->>'micros')::bigint),0) AS micros, coalesce(sum((cost->>'tokens')::bigint),0) AS tokens
       FROM video_pipeline_operations WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND kind=ANY($4::text[])`,
    [...scopeValues(scope), trackedOperations],
  );
  return result.rows[0]!;
}

export async function creativeRepairUsage(client: PoolClient, scope: CreativeScope, input: {
  contractHash: string; sourceHash: string; shotId: string; signature?: string;
}) {
  const { rows: [row] } = await client.query<{ automatic: string; manual: string; repeated: boolean }>(
    `WITH automatic AS (
       SELECT count(*) AS attempts, coalesce(bool_or(metadata->>'signature'=$7),false) AS repeated
       FROM video_artifacts WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND role='creative-event'
         AND metadata->>'kind'='creative.repair.started' AND metadata->>'contractHash'=$4
         AND metadata->>'sourceHash'=$5 AND metadata->>'shotId'=$6
     ), manual AS (
       SELECT count(*) AS attempts FROM video_repair_attempts a
       JOIN video_repair_plans p ON p.id=a.repair_plan_id
       JOIN production_stage_runs s ON s.id=p.target_stage_run_id
       JOIN video_artifacts v ON v.id=s.output_artifact_id
       WHERE v.tenant_id=$1 AND v.workspace_id=$2 AND v.project_id=$3 AND v.role='creative-rejected-shot'
         AND v.metadata->>'contractHash'=$4 AND v.metadata->>'sourceHash'=$5 AND s.item_key=$6
     )
     SELECT automatic.attempts AS automatic,manual.attempts AS manual,automatic.repeated FROM automatic,manual`,
    [...scopeValues(scope), input.contractHash, input.sourceHash, input.shotId, input.signature ?? null],
  );
  return { automatic: Number(row!.automatic), manual: Number(row!.manual), repeated: row!.repeated };
}

export async function creativeRunBudgetReceipt(client: PoolClient, scope: CreativeScope, runId: string) {
  const { rows: [row] } = await client.query<{ calls: string; known_micros: string; held_micros: string; known_tokens: string }>(
    `SELECT count(*) AS calls,
       coalesce(sum((cost->>'micros')::bigint) FILTER (WHERE state IN ('accepted','failed')),0) AS known_micros,
       coalesce(sum((cost->>'micros')::bigint) FILTER (WHERE state IN ('reserved','dispatched','unknown')),0) AS held_micros,
       coalesce(sum((cost->>'tokens')::bigint) FILTER (WHERE state IN ('accepted','failed')),0) AS known_tokens
     FROM video_pipeline_operations WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND pipeline_run_id=$4
       AND kind=ANY($5::text[])`, [...scopeValues(scope), runId, trackedOperations],
  );
  return { calls: Number(row!.calls), knownCny: Number(row!.known_micros) / MICRO, knownTokens: Number(row!.known_tokens),
    heldCny: Number(row!.held_micros) / MICRO, usageUnknown: Number(row!.held_micros) > 0 };
}

/** Only call after acquiring the same cross-process project lease as the worker. */
export async function assertNoCreativePendingUsage(
  scope: CreativeScope, options: { rejectActiveEnforce?: boolean } = {},
): Promise<void> {
  const state = await creativeTx(scope, async client => {
    await lockCreativeProject(client, scope);
    const { rows } = await client.query<{ pipeline_run_id: string; stage_run_id: string }>(
      `SELECT pipeline_run_id,stage_run_id FROM video_pipeline_operations
       WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND kind=ANY($4::text[])
         AND state IN ('reserved','dispatched','unknown')`, [...scopeValues(scope), trackedOperations],
    );
    if (!rows.length) {
      if (!options.rejectActiveEnforce) return "clear";
      const active = await client.query(
        `SELECT 1 FROM video_pipeline_runs
         WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND plan_key=$4
           AND status IN ('queued','running','waiting','reconciling') LIMIT 1`,
        [...scopeValues(scope), CREATIVE_PLAN],
      );
      return active.rowCount ? "pinned" : "clear";
    }
    const stageIds = [...new Set(rows.map(row => row.stage_run_id))];
    const runIds = [...new Set(rows.map(row => row.pipeline_run_id))];
    await client.query(
      `UPDATE production_stage_runs SET execution_status='interrupted',verification_status='unverified',
        disposition='reconcile',error_class='CREATIVE_USAGE_UNKNOWN',finished_at=coalesce(finished_at,now())
       WHERE id=ANY($1::text[]) AND pipeline_run_id=ANY($2::text[]) AND disposition<>'reconcile'`, [stageIds, runIds],
    );
    const repaired = await client.query<{ id: string }>(
      `UPDATE video_pipeline_runs SET status='reconciling',next_action='reconcile',lease_owner=NULL,lease_expires_at=NULL,
         revision=revision+1,updated_at=now()
       WHERE id=ANY($1::text[]) AND status IN ('running','waiting','queued') RETURNING id`, [runIds],
    );
    for (const row of repaired.rows) await appendCreativeEvent(client, scope, row.id, "creative.run.reconcile", { reason: "unsettled-usage" });
    return "pending";
  });
  if (state === "pending") creativeError("CREATIVE_USAGE_UNKNOWN", "项目存在未对账付费请求");
  if (state === "pinned") creativeError("CREATIVE_EXECUTION_PINNED", "项目仍有活跃的强制创作运行，暂不能切回旧执行路径");
}

function externalMicros(kind: CreativeExternalRequest["kind"], provider: string) {
  let prices: unknown;
  try { prices = JSON.parse(process.env.VM_CREATIVE_EXTERNAL_PRICES ?? "{}"); }
  catch { return creativeError("CREATIVE_BUDGET_UNCONFIGURED", "外部固定费价格必须是有效 JSON"); }
  const byKind = prices && typeof prices === "object" && Object.hasOwn(prices, kind)
    ? (prices as Record<string, unknown>)[kind] : undefined;
  const cny = byKind && typeof byKind === "object" && Object.hasOwn(byKind, provider)
    ? (byKind as Record<string, unknown>)[provider] : undefined;
  if (typeof cny !== "number" || !Number.isFinite(cny) || cny <= 0 || !Number.isSafeInteger(Math.ceil(cny * MICRO))) {
    return creativeError("CREATIVE_BUDGET_UNCONFIGURED", "外部请求没有受信任的固定费");
  }
  return Math.ceil(cny * MICRO);
}

export interface CreativeArtifact {
  id: string; sha256: string; storage_ref: string; bytes: string | number; metadata: Record<string, unknown>;
}
function artifactDirectory(scope: CreativeScope) {
  if (![scope.workspaceId, scope.projectId].every(id => /^[a-zA-Z0-9._:-]+$/.test(id) && id !== "." && id !== "..")) {
    return creativeError("CREATIVE_ARTIFACT_PATH_INVALID", "创作档案作用域非法");
  }
  return path.resolve(archiveWorkDir(), "archive", scope.workspaceId, scope.projectId, "artifacts", "creative");
}
async function storeBytes(scope: CreativeScope, value: unknown) {
  const bytes = Buffer.from(creativeCanonical(value));
  if (bytes.length > MAX_ARTIFACT_BYTES) creativeError("CREATIVE_ARTIFACT_TOO_LARGE", "创作产物超过存储限制");
  const sha256 = byteHash(bytes), directory = artifactDirectory(scope);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== path.join(await realpath(archiveWorkDir()), path.relative(archiveWorkDir(), directory))) {
    creativeError("CREATIVE_ARTIFACT_PATH_INVALID", "创作存储目录已重定向");
  }
  const storage_ref = `artifacts/creative/${sha256}.json`;
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o600, flush: true });
  try {
    await link(temporary, path.join(directory, `${sha256}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporary);
  }
  await readCreativeArtifact(scope, { sha256, storage_ref, bytes: bytes.length });
  return { sha256, storage_ref, bytes: bytes.length };
}
export async function readCreativeArtifact(scope: CreativeScope, artifact: Pick<CreativeArtifact, "sha256" | "storage_ref" | "bytes">): Promise<unknown> {
  if (!SHA.test(artifact.sha256) || artifact.storage_ref !== `artifacts/creative/${artifact.sha256}.json`) {
    creativeError("CREATIVE_ARTIFACT_REF_INVALID", "创作产物引用无效");
  }
  const directory = artifactDirectory(scope);
  if (await realpath(directory) !== path.join(await realpath(archiveWorkDir()), path.relative(archiveWorkDir(), directory))) {
    creativeError("CREATIVE_ARTIFACT_PATH_INVALID", "创作存储目录已重定向");
  }
  const file = await open(path.join(directory, `${artifact.sha256}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES || stat.size !== Number(artifact.bytes)) {
      creativeError("CREATIVE_ARTIFACT_CHANGED", "创作产物类型或字节数已改变");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size || byteHash(bytes.subarray(0, offset)) !== artifact.sha256) {
      creativeError("CREATIVE_ARTIFACT_CHANGED", "创作产物字节哈希已改变");
    }
    return JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

export async function insertCreativeArtifact(client: PoolClient, input: {
  scope: CreativeScope; runId: string; stageId: string; role: string; logicalId: string;
  revision: number; model: string; creatorId?: string; metadata: Record<string, unknown>; output: unknown;
}) {
  const record = { id: randomUUID(), ...await storeBytes(input.scope, input.output), metadata: input.metadata };
  const envelope = assertArtifactEnvelope({
    schemaVersion: "workloom.video-artifact/v1", id: record.id, logicalId: input.logicalId, role: input.role,
    revision: input.revision, schema: CREATIVE_PLAN, storageRef: record.storage_ref, sha256: record.sha256,
    bytes: record.bytes, mediaType: "application/json", metadata: record.metadata, parents: [],
    creator: { kind: input.model === "customer-patch" ? "human" : input.role === "creative-candidate" ? "model" : "deterministic",
      id: input.creatorId ?? input.model, version: CREATIVE_PLAN },
  });
  await client.query(
    `INSERT INTO video_artifacts
     (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,logical_id,revision,role,schema_version,
      storage_ref,sha256,bytes,media_type,creator,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'application/json',$14,$15)`,
    [record.id, ...scopeValues(input.scope), input.runId, input.stageId, input.logicalId, input.revision,
      input.role, CREATIVE_PLAN, record.storage_ref, record.sha256, record.bytes,
      creativeCanonical(envelope.creator), creativeCanonical(record.metadata)],
  );
  return { ...record, manifestHash: artifactManifestHash([envelope]) };
}

export async function linkCreativeArtifacts(client: PoolClient, scope: CreativeScope, runId: string,
  parent: Pick<CreativeArtifact, "id" | "sha256">, child: CreativeArtifact, role: string) {
  await client.query(
    `INSERT INTO video_artifact_edges
      (tenant_id,workspace_id,pipeline_run_id,parent_artifact_id,parent_sha256,child_artifact_id,child_sha256,input_role)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    [scope.tenantId, scope.workspaceId, runId, parent.id, parent.sha256, child.id, child.sha256, role],
  );
}

export interface CreativeStage { id: string; key: string; revision: number }
export async function insertCreativeStage(client: PoolClient, input: {
  scope: CreativeScope; runId: string; planHash: string; contract: CreativeContract; key: string;
  revision?: number; itemId?: string; parentStageId?: string; inputHash?: string;
}): Promise<CreativeStage> {
  const stage = { id: randomUUID(), key: input.key, revision: input.revision ?? 1 };
  await client.query(
    `INSERT INTO production_stage_runs
     (id,workspace_id,project_id,stage_id,attempt,run_id,pipeline_run_id,stage_key,item_key,revision,contract_version,
      plan_hash,contract_hash,input_manifest_hash,execution_status,verification_status,disposition,
      last_heartbeat_at,worker_version,repair_of_stage_run_id)
     SELECT $1,$2,$3,$4,coalesce(max(attempt),0)+1,$5,$5,$4,$6,$7,$8,$9,$10,$11,'running','pending','continue',now(),$12,$13
     FROM production_stage_runs WHERE workspace_id=$2 AND project_id=$3 AND stage_id=$4`,
    [stage.id, input.scope.workspaceId, input.scope.projectId, stage.key, input.runId, input.itemId ?? null,
      stage.revision, input.contract.schemaVersion, input.planHash, input.contract.hash, input.inputHash ?? input.contract.hash,
      CREATIVE_PLAN, input.parentStageId ?? null],
  );
  return stage;
}

async function setStageOutput(client: PoolClient, stage: CreativeStage, artifact: CreativeArtifact & { manifestHash: string }) {
  const result = await client.query(
    `UPDATE production_stage_runs SET execution_status='completed',verification_status='passed',disposition='done',
       output_manifest_hash=$5,output_sha256=$2,output_artifact_id=$3,output_ref=$4,finished_at=now()
     WHERE id=$1 AND execution_status='running'`,
    [stage.id, artifact.sha256, artifact.id, artifact.storage_ref, artifact.manifestHash],
  );
  if (result.rowCount !== 1) creativeError("CREATIVE_STAGE_CONFLICT", "创作阶段版本已变化");
}

interface SessionInput {
  scope: TenantScope; projectId: string; runId: string; rawIntent: string; metadata?: Record<string, unknown>;
  isMarketing: boolean; mode: "shadow" | "enforce"; model: string; actorId?: string;
  shouldAbort?: () => boolean; expectedContract?: CreativeContract;
  onStart?: (client: PoolClient) => Promise<void>;
}
interface ModelRequest {
  requestHash: string; inputChars: number; imageInputTokens?: number; maxOutputTokens: number; model: string; attempt: number;
  requestBytes: number; inputTokenEstimate: number; inputTokenUpperBound: number; inputTokenBasis: string;
}
interface ModelOutcome {
  usageKnown: boolean; success: boolean; inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number;
  finishReason?: string; providerRequestId?: string; responseHash?: string;
  failureClass?: string; httpStatus?: number;
}
export async function createCreativeExecutionSession(input: SessionInput) {
  const scope: CreativeScope = { ...input.scope, projectId: input.projectId };
  const { runId, model } = input;
  const actor = input.actorId ?? "system:video-creative", enforced = input.mode === "enforce";
  const started = performance.now(), budget = enforced ? budgetFor(model) : null;
  const planHash = creativeHash({ version: CREATIVE_PLAN, mode: input.mode, model });
  const seed = { scope, rawIntent: input.rawIntent, metadata: input.metadata, isMarketing: input.isMarketing };
  let contract = input.expectedContract ?? compileCreativeContract(seed);
  let closed = false, boundG1 = false, stage: CreativeStage | undefined, previous: CreativeArtifact | undefined;
  let receiptSequence = 0;
  const shouldAbort = () => closed || Boolean(input.shouldAbort?.()) || Boolean(budget && performance.now() - started >= budget.maxWallMs);

  if (enforced) {
    await assertNoCreativePendingUsage(scope);
    contract = await creativeTx(scope, async client => {
      const project = await lockCreativeProject(client, scope);
      if (project.kind !== (input.isMarketing ? "marketing" : "narrative")) {
        creativeError("CREATIVE_ROUTE_CONFLICT", "执行路线与项目不一致");
      }
      if ((await budgetTotals(client, scope)).pending) creativeError("CREATIVE_USAGE_UNKNOWN", "项目存在未对账付费请求");
      const { rows: [active] } = await client.query<{
        id: string; status: string; created_by: string; plan_key: string; plan_hash: string;
      }>(
        `SELECT id,status,created_by,plan_key,plan_hash FROM video_pipeline_runs
         WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND status IN ('queued','running','waiting','reconciling') FOR UPDATE`,
        scopeValues(scope),
      );
      if (active && active.plan_key !== CREATIVE_PLAN) {
        const shadow = compileLegacyShadowPlan();
        if (active.created_by !== "video-studio-shadow" || active.plan_key !== shadow.key || active.plan_hash !== shadow.planHash
          || !["running", "waiting"].includes(active.status)) {
          return creativeError("CREATIVE_EXECUTOR_BUSY", "项目已有活动执行或待对账运行");
        }
        const effects = await client.query(
          "SELECT 1 FROM video_pipeline_operations WHERE pipeline_run_id=$1 LIMIT 1", [active.id],
        );
        if (effects.rowCount) return creativeError("CREATIVE_EXECUTOR_BUSY", "旧观察运行存在外部动作");
        await client.query(
          `UPDATE production_stage_runs SET execution_status='interrupted',verification_status='unverified',disposition='blocked',
             finished_at=now() WHERE pipeline_run_id=$1 AND execution_status IN ('pending','ready','running')`, [active.id],
        );
        await client.query(
          `UPDATE video_pipeline_runs SET status='cancelled',next_action='done',current_frontier='[]',lease_owner=NULL,
             lease_expires_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1`, [active.id],
        );
        await appendCreativeEvent(client, scope, active.id, "creative.shadow.retired", { replacementRunId: runId });
      } else if (active && active.status !== "running") {
        return creativeError("CREATIVE_EXECUTOR_BUSY", "项目已有活动执行或待对账运行");
      }
      const current = await latestCreativeContract(client, scope);
      if (input.expectedContract && current?.hash !== input.expectedContract.hash) creativeError("CREATIVE_CONTRACT_STALE", "候选使用的创作合同已变化");
      const currentSource = current?.rawIntentHash === contract.rawIntentHash && current.sourceMetadataHash === contract.sourceMetadataHash
        && current.route === contract.route && current.feasibility.status !== "blocked"
        && (!current.facts?.validUntil || Date.parse(current.facts.validUntil) > Date.now());
      // Reuse the identity while preparing. The worker privately rebinds the actual current G1 before downstream execution.
      const selected = input.expectedContract ?? (currentSource ? current : await persistCreativeContract(client, seed, current, actor));
      assertCreativeContract(selected, { allowNeedsInput: true });
      // A previous process can leave a running record after losing its project lease.
      // The caller holds the same cross-process lease before entering this session.
      await client.query(
        `UPDATE production_stage_runs SET execution_status='interrupted',verification_status='unverified',
           disposition='blocked',finished_at=now()
         WHERE workspace_id=$2 AND project_id=$3 AND execution_status='running'
           AND pipeline_run_id IN (SELECT id FROM video_pipeline_runs WHERE tenant_id=$1 AND workspace_id=$2
             AND project_id=$3 AND plan_key=$4 AND status='running')`, [...scopeValues(scope), CREATIVE_PLAN],
      );
      await client.query(
        `UPDATE video_pipeline_runs SET status='failed',next_action='manual_fix',revision=revision+1,updated_at=now()
         WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND plan_key=$4 AND status='running'`,
        [...scopeValues(scope), CREATIVE_PLAN],
      );
      await client.query(
        `INSERT INTO video_pipeline_runs
          (id,tenant_id,workspace_id,project_id,pipeline_kind,intent_contract_id,intent_hash,
           plan_key,plan_version,plan_hash,status,created_by,lease_owner,lease_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,'running',$10,$11,now()+($12::integer * interval '1 millisecond'))`,
        [runId, ...scopeValues(scope), selected.route, `legacy:${runId}`, selected.rawIntentHash, CREATIVE_PLAN, planHash, actor, runId, budget!.maxWallMs],
      );
      await bindRunContract(client, selected);
      await appendCreativeEvent(client, scope, runId, "creative.run.started", { contractHash: selected.hash });
      await input.onStart?.(client);
      return selected;
    });
  }

  async function bindRunContract(client: PoolClient, selected: CreativeContract) {
    await client.query(
      `INSERT INTO video_creative_run_contracts (tenant_id,workspace_id,project_id,run_id,contract_hash)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [...scopeValues(scope), runId, selected.hash],
    );
  }
  async function current(client: PoolClient, checkBudget = true) {
    if (shouldAbort()) creativeError("CREATIVE_CANCELLED", "创作执行结束、取消或达到墙钟上限");
    assertCreativeContract(contract, { allowNeedsInput: true });
    const result = await client.query<{ status: string }>(
      `SELECT status FROM video_pipeline_runs WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND id=$4`,
      [...scopeValues(scope), runId],
    );
    if (result.rows[0]?.status !== "running" || (await latestCreativeContract(client, scope))?.hash !== contract.hash) {
      creativeError("CREATIVE_CONTRACT_STALE", "执行状态或创作合同已变化");
    }
    if (checkBudget && (await budgetTotals(client, scope)).pending) creativeError("CREATIVE_USAGE_UNKNOWN", "项目存在未对账付费请求");
  }
  async function assertCurrent() {
    if (!enforced) return;
    await creativeTx(scope, client => current(client));
    if (boundG1) await verifyCreativeMarketingSource(contract);
  }
  async function bindContract(next: CreativeContract, g1?: PrdMarketingAuthority, purpose: G1Purpose = "preproduction") {
    assertCreativeContract(next);
    if (creativeHash(next.scope) !== creativeHash(scope) || next.rawIntent !== input.rawIntent
      || next.sourceMetadataHash !== contract.sourceMetadataHash || next.route !== contract.route) {
      creativeError("CREATIVE_CONTRACT_SCOPE_CONFLICT", "合同来源与当前执行不一致");
    }
    if (!enforced) { contract = next; return contract; }
    if (next.route === "marketing") verifyBoundG1(next, runId, purpose, g1);
    contract = await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client);
      const latest = await latestCreativeContract(client, scope);
      const { hash: _hash, revision: _revision, ...body } = next;
      const candidate = { ...body, revision: latest!.revision };
      let bound = latest!;
      if (creativeHash(candidate) !== bound.hash) {
        const revision = { ...candidate, revision: latest!.revision + 1 };
        bound = { ...revision, hash: creativeHash(revision) };
        await insertCreativeContract(client, bound, latest, actor);
        await bindRunContract(client, bound);
      }
      if (g1 && next.route === "marketing") await client.query(
        `INSERT INTO video_creative_g1_evidence
           (tenant_id,workspace_id,project_id,run_id,contract_hash,attempt,purpose,sha256,proof)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [...scopeValues(scope), runId, bound.hash, g1.scope.attempt, purpose, g1.g1Artifact.sha256, creativeCanonical(g1.g1Proof)],
      );
      return bound;
    });
    boundG1 = Boolean(g1);
    return contract;
  }

  async function beginStage(key: string) {
    if (!enforced) return;
    if (stage || !/^[a-zA-Z0-9.:-]{1,100}$/.test(key)) creativeError("CREATIVE_STAGE_CONFLICT", "已有活动阶段或阶段名称无效");
    stage = await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client);
      const active = await insertCreativeStage(client, {
        scope, runId, planHash, contract, key: `creative:${key}`, inputHash: previous?.sha256,
      });
      await client.query("UPDATE video_pipeline_runs SET current_frontier=$2,revision=revision+1,updated_at=now() WHERE id=$1",
        [runId, JSON.stringify([active.key])]);
      await appendCreativeEvent(client, scope, runId, "creative.stage.started", { stageRunId: active.id, key });
      return active;
    });
  }
  async function completeStage(key: string, output: unknown, onPersist?: (client: PoolClient) => Promise<void>) {
    if (!enforced) return;
    const active = stage;
    if (!active || active.key !== `creative:${key}`) return creativeError("CREATIVE_STAGE_CONFLICT", "结束阶段与活动阶段不一致");
    previous = await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client);
      const artifact = await insertCreativeArtifact(client, { scope, runId, stageId: active.id, role: "creative-stage",
        logicalId: active.key, revision: active.revision, model, metadata: { contractHash: contract.hash }, output });
      if (previous) await linkCreativeArtifacts(client, scope, runId, previous, artifact, "previous-stage");
      const outputs = await client.query<{ id: string; sha256: string }>(
        `SELECT id,sha256 FROM video_artifacts WHERE pipeline_run_id=$2 AND role='creative-cache'
         AND (stage_run_id=$1 OR metadata->>'consumerStageId'=$1)`, [active.id, runId],
      );
      for (const parent of outputs.rows) await linkCreativeArtifacts(client, scope, runId, parent, artifact, "accepted-cache-output");
      await onPersist?.(client);
      await setStageOutput(client, active, artifact);
      await appendCreativeEvent(client, scope, runId, "creative.stage.completed", { stageRunId: active.id, key, artifactId: artifact.id });
      return artifact;
    });
    stage = undefined;
  }

  async function beforeModelCall(request: ModelRequest): Promise<string> {
    const imageInputTokens = request.imageInputTokens === undefined ? 0 : request.imageInputTokens;
    const inputLimit = request.inputTokenUpperBound, outputLimit = request.maxOutputTokens;
    if (!budget || request.model !== model || !SHA.test(request.requestHash)
      || request.inputTokenBasis !== DEEPSEEK_INPUT_TOKEN_BASIS || request.requestBytes > DEEPSEEK_REQUEST_BODY_LIMIT_BYTES
      || request.requestBytes !== request.inputChars
      || !Number.isSafeInteger(imageInputTokens) || imageInputTokens < 0
      || ![request.requestBytes, request.inputTokenEstimate, inputLimit, outputLimit, request.attempt].every(n => Number.isSafeInteger(n) && n > 0)
      || inputLimit < request.inputTokenEstimate || request.inputTokenEstimate < imageInputTokens || outputLimit > DEEPSEEK_FLASH_MAX_OUTPUT_TOKENS
      || inputLimit + outputLimit > DEEPSEEK_FLASH_CONTEXT_TOKENS) {
      return creativeError("CREATIVE_BUDGET_REQUEST_INVALID", "模型请求缺少可信价格、活动阶段或请求边界");
    }
    // Wire bytes and model tokens are separate. The transport plan already includes the vision allowance.
    const tokens = inputLimit + outputLimit, micros = costMicros(inputLimit, outputLimit, budget.price);
    return reserve(modelOperation, request.attempt, request.requestHash,
      { ...request, imageInputTokens, inputLimit, outputLimit, price: budget.price }, micros, tokens);
  }

  async function beforeExternalCall(request: CreativeExternalRequest & { attempt: number }) {
    if (!budget || !["search", "media"].includes(request.kind) || !/^[a-zA-Z0-9._:-]{1,150}$/.test(request.provider)
      || !SHA.test(request.requestHash) || !Number.isSafeInteger(request.attempt) || request.attempt < 1) {
      return creativeError("CREATIVE_BUDGET_REQUEST_INVALID", "外部请求缺少可信价格、活动阶段或请求边界");
    }
    const micros = externalMicros(request.kind, request.provider);
    return reserve(`creative.${request.kind}`, request.attempt, request.requestHash,
      { ...request, feeBasis: "trusted-fixed-request-price" }, micros, 0);
  }

  async function reserve(kind: string, attempt: number, requestHash: string, request: Record<string, unknown>, micros: number, tokens: number): Promise<string> {
    const active = stage;
    if (!budget || !active) return creativeError("CREATIVE_BUDGET_REQUEST_INVALID", "付费请求缺少活动创作阶段");
    return creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client, false);
      const totals = await budgetTotals(client, scope);
      if (totals.pending) creativeError("CREATIVE_USAGE_UNKNOWN", "项目存在未对账付费请求");
      if (!Number.isSafeInteger(micros) || !Number.isSafeInteger(tokens) || Number(totals.calls) >= budget.maxCalls
        || Number(totals.tokens) + tokens > budget.maxTokens || Number(totals.micros) + micros > budget.maxMicros) {
        creativeError("CREATIVE_BUDGET_EXHAUSTED", "本请求最坏消耗超出项目剩余限额");
      }
      const id = randomUUID();
      const inserted = await client.query(
        `INSERT INTO video_pipeline_operations (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,
           operation_key,kind,idempotency_key,request_hash,request,cost,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [id, ...scopeValues(scope), runId, active.id, `${kind}:${attempt}`, kind,
          creativeHash({ scope, runId, kind, attempt, hash: requestHash }), requestHash, creativeCanonical(request),
          creativeCanonical({ micros, tokens, reserved: true }), actor],
      );
      if (inserted.rowCount !== 1) creativeError("CREATIVE_MODEL_DUPLICATE", "本次付费请求已预留或派发");
      await client.query("UPDATE video_pipeline_operations SET state='dispatched',dispatched_at=now() WHERE id=$1", [id]);
      return id;
    });
  }
  async function afterExternalCall(reservation: string, known: boolean) {
    await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      const changed = await client.query(
        `UPDATE video_pipeline_operations SET state=$6,receipt=$7,finished_at=now(),
          cost=cost || jsonb_build_object('reserved',$8::boolean)
         WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND pipeline_run_id=$4 AND id=$5 AND state='dispatched'
           AND kind IN ('creative.search','creative.media')`,
        [...scopeValues(scope), runId, reservation, known ? "accepted" : "unknown", creativeCanonical({
          usageKnown: known, ...(known ? { feeBasis: "trusted-fixed-request-price" } : {}),
        }), !known],
      );
      if (changed.rowCount !== 1) creativeError("CREATIVE_BUDGET_RECEIPT_CONFLICT", "外部请求回执已终结或不存在");
    });
  }
  async function afterModelCall(reservation: unknown, outcome: ModelOutcome): Promise<void> {
    if (!budget || typeof reservation !== "string") return creativeError("CREATIVE_BUDGET_RECEIPT_INVALID", "缺少模型请求预留记录");
    const known = await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      const { rows } = await client.query<{ request: { inputLimit: number; outputLimit: number }; state: string; cost: unknown }>(
        `SELECT request,state,cost FROM video_pipeline_operations
         WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND pipeline_run_id=$4 AND id=$5 AND kind=$6 FOR UPDATE`,
        [...scopeValues(scope), runId, reservation, modelOperation],
      );
      const operation = rows[0];
      if (!operation || operation.state !== "dispatched") return creativeError("CREATIVE_BUDGET_RECEIPT_CONFLICT", "模型请求回执已终结或不存在");
      const inputTokens = outcome.inputTokens ?? -1, outputTokens = outcome.outputTokens ?? -1;
      const totalTokens = outcome.totalTokens, reasoningTokens = outcome.reasoningTokens;
      const coherent = outcome.usageKnown && Number.isSafeInteger(inputTokens) && Number.isSafeInteger(outputTokens)
        && inputTokens >= 0 && outputTokens >= 0 && Number.isSafeInteger(inputTokens + outputTokens)
        && (totalTokens === undefined || (Number.isSafeInteger(totalTokens) && totalTokens === inputTokens + outputTokens))
        && (reasoningTokens === undefined || (Number.isSafeInteger(reasoningTokens) && reasoningTokens >= 0 && reasoningTokens <= outputTokens));
      const valid = coherent && inputTokens <= operation.request.inputLimit && outputTokens <= operation.request.outputLimit;
      const usage = { inputTokens, outputTokens, ...(totalTokens !== undefined ? { totalTokens } : {}),
        ...(reasoningTokens !== undefined ? { reasoningTokens } : {}) };
      const wireEvidence = {
        ...(outcome.finishReason === "stop" || outcome.finishReason === "length" ? { finishReason: outcome.finishReason } : {}),
        ...(outcome.providerRequestId && /^[a-zA-Z0-9._:-]{1,200}$/.test(outcome.providerRequestId) ? { providerRequestId: outcome.providerRequestId } : {}),
        ...(outcome.responseHash && SHA.test(outcome.responseHash) ? { responseHash: outcome.responseHash } : {}),
      };
      const unknownReceipt = outcome.usageKnown
        ? (coherent ? { reportedUsage: usage, ...wireEvidence } : {})
        : modelFailureEvidence(outcome);
      await client.query(
        `UPDATE video_pipeline_operations SET state=$2,receipt=$3,cost=$4,finished_at=now() WHERE id=$1`,
        [reservation, valid ? (outcome.success ? "accepted" : "failed") : "unknown",
          creativeCanonical(valid ? { usageKnown: true, success: outcome.success, ...usage, ...wireEvidence }
            : { usageKnown: false, ...unknownReceipt }),
          creativeCanonical(valid ? { micros: costMicros(inputTokens, outputTokens, budget.price), tokens: inputTokens + outputTokens, reserved: false } : operation.cost)],
      );
      return valid;
    });
    if (!known && outcome.usageKnown) creativeError("CREATIVE_USAGE_UNKNOWN", "用量越过可信预留边界，项目冻结");
  }

  async function readCache(key: string): Promise<unknown | null> {
    if (!enforced) return null;
    if (!SHA.test(key)) creativeError("CREATIVE_CACHE_KEY_INVALID", "缓存依赖标识无效");
    const artifact = await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client);
      const result = await client.query<CreativeArtifact>(
        `SELECT a.id,a.sha256,a.storage_ref,a.bytes,a.metadata FROM video_artifacts a
           JOIN production_stage_runs s ON s.id=a.stage_run_id
         WHERE a.tenant_id=$1 AND a.workspace_id=$2 AND a.project_id=$3 AND a.role='creative-cache'
           AND a.metadata->>'cacheKey'=$4 AND a.metadata->>'contractHash'=$5 AND a.metadata->>'model'=$6
           AND s.verification_status='passed' ORDER BY a.created_at DESC LIMIT 1`,
        [...scopeValues(scope), key, contract.hash, model],
      );
      return result.rows[0];
    });
    if (!artifact) return null;
    const output = await readCreativeArtifact(scope, artifact);
    await assertCurrent();
    return output;
  }
  async function writeCache(key: string, output: unknown) {
    if (!enforced) return;
    const active = stage;
    const envelope = output as Record<string, unknown> | null;
    if (!active || !SHA.test(key) || envelope?.key !== key || envelope.contractHash !== contract.hash
      || creativeHash(envelope.output) !== envelope.outputHash) {
      return creativeError("CREATIVE_CACHE_KEY_INVALID", "缓存产物与执行依赖不一致");
    }
    await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client);
      const payload = envelope.output as { _workloomCreativeShot?: CreativeShot } | null;
      const shot = payload?._workloomCreativeShot;
      if (shot && (shot.contractHash !== contract.hash || !SHA.test(shot.sourceHash))) {
        creativeError("CREATIVE_CACHE_KEY_INVALID", "缓存镜头缺少当前合同和来源摘要");
      }
      // A verified shot stays reusable if a later shot causes the enclosing
      // Phase 3 attempt to fail. Its phase output still depends on this artifact.
      const verified = shot ? await insertCreativeStage(client, {
        scope, runId, planHash, contract, key: "creative:shot-cache", itemId: shot.id, revision: shot.revision,
        inputHash: shot.sourceHash,
      }) : active;
      const artifact = await insertCreativeArtifact(client, { scope, runId, stageId: verified.id, role: "creative-cache",
        logicalId: `cache:${key}`, revision: 1, model,
        metadata: { cacheKey: key, contractHash: contract.hash, model, consumerStageId: active.id,
          ...(shot ? { shotId: shot.id, sourceHash: shot.sourceHash } : {}) }, output });
      if (previous) await linkCreativeArtifacts(client, scope, runId, previous, artifact, "upstream");
      if (shot) await setStageOutput(client, verified, artifact);
    });
  }
  async function onEvent(event: { kind: string; payload: Record<string, unknown> }) {
    if (!enforced || !stage) return;
    const active = stage;
    await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await current(client);
      if (event.kind === "creative.repair.started") {
        const { shotId, sourceHash, signature } = event.payload;
        if (typeof shotId !== "string" || typeof sourceHash !== "string" || !SHA.test(sourceHash)
          || typeof signature !== "string" || !SHA.test(signature)) {
          creativeError("CREATIVE_REPAIR_EVIDENCE_INVALID", "修复请求缺少不可变镜头来源和问题签名");
        }
        const usage = await creativeRepairUsage(client, scope, { contractHash: contract.hash,
          shotId: String(shotId), sourceHash: String(sourceHash), signature: String(signature) });
        if (usage.automatic + usage.manual >= 2) creativeError("CREATIVE_REPAIR_LIMIT", "镜头已用完两次同合同来源修复");
        if (usage.repeated) creativeError("REPAIR_NO_PROGRESS", "重启后同一镜头问题签名没有进展");
      }
      if (event.kind === "creative.shot.accepted") {
        await client.query(
          `UPDATE production_stage_runs SET verification_status='stale',disposition='blocked'
           WHERE pipeline_run_id=$1 AND stage_key='creative:shot' AND item_key=$2 AND verification_status='rejected'`,
          [runId, event.payload.shotId],
        );
      }
      if (event.kind === "creative.shot.rejected") {
        const shot = event.payload.shot as CreativeShot;
        const findings = event.payload.findings as CreativeFinding[];
        if (shot.contractHash !== contract.hash || !Array.isArray(findings) || !findings.some(f => f.blocking)) {
          creativeError("CREATIVE_REPAIR_EVIDENCE_INVALID", "局部拒绝缺少当前合同或硬检查");
        }
        const stage = await insertCreativeStage(client, {
          scope, runId, planHash, contract, key: "creative:shot", itemId: shot.id, revision: shot.revision,
          inputHash: shot.sourceHash,
        });
        const artifact = await insertCreativeArtifact(client, { scope, runId, stageId: stage.id, role: "creative-rejected-shot",
          logicalId: `shot:${shot.id}`, revision: shot.revision, model,
          metadata: { contractHash: contract.hash, sourceHash: shot.sourceHash, attempt: event.payload.attempt }, output: event.payload });
        if (previous) await linkCreativeArtifacts(client, scope, runId, previous, artifact, "shot-source");
        const decisionId = randomUUID();
        await client.query(
          `INSERT INTO video_gate_decisions
            (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,gate_id,artifact_manifest_hash,
             plan_hash,check_set_version,rubric_version,status,reviewer,evidence_refs)
           VALUES ($1,$2,$3,$4,$5,$6,'creative.local',$7,$8,$9,$9,'rejected',$10,$11)`,
          [decisionId, ...scopeValues(scope), runId, stage.id, artifact.manifestHash, planHash, CREATIVE_PLAN,
            creativeCanonical({ type: "deterministic", component: CREATIVE_PLAN }), creativeCanonical([artifact.id])],
        );
        for (const finding of findings) {
          await client.query(
            `INSERT INTO video_gate_findings
              (id,tenant_id,workspace_id,decision_id,code,severity,target_type,target_id,field_path,
               expected_value,actual_value,evidence_refs,repair_class,blocking)
             VALUES ($1,$2,$3,$4,$5,$6,'field',$7,$8,$9,$10,$11,$12,$13)`,
            [randomUUID(), scope.tenantId, scope.workspaceId, decisionId, finding.code, finding.blocking ? "P0" : "advisory",
              finding.targetId, finding.fieldPath, creativeCanonical({ value: finding.expected, allowedChanges: finding.allowedChanges }),
              creativeCanonical(finding.actual), creativeCanonical(finding.evidence), finding.allowedChanges.length ? "schema" : "no_repair",
              finding.blocking],
          );
        }
        await client.query(
          `UPDATE production_stage_runs SET execution_status='completed',verification_status='rejected',
             disposition='repair',output_manifest_hash=$6,output_sha256=$2,output_artifact_id=$3,output_ref=$4,gate_decision_id=$5,finished_at=now()
           WHERE id=$1`, [stage.id, artifact.sha256, artifact.id, artifact.storage_ref, decisionId, artifact.manifestHash],
        );
        return;
      }
      await insertCreativeArtifact(client, { scope, runId, stageId: active.id, role: "creative-event",
        logicalId: `event:${++receiptSequence}`, revision: 1, model, metadata: { contractHash: contract.hash, kind: event.kind, shotId: event.payload.shotId ?? null,
          sourceHash: event.payload.sourceHash ?? null, signature: event.payload.signature ?? null },
        output: event.payload });
    });
  }
  async function finish(result: {
    success: boolean; error?: unknown;
    finalize?: (client: PoolClient, success: boolean) => Promise<void>;
  }) {
    if (!enforced || closed) return;
    const succeeded = await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      const pending = (await budgetTotals(client, scope)).pending;
      if (stage) await client.query(
        `UPDATE production_stage_runs SET execution_status=$2,verification_status='unverified',disposition=$3,
           error_class=$4,finished_at=now() WHERE id=$1 AND execution_status='running'`,
        [stage.id, pending ? "interrupted" : "failed", pending ? "reconcile" : "blocked",
          result.error instanceof CreativeContractError ? result.error.code : "CREATIVE_STAGE_INCOMPLETE"],
      );
      const success = result.success && !stage && !pending && !shouldAbort();
      if (success) await current(client);
      await result.finalize?.(client, success);
      await client.query(
        `UPDATE video_pipeline_runs SET status=$2,next_action=$3,current_frontier='[]',lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
         WHERE id=$1 AND status='running'`, [runId, pending ? "reconciling" : success ? "completed" : "failed",
          pending ? "reconcile" : success ? "done" : "manual_fix"],
      );
      await appendCreativeEvent(client, scope, runId, "creative.run.finished", { success, pending });
      return success;
    });
    closed = true;
    if (result.success && !succeeded) creativeError("CREATIVE_EXECUTION_NOT_CURRENT", "创作运行未达到可提交终态");
  }

  return { get activeStage() { return stage; }, get contract() { return contract; }, planHash, assertCurrent, bindContract, beginStage, completeStage,
    beforeModelCall, afterModelCall, beforeExternalCall, afterExternalCall, shouldAbort, readCache, writeCache, onEvent, finish };
}

async function readSourceBytes(root: string, relative: string, hash: string): Promise<Buffer> {
  const file = path.resolve(root, relative);
  if (!SHA.test(hash) || !file.startsWith(`${root}${path.sep}`) || await realpath(file) !== file) {
    return creativeError("CREATIVE_SOURCE_CHANGED", "当前事实证据路径或摘要失效");
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return creativeError("CREATIVE_SOURCE_CHANGED", "当前事实证据不可读");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const verified = bytes.subarray(0, offset);
    if (offset !== stat.size || byteHash(verified) !== hash) return creativeError("CREATIVE_SOURCE_CHANGED", "当前事实证据字节已改变");
    return verified;
  } finally { await handle.close(); }
}

type G1Purpose = "preproduction" | "candidates";
export function creativeCandidateFactsRoot(scope: CreativeScope, runId: string): string {
  if (!/^[a-zA-Z0-9._:-]{1,150}$/.test(runId) || runId === "." || runId === "..") {
    return creativeError("CREATIVE_SOURCE_CHANGED", "候选事实目录作用域非法");
  }
  return path.join(artifactDirectory(scope), "g1", runId);
}
function g1WorkDirectory(scope: CreativeScope, runId: string, purpose: G1Purpose): string {
  return purpose === "candidates" ? creativeCandidateFactsRoot(scope, runId) : path.join(archiveWorkDir(), "workspaces", scope.workspaceId);
}
function verifyBoundG1(contract: CreativeContract, runId: string, purpose: G1Purpose, g1?: PrdMarketingAuthority) {
  const { tenantId, workspaceId, projectId } = contract.scope;
  if (!g1 || g1.schemaVersion !== "workloom.prd-marketing-authority/v1" || !contract.facts
    || g1.scope.tenantId !== tenantId || g1.scope.workspaceId !== workspaceId || g1.scope.projectId !== projectId
    || g1.scope.runId !== runId || g1.g1Artifact.sha256 !== contract.facts.hash || g1.g1Artifact.content !== contract.facts.content) {
    return creativeError("CREATIVE_FACTS_REQUIRED", "当前创作合同缺少本次运行的真实 G1 通过证明");
  }
  try {
    const guard = createMarketingGateEvidenceGuard({ workDir: g1WorkDirectory(contract.scope, runId, purpose),
      scope: { ...contract.scope, runId } });
    guard.reset(g1.scope.attempt);
    guard.acceptG1({ scope: g1.scope, content: contract.facts.content, proof: g1.g1Proof });
  } catch (error) {
    return creativeError("CREATIVE_SOURCE_CHANGED", error instanceof Error ? error.message : "当前 G1 已失效");
  }
}

/** Re-read accepted G1 and its complete source bytes before a detached API consumes marketing claims. */
export async function verifyCreativeMarketingSource(contract: CreativeContract, transaction?: PoolClient) {
  assertCreativeContract(contract);
  if (contract.route !== "marketing") return undefined;
  const fact = contract.facts;
  if (!fact?.validUntil) return creativeError("CREATIVE_FACTS_REQUIRED", "缺少有有效期的已通过 G1 原件");
  const { tenantId, workspaceId, projectId } = contract.scope;
  if (![workspaceId, projectId].every(id => /^[a-zA-Z0-9._:-]+$/.test(id) && id !== "." && id !== "..")) {
    return creativeError("CREATIVE_SOURCE_CHANGED", "事实证据作用域非法");
  }
  const g1 = JSON.parse(fact.content) as { facts?: {
    scope?: Record<string, unknown>; collectedAt?: string; sources?: Array<Record<string, unknown>>;
    schemaVersion?: string; issuer?: string;
  }; requestedIntent?: unknown; requestedMetadata?: unknown };
  const facts = g1.facts, scope = facts?.scope;
  const attempt = scope?.attempt, age = Date.now() - Date.parse(facts?.collectedAt ?? "");
  if (g1.requestedIntent !== contract.rawIntent || !g1.requestedMetadata
    || creativeHash(g1.requestedMetadata) !== contract.sourceMetadataHash || facts?.schemaVersion !== "workloom.marketing-facts/v1" || facts.issuer !== "workloom.marketing-authority"
    || scope?.tenantId !== tenantId || scope.workspaceId !== workspaceId || scope.projectId !== projectId
    || !Number.isSafeInteger(attempt) || Number(attempt) < 1 || typeof scope.runId !== "string"
    || !Number.isFinite(age) || age < -30_000 || age > 24 * 3600_000
    || !Array.isArray(facts.sources) || !facts.sources.length) {
    return creativeError("CREATIVE_SOURCE_CHANGED", "G1 来源、作用域或有效期无效");
  }
  const root = await realpath(archiveWorkDir());
  const readApproval = async (client: PoolClient) => {
    const { rows: [approval] } = await client.query<{ proof: PrdMarketingAuthority["g1Proof"]; purpose: G1Purpose }>(
      `SELECT e.proof,e.purpose FROM video_creative_g1_evidence e
       JOIN production_stage_runs s ON s.workspace_id=e.workspace_id AND s.project_id=e.project_id
         AND s.run_id=e.run_id AND (
           (e.purpose='preproduction' AND s.stage_id='preproduction' AND s.pipeline_run_id IS NULL AND s.attempt=e.attempt)
           OR (e.purpose='candidates' AND s.stage_id='creative:facts' AND s.pipeline_run_id=e.run_id AND s.verification_status='passed')
         )
       WHERE e.tenant_id=$1 AND e.workspace_id=$2 AND e.project_id=$3 AND e.contract_hash=$4
         AND e.run_id=$5 AND e.attempt=$6 AND e.sha256=$7
         AND NOT EXISTS (SELECT 1 FROM production_stage_runs newer
           WHERE newer.workspace_id=s.workspace_id AND newer.project_id=s.project_id
             AND newer.stage_id IN ('preproduction','creative:facts')
             AND (newer.started_at>s.started_at OR
               (e.purpose='preproduction' AND newer.stage_id='preproduction' AND newer.attempt>s.attempt)))`,
      [...scopeValues(contract.scope), contract.hash, scope.runId, attempt, fact.hash],
    );
    if (!approval) return creativeError("CREATIVE_SOURCE_CHANGED", "当前预生产尝试缺少实际 G1 通过回执");
    return approval;
  };
  const { proof, purpose } = await (transaction ? readApproval(transaction) : creativeTx(contract.scope, readApproval));
  const workDirectory = g1WorkDirectory(contract.scope, scope.runId, purpose);
  verifyBoundG1(contract, scope.runId, purpose, {
    schemaVersion: "workloom.prd-marketing-authority/v1", scope: { ...contract.scope, runId: scope.runId, attempt: Number(attempt) },
    g1Artifact: { path: path.join(workDirectory, "gates", projectId, `attempt-${attempt}`, "G1_DOSSIER.md"),
      sha256: fact.hash, content: fact.content }, g1Proof: proof,
  });
  const prefix = `stages/preproduction/attempt-${attempt}.marketing-sources/`;
  const archive = purpose === "candidates" ? workDirectory : path.join(root, "archive", workspaceId, projectId);
  for (const source of facts.sources) {
    for (const [ref, hash] of [[source.rawRef, source.rawSha256], [source.textRef, source.textSha256]]) {
      if (typeof ref !== "string" || !ref.startsWith(prefix) || typeof hash !== "string") {
        return creativeError("CREATIVE_SOURCE_CHANGED", "G1 原始来源引用已改变");
      }
      try { await readSourceBytes(archive, ref, hash); }
      catch (error) {
        if (error instanceof CreativeContractError) throw error;
        return creativeError("CREATIVE_SOURCE_CHANGED", "当前事实原始字节无法重新读取");
      }
    }
  }
  const authority = extractProductVisualAuthority(fact.content);
  if (authority.mode !== contract.profile.visualMode) return creativeError("CREATIVE_SOURCE_CHANGED", "G1 视觉授权与合同不一致");
  return authority;
}
