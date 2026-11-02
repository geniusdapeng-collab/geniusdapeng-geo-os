import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactManifestHash, sha256Json, type ArtifactEnvelope } from "@workloom/pipeline-control";
import { compileVideoPipelineDocument } from "@hyperreality/video-pipeline";
import { VideoPipelineRepository, type PipelineRunView } from "./pipeline-repository.js";

const adminUrl = process.env.WORKLOOM_TEST_ADMIN_URL;
const appPassword = process.env.WORKLOOM_TEST_APP_PASSWORD;
const gatewayPassword = process.env.WORKLOOM_TEST_GATEWAY_PASSWORD;
const root = resolve(import.meta.dirname, "../../../../..");
const dbName = `pipeline_replay_${process.pid}_${Date.now()}`;
const methods = ["createRun", "claimStage", "commitArtifact", "refreshFrontier", "recordGateDecision", "markInterrupted"] as const;
type ReplayMethod = typeof methods[number];
type Response = PipelineRunView | { run: PipelineRunView; artifactManifestHash: string };

describe.skipIf(!adminUrl || !appPassword || !gatewayPassword)("pipeline command response replay with PostgreSQL", () => {
  let admin: pg.Client;
  let owner: pg.Client;
  let pool: pg.Pool;
  let repository: VideoPipelineRepository;
  let workDir: string;
  let previousWorkDir: string | undefined;
  const databaseUrl = (user?: string, password?: string) => {
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    if (user) url.username = user;
    if (password) url.password = password;
    return url.toString();
  };
  const plan = compileVideoPipelineDocument({
    quest: "command-replay",
    name: "command response replay",
    version: "1",
    steps: [
      { step_key: "source", name: "Source", owner: "worker", outputs: ["dossier"] },
      { step_key: "g1", name: "G1", owner: "director", gate: "G1", inputs: ["dossier"], outputs: ["dossier"], depends_on: ["source"] },
      { step_key: "consumer", name: "Consumer", owner: "worker", inputs: ["dossier"], outputs: ["payload"], depends_on: ["g1"] },
    ],
  }, { knownPipelines: ["command-replay"] });

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl(), APP_DB_PASSWORD: appPassword!, GATEWAY_DB_PASSWORD: gatewayPassword! },
      stdio: "pipe",
      maxBuffer: 20 * 1024 * 1024,
    });
    owner = new pg.Client({ connectionString: databaseUrl() });
    await owner.connect();
    await owner.query(`
      INSERT INTO tenants (id,name) VALUES ('REPLAY-T','command replay');
      INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ('REPLAY-W','REPLAY-T','command replay','command-replay');
    `);
    pool = new pg.Pool({ connectionString: databaseUrl("workloom_app", appPassword!), max: 4 });
    repository = new VideoPipelineRepository({ tenantId: "REPLAY-T", workspaceId: "REPLAY-W" }, pool);
    workDir = mkdtempSync(join(tmpdir(), "pipeline-command-replay-"));
    previousWorkDir = process.env.HR_WORK_DIR;
    process.env.HR_WORK_DIR = workDir;
  }, 30_000);

  afterAll(async () => {
    if (previousWorkDir === undefined) delete process.env.HR_WORK_DIR;
    else process.env.HR_WORK_DIR = previousWorkDir;
    await pool?.end();
    await owner?.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
      finally { await admin.end(); }
    }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  const cases = methods.flatMap((method) => [
    { method, legacy: false, label: "exact stored response" },
    { method, legacy: true, label: "historical partial receipt" },
  ]);
  it.each(cases)("$method restores $label without repeating state changes", async ({ method, legacy }) => {
    const projectId = `REPLAY-${method}-${legacy ? "legacy" : "current"}`;
    await owner.query(
      "INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,'REPLAY-W',$1,'marketing','test')",
      [projectId],
    );
    const system = { id: "replay-test", type: "system" as const };
    const worker = { id: "replay-worker", type: "worker" as const };
    const command = (name: string) => ({ commandId: `${projectId}:${name}`, idempotencyKey: `${projectId}:${name}` });
    const captured = new Map<ReplayMethod, { response: Response; invoke: () => Promise<Response>; key: string; partial: Record<string, unknown> }>();
    const capture = async (name: ReplayMethod, invoke: () => Promise<Response>, partial: (response: Response) => Record<string, unknown>) => {
      const response = await invoke();
      captured.set(name, { response, invoke, key: command(name).idempotencyKey, partial: partial(response) });
      return response;
    };
    const start = { projectId, pipelineKind: "marketing" as const, intentContractId: `IC:${projectId}`,
      intentHash: sha256Json({ projectId }), createdBy: "test", plan, ...command("createRun"), actor: system };
    const created = await capture("createRun", () => repository.createRun(start), (response) => ({ runId: (response as PipelineRunView).runId })) as PipelineRunView;
    const claim = { plan, runId: created.runId, stageKey: "source", owner: worker.id,
      ...command("claimStage"), expectedRunRevision: created.revision, expectedStageRevision: 1, leaseMs: 30_000 };
    const claimed = await capture("claimStage", () => repository.claimStage(claim), (response) => ({
      runId: created.runId, stageRunId: (response as PipelineRunView).stages.find((stage) => stage.key === "source")!.stageRunId,
    })) as PipelineRunView;
    const bytes = Buffer.from(JSON.stringify({ dossier: projectId }));
    const storageRef = "artifacts/source.json";
    const archive = join(workDir, "archive", "REPLAY-W", projectId);
    mkdirSync(join(archive, "artifacts"), { recursive: true });
    writeFileSync(join(archive, storageRef), bytes);
    const source: ArtifactEnvelope = {
      schemaVersion: "workloom.video-artifact/v1", id: `A:${projectId}`, logicalId: "dossier", role: "dossier",
      revision: 1, schema: "workloom.video.dossier/v1", storageRef,
      sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, mediaType: "application/json",
      creator: { kind: "deterministic", id: "replay-test", version: "1" }, parents: [], metadata: {},
    };
    const commit = { plan, runId: created.runId, stageKey: "source", artifact: source, manifestArtifacts: [source],
      ...command("commitArtifact"), expectedRunRevision: claimed.revision, expectedStageRevision: 1, actor: worker };
    const committed = await capture("commitArtifact", () => repository.commitArtifact(commit), (response) => ({
      runId: created.runId, artifactManifestHash: (response as { artifactManifestHash: string }).artifactManifestHash,
    })) as { run: PipelineRunView; artifactManifestHash: string };
    const refresh = { plan, runId: created.runId, ...command("refreshFrontier"),
      expectedRunRevision: committed.run.revision, actor: system };
    const ready = await capture("refreshFrontier", () => repository.refreshFrontier(refresh), () => ({ runId: created.runId })) as PipelineRunView;
    const sourceStage = ready.stages.find((stage) => stage.key === "source")!;
    const gate = { plan, runId: created.runId, gateStageKey: "g1", decision: {
      id: `GD:${projectId}`, runId: created.runId, stageRunId: sourceStage.stageRunId, gateId: "G1",
      artifactManifestHash: artifactManifestHash([source]), planHash: plan.planHash, checkSetVersion: "g1/v1", rubricVersion: "g1/v1",
      status: "passed" as const, reviewer: { kind: "host_rule" as const, id: "replay-test" }, findings: [], evidenceRefs: ["evidence:replay"],
      supersedesDecisionId: null, createdAt: new Date().toISOString(),
    }, findings: [], manifestArtifacts: [source], ...command("recordGateDecision"),
    expectedRunRevision: ready.revision, expectedStageRevision: 1, actor: system };
    const passed = await capture("recordGateDecision", () => repository.recordGateDecision(gate), () => ({ runId: created.runId, decisionId: gate.decision.id })) as PipelineRunView;
    const consumerReady = await repository.refreshFrontier({ plan, runId: created.runId, ...command("ready-consumer"),
      expectedRunRevision: passed.revision, actor: system });
    const consumerClaimed = await repository.claimStage({ plan, runId: created.runId, stageKey: "consumer", owner: worker.id,
      ...command("claim-consumer"), expectedRunRevision: consumerReady.revision, expectedStageRevision: 1, leaseMs: 30_000 });
    const interrupt = { runId: created.runId, reason: "worker interrupted before any external action", owner: worker.id,
      ...command("markInterrupted"), expectedRunRevision: consumerClaimed.revision, actor: system };
    const current = await capture("markInterrupted", () => repository.markInterrupted(interrupt), () => ({ runId: created.runId })) as PipelineRunView;
    const target = captured.get(method)!;
    if (legacy) {
      // Model receipts written by the pre-fix version; production history stays immutable during recovery.
      await owner.query("UPDATE video_pipeline_commands SET response_json=$2::jsonb WHERE workspace_id='REPLAY-W' AND idempotency_key=$1", [target.key, JSON.stringify(target.partial)]);
    }
    const before = await owner.query("SELECT event_kind,payload FROM video_pipeline_outbox WHERE run_id=$1 ORDER BY id", [created.runId]);
    const replayed = await target.invoke();
    const expected = legacy
      ? method === "commitArtifact" ? { run: current, artifactManifestHash: committed.artifactManifestHash } : current
      : target.response;
    expect(replayed).toEqual(expected);
    expect(await repository.getRun(created.runId)).toEqual(current);
    const after = await owner.query("SELECT event_kind,payload FROM video_pipeline_outbox WHERE run_id=$1 ORDER BY id", [created.runId]);
    expect(after.rows).toEqual(before.rows);
    const receipt = await owner.query("SELECT response_json FROM video_pipeline_commands WHERE workspace_id='REPLAY-W' AND idempotency_key=$1", [target.key]);
    expect(receipt.rows[0].response_json).toEqual(legacy ? target.partial : target.response);
    const commands = await owner.query("SELECT count(*)::int AS n FROM video_pipeline_commands WHERE workspace_id='REPLAY-W' AND idempotency_key=$1", [target.key]);
    expect(commands.rows[0].n).toBe(1);
    await expect(repository.createRun({ ...start, intentHash: sha256Json({ changed: projectId }) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  }, 60_000);
});
