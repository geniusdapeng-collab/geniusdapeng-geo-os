import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactManifestHash, sha256Json, type ArtifactEnvelope, type ArtifactRef } from "@workloom/pipeline-control";
import {
  compileVideoPipelineDocument,
  evaluateVideoSystemAutoApproval,
  loadVideoPipelinePlan,
  type CompiledVideoPipelinePlan,
} from "@hyperreality/video-pipeline";
import { VideoPipelineRepository } from "./pipeline-repository.js";
import { PipelineShadowObserver } from "./shadow.js";

const adminUrl = process.env.WORKLOOM_TEST_ADMIN_URL;
const root = resolve(import.meta.dirname, "../../../../..");
const dbName = `workloom_pipeline_${process.pid}_${Date.now()}`;
const appPassword = process.env.WORKLOOM_TEST_APP_PASSWORD;
const gatewayPassword = process.env.WORKLOOM_TEST_GATEWAY_PASSWORD;
const dbUrl = (name: string, user: string, password: string) => {
  if (!adminUrl) throw new Error("WORKLOOM_TEST_ADMIN_URL missing");
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.username = user;
  url.password = password;
  return url.toString();
};

function artifact(
  id: string,
  logicalId: string,
  sha256: string,
  bytes: number,
  storageRef: string,
  parents: ArtifactEnvelope["parents"] = [],
): ArtifactEnvelope {
  return {
    schemaVersion: "workloom.video-artifact/v1",
    id,
    logicalId,
    role: logicalId,
    revision: 1,
    schema: `workloom.video.${logicalId}/v1`,
    storageRef,
    sha256,
    bytes,
    mediaType: "application/json",
    creator: { kind: "deterministic", id: "pg-test", version: "1" },
    parents,
    metadata: {},
  };
}

