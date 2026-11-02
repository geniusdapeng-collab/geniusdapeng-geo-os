import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type pg from "pg";
import { getAppPool } from "@workloom/db";
import {
  PipelineControlError,
  artifactManifestHash,
  assertArtifactEnvelope,
  assertSystemAutoApprovalReceipt,
  commandRequestHash,
  parseGateDecision,
  parsePipelineOperationRecord,
  sha256Json,
  type ArtifactEnvelope,
  type ArtifactRef,
  type Disposition,
  type ExecutionStatus,
  type GateDecision,
  type GateFinding,
  type PipelineRunState,
  type PipelineOperationRecord,
  type StageRuntimeState,
  type VerificationStatus,
} from "@workloom/pipeline-control";
import {
  assertVideoPipelinePlan,
  pipelineAncestorKeys,
  VIDEO_SYSTEM_AUTO_APPROVAL_POLICY,
  type CompiledNode,
  type CompiledVideoPipelinePlan,
} from "@hyperreality/video-pipeline";
import { archiveWorkDir } from "../archive-host.js";

interface Scope {
  tenantId: string;
  workspaceId: string;
}

interface RunRow extends pg.QueryResultRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  pipeline_kind: string;
  intent_contract_id: string;
  intent_hash: string;
  plan_key: string;
  plan_version: string;
  plan_hash: string;
  status: PipelineRunState["status"];
  next_action: PipelineRunState["nextAction"];
  current_frontier: string[];
  revision: string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface StageRow extends pg.QueryResultRow {
  id: string;
  stage_key: string;
  item_key: string | null;
  revision: number;
  execution_status: ExecutionStatus;
  verification_status: VerificationStatus;
  disposition: Disposition;
  output_manifest_hash: string | null;
  output_artifact_id: string | null;
  gate_decision_id: string | null;
  input_manifest_hash: string;
  artifact_id: string | null;
  artifact_logical_id: string | null;
  artifact_role: string | null;
  artifact_revision: number | null;
  artifact_schema: string | null;
  artifact_storage_ref: string | null;
  artifact_sha256: string | null;
  artifact_bytes: string | number | null;
  artifact_media_type: string | null;
}

interface OperationRow extends pg.QueryResultRow {
  id: string;
  pipeline_run_id: string;
  stage_run_id: string;
  operation_key: string;
  kind: string;
  state: PipelineOperationRecord["state"];
  idempotency_key: string;
  request_hash: string;
  request: Record<string, unknown>;
  external_id: string | null;
  receipt: Record<string, unknown> | null;
  cost: Record<string, unknown>;
  error: Record<string, unknown> | null;
  created_by: string;
  created_at: Date | string;
  dispatched_at: Date | string | null;
  finished_at: Date | string | null;
  updated_at: Date | string;
}

export interface PipelineRunView {
  runId: string;
  projectId: string;
  pipelineKind: string;
  planKey: string;
  planVersion: string;
  planHash: string;
  status: PipelineRunState["status"];
  nextAction: PipelineRunState["nextAction"];
  currentFrontier: string[];
  revision: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  stages: StageRuntimeState[];
}

export interface CreatePipelineRunInput {
  projectId: string;
  pipelineKind: "marketing" | "narrative" | "explainer" | "edit" | "whiteboard";
  intentContractId: string;
  intentHash: string;
  createdBy: string;
  plan: CompiledVideoPipelinePlan;
  idempotencyKey: string;
  commandId: string;
  actor: { id: string; type: "human" | "system" | "worker" };
}

export interface CommandEnvelopeInput {
  commandId: string;
  idempotencyKey: string;
  expectedRunRevision: number;
  actor: { id: string; type: "human" | "system" | "worker" };
}

