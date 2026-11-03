import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllPools } from "@workloom/db";
import { DEEPSEEK_INPUT_TOKEN_BASIS } from "@workloom/base/model-router";
import { creativeTextHash } from "@hyperreality/video-studio";
import { acquireProjectLease } from "./archive-host.js";
import { createCreativeExecutionSession, creativeTx, lockCreativeProject, persistCreativeContract } from "./creative-service.js";
import { assertCreativeRenderBinding } from "./creative-render-binding.js";

const isolated = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL);
const suffix = randomUUID();
const workspace = { tenantId: `creative-render-tenant-${suffix}`, workspaceId: `creative-render-ws-${suffix}` };
const model = "deepseek-flash", rawIntent = "成片总时长10秒的窗边故事";
const promptsSha256 = creativeTextHash("fixture:complete-current-prompts");

describe.runIf(isolated)("creative qualification binding (real PostgreSQL and project artifacts)", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let workDir: string;
  beforeAll(async () => {
    workDir = await realpath(await mkdtemp(path.join(tmpdir(), "creative-render-fixture-")));
    vi.stubEnv("HR_WORK_DIR", workDir);
    vi.stubEnv("VM_CREATIVE_MODEL_PRICES", JSON.stringify({ [model]: { inputCnyPerMillion: 1, outputCnyPerMillion: 1 } }));
    vi.stubEnv("VM_CREATIVE_BUDGET_CNY", "10");
    vi.stubEnv("VM_CREATIVE_MAX_CALLS", "10");
    vi.stubEnv("VM_CREATIVE_MAX_TOKENS", "200000");
    vi.stubEnv("VM_CREATIVE_MAX_WALL_MS", "30000");
    await owner.query("INSERT INTO tenants(id,name) VALUES($1,'creative qualification fixture')", [workspace.tenantId]);
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug) VALUES($1,$2,'creative qualification fixture',$1)",
      [workspace.workspaceId, workspace.tenantId]);
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await Promise.all([closeAllPools(), owner.end()]);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  async function fixture<T>(check: (input: Awaited<ReturnType<typeof start>>) => Promise<T>) {
    const projectId = `creative-render-project-${randomUUID()}`;
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,$1,'narrative','fixture')",
      [projectId, workspace.workspaceId]);
    const lease = await acquireProjectLease(workspace, projectId);
    if (!lease) throw new Error("fixture project lease not obtained");
    try { return await check(await start(projectId)); }
    finally { await lease.release(); }
  }

  async function start(projectId: string) {
    const scope = { ...workspace, projectId }, runId = randomUUID();
    const session = await createCreativeExecutionSession({ scope: workspace, projectId, runId, rawIntent,
      isMarketing: false, mode: "enforce", model });
    const proof = { contractHash: session.contract.hash, planHash: session.planHash };
    const readFinal = (ref: string) => readFile(path.join(workDir, "archive", scope.workspaceId, projectId, ref));
    const verify = (changes: Partial<Pick<Parameters<typeof assertCreativeRenderBinding>[0], "sourceProof" | "readFinal" | "attempt" | "promptsSha256" | "runId">> = {}) =>
      creativeTx(scope, client => assertCreativeRenderBinding({ client, scope, runId, attempt: 1, promptsSha256,
        sourceProof: proof, readFinal, ...changes }));
    const complete = async () => {
      await session.beginStage("final");
      await session.completeStage("final", { result: { success: true }, renderBinding: { attempt: 1, promptsSha256 } });
      await session.finish({ success: true });
    };
    return { scope, runId, session, verify, complete };
  }

  it("rejects a running/failed creative source even when the legacy caller reports success", () => fixture(async ({ session, verify }) => {
    await expect(verify()).rejects.toMatchObject({ code: "CREATIVE_SOURCE_UNVERIFIED" });
    await session.finish({ success: false });
    await expect(verify()).rejects.toMatchObject({ code: "CREATIVE_SOURCE_UNVERIFIED" });
    await expect(verify({ runId: "legacy-off-run", sourceProof: undefined })).resolves.toBeUndefined();
  }));

  it("accepts the actual completed stage, and rejects missing proof, different prompt bytes or tampered archive", () => fixture(async ({ complete, verify }) => {
    await complete();
    await expect(verify()).resolves.toBeUndefined();
    await expect(verify({ sourceProof: undefined })).rejects.toMatchObject({ code: "CREATIVE_SOURCE_UNVERIFIED" });
    await expect(verify({ promptsSha256: creativeTextHash("another prompt pack") })).rejects.toMatchObject({ code: "CREATIVE_SOURCE_CHANGED" });
    await expect(verify({ attempt: 2 })).rejects.toMatchObject({ code: "CREATIVE_SOURCE_CHANGED" });
    await expect(verify({ readFinal: async () => Buffer.from("tampered") })).rejects.toMatchObject({ code: "CREATIVE_SOURCE_CHANGED" });
  }));

  it("revokes a completed source after a new effective contract is persisted", () => fixture(async ({ complete, scope, session, verify }) => {
    await complete();
    await creativeTx(scope, async client => {
      await lockCreativeProject(client, scope);
      await persistCreativeContract(client, { scope, rawIntent: "成片总时长20秒的新意图" }, session.contract, "fixture");
    });
    await expect(verify()).rejects.toMatchObject({ code: "CREATIVE_SOURCE_CHANGED" });
  }));

  it("blocks an unreconciled actual reservation before even reading the artifact, including rollback to a legacy attempt", () => fixture(async ({ session, verify }) => {
    await session.beginStage("final");
    await session.beforeModelCall({ requestHash: creativeTextHash("fixture request"), inputChars: 10, requestBytes: 10,
      inputTokenEstimate: 10, inputTokenUpperBound: 1034, inputTokenBasis: DEEPSEEK_INPUT_TOKEN_BASIS, maxOutputTokens: 20, model, attempt: 1 });
    const readFinal = vi.fn(async () => Buffer.from("must not be read"));
    await expect(verify({ runId: "legacy-off-run", sourceProof: undefined, readFinal })).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
    expect(readFinal).not.toHaveBeenCalled();
    await session.finish({ success: false });
  }));
});
