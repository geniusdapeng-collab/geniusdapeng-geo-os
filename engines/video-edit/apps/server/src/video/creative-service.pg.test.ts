import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeAllPools } from "@workloom/db";
import { buildCreativeShots, compileCreativeContract, CREATIVE_ART_DIMENSIONS, creativeHash, creativeTextHash,
  type CreativeFinding, type CreativeScope } from "@hyperreality/video-studio";
import type { TrpcContext } from "../trpc/context.js";
import { acquireProjectLease, makeLedgerWriter, projectRunLockKey } from "./archive-host.js";
import { readStageBreakpoints, resumeProject } from "./archive-resume.js";
import { assertNoCreativePendingUsage, createCreativeExecutionSession, creativeTx, insertCreativeArtifact, insertCreativeStage, linkCreativeArtifacts,
  verifyCreativeMarketingSource, type CreativeArtifact } from "./creative-service.js";
import { withCreativeExternalBudget } from "./creative-external-budget.js";
import { createApiSearchRunner } from "./data-mining-executor.js";
import { compileLegacyShadowPlan } from "./pipeline/shadow.js";

vi.mock("./marketing-source-fetcher.js", async original => {
  const module = await original<typeof import("./marketing-source-fetcher.js")>();
  return { ...module, fetchMarketingSourceWithRetry: async (url: string) => {
    const text = "星野风扇支持 9 档风量。", sha256 = creativeTextHash(text);
    return { snapshot: { sourceId: `SRC-${creativeTextHash(`${url}\n${sha256}`).slice(0, 24)}`, requestedUrl: url,
      finalUrl: url, redirectChain: [], fetchedAt: new Date().toISOString(), contentType: "text/plain", rawSha256: sha256,
      textSha256: sha256, bytes: Buffer.byteLength(text), text, assetUrls: [] }, rawBytes: Buffer.from(text) };
  } };
});

const adminUrl = process.env.WORKLOOM_TEST_ADMIN_URL;
const appPassword = process.env.WORKLOOM_TEST_APP_PASSWORD;
const gatewayPassword = process.env.WORKLOOM_TEST_GATEWAY_PASSWORD;
const root = resolve(import.meta.dirname, "../../../..");
const dbName = `creative_${process.pid}_${Date.now()}`;
const baseScope = { tenantId: "C-T", workspaceId: "C-W" };
const ownerIdentity = { kind: "member", ...baseScope, memberId: "C-M", memberNo: "MEM-C", name: "creative",
  plan: "pro", role: "owner" } as const;
const fixtureIntent = "制作总时长 6 秒的窗边故事，保留 café <&>。";
const model = "deepseek-flash";