export interface ReconcileCandidate {
  runId: string;
  projectId: string;
  runRevision: number;
  stageRunId: string | null;
  stageKey: string | null;
  reason: "expired_running_lease" | "output_ready_without_decision" | "external_unknown" | "unverified_gate";
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hash(value: unknown): string {
  return sha256Json(value);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function positiveInt(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PipelineControlError("PIPELINE_REVISION_INVALID", `${label} 非法`);
  return parsed;
}

function stageKeyOf(node: CompiledNode): string {
  return node.key;
}

function contractHashOf(node: CompiledNode): string {
  return hash(node);
}

function inputManifestHashOf(plan: CompiledVideoPipelinePlan, node: CompiledNode, intentHash: string): string {
  const ancestors = pipelineAncestorKeys(plan, node.key);
  if (ancestors.length === 0) return hash({ intentHash });
  return hash({ intentHash, ancestors });
}

function stageState(row: StageRow): StageRuntimeState {
  return {
    stageRunId: row.id,
    key: row.stage_key,
    itemKey: row.item_key,
    revision: Number(row.revision),
    executionStatus: row.execution_status,
    verificationStatus: row.verification_status,
    disposition: row.disposition,
    artifact: row.artifact_id
      && row.artifact_logical_id
      && row.artifact_role
      && row.artifact_revision !== null
      && row.artifact_schema
      && row.artifact_storage_ref
      && row.artifact_sha256
      && row.artifact_bytes !== null
      && row.artifact_media_type
      ? {
          id: row.artifact_id,
          logicalId: row.artifact_logical_id,
          role: row.artifact_role,
          revision: Number(row.artifact_revision),
          schema: row.artifact_schema,
          storageRef: row.artifact_storage_ref,
          sha256: row.artifact_sha256,
          bytes: Number(row.artifact_bytes),
          mediaType: row.artifact_media_type,
        }
      : null,
    gateDecisionId: row.gate_decision_id,
    staleReason: null,
  };
}

function operationRecord(row: OperationRow): PipelineOperationRecord {
  return parsePipelineOperationRecord({
    id: row.id,
    runId: row.pipeline_run_id,
    stageRunId: row.stage_run_id,
    operationKey: row.operation_key,
    kind: row.kind,
    state: row.state,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    request: row.request,
    externalId: row.external_id,
    receipt: row.receipt,
    cost: row.cost,
    error: row.error,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
    dispatchedAt: iso(row.dispatched_at),
    finishedAt: iso(row.finished_at),
    updatedAt: iso(row.updated_at)!,
  });
}

const STAGE_SELECT = `
  SELECT s.id,s.stage_key,s.item_key,s.revision,s.execution_status,s.verification_status,s.disposition,
         s.output_manifest_hash,s.output_artifact_id,s.gate_decision_id,s.input_manifest_hash,
         a.id AS artifact_id,a.logical_id AS artifact_logical_id,a.role AS artifact_role,
         a.revision AS artifact_revision,a.schema_version AS artifact_schema,
         a.storage_ref AS artifact_storage_ref,a.sha256 AS artifact_sha256,
         a.bytes AS artifact_bytes,a.media_type AS artifact_media_type
    FROM production_stage_runs s
    LEFT JOIN video_artifacts a ON a.id=s.output_artifact_id AND a.pipeline_run_id=s.pipeline_run_id
`;

function isSatisfied(stage: StageRuntimeState): boolean {
  return stage.executionStatus === "completed"
    && (stage.verificationStatus === "passed" || stage.verificationStatus === "not_applicable")
    && stage.disposition !== "blocked"
    && stage.disposition !== "repair"
    && stage.disposition !== "reconcile"
    && stage.disposition !== "wait_human";
}

export class VideoPipelineRepository {
  private readonly pool: pg.Pool;

  constructor(
    private readonly scope: Scope,
    pool: pg.Pool = getAppPool(),
  ) {
    this.pool = pool;
  }

  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [this.scope.workspaceId]);
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [this.scope.tenantId]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = true;
        throw new AggregateError([error, rollbackError], "pipeline-repository-rollback-failed");
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  private async commandReplay<T>(
    client: pg.PoolClient,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<T | null> {
    const found = await client.query<{
      request_hash: string;
      status: string;
      response_json: T | null;
    }>(
      `SELECT request_hash, status, response_json
         FROM video_pipeline_commands
        WHERE workspace_id=$1 AND idempotency_key=$2`,
      [this.scope.workspaceId, idempotencyKey],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (row.request_hash !== requestHash) {
      throw new PipelineControlError("IDEMPOTENCY_CONFLICT", "相同幂等键已绑定不同请求");
    }
    if (row.status !== "applied" || row.response_json === null) {
      throw new PipelineControlError("COMMAND_OUTCOME_UNKNOWN", "相同命令仍在处理中或缺少已应用回执");
    }
    return row.response_json;
  }

  private async recordCommand(
    client: pg.PoolClient,
    input: {
      id: string;
      runId: string;
      kind: string;
      idempotencyKey: string;
      requestHash: string;
      actor: { id: string; type: "human" | "system" | "worker" };
      expectedRunRevision: number;
      expectedStageRevision?: number;
      response: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO video_pipeline_commands
        (id,tenant_id,workspace_id,run_id,command_kind,idempotency_key,request_hash,actor_id,actor_type,
         expected_run_revision,expected_stage_revision,status,response_json,finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'applied',$12::jsonb,now())`,
      [input.id, this.scope.tenantId, this.scope.workspaceId, input.runId, input.kind,
        input.idempotencyKey, input.requestHash, input.actor.id, input.actor.type,
        input.expectedRunRevision, input.expectedStageRevision ?? null, JSON.stringify(input.response)],
    );
  }

  private async commandRunReplay(
    client: pg.PoolClient,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PipelineRunView | null> {
    const replay = await this.commandReplay<PipelineRunView | { runId: string }>(client, idempotencyKey, requestHash);
    if (!replay) return null;
    if ("stages" in replay) return replay;
    // Older commands stored only identifiers. Recover their current scoped view
    // without applying the command again or rewriting its historical receipt.
    const view = await this.readRunInTransaction(client, replay.runId);
    if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "历史命令的 run 读取失败");
    return view;
  }

  private async appendOutbox(
    client: pg.PoolClient,
    runId: string,
    eventKind: string,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const id = `OUT-${hash({ runId, eventKind, payload, at: Date.now(), nonce: Math.random() }).slice(0, 20)}`;
    await client.query(
      `INSERT INTO video_pipeline_outbox (id,tenant_id,workspace_id,run_id,event_kind,payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, this.scope.tenantId, this.scope.workspaceId, runId, eventKind, JSON.stringify(payload)],
    );
    return id;
  }

  async createRun(input: CreatePipelineRunInput): Promise<PipelineRunView> {
    const plan = assertVideoPipelinePlan(input.plan);
    if (input.plan.planHash.length !== 64 || input.intentHash.length !== 64) {
      throw new PipelineControlError("PIPELINE_HASH_INVALID", "planHash 与 intentHash 必须是 SHA-256");
    }
    const runId = `RUN-${hash({
      workspaceId: this.scope.workspaceId,
      projectId: input.projectId,
      planHash: plan.planHash,
      intentHash: input.intentHash,
    }).slice(0, 24)}`;
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: 1,
      payload: {
        kind: "startPipeline",
        projectId: input.projectId,
        pipelineKind: input.pipelineKind,
        intentContractId: input.intentContractId,
        intentHash: input.intentHash,
        planHash: plan.planHash,
      },
    });
    const response = await this.transaction(async (client) => {
      const replay = await this.commandRunReplay(client, input.idempotencyKey, requestHash);
      if (replay) return replay;

      const project = await client.query<{ id: string }>(
        `SELECT p.id FROM video_projects p JOIN workspaces w ON w.id=p.workspace_id
          WHERE p.workspace_id=$1 AND p.id=$2 AND w.tenant_id=$3`,
        [this.scope.workspaceId, input.projectId, this.scope.tenantId],
      );
      if (!project.rows[0]) throw new PipelineControlError("PROJECT_NOT_FOUND", "项目不存在或不属于当前作用域");

      const active = await client.query<{ id: string }>(
        `SELECT id FROM video_pipeline_runs
          WHERE workspace_id=$1 AND project_id=$2 AND status IN ('queued','running','waiting','reconciling')`,
        [this.scope.workspaceId, input.projectId],
      );
      if (active.rows[0]) throw new PipelineControlError("PIPELINE_ACTIVE_RUN_EXISTS", `项目已有活动 run ${active.rows[0].id}`);

      const roots = plan.roots;
      await client.query(
        `INSERT INTO video_pipeline_runs
          (id,tenant_id,workspace_id,project_id,pipeline_kind,intent_contract_id,intent_hash,
           plan_key,plan_version,plan_hash,status,next_action,current_frontier,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running','run_node',$11::jsonb,$12)`,
        [runId, this.scope.tenantId, this.scope.workspaceId, input.projectId, input.pipelineKind,
          input.intentContractId, input.intentHash, plan.key, plan.version, plan.planHash,
          JSON.stringify(roots), input.createdBy],
      );

      for (const node of plan.nodes) {
        const stageRunId = `SR-${hash({ runId, key: node.key }).slice(0, 20)}`;
        const isRoot = roots.includes(node.key);
        await client.query(
          `INSERT INTO production_stage_runs
            (id,workspace_id,project_id,stage_id,attempt,status,run_id,pipeline_run_id,stage_key,item_key,revision,
             contract_version,plan_hash,contract_hash,input_manifest_hash,execution_status,verification_status,disposition)
           VALUES ($1,$2,$3,$4,1,'running',$5,$6,$7,NULL,1,$8,$9,$10,$11,$12,'not_run','continue')`,
          [stageRunId, this.scope.workspaceId, input.projectId, node.key, runId, runId, node.key,
            node.kind === "stage" ? node.contractVersion : `${node.kind}/v1`, plan.planHash,
            contractHashOf(node), inputManifestHashOf(plan, node, input.intentHash),
            isRoot ? "ready" : "pending"],
        );
      }
      await this.appendOutbox(client, runId, "run.started", {
        projectId: input.projectId, planHash: plan.planHash, frontier: roots,
      });
      const view = await this.readRunInTransaction(client, runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId, runId, kind: "startPipeline", idempotencyKey: input.idempotencyKey,
        requestHash, actor: input.actor, expectedRunRevision: 1,
        response: { ...view },
      });
      return view;
    });
    return response;
  }

  private async readRunInTransaction(client: pg.PoolClient, runId: string): Promise<PipelineRunView | null> {
    const run = await client.query<RunRow>(
      `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2`,
      [this.scope.workspaceId, runId],
    );
    const row = run.rows[0];
    if (!row) return null;
    const stages = await client.query<StageRow>(
      `${STAGE_SELECT}
        WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2
        ORDER BY s.stage_key,s.item_key NULLS FIRST,s.revision`,
      [this.scope.workspaceId, runId],
    );
    return {
      runId: row.id,
      projectId: row.project_id,
      pipelineKind: row.pipeline_kind,
      planKey: row.plan_key,
      planVersion: row.plan_version,
      planHash: row.plan_hash,
      status: row.status,
      nextAction: row.next_action,
      currentFrontier: Array.isArray(row.current_frontier) ? row.current_frontier : [],
      revision: positiveInt(row.revision, "run.revision"),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: iso(row.lease_expires_at),
      stages: stages.rows.map(stageState),
    };
  }

