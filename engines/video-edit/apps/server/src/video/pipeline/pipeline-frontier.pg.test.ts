import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Json } from "@workloom/pipeline-control";
import { compileVideoPipelineDocument } from "@hyperreality/video-pipeline";
import { VideoPipelineRepository } from "./pipeline-repository.js";

const adminUrl = process.env.WORKLOOM_TEST_ADMIN_URL;
const appPassword = process.env.WORKLOOM_TEST_APP_PASSWORD;
const gatewayPassword = process.env.WORKLOOM_TEST_GATEWAY_PASSWORD;
const dbName = `pipeline_frontier_${process.pid}_${Date.now()}`;
const root = resolve(import.meta.dirname, "../../../../..");
const scope = { tenantId: "frontier-tenant", workspaceId: "frontier-workspace" };

describe.skipIf(!adminUrl || !appPassword || !gatewayPassword)("durable pipeline frontier", () => {
  let admin: pg.Client;
  let owner: pg.Client;
  let pool: pg.Pool;
  let repository: VideoPipelineRepository;
  let sequence = 0;
  const plan = compileVideoPipelineDocument({
    quest: "frontier-test", name: "frontier test", version: "1",
    steps: [
      { step_key: "left", name: "Left", owner: "worker", outputs: ["left-output"] },
      { step_key: "right", name: "Right", owner: "worker", outputs: ["right-output"] },
      { step_key: "child", name: "Child", owner: "worker", inputs: ["left-output"], outputs: ["child-output"], depends_on: ["left"] },
    ],
  });
  const dbUrl = (user?: string, password?: string) => {
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    if (user) url.username = user;
    if (password) url.password = password;
    return url.toString();
  };
  const command = (revision: number) => {
    const key = `frontier-${++sequence}`;
    return { commandId: key, idempotencyKey: key, expectedRunRevision: revision, actor: { id: "frontier-test", type: "system" as const } };
  };
  const create = async () => {
    const projectId = `frontier-project-${++sequence}`;
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'frontier','narrative','test')", [projectId, scope.workspaceId]);
    return repository.createRun({ ...command(1), plan, projectId, pipelineKind: "narrative", intentContractId: projectId, intentHash: sha256Json({ projectId }), createdBy: "frontier-test" });
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: dbUrl(), APP_DB_PASSWORD: appPassword!, GATEWAY_DB_PASSWORD: gatewayPassword! },
      stdio: "pipe", maxBuffer: 20 * 1024 * 1024,
    });
    owner = new pg.Client({ connectionString: dbUrl() });
    await owner.connect();
    await owner.query("INSERT INTO tenants (id,name) VALUES ($1,'frontier')", [scope.tenantId]);
    await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ($1,$2,'frontier','frontier-test')", [scope.workspaceId, scope.tenantId]);
    pool = new pg.Pool({ connectionString: dbUrl("workloom_app", appPassword), max: 4 });
    repository = new VideoPipelineRepository(scope, pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    await owner?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("keeps unclaimed roots runnable across repeated refreshes and server reads", async () => {
    let run = await create();
    for (let index = 0; index < 3; index++) {
      run = await repository.refreshFrontier({ ...command(run.revision), plan, runId: run.runId });
      expect(run.currentFrontier).toEqual(["left", "right"]);
      expect(run.nextAction).toBe("run_node");
      expect((await repository.getRun(run.runId))?.currentFrontier).toEqual(["left", "right"]);
      expect(run.stages.find(stage => stage.key === "child")?.executionStatus).toBe("pending");
    }
  });

  it("retains an unclaimed sibling while another root runs", async () => {
    let run = await create();
    run = await repository.claimStage({ ...command(run.revision), plan, runId: run.runId, stageKey: "left", owner: "frontier-worker", expectedStageRevision: 1, leaseMs: 60_000 });
    run = await repository.refreshFrontier({ ...command(run.revision), plan, runId: run.runId });
    expect(run.currentFrontier).toEqual(["right"]);
    expect(run.nextAction).toBe("run_node");
  });

  it("waits for running work when no ready nodes remain", async () => {
    let run = await create();
    for (const stageKey of ["left", "right"]) {
      run = await repository.claimStage({ ...command(run.revision), plan, runId: run.runId, stageKey, owner: "frontier-worker", expectedStageRevision: 1, leaseMs: 60_000 });
    }
    run = await repository.refreshFrontier({ ...command(run.revision), plan, runId: run.runId });
    expect(run.currentFrontier).toEqual([]);
    expect(run.nextAction).toBe("wait_resource");
  });

  it("does not hide a repair blocker when another root remains ready", async () => {
    let run = await create();
    await owner.query("BEGIN");
    try {
      await owner.query("SELECT set_config('app.workspace_id',$1,true), set_config('app.tenant_id',$2,true)", [scope.workspaceId, scope.tenantId]);
      await owner.query("UPDATE production_stage_runs SET execution_status='failed',status='failed',disposition='repair' WHERE pipeline_run_id=$1 AND stage_key='left'", [run.runId]);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
    run = await repository.refreshFrontier({ ...command(run.revision), plan, runId: run.runId });
    expect(run.currentFrontier).toEqual(["right"]);
    expect(run.nextAction).toBe("repair");
    expect(run.status).toBe("waiting");
  });
});
