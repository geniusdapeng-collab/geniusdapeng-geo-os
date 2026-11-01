import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Json } from "@workloom/pipeline-control";
import { compileVideoPipelineDocument } from "@hyperreality/video-pipeline";
import { VideoPipelineRepository } from "./pipeline-repository.js";

const adminUrl = process.env.WORKLOOM_TEST_ADMIN_URL;
const appUrl = process.env.DATABASE_APP_URL;
const gatewayUrl = process.env.DATABASE_GATEWAY_URL;

describe.skipIf(!adminUrl || !appUrl || !gatewayUrl)("pipeline control concurrency stress", () => {
  const scope = { tenantId: "stress-tenant", workspaceId: "stress-workspace" };
  const owner = new pg.Client({ connectionString: adminUrl });
  const pool = new pg.Pool({ connectionString: appUrl, max: 24 });
  const repository = new VideoPipelineRepository(scope, pool);
  const plan = compileVideoPipelineDocument({
    quest: "stress-provider",
    name: "stress provider",
    version: "1",
    steps: [{
      step_key: "provider",
      name: "Provider",
      owner: "provider-worker",
      outputs: ["provider_asset"],
      side_effect: "provider",
    }],
  }, { knownPipelines: ["stress-provider"] });

  beforeAll(async () => {
    await owner.connect();
    await owner.query(
      "INSERT INTO tenants (id,name) VALUES ($1,'stress') ON CONFLICT (id) DO NOTHING",
      [scope.tenantId],
    );
    await owner.query(
      `INSERT INTO workspaces (id,tenant_id,name,slug)
       VALUES ($2,$1,'stress','stress-workspace') ON CONFLICT (id) DO NOTHING`,
      [scope.tenantId, scope.workspaceId],
    );
    await owner.query(
      `INSERT INTO video_projects (id,workspace_id,title,kind,created_by)
       SELECT 'STRESS-' || n, $1, 'stress ' || n, 'narrative', 'stress'
         FROM generate_series(1, 50) AS n`,
      [scope.workspaceId],
    );
  }, 30_000);

  afterAll(async () => {
    await pool.end().catch(() => undefined);
    await owner.end().catch(() => undefined);
  });

  it("serializes 8 competing workers per run and persists 50 unknown operations for reconcile", async () => {
    const started = performance.now();
    const runs = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
      const projectId = `STRESS-${index + 1}`;
      return repository.createRun({
        projectId,
        pipelineKind: "narrative",
        intentContractId: `stress:${projectId}`,
        intentHash: sha256Json({ projectId }),
        createdBy: "stress",
        plan,
        idempotencyKey: `stress-start:${projectId}`,
        commandId: `stress-start:${projectId}`,
        actor: { id: "stress", type: "system" },
      });
    }));

    const races = await Promise.all(runs.map(async (run) => {
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, async (_, worker) => {
        return repository.claimStage({
          plan,
          runId: run.runId,
          stageKey: "provider",
          owner: `worker-${worker}`,
          commandId: `claim:${run.runId}:${worker}`,
          idempotencyKey: `claim:${run.runId}:${worker}`,
          expectedRunRevision: run.revision,
          expectedStageRevision: 1,
          leaseMs: 60_000,
        });
      }));
      const winners = attempts.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      expect(winners).toHaveLength(1);
      return winners[0]!;
    }));

    const reserved = await Promise.all(races.map(async (run, index) => repository.reserveOperation({
      plan,
      runId: run.runId,
      stageKey: "provider",
      operationKey: "provider-submit",
      kind: "provider.submit",
      request: { projectId: `STRESS-${index + 1}`, fixture: "concurrency" },
      commandId: `reserve:${run.runId}`,
      idempotencyKey: `reserve:${run.runId}`,
      expectedRunRevision: run.revision,
      expectedStageRevision: 1,
      actor: { id: "stress-worker", type: "worker" },
    })));
    const dispatched = await Promise.all(reserved.map(async ({ operation, run }) => repository.dispatchOperation({
      plan,
      runId: run.runId,
      operationId: operation.id,
      externalId: `external:${operation.id}`,
      commandId: `dispatch:${operation.id}`,
      idempotencyKey: `dispatch:${operation.id}`,
      expectedRunRevision: run.revision,
      expectedStageRevision: 1,
      actor: { id: "stress-worker", type: "worker" },
    })));
    const settled = await Promise.all(dispatched.map(async ({ operation, run }) => repository.settleOperation({
      plan,
      runId: run.runId,
      operationId: operation.id,
      outcome: "unknown",
      receipt: { responseLost: true },
      error: { code: "STRESS_PROVIDER_UNKNOWN" },
      cost: { cny: null },
      commandId: `unknown:${operation.id}`,
      idempotencyKey: `unknown:${operation.id}`,
      expectedRunRevision: run.revision,
      expectedStageRevision: 1,
      actor: { id: "stress-worker", type: "worker" },
    })));

    expect(settled.every(({ operation }) => operation.state === "unknown")).toBe(true);
    expect(settled.every(({ run }) => run.status === "reconciling" && run.nextAction === "reconcile")).toBe(true);
    const operations = await owner.query<{ state: string }>(
      "SELECT state FROM video_pipeline_operations WHERE workspace_id=$1",
      [scope.workspaceId],
    );
    expect(operations.rows).toHaveLength(50);
    expect(operations.rows.every((row) => row.state === "unknown")).toBe(true);
    const dispatchEvents = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM video_pipeline_outbox
        WHERE workspace_id=$1 AND event_kind='operation.dispatched'`,
      [scope.workspaceId],
    );
    expect(Number(dispatchEvents.rows[0]?.n)).toBe(50);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 45_000);
});