  async getRun(runId: string): Promise<PipelineRunView | null> {
    return this.transaction((client) => this.readRunInTransaction(client, runId));
  }

  async findByIntentContractId(intentContractId: string): Promise<PipelineRunView | null> {
    return this.transaction(async (client) => {
      const rows = await client.query<{ id: string }>(
        `SELECT id FROM video_pipeline_runs
          WHERE workspace_id=$1 AND intent_contract_id=$2
          ORDER BY created_at DESC LIMIT 1`,
        [this.scope.workspaceId, intentContractId],
      );
      const runId = rows.rows[0]?.id;
      return runId ? this.readRunInTransaction(client, runId) : null;
    });
  }

  async listReconcileCandidates(limit = 100): Promise<ReconcileCandidate[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new PipelineControlError("PIPELINE_RECONCILE_LIMIT_INVALID", "limit 必须在 1..1000");
    }
    return this.transaction(async (client) => {
      const rows = await client.query<{
        run_id: string;
        project_id: string;
        revision: string;
        stage_run_id: string | null;
        stage_key: string | null;
        reason: ReconcileCandidate["reason"];
      }>(
        `SELECT r.id AS run_id,r.project_id,r.revision,
                s.id AS stage_run_id,s.stage_key,
                CASE
                  WHEN r.status='running'
                   AND (r.lease_expires_at IS NULL OR r.lease_expires_at < now())
                   AND s.execution_status='running' THEN 'expired_running_lease'
                  WHEN s.execution_status='output_ready'
                   AND (s.verification_status='pending' OR s.gate_decision_id IS NULL) THEN 'output_ready_without_decision'
                  WHEN s.disposition='reconcile' THEN 'external_unknown'
                  WHEN s.verification_status='unverified' THEN 'unverified_gate'
                  ELSE NULL
                END AS reason
           FROM video_pipeline_runs r
           LEFT JOIN production_stage_runs s ON s.pipeline_run_id=r.id
          WHERE r.workspace_id=$1
            AND r.status IN ('running','waiting','reconciling','failed')
            AND (
              (r.status='running' AND (r.lease_expires_at IS NULL OR r.lease_expires_at < now()))
              OR s.execution_status='output_ready'
              OR s.disposition='reconcile'
              OR s.verification_status='unverified'
            )
          ORDER BY r.updated_at,s.stage_key
          LIMIT $2`,
        [this.scope.workspaceId, limit],
      );
      return rows.rows
        .filter((row): row is typeof row & { reason: ReconcileCandidate["reason"] } => row.reason !== null)
        .map((row) => ({
          runId: row.run_id,
          projectId: row.project_id,
          runRevision: positiveInt(row.revision, "run.revision"),
          stageRunId: row.stage_run_id,
          stageKey: row.stage_key,
          reason: row.reason,
        }));
    });
  }

  async claimStage(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    owner: string;
    commandId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedStageRevision: number;
    leaseMs: number;
  }): Promise<PipelineRunView> {
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new PipelineControlError("PIPELINE_LEASE_INVALID", "leaseMs 必须是正整数");
    }
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: { id: input.owner, type: "worker" },
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "claimStage",
        runId: input.runId,
        stageKey: input.stageKey,
        itemKey: input.itemKey ?? null,
        leaseMs: input.leaseMs,
        planHash: input.plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandRunReplay(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      if (!run.rows[0]) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(run.rows[0].revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (run.rows[0].plan_hash !== input.plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "claim 使用的 plan 与 run 不一致");
      }
      if (run.rows[0].lease_owner
        && run.rows[0].lease_owner !== input.owner
        && run.rows[0].lease_expires_at
        && new Date(run.rows[0].lease_expires_at).getTime() > Date.now()) {
        throw new PipelineControlError("PIPELINE_LEASE_BUSY", `项目租约属于 ${run.rows[0].lease_owner}`);
      }
      const node = input.plan.nodes.find((item) => item.key === input.stageKey);
      if (!node) throw new PipelineControlError("PIPELINE_STAGE_UNKNOWN", "stage 不在当前 plan");
      await this.assertDependenciesSatisfied(client, input.runId, node);
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND COALESCE(s.item_key,'')=$4
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.stageKey, input.itemKey ?? ""],
      );
      const row = stage.rows[0];
      if (!row) throw new PipelineControlError("PIPELINE_STAGE_NOT_FOUND", "stage 不存在");
      if (row.revision !== input.expectedStageRevision) throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      if (row.execution_status !== "ready") throw new PipelineControlError("PIPELINE_STAGE_NOT_READY", "stage 未 ready");
      const inputs = await this.currentInputArtifacts(
        client,
        input.runId,
        input.stageKey,
        input.plan,
        run.rows[0].intent_hash,
      );
      const leaseExpires = new Date(Date.now() + input.leaseMs);
      await client.query(
        `UPDATE production_stage_runs
            SET execution_status='running',status='running',disposition='continue',worker_version=$4,
                input_manifest_hash=$5,last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, row.id, input.owner, inputs.manifestHash],
      );
      await client.query(
        `UPDATE video_pipeline_runs
            SET lease_owner=$3,lease_expires_at=$4,next_action='run_node',revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, input.owner, leaseExpires.toISOString()],
      );
      await this.appendOutbox(client, input.runId, "node.claimed", {
        stageRunId: row.id, stageKey: row.stage_key, owner: input.owner, leaseExpiresAt: leaseExpires.toISOString(),
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId, runId: input.runId, kind: "claimStage", idempotencyKey: input.idempotencyKey,
        requestHash, actor: { id: input.owner, type: "worker" }, expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision, response: { ...view },
      });
      return view;
    });
  }

  private artifactRoot(projectId: string): string {
    return path.join(archiveWorkDir(), "archive", this.scope.workspaceId, projectId);
  }

  private verifyArtifact(projectId: string, artifact: ArtifactEnvelope): ArtifactEnvelope {
    const normalized = assertArtifactEnvelope(artifact);
    const root = this.artifactRoot(projectId);
    const full = path.resolve(root, normalized.storageRef);
    if (!full.startsWith(`${path.resolve(root)}${path.sep}`)) throw new PipelineControlError("ARTIFACT_PATH_INVALID", "artifact 路径越出项目档案");
    const entry = lstatSync(full);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new PipelineControlError("ARTIFACT_FILE_INVALID", "artifact 必须是档案根内普通文件，禁止符号链接");
    }
    const realRoot = realpathSync(root);
    const realFile = realpathSync(full);
    if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
      throw new PipelineControlError("ARTIFACT_PATH_INVALID", "artifact 真实路径越出项目档案");
    }
    const bytes = readFileSync(full);
    if (bytes.byteLength !== normalized.bytes) throw new PipelineControlError("ARTIFACT_SIZE_MISMATCH", "artifact bytes 与文件不一致");
    if (sha256(bytes) !== normalized.sha256) throw new PipelineControlError("ARTIFACT_HASH_MISMATCH", "artifact sha256 与文件不一致");
    return normalized;
  }

  private async currentInputArtifacts(
    client: pg.PoolClient,
    runId: string,
    stageKey: string,
    plan: CompiledVideoPipelinePlan,
    intentHash: string,
  ): Promise<{ refs: ArtifactRef[]; manifestHash: string }> {
    const ancestorKeys = pipelineAncestorKeys(plan, stageKey);
    if (ancestorKeys.length === 0) return { refs: [], manifestHash: hash({ intentHash }) };
    const result = await client.query<{
      id: string;
      logical_id: string;
      role: string;
      revision: number;
      schema_version: string;
      storage_ref: string;
      sha256: string;
      bytes: string;
      media_type: string;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (stage_key)
                id,stage_key,revision,output_artifact_id
           FROM production_stage_runs
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND stage_key=ANY($3::text[])
            AND execution_status='completed'
            AND verification_status IN ('passed','not_applicable')
            AND disposition NOT IN ('blocked','repair','reconcile','wait_human')
          ORDER BY stage_key,revision DESC
       )
       SELECT DISTINCT
              a.id,a.logical_id,a.role,a.revision,a.schema_version,a.storage_ref,a.sha256,a.bytes,a.media_type
         FROM latest s
         JOIN video_artifacts a
           ON a.stage_run_id=s.id OR a.id=s.output_artifact_id
        WHERE a.workspace_id=$1 AND a.pipeline_run_id=$2
        ORDER BY a.logical_id,a.role,a.revision`,
      [this.scope.workspaceId, runId, ancestorKeys],
    );
    const refs = result.rows.map((row): ArtifactRef => ({
      id: row.id,
      logicalId: row.logical_id,
      role: row.role,
      revision: Number(row.revision),
      schema: row.schema_version,
      storageRef: row.storage_ref,
      sha256: row.sha256,
      bytes: Number(row.bytes),
      mediaType: row.media_type,
    }));
    return { refs, manifestHash: refs.length > 0 ? artifactManifestHash(refs) : hash({ intentHash }) };
  }

  async getStageInputManifest(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
  }): Promise<{ refs: ArtifactRef[]; manifestHash: string }> {
    const plan = assertVideoPipelinePlan(input.plan);
    return this.transaction(async (client) => {
      const run = await client.query<{ intent_hash: string }>(
        "SELECT intent_hash FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2",
        [this.scope.workspaceId, input.runId],
      );
      if (!run.rows[0]) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      return this.currentInputArtifacts(
        client,
        input.runId,
        input.stageKey,
        plan,
        run.rows[0].intent_hash,
      );
    });
  }

  private async assertDependenciesSatisfied(
    client: pg.PoolClient,
    runId: string,
    node: CompiledNode,
  ): Promise<void> {
    if (node.dependsOn.length === 0) return;
    const result = await client.query<StageRow>(
      `${STAGE_SELECT}
        WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=ANY($3::text[])
        ORDER BY s.stage_key,s.revision DESC`,
      [this.scope.workspaceId, runId, node.dependsOn],
    );
    const latest = new Map<string, StageRuntimeState>();
    for (const row of result.rows) {
      if (!latest.has(row.stage_key)) latest.set(row.stage_key, stageState(row));
    }
    const blockers = node.dependsOn.filter((dependency) => {
      const state = latest.get(dependency);
      return !state || !isSatisfied(state);
    });
    if (blockers.length > 0) {
      throw new PipelineControlError("PIPELINE_DEPENDENCIES_NOT_READY", `上游未通过：${blockers.join(",")}`);
    }
  }

  async commitArtifact(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    artifact?: ArtifactEnvelope;
    artifacts?: ArtifactEnvelope[];
    manifestArtifacts: ArtifactRef[];
    commandId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedStageRevision: number;
    actor: { id: string; type: "human" | "system" | "worker" };
  }): Promise<{ run: PipelineRunView; artifactManifestHash: string }> {
    const plan = assertVideoPipelinePlan(input.plan);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "commitArtifact",
        runId: input.runId,
        stageKey: input.stageKey,
        itemKey: input.itemKey ?? null,
        artifact: input.artifact ?? null,
        artifacts: input.artifacts ?? null,
        manifestArtifacts: input.manifestArtifacts,
        planHash: plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<{ run: PipelineRunView; artifactManifestHash: string }
        | { runId: string; artifactManifestHash: string }>(
        client, input.idempotencyKey, requestHash,
      );
      if (replay) {
        if ("run" in replay) return replay;
        // Legacy artifact receipts retain their original manifest while the run
        // is read at its current revision; no artifact/file validation is rerun.
        const view = await this.readRunInTransaction(client, replay.runId);
        if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "历史命令的 run 读取失败");
        return { run: view, artifactManifestHash: replay.artifactManifestHash };
      }
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "commit 使用的 plan 与 run 不一致");
      }
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      const node = plan.nodes.find((item) => item.key === input.stageKey);
      if (!node || node.kind === "gate") {
        throw new PipelineControlError("PIPELINE_STAGE_UNKNOWN", "commit 目标不是可执行节点");
      }
      const submittedRaw = input.artifacts ?? (input.artifact ? [input.artifact] : []);
      if (submittedRaw.length === 0) {
        throw new PipelineControlError("ARTIFACT_OUTPUT_MISSING", "至少需要一个输出 artifact");
      }
      const artifacts = submittedRaw.map((artifact) => this.verifyArtifact(runRow.project_id, artifact));
      const byRole = new Map<string, ArtifactEnvelope[]>();
      for (const artifact of artifacts) {
        const matches = node.outputs.filter((port) => port.role === artifact.role && port.schema === artifact.schema);
        if (matches.length !== 1) {
          throw new PipelineControlError("ARTIFACT_OUTPUT_UNEXPECTED", `${artifact.role}/${artifact.schema} 不是 ${node.key} 的唯一输出槽位`);
        }
        byRole.set(artifact.role, [...(byRole.get(artifact.role) ?? []), artifact]);
      }
      for (const port of node.outputs.filter((item) => item.required)) {
        if ((byRole.get(port.role)?.length ?? 0) !== 1) {
          throw new PipelineControlError("ARTIFACT_OUTPUT_MISSING", `${node.key} 缺少 required output ${port.role}`);
        }
      }
      for (const [role, values] of byRole) {
        if (values.length !== 1) throw new PipelineControlError("ARTIFACT_OUTPUT_DUPLICATE", `${node.key}.${role} 重复`);
      }
      const closure = await this.currentInputArtifacts(client, input.runId, input.stageKey, plan, runRow.intent_hash);
      const closureById = new Map(closure.refs.map((artifact) => [artifact.id, artifact]));
      for (const artifact of artifacts) {
        const parentIds = artifact.parents.map((parent) => parent.artifactId).sort();
        const expectedIds = [...closureById.keys()].sort();
        if (hash(parentIds) !== hash(expectedIds)) {
          throw new PipelineControlError("PIPELINE_INPUT_CLOSURE_MISMATCH", `${node.key} artifact parents 未覆盖完整输入闭包`);
        }
        for (const parent of artifact.parents) {
          const current = closureById.get(parent.artifactId);
          if (!current || current.sha256 !== parent.sha256 || current.role !== parent.role) {
            throw new PipelineControlError("ARTIFACT_PARENT_MISMATCH", `parent ${parent.artifactId} 与当前输入闭包不一致`);
          }
        }
      }
      const orderedArtifacts = node.outputs.flatMap((port) => byRole.get(port.role) ?? []);
      const primaryArtifact: ArtifactEnvelope | undefined = orderedArtifacts[0];
      if (!primaryArtifact) throw new PipelineControlError("ARTIFACT_OUTPUT_MISSING", "没有可提交的 canonical output");
      const completeManifest = [...closure.refs, ...orderedArtifacts];
      const manifestHash = artifactManifestHash(completeManifest);
      if (artifactManifestHash(input.manifestArtifacts) !== manifestHash) {
        throw new PipelineControlError("ARTIFACT_MANIFEST_MISMATCH", "调用方 manifest 必须精确包含输入闭包与全部输出制品");
      }
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND COALESCE(s.item_key,'')=$4
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.stageKey, input.itemKey ?? ""],
      );
      const stageRow = stage.rows[0];
      if (!stageRow) throw new PipelineControlError("PIPELINE_STAGE_NOT_FOUND", "stage 不存在");
      if (stageRow.revision !== input.expectedStageRevision) throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      if (stageRow.execution_status !== "running") throw new PipelineControlError("PIPELINE_STAGE_NOT_RUNNING", "stage 不在运行态");
      if (stageRow.input_manifest_hash !== closure.manifestHash) {
        throw new PipelineControlError("PIPELINE_INPUT_MANIFEST_MISMATCH", "输入 manifest 与 StageRun 冻结值不一致");
      }
      if (node.sideEffect === "provider" || node.sideEffect === "public") {
        const acceptedOperation = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n
             FROM video_pipeline_operations
            WHERE workspace_id=$1 AND stage_run_id=$2 AND state='accepted'`,
          [this.scope.workspaceId, stageRow.id],
        );
        if (Number(acceptedOperation.rows[0]?.n ?? 0) === 0) {
          throw new PipelineControlError("OPERATION_RECEIPT_REQUIRED", `${node.key} 必须先取得已接受的 operation receipt`);
        }
      }
      for (const artifact of orderedArtifacts) {
        await client.query(
          `INSERT INTO video_artifacts
            (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,logical_id,revision,role,
             schema_version,storage_ref,sha256,bytes,media_type,creator,metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb)`,
          [artifact.id, this.scope.tenantId, this.scope.workspaceId, runRow.project_id, input.runId, stageRow.id,
            artifact.logicalId, artifact.revision, artifact.role, artifact.schema, artifact.storageRef, artifact.sha256,
            artifact.bytes, artifact.mediaType, JSON.stringify(artifact.creator), JSON.stringify(artifact.metadata)],
        );
        for (const parent of artifact.parents) {
          await client.query(
            `INSERT INTO video_artifact_edges
              (tenant_id,workspace_id,pipeline_run_id,parent_artifact_id,parent_sha256,child_artifact_id,child_sha256,input_role)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [this.scope.tenantId, this.scope.workspaceId, input.runId, parent.artifactId, parent.sha256,
              artifact.id, artifact.sha256, parent.role],
          );
        }
      }
      await client.query(
        `UPDATE production_stage_runs
            SET output_ref=$4,output_sha256=$5,output_manifest_hash=$6,output_artifact_id=$7,
                execution_status='output_ready',status='running',verification_status='pending',disposition='continue',
                last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, stageRow.id, primaryArtifact.storageRef, primaryArtifact.sha256, manifestHash, primaryArtifact.id],
      );
      const hasDownstreamGate = plan.nodes.some((node) =>
        node.kind === "gate" && node.dependsOn.includes(input.stageKey));
      if (!hasDownstreamGate) {
        await client.query(
          `UPDATE production_stage_runs
              SET execution_status='completed',status='done',verification_status='not_applicable',disposition='continue'
            WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
          [this.scope.workspaceId, input.runId, stageRow.id],
        );
      }
      await client.query(
        `UPDATE video_pipeline_runs
            SET next_action='run_node',lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId],
      );
      await this.appendOutbox(client, input.runId, "artifact.committed", {
        stageRunId: stageRow.id,
        artifactIds: orderedArtifacts.map((artifact) => artifact.id),
        artifactSha256: primaryArtifact.sha256,
        artifactManifestHash: manifestHash,
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      const response = { run: view, artifactManifestHash: manifestHash };
      await this.recordCommand(client, {
        id: input.commandId, runId: input.runId, kind: "commitArtifact", idempotencyKey: input.idempotencyKey,
        requestHash, actor: input.actor, expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision, response,
      });
      return response;
    });
  }

  async recordGateDecision(input: {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    gateStageKey: string;
    decision: GateDecision;
    findings: GateFinding[];
    manifestArtifacts: ArtifactRef[];
    commandId: string;
    idempotencyKey: string;
    expectedRunRevision: number;
    expectedStageRevision: number;
    actor: { id: string; type: "human" | "system" | "worker" };
  }): Promise<PipelineRunView> {
    const plan = assertVideoPipelinePlan(input.plan);
    const decision = parseGateDecision(input.decision);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "recordGateDecision",
        runId: input.runId,
        gateStageKey: input.gateStageKey,
        decision,
        findings: input.findings,
        manifestArtifacts: input.manifestArtifacts,
        planHash: plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandRunReplay(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (decision.runId !== input.runId || decision.planHash !== runRow.plan_hash) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 未绑定当前 run/plan");
      }
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "gate decision 使用的 plan 与 run 不一致");
      }
      const manifestHash = artifactManifestHash(input.manifestArtifacts);
      if (decision.artifactManifestHash !== manifestHash) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 未绑定当前 artifact manifest");
      }
      if (sha256Json(decision.findings) !== sha256Json(input.findings)) {
        throw new PipelineControlError("GATE_FINDINGS_MISMATCH", "GateDecision.findings 与持久化 findings 不一致");
      }
      const manifestCheck = await client.query<{ id: string; sha256: string }>(
        `SELECT id,sha256 FROM video_artifacts
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=ANY($3::text[])`,
        [this.scope.workspaceId, input.runId, input.manifestArtifacts.map((item) => item.id)],
      );
      const artifactHashes = new Map(manifestCheck.rows.map((row) => [row.id, row.sha256]));
      if (input.manifestArtifacts.some((artifact) => artifactHashes.get(artifact.id) !== artifact.sha256)) {
        throw new PipelineControlError("GATE_ARTIFACT_STALE", "GateDecision manifest 包含缺失或摘要漂移的 artifact");
      }
      const gateNode = plan.nodes.find((node) => node.key === input.gateStageKey);
      if (!gateNode || gateNode.kind !== "gate") {
        throw new PipelineControlError("PIPELINE_GATE_NODE_UNKNOWN", "gateStageKey 不在当前 plan 或不是 gate");
      }
      if (decision.gateId !== gateNode.gateId
        || decision.checkSetVersion !== gateNode.checkSetVersion
        || decision.rubricVersion !== gateNode.rubricVersion) {
        throw new PipelineControlError("GATE_POLICY_STALE", "GateDecision 与当前 gate policy 不一致");
      }
      const marker = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND s.item_key IS NULL
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.gateStageKey],
      );
      const markerRow = marker.rows[0];
      if (!markerRow) throw new PipelineControlError("PIPELINE_GATE_STAGE_NOT_FOUND", "gate stage 不存在");
      if (markerRow.revision !== input.expectedStageRevision) throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "gate stage revision 已变化");
      if (markerRow.execution_status !== "ready") {
        throw new PipelineControlError("PIPELINE_GATE_STAGE_NOT_READY", "gate stage 不在 ready");
      }
      const producer = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.id=$3
          FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, decision.stageRunId],
      );
      const producerRow = producer.rows[0];
      if (!producerRow) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 目标 stage 不存在");
      }
      if (!gateNode.dependsOn.includes(producerRow.stage_key)) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 目标 stage 不是当前 gate 的直接输入");
      }
      if (producerRow.execution_status !== "output_ready") {
        throw new PipelineControlError("GATE_TARGET_NOT_OUTPUT_READY", "GateDecision 目标 stage 不是 output_ready");
      }
      if (manifestHash !== producerRow.output_manifest_hash) {
        throw new PipelineControlError("GATE_ARTIFACT_MANIFEST_MISMATCH", "门只能消费目标阶段完整的输入闭包与输出 manifest");
      }
      if (!input.manifestArtifacts.some((artifact) => artifact.id === producerRow.output_artifact_id
        && artifact.sha256 === producerRow.artifact_sha256)) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision manifest 不包含目标 stage 当前产物");
      }
      const primaryArtifact = input.manifestArtifacts.find((artifact) =>
        artifact.id === producerRow.output_artifact_id && artifact.sha256 === producerRow.artifact_sha256);
      if (!primaryArtifact) {
        throw new PipelineControlError("GATE_DECISION_SCOPE_MISMATCH", "GateDecision 缺少目标 stage canonical output");
      }
      if (decision.authority === "system_auto_approval") {
        if (input.actor.type !== "system" || decision.reviewer.kind !== "system_auto_approval"
          || !decision.reviewer.autoApproval) {
          throw new PipelineControlError("GATE_SYSTEM_ACTOR_REQUIRED", "system auto-approval requires a system actor and exact policy receipt");
        }
        const outcome = decision.status === "passed" ? "passed" : decision.status === "rejected" ? "repair" : "blocked";
        if (!["passed", "rejected", "blocked"].includes(decision.status)) {
          throw new PipelineControlError("GATE_AUTO_STATUS_INVALID", "system auto-approval must be passed, rejected or blocked");
        }
        const receipt = assertSystemAutoApprovalReceipt(decision.reviewer.autoApproval, {
          policyId: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.id,
          policyVersion: VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.version,
          gateKey: decision.gateId,
          outcome,
        });
        if (receipt.artifactSha256 !== primaryArtifact.sha256) {
          throw new PipelineControlError("GATE_AUTO_ARTIFACT_MISMATCH", "system auto-approval receipt is bound to another artifact");
        }
      } else if (decision.authority === "human_approval" || decision.reviewer.kind === "human_approval") {
        throw new PipelineControlError("VIDEO_HUMAN_REVIEW_DISABLED", "review-capable video gates cannot create or consume human approvals");
      }
      await client.query(
        `INSERT INTO video_gate_decisions
          (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,gate_id,artifact_manifest_hash,
           plan_hash,check_set_version,rubric_version,status,reviewer,evidence_refs,supersedes_decision_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)`,
        [decision.id, this.scope.tenantId, this.scope.workspaceId, runRow.project_id, input.runId,
          producerRow.id, decision.gateId, manifestHash, decision.planHash,
          decision.checkSetVersion, decision.rubricVersion, decision.status,
          JSON.stringify(decision.reviewer), JSON.stringify(decision.evidenceRefs),
          decision.supersedesDecisionId, decision.createdAt],
      );
      for (const finding of input.findings) {
        await client.query(
          `INSERT INTO video_gate_findings
            (id,tenant_id,workspace_id,decision_id,code,severity,target_type,target_id,field_path,expected_value,
             actual_value,evidence_refs,repair_class,blocking)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)`,
          [`GF-${hash({ decisionId: decision.id, finding }).slice(0, 20)}`, this.scope.tenantId,
            this.scope.workspaceId, decision.id, finding.code, finding.severity, finding.targetType,
            finding.targetId, finding.fieldPath, JSON.stringify(finding.expected ?? null),
            JSON.stringify(finding.actual ?? null), JSON.stringify(finding.evidenceRefs), finding.repairClass, finding.blocking],
        );
      }
      const execution = "completed";
      const disposition = decision.status === "passed" || decision.status === "not_applicable"
        ? "continue" : decision.status === "blocked" ? "blocked" : decision.status === "rejected" ? "repair" : "wait_human";
      await client.query(
        `UPDATE production_stage_runs
            SET gate_decision_id=$4,execution_status='completed',verification_status=$5,disposition=$6,
                output_manifest_hash=$7,last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, producerRow.id, decision.id, decision.status, disposition, manifestHash],
      );
      await client.query(
        `UPDATE production_stage_runs
            SET output_ref=$4,output_sha256=$5,output_manifest_hash=$6,output_artifact_id=$7,gate_decision_id=$8,
                execution_status=$9,status=$10,verification_status=$11,disposition=$12,last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
        [this.scope.workspaceId, input.runId, markerRow.id, primaryArtifact.storageRef, primaryArtifact.sha256,
          manifestHash, primaryArtifact.id, decision.id, execution,
          decision.status === "passed" || decision.status === "not_applicable" ? "done" : "failed",
          decision.status, disposition],
      );
      const nextAction = decision.status === "blocked" ? "manual_fix" : decision.status === "rejected" ? "repair"
        : decision.status === "unverified" ? "reconcile" : "run_node";
      const status = decision.status === "blocked" ? "failed" : decision.status === "rejected" ? "waiting"
        : decision.status === "unverified" ? "reconciling" : "running";
      await client.query(
        `UPDATE video_pipeline_runs
            SET status=$3,next_action=$4,revision=revision+1,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, status, nextAction],
      );
      await this.appendOutbox(client, input.runId, "gate.decided", {
        stageRunId: markerRow.id, targetStageRunId: producerRow.id, decisionId: decision.id, status: decision.status,
        artifactManifestHash: manifestHash,
      });
      if (decision.authority === "system_auto_approval") {
        await this.appendOutbox(client, input.runId, "system-auto-approval", {
          stageRunId: markerRow.id,
          targetStageRunId: producerRow.id,
          decisionId: decision.id,
          gateKey: decision.gateId,
          reviewer: decision.reviewer,
          evidenceRefs: decision.evidenceRefs,
        });
      }
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId, runId: input.runId, kind: "recordGateDecision", idempotencyKey: input.idempotencyKey,
        requestHash, actor: input.actor, expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision, response: { ...view },
      });
      return view;
    });
  }

  async refreshFrontier(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
  }): Promise<PipelineRunView> {
    const plan = assertVideoPipelinePlan(input.plan);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      payload: { kind: "refreshFrontier", runId: input.runId, planHash: plan.planHash },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandRunReplay(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "frontier 使用的 plan 与 run 不一致");
      }
      const stages = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2
          ORDER BY s.stage_key,s.revision DESC`,
        [this.scope.workspaceId, input.runId],
      );
      const latest = new Map<string, StageRuntimeState>();
      for (const row of stages.rows) {
        if (!latest.has(row.stage_key)) latest.set(row.stage_key, stageState(row));
      }
      const gateDependencyReady = (state: StageRuntimeState | undefined): boolean => Boolean(
        state
        && state.artifact
        && (state.executionStatus === "output_ready"
          || (state.executionStatus === "completed"
            && (state.verificationStatus === "passed" || state.verificationStatus === "not_applicable")))
        && state.disposition !== "blocked"
        && state.disposition !== "reconcile"
        && state.disposition !== "repair"
        && state.disposition !== "wait_human",
      );
      for (const node of plan.nodes) {
        const state = latest.get(node.key);
        if (!state || state.executionStatus !== "pending") continue;
        const dependenciesReady = node.dependsOn.every((dependency) => {
          const dependencyState = latest.get(dependency);
          return node.kind === "gate"
            ? gateDependencyReady(dependencyState)
            : Boolean(dependencyState && isSatisfied(dependencyState));
        });
        if (dependenciesReady) {
          const row = stages.rows.find((item) => item.stage_key === node.key);
          if (!row) continue;
          await client.query(
            `UPDATE production_stage_runs SET execution_status='ready',verification_status='not_run',disposition='continue',status='running'
              WHERE workspace_id=$1 AND pipeline_run_id=$2 AND id=$3`,
            [this.scope.workspaceId, input.runId, row.id],
          );
          const nextState = { ...state, executionStatus: "ready" as const, verificationStatus: "not_run" as const };
          latest.set(node.key, nextState);
        }
      }
      // Frontier is a snapshot of all runnable nodes, including work made ready
      // by an earlier refresh. Reconciliation/status refreshes must not consume it.
      const ready = plan.nodes.filter((node) => {
        const state = latest.get(node.key);
        return state?.executionStatus === "ready" && state.disposition === "continue";
      }).map((node) => node.key);
      const blockers = stages.rows.filter((row) => ["repair","reconcile","wait_human","blocked"].includes(row.disposition));
      const allDone = plan.nodes.every((node) => {
        const state = latest.get(node.key);
        return Boolean(state && isSatisfied(state));
      });
      const nextAction: PipelineRunState["nextAction"] = blockers.some((row) => row.disposition === "repair") ? "repair"
        : blockers.some((row) => row.disposition === "reconcile") ? "reconcile"
          : blockers.some((row) => row.disposition === "wait_human") ? "wait_approval"
            : blockers.length > 0 ? "manual_fix"
              : ready.length > 0 ? "run_node"
                : allDone ? "done" : "wait_resource";
      const status: PipelineRunState["status"] = nextAction === "repair" ? "waiting"
        : nextAction === "reconcile" ? "reconciling"
          : nextAction === "wait_approval" ? "waiting"
            : nextAction === "manual_fix" ? "failed"
              : nextAction === "done" ? "completed" : "running";
      await client.query(
        `UPDATE video_pipeline_runs SET status=$3,next_action=$4,current_frontier=$5::jsonb,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, status, nextAction, JSON.stringify(ready)],
      );
      await this.appendOutbox(client, input.runId, nextAction === "done" ? "run.completed" : "run.state_changed", {
        command: "refreshFrontier",
        nextAction,
        frontier: ready,
      });
      const response = await this.readRunInTransaction(client, input.runId);
      if (!response) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "refreshFrontier",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        response: { ...response },
      });
      return response;
    });
  }

  async reserveOperation(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    stageKey: string;
    itemKey?: string | null;
    operationKey: string;
    kind: string;
    request: Record<string, unknown>;
    expectedStageRevision: number;
  }): Promise<{ operation: PipelineOperationRecord; run: PipelineRunView }> {
    const plan = assertVideoPipelinePlan(input.plan);
    if (!input.operationKey.trim() || !input.kind.trim()) {
      throw new PipelineControlError("OPERATION_IDENTITY_INVALID", "operationKey 与 kind 必填");
    }
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "reserveOperation",
        runId: input.runId,
        stageKey: input.stageKey,
        itemKey: input.itemKey ?? null,
        operationKey: input.operationKey,
        operationKind: input.kind,
        request: input.request,
        planHash: plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<{ operation: PipelineOperationRecord; run: PipelineRunView }>(
        client,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
      const run = await client.query<RunRow>(
        "SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (runRow.plan_hash !== plan.planHash) {
        throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "operation 使用的 plan 与 run 不一致");
      }
      const node = plan.nodes.find((item) => item.key === input.stageKey);
      if (!node || node.kind === "gate" || node.sideEffect === "none") {
        throw new PipelineControlError("OPERATION_STAGE_INVALID", "operation 只能绑定当前 plan 的有副作用 stage");
      }
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT}
          WHERE s.workspace_id=$1 AND s.pipeline_run_id=$2 AND s.stage_key=$3 AND COALESCE(s.item_key,'')=$4
          ORDER BY s.revision DESC LIMIT 1 FOR UPDATE OF s`,
        [this.scope.workspaceId, input.runId, input.stageKey, input.itemKey ?? ""],
      );
      const stageRow = stage.rows[0];
      if (!stageRow) throw new PipelineControlError("PIPELINE_STAGE_NOT_FOUND", "stage 不存在");
      if (stageRow.revision !== input.expectedStageRevision) {
        throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      }
      if (stageRow.execution_status !== "running") {
        throw new PipelineControlError("PIPELINE_STAGE_NOT_RUNNING", "只有运行中的 stage 可以预留操作");
      }
      const duplicate = await client.query<{ id: string }>(
        "SELECT id FROM video_pipeline_operations WHERE stage_run_id=$1 AND operation_key=$2",
        [stageRow.id, input.operationKey],
      );
      if (duplicate.rows[0]) {
        throw new PipelineControlError("OPERATION_ALREADY_RESERVED", `operationKey ${input.operationKey} 已绑定 ${duplicate.rows[0].id}`);
      }
      const operationId = `OP-${hash({
        runId: input.runId,
        stageRunId: stageRow.id,
        operationKey: input.operationKey,
        requestHash,
      }).slice(0, 24)}`;
      const inserted = await client.query<OperationRow>(
        `INSERT INTO video_pipeline_operations
          (id,tenant_id,workspace_id,project_id,pipeline_run_id,stage_run_id,operation_key,kind,state,
           idempotency_key,request_hash,request,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9,$10,$11::jsonb,$12)
         RETURNING *`,
        [operationId, this.scope.tenantId, this.scope.workspaceId, runRow.project_id, input.runId,
          stageRow.id, input.operationKey, input.kind, input.idempotencyKey, requestHash,
          JSON.stringify(input.request), input.actor.id],
      );
      await client.query(
        `UPDATE video_pipeline_runs
            SET next_action='run_node',revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId],
      );
      await this.appendOutbox(client, input.runId, "operation.reserved", {
        operationId,
        stageRunId: stageRow.id,
        operationKey: input.operationKey,
        kind: input.kind,
        requestHash,
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      const operation = operationRecord(inserted.rows[0]!);
      const response = { operation, run: view };
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "reserveOperation",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision,
        response,
      });
      return response;
    });
  }

  async dispatchOperation(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    operationId: string;
    externalId?: string | null;
    expectedStageRevision: number;
  }): Promise<{ operation: PipelineOperationRecord; run: PipelineRunView }> {
    const plan = assertVideoPipelinePlan(input.plan);
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: { kind: "dispatchOperation", runId: input.runId, operationId: input.operationId, externalId: input.externalId ?? null, planHash: plan.planHash },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<{ operation: PipelineOperationRecord; run: PipelineRunView }>(
        client,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
      const run = await client.query<RunRow>(
        "SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (runRow.plan_hash !== plan.planHash) throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "plan 不一致");
      const operationRows = await client.query<OperationRow>(
        "SELECT * FROM video_pipeline_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.workspaceId, input.operationId],
      );
      const existing = operationRows.rows[0];
      if (!existing || existing.pipeline_run_id !== input.runId) {
        throw new PipelineControlError("OPERATION_NOT_FOUND", "operation 不存在");
      }
      if (existing.state !== "reserved") throw new PipelineControlError("OPERATION_STATE_INVALID", "只有 reserved operation 可以 dispatch");
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT} WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF s`,
        [this.scope.workspaceId, existing.stage_run_id],
      );
      const stageRow = stage.rows[0];
      if (!stageRow || stageRow.revision !== input.expectedStageRevision) {
        throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      }
      if (stageRow.execution_status !== "running") throw new PipelineControlError("PIPELINE_STAGE_NOT_RUNNING", "stage 不在运行态");
      const updated = await client.query<OperationRow>(
        `UPDATE video_pipeline_operations
            SET state='dispatched',external_id=$3,dispatched_at=now()
          WHERE workspace_id=$1 AND id=$2
          RETURNING *`,
        [this.scope.workspaceId, input.operationId, input.externalId ?? null],
      );
      await client.query(
        `UPDATE video_pipeline_runs SET revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId],
      );
      await this.appendOutbox(client, input.runId, "operation.dispatched", {
        operationId: input.operationId,
        stageRunId: existing.stage_run_id,
        externalId: input.externalId ?? null,
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      const operation = operationRecord(updated.rows[0]!);
      const response = { operation, run: view };
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "dispatchOperation",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision,
        response,
      });
      return response;
    });
  }

  async settleOperation(input: CommandEnvelopeInput & {
    plan: CompiledVideoPipelinePlan;
    runId: string;
    operationId: string;
    outcome: "accepted" | "failed" | "unknown";
    receipt?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
    cost?: Record<string, unknown>;
    externalId?: string | null;
    expectedStageRevision: number;
  }): Promise<{ operation: PipelineOperationRecord; run: PipelineRunView }> {
    const plan = assertVideoPipelinePlan(input.plan);
    if (input.outcome === "accepted" && (!input.receipt || Object.keys(input.receipt).length === 0)) {
      throw new PipelineControlError("OPERATION_RECEIPT_REQUIRED", "accepted operation 必须提供真实 receipt");
    }
    if (input.outcome === "failed" && (!input.error || Object.keys(input.error).length === 0)) {
      throw new PipelineControlError("OPERATION_ERROR_REQUIRED", "failed operation 必须提供错误回执");
    }
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      expectedStageRevision: input.expectedStageRevision,
      payload: {
        kind: "settleOperation",
        runId: input.runId,
        operationId: input.operationId,
        outcome: input.outcome,
        receipt: input.receipt ?? null,
        error: input.error ?? null,
        cost: input.cost ?? {},
        externalId: input.externalId ?? null,
        planHash: plan.planHash,
      },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandReplay<{ operation: PipelineOperationRecord; run: PipelineRunView }>(
        client,
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
      const run = await client.query<RunRow>(
        "SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      if (runRow.plan_hash !== plan.planHash) throw new PipelineControlError("PIPELINE_PLAN_NOT_CURRENT", "plan 不一致");
      const operationRows = await client.query<OperationRow>(
        "SELECT * FROM video_pipeline_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.workspaceId, input.operationId],
      );
      const existing = operationRows.rows[0];
      if (!existing || existing.pipeline_run_id !== input.runId) {
        throw new PipelineControlError("OPERATION_NOT_FOUND", "operation 不存在");
      }
      if (existing.state !== "dispatched") throw new PipelineControlError("OPERATION_STATE_INVALID", "只有 dispatched operation 可以结束");
      const stage = await client.query<StageRow>(
        `${STAGE_SELECT} WHERE s.workspace_id=$1 AND s.id=$2 FOR UPDATE OF s`,
        [this.scope.workspaceId, existing.stage_run_id],
      );
      const stageRow = stage.rows[0];
      if (!stageRow || stageRow.revision !== input.expectedStageRevision) {
        throw new PipelineControlError("PIPELINE_STAGE_REVISION_CONFLICT", "stage revision 已变化");
      }
      const updated = await client.query<OperationRow>(
        `UPDATE video_pipeline_operations
            SET state=$3,external_id=COALESCE($4,external_id),receipt=$5::jsonb,cost=$6::jsonb,
                error=$7::jsonb,finished_at=now()
          WHERE workspace_id=$1 AND id=$2
          RETURNING *`,
        [this.scope.workspaceId, input.operationId, input.outcome, input.externalId ?? null,
          input.receipt ? JSON.stringify(input.receipt) : null, JSON.stringify(input.cost ?? {}),
          input.error ? JSON.stringify(input.error) : null],
      );
      if (input.outcome === "failed") {
        await client.query(
          `UPDATE production_stage_runs
              SET execution_status='failed',verification_status='not_run',disposition='repair',
                  status='failed',error_class='EXTERNAL_OPERATION_FAILED',error_msg=$3,finished_at=now()
            WHERE workspace_id=$1 AND id=$2`,
          [this.scope.workspaceId, existing.stage_run_id, String(input.error?.code ?? "EXTERNAL_OPERATION_FAILED")],
        );
      } else if (input.outcome === "unknown") {
        await client.query(
          `UPDATE production_stage_runs
              SET execution_status='interrupted',verification_status='unverified',disposition='reconcile',
                  status='interrupted',error_class='EXTERNAL_OPERATION_UNKNOWN',error_msg='external operation outcome unknown',finished_at=now()
            WHERE workspace_id=$1 AND id=$2`,
          [this.scope.workspaceId, existing.stage_run_id],
        );
      }
      const runStatus = input.outcome === "failed" ? "waiting" : input.outcome === "unknown" ? "reconciling" : "running";
      const nextAction = input.outcome === "failed" ? "repair" : input.outcome === "unknown" ? "reconcile" : "run_node";
      await client.query(
        `UPDATE video_pipeline_runs
            SET status=$3,next_action=$4,
                lease_owner=CASE WHEN $5::boolean THEN lease_owner ELSE NULL END,
                lease_expires_at=CASE WHEN $5::boolean THEN lease_expires_at ELSE NULL END,
                revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId, runStatus, nextAction, input.outcome === "accepted"],
      );
      const eventKind = input.outcome === "accepted" ? "operation.accepted"
        : input.outcome === "failed" ? "operation.failed" : "operation.unknown";
      await this.appendOutbox(client, input.runId, eventKind, {
        operationId: input.operationId,
        stageRunId: existing.stage_run_id,
        receipt: input.receipt ?? null,
        error: input.error ?? null,
        cost: input.cost ?? {},
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      const operation = operationRecord(updated.rows[0]!);
      const response = { operation, run: view };
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "settleOperation",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        expectedStageRevision: input.expectedStageRevision,
        response,
      });
      return response;
    });
  }

  async markInterrupted(input: CommandEnvelopeInput & {
    runId: string;
    reason: string;
    owner: string;
  }): Promise<PipelineRunView> {
    const requestHash = commandRequestHash({
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      expectedRunRevision: input.expectedRunRevision,
      payload: { kind: "markInterrupted", runId: input.runId, reason: input.reason, owner: input.owner },
    });
    return this.transaction(async (client) => {
      const replay = await this.commandRunReplay(client, input.idempotencyKey, requestHash);
      if (replay) return replay;
      const run = await client.query<RunRow>(
        `SELECT * FROM video_pipeline_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [this.scope.workspaceId, input.runId],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 不存在");
      if (positiveInt(runRow.revision, "run.revision") !== input.expectedRunRevision) {
        throw new PipelineControlError("PIPELINE_REVISION_CONFLICT", "run revision 已变化");
      }
      await client.query(
        `UPDATE production_stage_runs
            SET execution_status='interrupted',verification_status='unverified',disposition='reconcile',
                status='interrupted',worker_version=$3,error_class='RECONCILE_REQUIRED',error_msg=$4,
                finished_at=now(),last_heartbeat_at=now()
          WHERE workspace_id=$1 AND pipeline_run_id=$2 AND execution_status='running'`,
        [this.scope.workspaceId, input.runId, input.owner, input.reason.slice(0, 500)],
      );
      await client.query(
        `UPDATE video_pipeline_runs
            SET status='reconciling',next_action='reconcile',lease_owner=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [this.scope.workspaceId, input.runId],
      );
      await this.appendOutbox(client, input.runId, "node.interrupted", {
        owner: input.owner,
        reason: input.reason,
      });
      const view = await this.readRunInTransaction(client, input.runId);
      if (!view) throw new PipelineControlError("PIPELINE_RUN_NOT_FOUND", "run 读取失败");
      await this.recordCommand(client, {
        id: input.commandId,
        runId: input.runId,
        kind: "markInterrupted",
        idempotencyKey: input.idempotencyKey,
        requestHash,
        actor: input.actor,
        expectedRunRevision: input.expectedRunRevision,
        response: { ...view },
      });
      return view;
    });
  }
}