describe.skipIf(!adminUrl || !appPassword || !gatewayPassword)("creative tRPC and execution journal in PostgreSQL", () => {
  let admin: pg.Client, database: pg.Client, workDir: string, mockModel: Server;
  let videoRouter: typeof import("./router.js")["videoRouter"];
  let posts = 0, searchPosts = 0, projectIndex = 0, localOrigin: string;
  const databaseUrl = (user?: string, password?: string) => {
    const url = new URL(adminUrl!);
    url.pathname = `/${dbName}`;
    if (user) url.username = user;
    if (password) url.password = password;
    return url.toString();
  };
  const caller = (identity: TrpcContext["identity"] = ownerIdentity) => videoRouter.createCaller({
    identity, session: identity, headers: new Headers(), partnerIdentity: null,
  }).studio;
  const project = async (kind: "narrative" | "marketing" = "narrative") => {
    const projectId = `C-P-${++projectIndex}`;
    await database.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,$1,$3,'MEM-C')",
      [projectId, baseScope.workspaceId, kind]);
    return projectId;
  };
  const start = (projectId: string, runId = randomUUID(), rawIntent = fixtureIntent, isMarketing = false) => createCreativeExecutionSession({
    scope: baseScope, projectId, runId, rawIntent, isMarketing, mode: "enforce", model,
  });
  const modelRequest = (attempt: number) => ({ attempt, model, requestHash: creativeHash({ attempt }),
    inputChars: 100, maxOutputTokens: 100 });
  const known = { usageKnown: true, success: true, inputTokens: 10, outputTokens: 20 };

  it("creates the third route with its real scoped 16:9 draft and refuses a Studio restart", async () => {
    const video = videoRouter.createCaller({ identity: ownerIdentity, session: ownerIdentity, headers: new Headers(), partnerIdentity: null });
    const beforePosts = posts;
    const draft = await video.explainer.create({ intent: "制作口播解说", scriptText: "解释一个案例。", aspect: "16:9" });
    const row = (await database.query<{ kind: string; render_scope: { aspect: string } }>(
      `SELECT p.kind,s.render_scope FROM video_projects p JOIN explainer_shotbooks s ON s.project_id=p.id AND s.workspace_id=p.workspace_id
       WHERE p.workspace_id=$1 AND p.id=$2 AND s.id=$3`,
      [baseScope.workspaceId, draft.projectId, draft.shotbookId])).rows[0];
    expect(row).toMatchObject({ kind: "explainer", render_scope: { aspect: "16:9" } });
    await expect(video.studio.start({ projectId: draft.projectId, intent: "制作叙事短片" }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(video.studio.resume({ projectId: draft.projectId, fromStage: "preproduction" }))
      .resolves.toMatchObject({ kind: "noaction", message: expect.stringContaining("专属入口") });
    expect(posts).toBe(beforePosts);
  });

  it.each(["known", "unknown"])("known-scope archive resume after %s billed result uses the immutable attempt or dispatches nothing", async result => {
    const projectId = await project();
    const runId = randomUUID(), scope = { ...baseScope, projectId };
    const rawIntent = "使用完整客户原文与 café 标记，制作总时长六秒的窗边叙事。".repeat(12);
    const metadata = { brief: { audience: "技术团队", style: "实拍" } };
    const lock = await acquireProjectLease(baseScope, projectId);
    if (!lock) throw new Error("fixture project lease unavailable");
    let acceptedContract: ReturnType<typeof compileCreativeContract>;
    try {
      const session = await createCreativeExecutionSession({ scope: baseScope, projectId, runId, rawIntent, metadata,
        isMarketing: false, mode: "enforce", model });
      acceptedContract = session.contract;
      const ledger = makeLedgerWriter(baseScope);
      const stage = await ledger.claimRun({ id: randomUUID(), projectId, stageId: "preproduction",
        inputRefTemplate: "stages/preproduction/attempt-{attempt}.input.json", runId });
      await session.beginStage("phase3");
      const reservation = await session.beforeModelCall(modelRequest(1));
      await session.afterModelCall(reservation, result === "known" ? known : { usageKnown: false, success: false });
      await session.finish({ success: false });
      await ledger.finishRun({ projectId, stageId: "preproduction", attempt: stage.attempt, status: "failed",
        outputRef: null, outputSha256: null, errorClass: "PHASE_3_INTERRUPTED", errorMsg: null, durationMs: 100 });
    } finally { await lock.release(); }

    expect((await readStageBreakpoints(baseScope, projectId)).map(row => row.stageId)).toEqual(["preproduction"]);
    const startRun = vi.fn(() => "RUN-RESUME");
    const beforePosts = posts;
    const outcome = await resumeProject(baseScope, { projectId, startRun, actor: { id: "MEM-C", type: "human" } });
    if (result === "known") {
      expect(outcome).toMatchObject({ kind: "resumed", attempt: 1, runId: "RUN-RESUME" });
      expect(startRun).toHaveBeenCalledExactlyOnceWith({ projectId, intent: rawIntent, metadata, isMarketing: false,
        resumeContract: acceptedContract! });
      const current = await creativeTx(scope, client => client.query<{ state: string }>(
        "SELECT state FROM video_pipeline_operations WHERE pipeline_run_id=$1", [runId]));
      expect(current.rows).toEqual([{ state: "accepted" }]);
    } else {
      expect(outcome).toMatchObject({ kind: "noaction", stage: "preproduction", message: expect.stringContaining("待对账") });
      expect(startRun).not.toHaveBeenCalled();
    }
    expect(posts).toBe(beforePosts);
  }, 20_000);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl(), APP_DB_PASSWORD: appPassword!, GATEWAY_DB_PASSWORD: gatewayPassword! },
      stdio: "pipe", maxBuffer: 20 * 1024 * 1024,
    });
    database = new pg.Client({ connectionString: databaseUrl() });
    await database.connect();
    await database.query(`
      INSERT INTO tenants (id,name) VALUES ('C-T','creative'),('X-T','other');
      INSERT INTO workspaces (id,tenant_id,name,slug) VALUES ('C-W','C-T','creative','creative'),('X-W','X-T','other','other');
      INSERT INTO members (id,workspace_id,member_no,name,role)
      VALUES ('C-M','C-W','MEM-C','creative','owner'),('R-M','C-W','MEM-R','reader','readonly'),('X-M','X-W','MEM-X','other','owner');
    `);
    workDir = await realpath(await mkdtemp(join(tmpdir(), "creative-service-pg-")));
    for (const [key, value] of Object.entries({
      DATABASE_APP_URL: databaseUrl("workloom_app", appPassword!),
      DATABASE_GATEWAY_URL: databaseUrl("workloom_gateway", gatewayPassword!),
      DATABASE_URL: databaseUrl(), HR_WORK_DIR: workDir,
      PIPELINE_COORDINATOR: "off", PIPELINE_CONTROL_PLANE: "", PIPELINE_SCOPE: "all",
      VM_CREATIVE_BUDGET_CNY: "20", VM_CREATIVE_MAX_CALLS: "10", VM_CREATIVE_MAX_TOKENS: "1000000",
      VM_CREATIVE_MAX_WALL_MS: "30000",
      VM_CREATIVE_MODEL_PRICES: JSON.stringify({ [model]: { inputCnyPerMillion: 0.5, outputCnyPerMillion: 1 } }),
      LLM_API_KEY: "local-test-only", LLM_MODEL: model, LLM_FORCE_MODEL: model,
    })) vi.stubEnv(key, value);
    mockModel = createServer(async (req, res) => {
      let wire = "";
      for await (const chunk of req) wire += chunk.toString();
      const request = JSON.parse(wire);
      if (req.url === "/search") {
        searchPosts++;
        res.setHeader("content-type", "application/json");
        if (request.query === "unknown") { res.statusCode = 503; res.end("{}"); return; }
        res.end(JSON.stringify({ results: [{ title: request.query, url: "https://source.example.test/fan", snippet: "星野风扇支持 9 档风量" }] }));
        return;
      }
      posts++;
      const user = request.messages.at(-1).content;
      const text = typeof user === "string" ? user : user.map((part: { text?: string }) => part.text ?? "").join("\n");
      const extraction = /当前阶段：(A[123])\n/.exec(text);
      let last: Record<string, unknown> = {};
      if (text.startsWith("{")) last = JSON.parse(text);
      let payload;
      if (extraction) {
        const stage = extraction[1]!;
        const parsed = JSON.parse(text.slice(extraction.index + extraction[0].length));
        const source = parsed.sources[0];
        payload = stage === "A1" ? {
          payload: { identity: { name: "星野风扇", specs: { 风量: "9 档" } }, images: [] },
          citations: ["/identity/name", "/identity/specs/风量"].map(pointer => ({
            pointer, sourceId: source.sourceId, quoteId: source.textFragments[0].quoteId,
          })),
        } : { payload: stage === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "本次来源没有评价或竞品证据" };
      } else if (last.candidateHash) {
        payload = { candidateHash: last.candidateHash, contractHash: last.contractHash, rubricVersion: last.rubricVersion, findings: [],
          scores: Object.fromEntries(CREATIVE_ART_DIMENSIONS.map(key => [key, { score: 80, evidence: "玻璃杯在窗边的倒影和动作" }])) };
      } else if (last.candidateOrdinal) {
        payload = { shots: [{ shotId: "S1", sceneId: "SC1", duration: 6, purpose: "建立窗边环境",
          subject: "玻璃杯", action: "杯影随阳光移动", sound: "自然环境音", textLayers: [],
          fields: { 构图: "窗边玻璃杯，宽景固定机位" }, fieldOrder: ["构图"], prompt: "窗边玻璃杯，宽景固定机位" }] };
      } else {
        payload = { approved: true, score: 96, issues: [], suggestions: [], reason: "本机夹具：逐项支持事实" };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: `local-${posts}`, model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, completion_tokens_details: { reasoning_tokens: 0 } } }));
    });
    await new Promise<void>((resolve, reject) => mockModel.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = mockModel.address();
    if (!address || typeof address === "string") throw new Error("mock model socket missing");
    localOrigin = `http://127.0.0.1:${address.port}`;
    vi.stubEnv("LLM_BASE_URL", localOrigin);
    videoRouter = (await import("./router.js")).videoRouter;
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (mockModel) await new Promise<void>((resolve, reject) => mockModel.close(error => error ? reject(error) : resolve()));
    await closeAllPools();
    await database?.end();
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); }
      finally { await admin.end(); }
    }
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("validates the live tRPC session, source scope, immutable contract, concurrent replay and revision CAS", async () => {
    const projectId = await project();
    const input = { projectId, rawIntent: fixtureIntent, expectedRevision: 0, idempotencyKey: "compile-once" };
    await expect(caller(null).compileIntent(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller({ ...ownerIdentity, memberId: "R-M", memberNo: "MEM-R" }).compileIntent(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller({ ...ownerIdentity, tenantId: "X-T", workspaceId: "X-W", memberId: "X-M", memberNo: "MEM-X" })
      .compileIntent(input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [first, replay] = await Promise.all([caller().compileIntent(input), caller().compileIntent(input)]);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ rawIntent: fixtureIntent, revision: 1, feasibility: { status: "feasible" } });
    await expect(caller().compileIntent({ ...input, rawIntent: "different" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller().compileIntent({ ...input, idempotencyKey: "stale-once" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(database.query("UPDATE video_creative_contracts SET created_by='changed' WHERE project_id=$1", [projectId]))
      .rejects.toThrow(/append-only/);
    const changed = { ...input, expectedRevision: 1, rawIntent: fixtureIntent + "黑白画面", idempotencyKey: "compile-next" };
    const lockKey = projectRunLockKey(baseScope, projectId);
    await database.query("SELECT pg_advisory_lock_shared(hashtext($1))", [lockKey]);
    try {
      await expect(caller().compileIntent(changed)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await caller().compileIntent(input)).toEqual(first);
      expect((await database.query("SELECT revision FROM video_creative_contracts WHERE project_id=$1", [projectId])).rows).toEqual([{ revision: 1 }]);
    } finally { await database.query("SELECT pg_advisory_unlock_shared(hashtext($1))", [lockKey]); }
    const second = await caller().compileIntent(changed);
    expect(second.revision).toBe(2);
  });

  it("runs real generation and separate same-model review through the tRPC caller and HTTP boundary once", async () => {
    const projectId = await project();
    const { hash } = await caller().compileIntent({ projectId, rawIntent: fixtureIntent, expectedRevision: 0, idempotencyKey: "compile-candidate" });
    const request = { projectId, contractHash: hash, count: 1, idempotencyKey: "candidate-once" };
    const baseline = posts;
    await expect(caller().creativeCandidates(request)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(posts).toBe(baseline);
    vi.stubEnv("PIPELINE_COORDINATOR", "enforce");
    vi.stubEnv("PIPELINE_SCOPE", "all");
    try {
      const result = await caller().creativeCandidates(request);
      expect(result).toMatchObject({ status: "completed", contractHash: hash, eligible: [{ score: 80 }], rejected: [],
        budget: { calls: 2, knownCny: 0.00005, knownTokens: 60, heldCny: 0, usageUnknown: false } });
      expect(await caller().creativeCandidates(request)).toEqual(result);
      expect(posts - baseline).toBe(2);
      const { rows: [candidate] } = await database.query(
        "SELECT a.sha256,a.creator,c.generation FROM video_creative_candidates c JOIN video_artifacts a ON a.id=c.artifact_id WHERE c.run_id=$1", [result.runId]);
      expect(candidate.creator).toMatchObject({ kind: "model", id: model });
      expect(candidate.generation.generation.requestId).not.toBe(candidate.generation.review.requestId);
      expect(candidate.generation.generation.model).toBe(candidate.generation.review.model);
      expect(candidate.generation.review.contractHash).toBe(hash);
      const operations = await database.query("SELECT state,cost FROM video_pipeline_operations WHERE pipeline_run_id=$1 ORDER BY operation_key", [result.runId]);
      expect(operations.rows).toEqual([1, 2].map(() => ({ state: "accepted", cost: { micros: 25, reserved: false, tokens: 30 } })));
    } finally { vi.stubEnv("PIPELINE_COORDINATOR", "off"); }
  });

  it("keeps one reviewed candidate when independently generated content is duplicated", async () => {
    const projectId = await project(), baseline = posts;
    const contract = await caller().compileIntent({ projectId, rawIntent: fixtureIntent, expectedRevision: 0, idempotencyKey: "compile-dupes" });
    vi.stubEnv("PIPELINE_COORDINATOR", "enforce");
    try {
      const response = await caller().creativeCandidates({ projectId, contractHash: contract.hash, count: 2, idempotencyKey: "candidate-dupes" });
      expect(response).toMatchObject({ status: "completed", eligible: [{ score: 80 }],
        rejected: [{ code: "CREATIVE_CANDIDATE_DUPLICATE" }], budget: { calls: 3 } });
      expect(posts - baseline).toBe(3);
      expect(response.candidateIds).toHaveLength(1);
    } finally { vi.stubEnv("PIPELINE_COORDINATOR", "off"); }
  });

  it("collects and reviews real G1 evidence before a fresh marketing candidate without running prompt fusion", async () => {
    const projectId = await project("marketing");
    const input = { projectId, rawIntent: "制作星野风扇总时长 6 秒的宣传片。禁止展示产品外观。",
      metadata: { brief: { product: "星野风扇" } }, expectedRevision: 0, idempotencyKey: "compile-first-g1" };
    const contract = await caller().compileIntent(input);
    expect(contract.feasibility.status).toBe("needs_input");
    const before = posts, beforeSearch = searchPosts;
    for (const [key, value] of Object.entries({
      PIPELINE_COORDINATOR: "enforce", PIPELINE_SCOPE: "all", VM_CREATIVE_MAX_CALLS: "100",
      WL_SEARCH_PROVIDERS: "api", WL_SEARCH_API_PROVIDER: "generic", WL_SEARCH_API_URL: `${localOrigin}/search`,
      WL_SEARCH_API_KEY: "local-search-key", VM_CREATIVE_EXTERNAL_PRICES: JSON.stringify({ search: { generic: 0.0125 } }),
    })) vi.stubEnv(key, value);
    try {
      const request = { projectId, contractHash: contract.hash, count: 1, idempotencyKey: "first-marketing-candidate" };
      const result = await caller().creativeCandidates(request);
      if (result.status === "failed" && result.errorCode === "MARKETING_EXTRACTION_UNVERIFIED") {
        const saved = JSON.parse(await readFile(join(workDir, "archive", baseScope.workspaceId, projectId, "artifacts/creative/g1",
          result.runId, "stages/preproduction/attempt-1.marketing-A1.extraction-1.json"), "utf8"));
        throw new Error(JSON.stringify({ result, extractionError: saved.error, response: saved.response }));
      }
      expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", eligible: [{ score: 80 }], rejected: [], budget: { usageUnknown: false } });
      expect(posts).toBeGreaterThan(before + 2);
      expect(searchPosts).toBeGreaterThan(beforeSearch);
      // Include the actual G1 producer review request, which does not use the
      // regular Studio model adapter. The ledger must match every transport.
      expect(result.budget.calls).toBe((posts - before) + (searchPosts - beforeSearch));
      const { rows: operations } = await database.query("SELECT kind,state FROM video_pipeline_operations WHERE pipeline_run_id=$1", [result.runId]);
      expect(operations.filter(row => row.kind === "creative.model" && row.state === "accepted")).toHaveLength(posts - before);
      expect(operations.filter(row => row.kind === "creative.search" && row.state === "accepted")).toHaveLength(searchPosts - beforeSearch);
      const stageKeys = await database.query("SELECT stage_key FROM production_stage_runs WHERE pipeline_run_id=$1 ORDER BY started_at", [result.runId]);
      expect(stageKeys.rows.map(row => row.stage_key)).toEqual(["creative:facts", "creative:candidates"]);
      expect(result.contractHash).not.toBe(contract.hash);
      const bound = await caller().compileIntent({ ...input, expectedRevision: 2, idempotencyKey: "compile-reuse-current-g1" });
      expect(bound).toMatchObject({ hash: result.contractHash, feasibility: { status: "feasible" },
        profile: { visualMode: "abstract_without_product_appearance" } });
      expect(await caller().creativeCandidates(request)).toEqual(result);
    } finally {
      vi.stubEnv("PIPELINE_COORDINATOR", "off"); vi.stubEnv("VM_CREATIVE_MAX_CALLS", "10");
    }
  });

  it("reserves vision tokens separately from request bytes before model dispatch", async () => {
    const projectId = await project(), runId = randomUUID();
    const lease = await acquireProjectLease(baseScope, projectId);
    const previousLimit = process.env.VM_CREATIVE_MAX_TOKENS;
    const request = { ...modelRequest(1), imageInputTokens: 1024 };
    try {
      vi.stubEnv("VM_CREATIVE_MAX_TOKENS", "2000");
      const limited = await start(projectId);
      await limited.beginStage("preparation");
      await expect(limited.beforeModelCall(request)).rejects.toThrow(/CREATIVE_BUDGET_EXHAUSTED/);
      expect((await database.query("SELECT id FROM video_pipeline_operations WHERE project_id=$1", [projectId])).rowCount).toBe(0);
      await limited.finish({ success: false });

      vi.stubEnv("VM_CREATIVE_MAX_TOKENS", "2248");
      const session = await start(projectId, runId);
      await session.beginStage("preparation");
      await expect(session.beforeModelCall({ ...request, imageInputTokens: -1 })).rejects.toThrow(/CREATIVE_BUDGET_REQUEST_INVALID/);
      const reservation = await session.beforeModelCall(request);
      await session.afterModelCall(reservation, { usageKnown: true, success: true, inputTokens: 2100, outputTokens: 50 });
      await session.completeStage("preparation", { current: true });
      await session.finish({ success: true });

      const operation = await database.query("SELECT state,request,cost FROM video_pipeline_operations WHERE pipeline_run_id=$1", [runId]);
      expect(operation.rows).toEqual([expect.objectContaining({ state: "accepted",
        request: expect.objectContaining({ inputChars: 100, imageInputTokens: 1024, inputLimit: 2148, outputLimit: 100 }),
        cost: { micros: 1100, tokens: 2150, reserved: false },
      })]);
    } finally {
      vi.stubEnv("VM_CREATIVE_MAX_TOKENS", previousLimit);
      await lease?.release();
    }
  });

  it("preserves unknown usage across session recreation and rejects outbound retry", async () => {
    const projectId = await project(), runId = randomUUID();
    const lease = await acquireProjectLease(baseScope, projectId);
    try {
      const session = await start(projectId, runId);
      await session.beginStage("preparation");
      const reservation = await session.beforeModelCall(modelRequest(1));
      await session.afterModelCall(reservation, { usageKnown: false, success: false });
      await expect(session.beforeModelCall(modelRequest(2))).rejects.toThrow(/CREATIVE_USAGE_UNKNOWN/);
      await session.finish({ success: false });
    } finally { await lease?.release(); }
    const secondLease = await acquireProjectLease(baseScope, projectId);
    try { await expect(start(projectId)).rejects.toThrow(/CREATIVE_USAGE_UNKNOWN/); }
    finally { await secondLease?.release(); }
    const { rows } = await database.query("SELECT state,cost,request_hash FROM video_pipeline_operations WHERE project_id=$1", [projectId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "unknown", cost: { reserved: true }, request_hash: modelRequest(1).requestHash });
  });

  it("moves a crashed dispatched request into the reconciliation projection and preserves its original reservation", async () => {
    const projectId = await project(), runId = randomUUID();
    const lease = await acquireProjectLease(baseScope, projectId);
    const session = await start(projectId, runId);
    try {
      await session.beginStage("preparation");
      await session.beforeModelCall(modelRequest(1));
    } finally { await lease?.release(); }
    const readOperation = () => database.query("SELECT * FROM video_pipeline_operations WHERE pipeline_run_id=$1", [runId]);
    const original = (await readOperation()).rows;
    const restart = await acquireProjectLease(baseScope, projectId);
    try {
      await expect(assertNoCreativePendingUsage({ ...baseScope, projectId }, { rejectActiveEnforce: true }))
        .rejects.toThrow(/CREATIVE_USAGE_UNKNOWN/);
    }
    finally { await restart?.release(); }
    expect((await readOperation()).rows).toEqual(original);
    expect((await database.query("SELECT status,next_action FROM video_pipeline_runs WHERE id=$1", [runId])).rows[0])
      .toEqual({ status: "reconciling", next_action: "reconcile" });
    expect((await database.query("SELECT execution_status,disposition FROM production_stage_runs WHERE pipeline_run_id=$1", [runId])).rows[0])
      .toEqual({ execution_status: "interrupted", disposition: "reconcile" });
  });

  it("pins an active enforce run with settled usage against legacy rollback", async () => {
    const projectId = await project(), runId = randomUUID();
    const scope = { ...baseScope, projectId };
    const ownerLease = await acquireProjectLease(baseScope, projectId);
    const session = await start(projectId, runId);
    try {
      await session.beginStage("preparation");
      const reservation = await session.beforeModelCall(modelRequest(1));
      await session.afterModelCall(reservation, known);
      await session.completeStage("preparation", { current: true });
    } finally { await ownerLease?.release(); }

    const rollbackLease = await acquireProjectLease(baseScope, projectId);
    const rollback = { rejectActiveEnforce: true };
    try {
      await expect(assertNoCreativePendingUsage(scope, rollback)).rejects.toThrow(/CREATIVE_EXECUTION_PINNED/);
      const run = await database.query("SELECT status FROM video_pipeline_runs WHERE id=$1", [runId]);
      expect(run.rows).toEqual([{ status: "running" }]);
      const operations = await database.query("SELECT state,cost FROM video_pipeline_operations WHERE pipeline_run_id=$1", [runId]);
      expect(operations.rows).toEqual([{ state: "accepted", cost: { micros: 25, tokens: 30, reserved: false } }]);
      const unrelated = await project();
      const unrelatedLease = await acquireProjectLease(baseScope, unrelated);
      try {
        await expect(assertNoCreativePendingUsage({ ...scope, projectId: unrelated }, rollback)).resolves.toBeUndefined();
      } finally { await unrelatedLease?.release(); }
      await session.finish({ success: true });
      await expect(assertNoCreativePendingUsage(scope, rollback)).resolves.toBeUndefined();
    } finally { await rollbackLease?.release(); }
  });

  it("reserves every actual paid search request, requires trusted fixed price and freezes after ambiguous HTTP", async () => {
    const projectId = await project(), runId = randomUUID(), baseline = searchPosts;
    const runner = createApiSearchRunner({ provider: "generic", apiUrl: `${localOrigin}/search`, apiKey: "local-search-key" });
    const lease = await acquireProjectLease(baseScope, projectId);
    try {
      const session = await start(projectId, runId);
      await session.beginStage("preparation");
      vi.stubEnv("VM_CREATIVE_EXTERNAL_PRICES", "{}");
      await expect(withCreativeExternalBudget(session, () => runner.search("blocked before network", 1)))
        .rejects.toThrow(/CREATIVE_BUDGET_UNCONFIGURED/);
      expect(searchPosts).toBe(baseline);
      vi.stubEnv("VM_CREATIVE_EXTERNAL_PRICES", JSON.stringify({ search: { generic: 0.0125 } }));
      await expect(withCreativeExternalBudget(session, async () => {
        const found = await runner.search("valid", 1);
        expect(found.hits).toHaveLength(1);
        expect(searchPosts).toBe(baseline + 1);
        return Promise.all([runner.search("unknown", 1), runner.search("queued after unknown", 1)]);
      })).rejects.toThrow(/CREATIVE_USAGE_UNKNOWN/);
      expect(searchPosts).toBe(baseline + 2);
      await expect(session.beforeModelCall(modelRequest(1))).rejects.toThrow(/CREATIVE_USAGE_UNKNOWN/);
      await session.finish({ success: false });
      const { rows } = await database.query(
        "SELECT kind,state,cost,request FROM video_pipeline_operations WHERE pipeline_run_id=$1 ORDER BY created_at", [runId]);
      expect(rows).toEqual([
        expect.objectContaining({ kind: "creative.search", state: "accepted", cost: { micros: 12500, tokens: 0, reserved: false } }),
        expect.objectContaining({ kind: "creative.search", state: "unknown", cost: { micros: 12500, tokens: 0, reserved: true } }),
      ]);
      expect(JSON.stringify(rows)).not.toContain("local-search-key");
    } finally { await lease?.release(); }
  });

  it("retires only the proven inactive shadow observer when enforce claims the project", async () => {
    const projectId = await project(), shadowId = randomUUID(), activeId = randomUUID();
    const shadow = compileLegacyShadowPlan(), originalHash = creativeHash("shadow");
    const seed = (id: string, creator: string) => database.query(
      `INSERT INTO video_pipeline_runs (id,tenant_id,workspace_id,project_id,pipeline_kind,intent_contract_id,intent_hash,
        plan_key,plan_version,plan_hash,status,next_action,created_by)
       VALUES ($1,'C-T','C-W',$2,'narrative',$1,$3,$4,$5,$6,'waiting','wait_approval',$7)`,
      [id, projectId, originalHash, shadow.key, shadow.version, shadow.planHash, creator],
    );
    await seed(shadowId, "video-studio-shadow");
    const lease = await acquireProjectLease(baseScope, projectId);
    try {
      const session = await start(projectId);
      await session.finish({ success: true });
      const { rows } = await database.query("SELECT status FROM video_pipeline_runs WHERE id=$1", [shadowId]);
      expect(rows[0]).toEqual({ status: "cancelled" });
      await seed(activeId, "real-worker");
      await expect(start(projectId)).rejects.toThrow(/CREATIVE_EXECUTOR_BUSY/);
      expect((await database.query("SELECT status FROM video_pipeline_runs WHERE id=$1", [activeId])).rows[0]).toEqual({ status: "waiting" });
    } finally { await lease?.release(); }
  });

  it("persists single-shot reject/repair, validates actual patch deltas, replays receipt and invalidates transitive descendants", async () => {
    const projectId = await project(), runId = randomUUID();
    const scope: CreativeScope = { ...baseScope, projectId };
    const lease = await acquireProjectLease(baseScope, projectId);
    try {
      const session = await start(projectId, runId);
      await session.beginStage("phase3");
      const [shot] = buildCreativeShots(session.contract, [{ id: "S1", duration: 6, fields: { Scene: "玻璃杯" }, prompt: "玻璃杯" }]);
      const finding: CreativeFinding = { code: "CREATIVE_NATIVE_FIELD_MISSING", targetId: "S1", fieldPath: "fields.Camera",
        expected: "non-empty", actual: null, evidence: [creativeHash("fixture-schema")], ownerStage: "creative",
        allowedChanges: ["fields.Camera"], blocking: true };
      await session.onEvent({ kind: "creative.shot.rejected", payload: { shot, findings: [finding], attempt: 0 } });
      const rootArtifact = (await database.query<CreativeArtifact>(
        "SELECT a.* FROM video_artifacts a WHERE pipeline_run_id=$1 AND role='creative-rejected-shot'", [runId])).rows[0]!;
      const downstream = await creativeTx(scope, async client => {
        const ids: string[] = [];
        let parent = rootArtifact;
        for (const key of ["creative:next", "creative:downstream"]) {
          const stage = await insertCreativeStage(client, { scope, runId, planHash: session.planHash, contract: session.contract, key });
          const output = await insertCreativeArtifact(client, { scope, runId, stageId: stage.id, role: "creative-stage",
            logicalId: key, revision: 1, model, metadata: {}, output: { key } });
          await linkCreativeArtifacts(client, scope, runId, parent, output, "fixture-dependency");
          parent = output; ids.push(stage.id);
        }
        return ids.sort();
      });
      await session.finish({ success: false });
      const { rows: [{ id: decisionId }] } = await database.query("SELECT id FROM video_gate_decisions WHERE pipeline_run_id=$1", [runId]);
      const previewInput = { projectId, decisionId, targetId: "S1", expectedStageRevision: 1, idempotencyKey: "repair-preview" };
      const preview = await caller().repairPreview(previewInput);
      expect(preview.allowedChanges).toEqual(["fields.Camera"]);
      expect(preview.invalidationClosure).toEqual(downstream);
      expect(await caller().repairPreview(previewInput)).toEqual(preview);
      // tRPC apply takes the same real project lease as the worker.
      const request = { projectId, repairPlanId: preview.repairPlanId, planHash: preview.planHash, expectedStageRevision: 1,
        idempotencyKey: "repair-apply", patch: { ...preview.sourceShot, fields: { ...preview.sourceShot.fields, Camera: "定机位平视" } } };
      await expect(caller().applyRepair(request)).rejects.toMatchObject({ code: "CONFLICT" });
      await lease?.release();
      const forbidden = { ...request, idempotencyKey: "repair-forbidden", patch: { ...request.patch, assetRefs: ["foreign"] } };
      await expect(caller().applyRepair(forbidden)).resolves.toMatchObject({ status: "blocked", code: "PATCH_SCOPE_VIOLATION" });
      const newPlan = await caller().repairPreview({ ...previewInput, idempotencyKey: "repair-preview-next" });
      expect(newPlan.budgetEnvelope.attemptsRemaining).toBe(1);
      request.repairPlanId = newPlan.repairPlanId;
      request.planHash = newPlan.planHash;
      const result = await caller().applyRepair(request);
      expect(result).toMatchObject({ status: "applied", stageRevision: 2, actualDiff: ["fields.Camera"], nextAction: "review" });
      expect(result.invalidatedStageIds).toEqual(expect.arrayContaining(downstream));
      expect(await caller().applyRepair(request)).toEqual(result);
      expect((await database.query("SELECT verification_status FROM production_stage_runs WHERE output_artifact_id=$1",
        [result.artifactId])).rows[0]).toEqual({ verification_status: "pending" });
      const { rows: [repaired] } = await database.query("SELECT storage_ref FROM video_artifacts WHERE id=$1", [result.artifactId]);
      const output = JSON.parse(await readFile(join(workDir, "archive", baseScope.workspaceId, projectId, repaired.storage_ref), "utf8"));
      expect(output.fieldOrder).toEqual(["Scene", "Camera"]);
      expect(output.prompt).toContain("02.【Camera】定机位平视");
    } finally { await lease?.release(); }
  });

  it("requires current private G1 approval and complete original bytes for detached marketing operations", async () => {
    const projectId = await project("marketing"), runId = randomUUID(), attempt = 1;
    const scope = { ...baseScope, projectId };
    const g1Scope = { ...scope, runId, attempt };
    const rawIntent = "制作 6 秒抽象宣传片。禁止展示产品外观。";
    const metadata = { brief: { product: "产品 A" } };
    const work = join(workDir, "workspaces", baseScope.workspaceId, "gates", projectId, "attempt-1");
    const folder = join(workDir, "archive", baseScope.workspaceId, projectId, "stages/preproduction/attempt-1.marketing-sources");
    const gate = join(work, "G1_DOSSIER.md"), bytes = "支持 9 档风量";
    const ref = "stages/preproduction/attempt-1.marketing-sources/source.txt";
    const collectedAt = new Date().toISOString();
    const content = JSON.stringify({ requestedIntent: rawIntent, requestedMetadata: metadata,
      facts: { schemaVersion: "workloom.marketing-facts/v1", issuer: "workloom.marketing-authority", scope: g1Scope, collectedAt,
        sources: [{ rawRef: ref, textRef: ref, rawSha256: creativeTextHash(bytes), textSha256: creativeTextHash(bytes) }] } });
    await mkdir(work, { recursive: true }); await mkdir(folder, { recursive: true });
    await writeFile(gate, content); await writeFile(join(folder, "source.txt"), bytes);
    const contract = compileCreativeContract({ scope, rawIntent, metadata, isMarketing: true,
      profile: { visualMode: "abstract_without_product_appearance" },
      facts: { content, hash: creativeTextHash(content), claims: [], validUntil: new Date(Date.now() + 60_000).toISOString() } });
    await expect(verifyCreativeMarketingSource(contract)).rejects.toThrow(/当前预生产尝试缺少实际 G1/);
    const lease = await acquireProjectLease(baseScope, projectId);
    try {
      const session = await createCreativeExecutionSession({
        scope: baseScope, projectId, runId, rawIntent, metadata, isMarketing: true, mode: "enforce", model,
      });
      await session.beginStage("preparation");
      await database.query(`INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,run_id)
        VALUES ('C-G1-1','C-W',$1,'preproduction',1,$2)`, [projectId, runId]);
      const actual = await session.bindContract(contract, {
        schemaVersion: "workloom.prd-marketing-authority/v1", scope: g1Scope,
        g1Artifact: { path: gate, sha256: creativeTextHash(content), content },
        g1Proof: { gate: "G1_DOSSIER", status: "passed", approved: true, via: "llm", degraded: false, model,
          evidence: [{ path: gate, sha256: creativeTextHash(content), scope: "complete-text" }] },
      });
      await session.completeStage("preparation", { valid: true }); await session.finish({ success: true });
      expect(await verifyCreativeMarketingSource(actual)).toMatchObject({ mode: "abstract_without_product_appearance" });
      await writeFile(join(folder, "source.txt"), "变更字节");
      await expect(verifyCreativeMarketingSource(actual)).rejects.toThrow(/CREATIVE_SOURCE_CHANGED/);
      await writeFile(join(folder, "source.txt"), bytes);
      await database.query(`INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,run_id,status)
        VALUES ('C-G1-2','C-W',$1,'preproduction',2,'new-run','failed')`, [projectId]);
      await expect(verifyCreativeMarketingSource(actual)).rejects.toThrow(/当前预生产尝试缺少实际 G1/);
    } finally { await lease?.release(); }
  });

  it("uses persistent project-scoped bytes for a cache hit and rejects a tampered file", async () => {
    const projectId = await project();
    const lease = await acquireProjectLease(baseScope, projectId);
    try {
      const first = await start(projectId);
      await first.beginStage("phase1");
      const key = creativeHash("cache-key"), output = { detail: "verified output" };
      const envelope = { key, schemaVersion: "workloom.creative-executor/v1", output, outputHash: creativeHash(output),
        contractHash: first.contract.hash };
      await first.writeCache(key, envelope);
      await first.completeStage("phase1", output);
      await first.finish({ success: true });
      const second = await start(projectId);
      await second.beginStage("phase1");
      expect(await second.readCache(key)).toEqual(envelope);
      const { rows: [cache] } = await database.query("SELECT storage_ref FROM video_artifacts WHERE project_id=$1 AND role='creative-cache'", [projectId]);
      await writeFile(join(workDir, "archive", baseScope.workspaceId, projectId, cache.storage_ref), "different bytes");
      await expect(second.readCache(key)).rejects.toThrow(/CREATIVE_ARTIFACT_CHANGED/);
      await second.finish({ success: false });
    } finally { await lease?.release(); }
  });

  it("retains a verified first shot after a later shot fails, with no extra paid operation for the first shot", async () => {
    const projectId = await project(), lease = await acquireProjectLease(baseScope, projectId);
    try {
      const first = await start(projectId);
      await first.beginStage("phase3");
      const [shot] = buildCreativeShots(first.contract, [{ id: "S1", duration: 6, fields: { Camera: "宽镜头" }, prompt: "玻璃杯" }]);
      const key = creativeHash(["first-shot", shot!.sourceHash]);
      const output = { shotId: "S1", _workloomCreativeShot: shot };
      const envelope = { schemaVersion: "workloom.creative-executor/v1", key, output,
        outputHash: creativeHash(output), contractHash: first.contract.hash };
      const op = await first.beforeModelCall(modelRequest(1)); await first.afterModelCall(op, known);
      await first.writeCache(key, envelope);
      await first.finish({ success: false, error: new Error("later shot failed") });
      const statuses = await database.query("SELECT stage_key,verification_status FROM production_stage_runs WHERE project_id=$1 ORDER BY stage_key", [projectId]);
      expect(statuses.rows).toEqual([{ stage_key: "creative:phase3", verification_status: "unverified" },
        { stage_key: "creative:shot-cache", verification_status: "passed" }]);
      const resumed = await start(projectId);
      await resumed.beginStage("phase3");
      expect(await resumed.readCache(key)).toEqual(envelope);
      expect((await database.query("SELECT id FROM video_pipeline_operations WHERE project_id=$1", [projectId])).rows).toHaveLength(1);
      await resumed.finish({ success: false });
    } finally { await lease?.release(); }
  });

  it("keeps an actual repair signature and the two-attempt cap across worker runs for the same source", async () => {
    const projectId = await project(), lease = await acquireProjectLease(baseScope, projectId);
    const sourceHash = creativeHash("same-source");
    const event = (value: string) => ({ kind: "creative.repair.started", payload: { shotId: "S1", sourceHash,
      signature: creativeHash(value) } });
    try {
      const first = await start(projectId);
      await first.beginStage("phase3"); await first.onEvent(event("first")); await first.finish({ success: false });
      const second = await start(projectId);
      await second.beginStage("phase3");
      await expect(second.onEvent(event("first"))).rejects.toThrow(/REPAIR_NO_PROGRESS/);
      await second.onEvent(event("second")); await second.finish({ success: false });
      const third = await start(projectId);
      await third.beginStage("phase3");
      await expect(third.onEvent(event("third"))).rejects.toThrow(/CREATIVE_REPAIR_LIMIT/);
      await third.finish({ success: false });
    } finally { await lease?.release(); }
  });
});