describe.skipIf(!adminUrl || !appPassword || !gatewayPassword)("video pipeline repository with PostgreSQL", () => {
  let admin: pg.Client;
  let owner: pg.Client;
  let appPool: pg.Pool;
  let workDir: string;
  let repository: VideoPipelineRepository;
  let plan: CompiledVideoPipelinePlan;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl(dbName, new URL(adminUrl!).username, decodeURIComponent(new URL(adminUrl!).password)),
        APP_DB_PASSWORD: appPassword!,
        GATEWAY_DB_PASSWORD: gatewayPassword!,
      },
      stdio: "pipe",
      maxBuffer: 20 * 1024 * 1024,
    });
    owner = new pg.Client({ connectionString: dbUrl(
      dbName,
      new URL(adminUrl!).username,
      decodeURIComponent(new URL(adminUrl!).password),
    ) });
    await owner.connect();
    await owner.query(`
      INSERT INTO tenants (id,name) VALUES ('T1','test');
      INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ('W1','T1','test','test-pipeline');
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P1','W1','test project','marketing','test');
    `);
    workDir = mkdtempSync(join(tmpdir(), "wl-pipeline-pg-"));
    process.env.HR_WORK_DIR = workDir;
    process.env.DATABASE_APP_URL = dbUrl(dbName, "workloom_app", appPassword!);
    process.env.DATABASE_GATEWAY_URL = dbUrl(dbName, "workloom_gateway", gatewayPassword!);
    appPool = new pg.Pool({ connectionString: dbUrl(dbName, "workloom_app", appPassword!), max: 4 });
    repository = new VideoPipelineRepository({ tenantId: "T1", workspaceId: "W1" }, appPool);
    plan = compileVideoPipelineDocument({
      quest: "test-film",
      name: "test-film",
      version: "1",
      steps: [
        { step_key: "source", name: "Source", owner: "worker", outputs: ["dossier"] },
        {
          step_key: "g1", name: "G1", owner: "director", gate: "G1", inputs: ["dossier"],
          outputs: ["dossier"], depends_on: ["source"],
        },
        {
          step_key: "prd", name: "PRD", owner: "writer", inputs: ["dossier"],
          outputs: ["prd"], depends_on: ["g1"],
        },
        {
          step_key: "g4", name: "G4", owner: "director", gate: "G4", inputs: ["prd"],
          outputs: ["prd"], depends_on: ["prd"],
        },
      ],
    }, { knownPipelines: ["test-film"] });
  }, 30_000);

  afterAll(async () => {
    await appPool?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("runs a source -> G1 -> PRD -> rejected G4 loop without regenerating approved upstream", async () => {
    const intentHash = sha256Json({ intent: "test" });
    const created = await repository.createRun({
      projectId: "P1",
      pipelineKind: "marketing",
      intentContractId: "IC1",
      intentHash,
      createdBy: "test",
      plan,
      idempotencyKey: "start-1",
      commandId: "command-start-1",
      actor: { id: "test", type: "system" },
    });
    expect(created.currentFrontier).toEqual(["source"]);

    const replayed = await repository.createRun({
      projectId: "P1",
      pipelineKind: "marketing",
      intentContractId: "IC1",
      intentHash,
      createdBy: "test",
      plan,
      idempotencyKey: "start-1",
      commandId: "command-start-replay",
      actor: { id: "test", type: "system" },
    });
    expect(replayed.runId).toBe(created.runId);

    const claimedSource = await repository.claimStage({
      plan,
      runId: created.runId,
      stageKey: "source",
      owner: "worker-1",
      commandId: "claim-source",
      idempotencyKey: "claim-source",
      expectedRunRevision: created.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const sourceArtifactRoot = join(workDir, "archive", "W1", "P1", "artifacts");
    mkdirSync(sourceArtifactRoot, { recursive: true });
    const sourceBytes = Buffer.from('{"dossier":"verified"}\n');
    const sourceStorage = "artifacts/source.json";
    writeFileSync(join(workDir, "archive", "W1", "P1", sourceStorage), sourceBytes);
    const sourceArtifact = artifact(
      "A-SOURCE",
      "dossier",
      createHash("sha256").update(sourceBytes).digest("hex"),
      sourceBytes.length,
      sourceStorage,
    );
    const committedSource = await repository.commitArtifact({
      plan,
      runId: created.runId,
      stageKey: "source",
      artifact: sourceArtifact,
      manifestArtifacts: [sourceArtifact],
      commandId: "commit-source",
      idempotencyKey: "commit-source",
      expectedRunRevision: claimedSource.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-1", type: "worker" },
    });
    expect(committedSource.run.leaseOwner).toBeNull();
    expect(committedSource.run.leaseExpiresAt).toBeNull();
    const sourceStage = committedSource.run.stages.find((stage) => stage.key === "source")!;
    expect(sourceStage.executionStatus).toBe("output_ready");
    expect(sourceStage.verificationStatus).toBe("pending");

    const g1Ready = await repository.refreshFrontier({
      plan,
      runId: created.runId,
      commandId: "refresh-g1",
      idempotencyKey: "refresh-g1",
      expectedRunRevision: committedSource.run.revision,
      actor: { id: "test", type: "system" },
    });
    const g1Marker = g1Ready.stages.find((stage) => stage.key === "g1")!;
    const g1Decision = {
      id: "GD-G1",
      runId: created.runId,
      stageRunId: sourceStage.stageRunId,
      gateId: "G1",
      artifactManifestHash: artifactManifestHash([sourceArtifact]),
      planHash: plan.planHash,
      checkSetVersion: "g1/v1",
      rubricVersion: "g1/v1",
      status: "passed" as const,
      reviewer: { kind: "host_rule" as const, id: "test" },
      findings: [],
      evidenceRefs: ["evidence:g1"],
      supersedesDecisionId: null,
      createdAt: new Date().toISOString(),
    };
    const g1Passed = await repository.recordGateDecision({
      plan,
      runId: created.runId,
      gateStageKey: "g1",
      decision: g1Decision,
      findings: [],
      manifestArtifacts: [sourceArtifact],
      commandId: "gate-g1",
      idempotencyKey: "gate-g1",
      expectedRunRevision: g1Ready.revision,
      expectedStageRevision: g1Marker.revision,
      actor: { id: "test", type: "system" },
    });
    expect(g1Passed.stages.find((stage) => stage.key === "source")?.verificationStatus).toBe("passed");

    const prdReady = await repository.refreshFrontier({
      plan,
      runId: created.runId,
      commandId: "refresh-prd",
      idempotencyKey: "refresh-prd",
      expectedRunRevision: g1Passed.revision,
      actor: { id: "test", type: "system" },
    });
    const prdStageReady = prdReady.stages.find((stage) => stage.key === "prd")!;
    const claimedPrd = await repository.claimStage({
      plan,
      runId: created.runId,
      stageKey: "prd",
      owner: "worker-2",
      commandId: "claim-prd",
      idempotencyKey: "claim-prd",
      expectedRunRevision: prdReady.revision,
      expectedStageRevision: prdStageReady.revision,
      leaseMs: 30_000,
    });
    const prdBytes = Buffer.from('{"prd":1}\n');
    const prdStorage = "artifacts/prd-v1.json";
    writeFileSync(join(workDir, "archive", "W1", "P1", prdStorage), prdBytes);
    const prdArtifact = artifact(
      "A-PRD-1",
      "prd",
      createHash("sha256").update(prdBytes).digest("hex"),
      prdBytes.length,
      prdStorage,
      [{ artifactId: sourceArtifact.id, sha256: sourceArtifact.sha256, role: "dossier" }],
    );
    const prdCommitted = await repository.commitArtifact({
      plan,
      runId: created.runId,
      stageKey: "prd",
      artifact: prdArtifact,
      manifestArtifacts: [sourceArtifact, prdArtifact],
      commandId: "commit-prd",
      idempotencyKey: "commit-prd",
      expectedRunRevision: claimedPrd.revision,
      expectedStageRevision: prdStageReady.revision,
      actor: { id: "worker-2", type: "worker" },
    });
    const g4Ready = await repository.refreshFrontier({
      plan,
      runId: created.runId,
      commandId: "refresh-g4",
      idempotencyKey: "refresh-g4",
      expectedRunRevision: prdCommitted.run.revision,
      actor: { id: "test", type: "system" },
    });
    const g4Marker = g4Ready.stages.find((stage) => stage.key === "g4")!;
    const prdStage = prdCommitted.run.stages.find((stage) => stage.key === "prd")!;
    const rejected = await repository.recordGateDecision({
      plan,
      runId: created.runId,
      gateStageKey: "g4",
      decision: {
        id: "GD-G4-REJECTED",
        runId: created.runId,
        stageRunId: prdStage.stageRunId,
        gateId: "G4",
        artifactManifestHash: artifactManifestHash([sourceArtifact, prdArtifact]),
        planHash: plan.planHash,
        checkSetVersion: "g4/v1",
        rubricVersion: "g4/v1",
        status: "rejected",
        reviewer: { kind: "llm_review", id: "reviewer" },
        findings: [{
          code: "G4_DURATION_CONFLICT",
          severity: "P1",
          targetType: "field",
          targetId: "prd.delivery.durationSeconds",
          fieldPath: "$.delivery.durationSeconds",
          expected: 30,
          actual: 31,
          evidenceRefs: ["evidence:g4"],
          repairClass: "deterministic",
          blocking: true,
        }],
        evidenceRefs: ["evidence:g4"],
        supersedesDecisionId: null,
        createdAt: new Date().toISOString(),
      },
      findings: [{
        code: "G4_DURATION_CONFLICT",
        severity: "P1",
        targetType: "field",
        targetId: "prd.delivery.durationSeconds",
        fieldPath: "$.delivery.durationSeconds",
        expected: 30,
        actual: 31,
        evidenceRefs: ["evidence:g4"],
        repairClass: "deterministic",
        blocking: true,
      }],
      manifestArtifacts: [sourceArtifact, prdArtifact],
      commandId: "gate-g4-rejected",
      idempotencyKey: "gate-g4-rejected",
      expectedRunRevision: g4Ready.revision,
      expectedStageRevision: g4Marker.revision,
      actor: { id: "reviewer", type: "system" },
    });
    expect(rejected.nextAction).toBe("repair");
    expect(rejected.stages.find((stage) => stage.key === "source")?.artifact?.sha256).toBe(sourceArtifact.sha256);
    expect(rejected.stages.find((stage) => stage.key === "g1")?.verificationStatus).toBe("passed");

    await expect(owner.query("UPDATE video_artifacts SET role='rewritten' WHERE id='A-PRD-1'"))
      .rejects.toThrow(/append-only/);
    await expect(owner.query("UPDATE video_gate_decisions SET status='passed' WHERE id='GD-G4-REJECTED'"))
      .rejects.toThrow(/append-only/);

    await owner.query(`
      INSERT INTO video_repair_plans
        (id,tenant_id,workspace_id,pipeline_run_id,root_decision_id,target_stage_run_id,target_revision,
         playbook_id,playbook_version,plan_hash,allowed_changes,forbidden_changes,invalidation_closure,
         budget_envelope,requires_approval,status)
      VALUES
        ('RP-G4','T1','W1',$1,'GD-G4-REJECTED',$2,1,'repair-prd-delivery-fields','1',$3,
         '["$.delivery"]'::jsonb,'["$.facts"]'::jsonb,'["g4"]'::jsonb,
         '{"maxAttempts":2,"maxWallMs":1000,"maxModelTokens":100,"maxCny":0}'::jsonb,false,'proposed')
    `, [created.runId, prdStage.stageRunId, "d".repeat(64)]);
    await owner.query(`
      INSERT INTO video_repair_attempts
        (id,tenant_id,workspace_id,repair_plan_id,attempt,input_manifest_hash,status)
      VALUES ('RA-1','T1','W1','RP-G4',1,$1,'running')
    `, [artifactManifestHash([prdArtifact])]);
    await owner.query(`
      UPDATE video_repair_attempts
         SET status='rejected',findings='[{"code":"G4_DURATION_CONFLICT"}]'::jsonb,finished_at=now()
       WHERE id='RA-1'
    `);
    await expect(owner.query("UPDATE video_repair_attempts SET findings='[]'::jsonb WHERE id='RA-1'"))
      .rejects.toThrow(/terminal receipt is immutable/);

    await owner.query(`
      INSERT INTO tenants (id,name) VALUES ('T2','other');
      INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ('W2','T2','other','test-pipeline-other');
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P2','W2','other project','marketing','test');
    `);
    await expect(repository.createRun({
      projectId: "P2",
      pipelineKind: "marketing",
      intentContractId: "IC2",
      intentHash: sha256Json({ intent: "other" }),
      createdBy: "test",
      plan,
      idempotencyKey: "cross-scope-start",
      commandId: "cross-scope-start",
      actor: { id: "test", type: "system" },
    })).rejects.toThrow(/项目不存在或不属于当前作用域/);

    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P3','W1','shadow project','marketing','test')
    `);
    const observedPlan = loadVideoPipelinePlan(
      resolve(root, "bundles/ai-video/pipelines/marketing-film.yml"),
      "marketing-film",
    );
    const observer = new PipelineShadowObserver({ tenantId: "T1", workspaceId: "W1" }, "P3", "LEGACY-RUN-1");
    observer.observeGate("G1_DOSSIER");
    observer.observeGate("G2_THEME");
    observer.observeGate("G3_INSIGHT");
    observer.observeGate("G4_PRD");
    const shadowRunId = await observer.finalize({
      success: true,
      pipelineKind: "marketing",
      intent: "shadow test",
      observedGates: [{ gate: "G1_DOSSIER", approved: true }, { gate: "G4_PRD", approved: true }],
      expectedPlan: observedPlan,
    });
    const shadow = await owner.query<{ status: string; next_action: string }>(
      `SELECT status,next_action FROM video_pipeline_runs WHERE id=$1 AND project_id='P3'`,
      [shadowRunId],
    );
    expect(shadow.rows[0]).toEqual({ status: "completed", next_action: "done" });
  }, 60_000);

  it("persists a passed system-auto-approval receipt without creating an approval row", async () => {
    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P4','W1','auto approval','marketing','test')
    `);
    const autoPlan = compileVideoPipelineDocument({
      quest: "auto-approval-film",
      name: "auto approval film",
      version: "1",
      steps: [
        { step_key: "source", name: "Source", owner: "worker", outputs: ["dossier"] },
        {
          step_key: "g1", name: "G1", owner: "director", gate: "G1",
          inputs: ["dossier"], outputs: ["dossier"], depends_on: ["source"],
        },
      ],
    }, { knownPipelines: ["auto-approval-film"] });
    const run = await repository.createRun({
      projectId: "P4",
      pipelineKind: "marketing",
      intentContractId: "IC-AUTO",
      intentHash: sha256Json({ intent: "auto approval" }),
      createdBy: "test",
      plan: autoPlan,
      idempotencyKey: "auto-start",
      commandId: "auto-start-command",
      actor: { id: "test", type: "system" },
    });
    const claimed = await repository.claimStage({
      plan: autoPlan,
      runId: run.runId,
      stageKey: "source",
      owner: "worker-auto",
      commandId: "auto-claim",
      idempotencyKey: "auto-claim",
      expectedRunRevision: run.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const bytes = Buffer.from('{"dossier":"auto"}\n');
    const storageRef = "artifacts/auto-source.json";
    mkdirSync(join(workDir, "archive", "W1", "P4", "artifacts"), { recursive: true });
    writeFileSync(join(workDir, "archive", "W1", "P4", storageRef), bytes);
    const source = artifact("A-AUTO-SOURCE", "dossier", createHash("sha256").update(bytes).digest("hex"), bytes.length, storageRef);
    const committed = await repository.commitArtifact({
      plan: autoPlan,
      runId: run.runId,
      stageKey: "source",
      artifact: source,
      manifestArtifacts: [source],
      commandId: "auto-commit",
      idempotencyKey: "auto-commit",
      expectedRunRevision: claimed.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-auto", type: "worker" },
    });
    const gateReady = await repository.refreshFrontier({
      plan: autoPlan,
      runId: run.runId,
      commandId: "auto-refresh-gate",
      idempotencyKey: "auto-refresh-gate",
      expectedRunRevision: committed.run.revision,
      actor: { id: "test", type: "system" },
    });
    const marker = gateReady.stages.find((stage) => stage.key === "g1")!;
    const artifactManifest = artifactManifestHash([source]);
    const auto = evaluateVideoSystemAutoApproval(true, {
      gateKey: "G1",
      action: "g1.confirm",
      artifactSha256: source.sha256,
      factHash: source.sha256,
      expectedFactHash: source.sha256,
      deterministicChecks: [{
        id: "schema-current",
        category: "deterministic",
        status: "passed",
        detail: "current artifact matches the deterministic schema",
        evidenceRef: source.storageRef,
      }],
      budget: { status: "passed", detail: "budget remains bounded", evidenceRef: "budget:auto" },
      qualification: { status: "passed", detail: "qualification token matches", evidenceRef: "qualification:auto" },
      permission: { status: "passed", detail: "workspace scope matches", evidenceRef: "permission:auto" },
      fence: { status: "passed", level: "review", detail: "review fence can be converted", evidenceRef: "fence:G1" },
      evidenceRefs: [{ id: "source", kind: "file", sha256: source.sha256, ref: source.storageRef }],
    });
    expect(auto.outcome).toBe("passed");
    const gateNode = autoPlan.nodes.find((node) => node.key === "g1");
    if (!gateNode || gateNode.kind !== "gate") throw new Error("compiled G1 gate missing");
    const decision = {
      id: "GD-AUTO-G1",
      runId: run.runId,
      stageRunId: committed.run.stages.find((stage) => stage.key === "source")!.stageRunId,
      gateId: "G1",
      artifactManifestHash: artifactManifest,
      planHash: autoPlan.planHash,
      checkSetVersion: gateNode.checkSetVersion,
      rubricVersion: gateNode.rubricVersion,
      authority: "system_auto_approval" as const,
      status: "passed" as const,
      reviewer: {
        kind: "system_auto_approval" as const,
        id: auto.receipt.evidenceDigest,
        autoApproval: auto.receipt,
      },
      findings: [],
      evidenceRefs: auto.receipt.evidenceRefs,
      supersedesDecisionId: null,
      createdAt: new Date().toISOString(),
    };
    const passed = await repository.recordGateDecision({
      plan: autoPlan,
      runId: run.runId,
      gateStageKey: "g1",
      decision,
      findings: [],
      manifestArtifacts: [source],
      commandId: "auto-gate",
      idempotencyKey: "auto-gate",
      expectedRunRevision: gateReady.revision,
      expectedStageRevision: marker.revision,
      actor: { id: "video-system-auto-approval", type: "system" },
    });
    expect(passed.stages.find((stage) => stage.key === "source")?.verificationStatus).toBe("passed");
    const outbox = await owner.query(
      "SELECT event_kind FROM video_pipeline_outbox WHERE run_id=$1 ORDER BY created_at",
      [run.runId],
    );
    expect(outbox.rows.some((row) => row.event_kind === "system-auto-approval")).toBe(true);
    const approvals = await owner.query("SELECT count(*)::int AS n FROM approvals WHERE workspace_id='W1'");
    expect(approvals.rows[0]?.n).toBe(0);
  }, 60_000);

  it("marks a running stage as interrupted and exposes it for reconciliation", async () => {
    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P5','W1','reconcile probe','narrative','test')
    `);
    const reconcilePlan = compileVideoPipelineDocument({
      quest: "reconcile-probe",
      name: "reconcile probe",
      version: "1",
      steps: [
        { step_key: "worker", name: "Worker", owner: "worker", outputs: ["payload"] },
        {
          step_key: "g4", name: "G4", owner: "director", gate: "G4",
          inputs: ["payload"], outputs: ["payload"], depends_on: ["worker"],
        },
      ],
    }, { knownPipelines: ["reconcile-probe"] });
    const created = await repository.createRun({
      projectId: "P5",
      pipelineKind: "narrative",
      intentContractId: "IC-RECONCILE",
      intentHash: sha256Json({ intent: "reconcile probe" }),
      createdBy: "test",
      plan: reconcilePlan,
      idempotencyKey: "reconcile-start",
      commandId: "reconcile-start-command",
      actor: { id: "test", type: "system" },
    });
    const claimed = await repository.claimStage({
      plan: reconcilePlan,
      runId: created.runId,
      stageKey: "worker",
      owner: "worker-reconcile",
      commandId: "reconcile-claim",
      idempotencyKey: "reconcile-claim",
      expectedRunRevision: created.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const interrupted = await repository.markInterrupted({
      runId: created.runId,
      reason: "worker stopped before any external operation",
      owner: "worker-reconcile",
      commandId: "reconcile-interrupt",
      idempotencyKey: "reconcile-interrupt",
      expectedRunRevision: claimed.revision,
      actor: { id: "test", type: "system" },
    });
    expect(interrupted.status).toBe("reconciling");
    expect(interrupted.nextAction).toBe("reconcile");
    expect(interrupted.stages.find((stage) => stage.key === "worker")).toMatchObject({
      executionStatus: "interrupted",
      verificationStatus: "unverified",
      disposition: "reconcile",
    });
    const candidates = await repository.listReconcileCandidates();
    expect(candidates.find((candidate) => candidate.runId === created.runId)?.reason).toBe("external_unknown");
  }, 60_000);

  it("requires every declared output slot and freezes the complete ancestor input closure", async () => {
    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES ('P6','W1','artifact closure','narrative','test')
    `);
    const closurePlan = compileVideoPipelineDocument({
      quest: "artifact-closure",
      name: "artifact closure",
      version: "1",
      steps: [
        {
          step_key: "source", name: "Source", owner: "worker",
          outputs: ["alpha", "beta"],
        },
        {
          step_key: "consume", name: "Consume", owner: "worker",
          inputs: ["alpha", "beta"], outputs: ["gamma"], depends_on: ["source"],
        },
        {
          step_key: "g4", name: "G4", owner: "director", gate: "G4",
          inputs: ["gamma"], outputs: ["gamma"], depends_on: ["consume"],
        },
      ],
    }, { knownPipelines: ["artifact-closure"] });
    const run = await repository.createRun({
      projectId: "P6",
      pipelineKind: "narrative",
      intentContractId: "IC-CLOSURE",
      intentHash: sha256Json({ intent: "artifact closure" }),
      createdBy: "test",
      plan: closurePlan,
      idempotencyKey: "closure-start",
      commandId: "closure-start-command",
      actor: { id: "test", type: "system" },
    });
    const claimed = await repository.claimStage({
      plan: closurePlan,
      runId: run.runId,
      stageKey: "source",
      owner: "closure-worker",
      commandId: "closure-claim",
      idempotencyKey: "closure-claim",
      expectedRunRevision: run.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const artifactRoot = join(workDir, "archive", "W1", "P6", "artifacts");
    mkdirSync(artifactRoot, { recursive: true });
    const alphaBytes = Buffer.from('{"alpha":"current"}\n');
    const betaBytes = Buffer.from('{"beta":"current"}\n');
    writeFileSync(join(artifactRoot, "alpha.json"), alphaBytes);
    writeFileSync(join(artifactRoot, "beta.json"), betaBytes);
    const alpha = artifact(
      "A-ALPHA",
      "alpha",
      createHash("sha256").update(alphaBytes).digest("hex"),
      alphaBytes.length,
      "artifacts/alpha.json",
    );
    const beta = artifact(
      "A-BETA",
      "beta",
      createHash("sha256").update(betaBytes).digest("hex"),
      betaBytes.length,
      "artifacts/beta.json",
    );
    await expect(repository.commitArtifact({
      plan: closurePlan,
      runId: run.runId,
      stageKey: "source",
      artifact: alpha,
      artifacts: [alpha],
      manifestArtifacts: [alpha],
      commandId: "closure-incomplete",
      idempotencyKey: "closure-incomplete",
      expectedRunRevision: claimed.revision,
      expectedStageRevision: 1,
      actor: { id: "closure-worker", type: "worker" },
    })).rejects.toThrow(/required output beta/);
    const sourceCommitted = await repository.commitArtifact({
      plan: closurePlan,
      runId: run.runId,
      stageKey: "source",
      artifacts: [alpha, beta],
      manifestArtifacts: [alpha, beta],
      commandId: "closure-source-complete",
      idempotencyKey: "closure-source-complete",
      expectedRunRevision: claimed.revision,
      expectedStageRevision: 1,
      actor: { id: "closure-worker", type: "worker" },
    });
    const sourceRun = sourceCommitted.run;
    const consumedReady = await repository.refreshFrontier({
      plan: closurePlan,
      runId: run.runId,
      commandId: "closure-refresh-consume",
      idempotencyKey: "closure-refresh-consume",
      expectedRunRevision: sourceRun.revision,
      actor: { id: "test", type: "system" },
    });
    const inputManifest = await repository.getStageInputManifest({
      plan: closurePlan,
      runId: run.runId,
      stageKey: "consume",
    });
    expect(inputManifest.refs.map((item) => item.logicalId)).toEqual(["alpha", "beta"]);
    const claimedConsumer = await repository.claimStage({
      plan: closurePlan,
      runId: run.runId,
      stageKey: "consume",
      owner: "closure-worker",
      commandId: "closure-claim-consume",
      idempotencyKey: "closure-claim-consume",
      expectedRunRevision: consumedReady.revision,
      expectedStageRevision: 1,
      leaseMs: 30_000,
    });
    const gammaBytes = Buffer.from('{"gamma":"derived"}\n');
    writeFileSync(join(artifactRoot, "gamma.json"), gammaBytes);
    const gamma = artifact(
      "A-GAMMA",
      "gamma",
      createHash("sha256").update(gammaBytes).digest("hex"),
      gammaBytes.length,
      "artifacts/gamma.json",
      [
        { artifactId: alpha.id, sha256: alpha.sha256, role: alpha.role },
        { artifactId: beta.id, sha256: beta.sha256, role: beta.role },
      ],
    );
    const completeManifest = [alpha, beta, gamma];
    const consumed = await repository.commitArtifact({
      plan: closurePlan,
      runId: run.runId,
      stageKey: "consume",
      artifact: gamma,
      artifacts: [gamma],
      manifestArtifacts: completeManifest,
      commandId: "closure-commit-consume",
      idempotencyKey: "closure-commit-consume",
      expectedRunRevision: claimedConsumer.revision,
      expectedStageRevision: 1,
      actor: { id: "closure-worker", type: "worker" },
    });
    expect(consumed.run.stages.find((stage) => stage.key === "consume")?.artifact?.id).toBe(gamma.id);
  }, 60_000);

  it("persists reserve, dispatch and terminal external operation receipts without replaying unknown work", async () => {
    await owner.query(`
      INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
      VALUES
        ('P7','W1','unknown operation','narrative','test'),
        ('P8','W1','accepted operation','narrative','test')
    `);
    const operationPlan = compileVideoPipelineDocument({
      quest: "operation-fixture",
      name: "operation fixture",
      version: "1",
      steps: [{
        step_key: "provider",
        name: "Provider action",
        owner: "provider-worker",
        outputs: ["provider_asset"],
        side_effect: "provider",
      }],
    }, { knownPipelines: ["operation-fixture"] });

    const startAndClaim = async (projectId: string) => {
      const run = await repository.createRun({
        projectId,
        pipelineKind: "narrative",
        intentContractId: `IC-${projectId}`,
        intentHash: sha256Json({ projectId }),
        createdBy: "test",
        plan: operationPlan,
        idempotencyKey: `start-${projectId}`,
        commandId: `start-${projectId}`,
        actor: { id: "test", type: "system" },
      });
      return repository.claimStage({
        plan: operationPlan,
        runId: run.runId,
        stageKey: "provider",
        owner: `worker-${projectId}`,
        commandId: `claim-${projectId}`,
        idempotencyKey: `claim-${projectId}`,
        expectedRunRevision: run.revision,
        expectedStageRevision: 1,
        leaseMs: 60_000,
      });
    };

    const unknownRun = await startAndClaim("P7");
    const reserved = await repository.reserveOperation({
      plan: operationPlan,
      runId: unknownRun.runId,
      stageKey: "provider",
      operationKey: "provider-submit",
      kind: "provider.submit",
      request: { projectId: "P7", promptSha256: "a".repeat(64) },
      commandId: "reserve-P7",
      idempotencyKey: "reserve-P7",
      expectedRunRevision: unknownRun.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P7", type: "worker" },
    });
    const dispatched = await repository.dispatchOperation({
      plan: operationPlan,
      runId: unknownRun.runId,
      operationId: reserved.operation.id,
      externalId: "provider-unknown",
      commandId: "dispatch-P7",
      idempotencyKey: "dispatch-P7",
      expectedRunRevision: reserved.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P7", type: "worker" },
    });
    await expect(repository.reserveOperation({
      plan: operationPlan,
      runId: unknownRun.runId,
      stageKey: "provider",
      operationKey: "provider-submit",
      kind: "provider.submit",
      request: { projectId: "P7", promptSha256: "a".repeat(64) },
      commandId: "reserve-P7-duplicate",
      idempotencyKey: "reserve-P7-duplicate",
      expectedRunRevision: dispatched.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P7", type: "worker" },
    })).rejects.toThrow(/operationKey|already/);
    const unknown = await repository.settleOperation({
      plan: operationPlan,
      runId: unknownRun.runId,
      operationId: reserved.operation.id,
      outcome: "unknown",
      receipt: { responseLost: true },
      error: { code: "PROVIDER_RESULT_UNKNOWN" },
      cost: { cny: null },
      commandId: "unknown-P7",
      idempotencyKey: "unknown-P7",
      expectedRunRevision: dispatched.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P7", type: "worker" },
    });
    expect(unknown.operation).toMatchObject({ state: "unknown", externalId: "provider-unknown" });
    expect(unknown.run).toMatchObject({ status: "reconciling", nextAction: "reconcile" });
    expect(unknown.run.leaseOwner).toBeNull();
    expect(unknown.run.leaseExpiresAt).toBeNull();
    expect(unknown.run.stages.find((stage) => stage.key === "provider")).toMatchObject({
      executionStatus: "interrupted",
      verificationStatus: "unverified",
      disposition: "reconcile",
    });
    const unknownEvents = await owner.query<{ event_kind: string }>(
      "SELECT event_kind FROM video_pipeline_outbox WHERE run_id=$1 ORDER BY created_at",
      [unknownRun.runId],
    );
    expect(unknownEvents.rows.map((row) => row.event_kind)).toEqual(expect.arrayContaining([
      "operation.reserved", "operation.dispatched", "operation.unknown",
    ]));
    await expect(repository.dispatchOperation({
      plan: operationPlan,
      runId: unknownRun.runId,
      operationId: reserved.operation.id,
      externalId: "duplicate-dispatch",
      commandId: "dispatch-again-P7",
      idempotencyKey: "dispatch-again-P7",
      expectedRunRevision: unknown.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P7", type: "worker" },
    })).rejects.toThrow(/dispatched operation|reserved operation/);

    const acceptedRun = await startAndClaim("P8");
    const acceptedRoot = join(workDir, "archive", "W1", "P8", "artifacts");
    mkdirSync(acceptedRoot, { recursive: true });
    const acceptedBytes = Buffer.from('{"provider_asset":"accepted"}\n');
    writeFileSync(join(acceptedRoot, "provider.json"), acceptedBytes);
    const providerArtifact = artifact(
      "A-PROVIDER",
      "provider_asset",
      createHash("sha256").update(acceptedBytes).digest("hex"),
      acceptedBytes.length,
      "artifacts/provider.json",
    );
    await expect(repository.commitArtifact({
      plan: operationPlan,
      runId: acceptedRun.runId,
      stageKey: "provider",
      artifact: providerArtifact,
      manifestArtifacts: [providerArtifact],
      commandId: "commit-before-operation",
      idempotencyKey: "commit-before-operation",
      expectedRunRevision: acceptedRun.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P8", type: "worker" },
    })).rejects.toThrow(/operation receipt/);
    const acceptedReserved = await repository.reserveOperation({
      plan: operationPlan,
      runId: acceptedRun.runId,
      stageKey: "provider",
      operationKey: "provider-submit",
      kind: "provider.submit",
      request: { projectId: "P8", promptSha256: "b".repeat(64) },
      commandId: "reserve-P8",
      idempotencyKey: "reserve-P8",
      expectedRunRevision: acceptedRun.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P8", type: "worker" },
    });
    const acceptedDispatched = await repository.dispatchOperation({
      plan: operationPlan,
      runId: acceptedRun.runId,
      operationId: acceptedReserved.operation.id,
      externalId: "provider-accepted",
      commandId: "dispatch-P8",
      idempotencyKey: "dispatch-P8",
      expectedRunRevision: acceptedReserved.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P8", type: "worker" },
    });
    const accepted = await repository.settleOperation({
      plan: operationPlan,
      runId: acceptedRun.runId,
      operationId: acceptedReserved.operation.id,
      outcome: "accepted",
      receipt: { taskId: "provider-accepted", sha256: "c".repeat(64) },
      cost: { cny: 0, paidCalls: 1 },
      commandId: "accepted-P8",
      idempotencyKey: "accepted-P8",
      expectedRunRevision: acceptedDispatched.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P8", type: "worker" },
    });
    expect(accepted.operation.state).toBe("accepted");
    expect(accepted.run.status).toBe("running");
    expect(accepted.run.leaseOwner).toBe("worker-P8");
    await expect(owner.query(
      "UPDATE video_pipeline_operations SET receipt=$2::jsonb WHERE id=$1",
      [acceptedReserved.operation.id, JSON.stringify({ forged: true })],
    )).rejects.toThrow(/terminal video operation receipt is immutable/);
    await expect(owner.query(
      "DELETE FROM video_pipeline_operations WHERE id=$1",
      [acceptedReserved.operation.id],
    )).rejects.toThrow(/append-only/);
    const committed = await repository.commitArtifact({
      plan: operationPlan,
      runId: acceptedRun.runId,
      stageKey: "provider",
      artifact: providerArtifact,
      manifestArtifacts: [providerArtifact],
      commandId: "commit-P8",
      idempotencyKey: "commit-P8",
      expectedRunRevision: accepted.run.revision,
      expectedStageRevision: 1,
      actor: { id: "worker-P8", type: "worker" },
    });
    expect(committed.run.stages.find((stage) => stage.key === "provider")?.artifact?.id).toBe(providerArtifact.id);
  }, 60_000);
});
