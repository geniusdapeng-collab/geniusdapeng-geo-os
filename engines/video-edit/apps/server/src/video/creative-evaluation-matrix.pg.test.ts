/** Fixture-only benchmark. It uses the real scoped PG session, native single-shot agent and wire serializer. */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { getAppPool } from "@workloom/db";
import {
  creativeDiff, creativeHash, creativeTextHash,
  extractProductVisualAuthority, ABSTRACT_PRODUCT_RENDER_RULE, type CompileCreativeInput,
  type CreativeFactInput, type CreativeScope, requirementCast, normalizePrdProductionProfile, DEEPSEEK_FLASH_MODEL,
  CreativeRuntime, withCreativeBudget, withCreativeRuntime, completeVideoTextTask, currentCreativeModelSlice,
} from "@hyperreality/video-studio";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createCreativeExecutionSession, creativeTx, latestCreativeContract, lockCreativeProject, persistCreativeContract } from "./creative-service.js";
import { acquireProjectLease } from "./archive-host.js";
import type { TrpcContext } from "../trpc/context.js";

const require = createRequire(import.meta.url);
const engineRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const vendorRoot = path.join(engineRoot, "vendor/supermickey/hyperreality-system/engines");
const nativePath = path.join(vendorRoot, "production-engine/agents/prompt-fusion-agent.js");
type Obj = Record<string, unknown>;
const { PromptFusionAgent } = require(nativePath) as {
  PromptFusionAgent: new (options: Obj) => { _fuseSingleShotWithDeadline: (...args: unknown[]) => Promise<Obj>; _getLLMEngine: () => unknown };
};
const { FIELD_NAME_CN } = require(path.join(vendorRoot, "field-standardizer.js")) as { FIELD_NAME_CN: Record<string, string> };
const fieldKeys = Object.keys(FIELD_NAME_CN).slice(0, Object.keys(FIELD_NAME_CN).indexOf("title_content"));
const labels = Object.fromEntries(fieldKeys.map(key => [key, FIELD_NAME_CN[key]!]));
const endpoint = { baseUrl: "https://offline-fixture.example.invalid/v1", apiKey: "fixture", model: DEEPSEEK_FLASH_MODEL };
const combinations = ["basic", "time_text", "cast_voice", "claims_rights", "visual_platform"] as const;
const disturbances = ["normal", "empty_boundary", "conflict", "timeout_failure", "concurrent_revision", "restart_unknown"] as const;
const fixtures = (["narrative", "marketing"] as const).flatMap(route => combinations.flatMap((combination, c) => disturbances.map((disturbance, d) => ({
  id: `B60-${route === "narrative" ? "N" : "M"}${c + 1}${d + 1}`, route, combination, disturbance,
}))));
type Scenario = typeof fixtures[number];

const isolated = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL);
const scopeBase = { tenantId: `fixture-eval-t-${randomUUID()}`, workspaceId: `fixture-eval-w-${randomUUID()}` };
const fixtureMemberId = `fixture-eval-m-${randomUUID()}`;
const fixtureIdentity: NonNullable<TrpcContext["identity"]> = { ...scopeBase, kind: "member", memberId: fixtureMemberId,
  memberNo: "MEM-MATRIX", name: "Creative matrix fixture owner", role: "owner", plan: "pro" };
let caller: ReturnType<typeof import("./router.js").videoRouter.createCaller>;
const narrator = "旁白：光点慢慢聚成一条清楚的路径。";
const approvedName = "合成角色甲";
const approvedId = "fixture-cast-a";
const firstClaim = "来源甲支持开放图例";
const secondClaim = "来源乙支持两种抽象节点";
const artifactHashes: Record<string, string> = {};
let schemaHash = "";
let sourceCommit = "";
let benchmarkRoot = "";
let owner: pg.Pool;
const records: Obj[] = [];

function inputs(s: Scenario, scope: CreativeScope) {
  const marketing = s.route === "marketing", abstract = s.combination === "visual_platform";
  const castVoice = s.combination === "cast_voice", timed = s.combination === "time_text";
  const claimCoverage = s.combination === "claims_rights";
  const sourceClaims = claimCoverage ? [firstClaim, secondClaim].map((text, index) => ({
    id: `claim-${index + 1}`, text, sourceRef: `fixture:verified-source-${index + 1}`,
  })) : [];
  const rawIntent = timed ? "成片60秒。封面3秒，交付独立旁挂字幕，屏上图形写‘节点关系’。"
    : castVoice ? `成片20秒。由已选角色${approvedName}出镜，并保留明确的旁白。`
    : abstract ? "成片20秒。只用暖橙色示意图，不展示产品外观。保留手鼓配乐。"
    : claimCoverage ? "成片20秒。两条获准来源各明确交代一次。"
    : "成片20秒。固定窗边光线变化形成叙事。";
  const g1 = (intent: string, metadata: Obj) => JSON.stringify({
    facts: { scope, productQuery: abstract ? { name: "Atlas Fixture" } : {}, stages: [] },
    requestedIntent: intent, requestedMetadata: metadata, sourceClaims,
  });
  const cast = castVoice ? {
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "custom",
      characters: [{ id: approvedId, name: approvedName, source: "explicit-custom", profileSha256: creativeTextHash("fixture approved identity") }] },
    characters: [{ id: approvedId, name: approvedName, role: "presenter" }], hasPerson: true, noCharacters: false,
  } : {
    builtinCharacterSelection: { schemaVersion: "workloom.video-character-selection/v1", mode: "none", characters: [] },
    characters: [], hasPerson: false, noCharacters: true,
  };
  const brief: Obj = {
    duration: timed ? 60 : 20,
    ...(abstract ? { product: "Atlas Fixture", colorPalette: "暖橙色", music: "手鼓" } : {}),
    ...(castVoice ? { voice: narrator } : {}),
    aspectRatio: timed || abstract ? "16:9" : "9:16",
    productionRequirements: {
      resolution: "1080p", frameRate: 24, subtitleMode: timed ? "sidecar" : "none",
      openWithCover: timed, coverIntroSeconds: timed ? 3 : 0, titleCard: false, durationToleranceFrames: 1,
      nativeAudio: castVoice,
      ...(abstract ? { visualMode: "abstract_without_product_appearance" } : {}),
    },
  };
  const metadata: Obj = { ...cast, brief };
  const factsContent = marketing ? g1(rawIntent, metadata) : JSON.stringify({ source: "approved-narrative-reference", sourceClaims });
  const facts: CreativeFactInput = { content: factsContent, hash: creativeTextHash(factsContent), claims: sourceClaims,
    validUntil: "2099-01-01T00:00:00.000Z" };
  const seed: CompileCreativeInput = {
    scope, rawIntent, metadata, isMarketing: marketing, ...(marketing || claimCoverage ? { facts } : {}),
    requiredClaimIds: sourceClaims.map(claim => claim.id), bounds: { minShotSeconds: 3, maxShotSeconds: 15, maxShots: 12 },
  };
  let anticipatedCode: string | undefined;
  if (s.disturbance === "empty_boundary") switch (s.combination) {
    case "basic": seed.rawIntent = ""; anticipatedCode = "CREATIVE_INTENT_INVALID"; break;
    case "time_text": seed.rawIntent = "成片5秒。封面3秒。"; brief.duration = 5; anticipatedCode = "CONSTRAINT_TIMING_INFEASIBLE"; break;
    case "cast_voice": metadata.characters = []; anticipatedCode = "REQUIREMENT_CAST_CONFLICT"; break;
    case "claims_rights": delete seed.facts; anticipatedCode = "needs_input"; break;
    case "visual_platform": brief.aspectRatio = "42:1"; anticipatedCode = "PRD_PROFILE_INVALID"; break;
  }
  if (s.disturbance === "conflict") switch (s.combination) {
    case "basic": brief.duration = 25; anticipatedCode = "CONSTRAINT_CONFLICT"; break;
    case "time_text": seed.rawIntent = "成片5秒。封面5秒。"; brief.duration = 5;
      (brief.productionRequirements as Obj).coverIntroSeconds = 5; anticipatedCode = "CONSTRAINT_DURATION_INVALID"; break;
    case "cast_voice": metadata.hasPerson = false; anticipatedCode = "REQUIREMENT_CAST_CONFLICT"; break;
    case "claims_rights": seed.requiredClaimIds = ["unapproved-claim"]; anticipatedCode = "FACT_COVERAGE_INVALID"; break;
    case "visual_platform": seed.rawIntent += "但需要实拍产品包装。"; anticipatedCode = "PRODUCT_VISUAL_MODE_CONFLICT"; break;
  }
  return { seed, anticipatedCode, abstract, castVoice, timed, claimCoverage, g1 };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code)
    : error instanceof Error ? error.message.slice(0, 140) : String(error);
}
async function saveContract(input: CompileCreativeInput) {
  return creativeTx(input.scope, async client => {
    await lockCreativeProject(client, input.scope);
    return persistCreativeContract(client, input, await latestCreativeContract(client, input.scope), "offline-fixture");
  });
}
type Session = Awaited<ReturnType<typeof createCreativeExecutionSession>>;
function startSession(input: CompileCreativeInput, runId: string, expectedContract: Session["contract"]) {
  return createCreativeExecutionSession({ scope: scopeBase, projectId: input.scope.projectId, runId, rawIntent: input.rawIntent,
    metadata: input.metadata, isMarketing: input.isMarketing === true, mode: "enforce", model: endpoint.model, expectedContract });
}

function shotInputs(s: Scenario, contract: Session["contract"]) {
  const count = s.combination === "time_text" ? 4 : 2;
  return Array.from({ length: count }, (_, index) => ({
    shotId: `S${index + 1}`, sceneId: `scene-${index + 1}`, duration: contract.profile.contentDuration / count,
    scene: s.combination === "visual_platform" ? "暖橙色节点组网" : "窗边光线逐渐移动",
    action: s.combination === "cast_voice" ? `${approvedName}抬起手指向左侧光点` : "光点缓慢聚合",
    camera_movement: "稳定机位",
    characters: s.combination === "cast_voice" ? [{ id: approvedId, name: approvedName }] : [],
  }));
}
function fixtureFields(s: Scenario, shot: ReturnType<typeof shotInputs>[number], keys: string[]): Obj {
  const natural = "利用左侧自然漫射光的运动建立构图，保留右侧暗部与几何轮廓之间的连续变化。";
  const fields = Object.fromEntries(keys.map(key => [key, natural.repeat(key === "timeline" ? 8 : 6)]));
  fields.scene = s.combination === "claims_rights" ? shot.shotId === "S1" ? firstClaim : secondClaim : shot.scene;
  fields.action = shot.action;
  fields.character = s.combination === "cast_voice" ? approvedName : "场景中无人出镜";
  fields.portraits = s.combination === "cast_voice" ? "角色档案：fixture-cast-a" : "无人角色定妆需求";
  fields.audio = s.combination === "visual_platform" ? "低音量手鼓配乐" : "原生环境声";
  fields.dialogue = s.combination === "cast_voice" ? narrator : s.combination === "time_text" ? "字幕旁挂：光线移动" : "无对白";
  fields.color_palette = s.combination === "visual_platform" ? "暖橙色为主" : "窗边暖色";
  fields.composition = s.combination === "time_text" ? "屏上独立图形文字：节点关系" : "几何主体位于安全画幅内";
  fields.negative = s.combination === "visual_platform" ? ABSTRACT_PRODUCT_RENDER_RULE : "无未经授权文字";
  for (const key of ["scene", "action", "color_palette", "composition", "audio"]) fields[key] = `${String(fields[key])}。${natural.repeat(6)}`;
  return fields;
}
function successEnvelope(id: string, value: unknown): Response {
  return new Response(JSON.stringify({ id, model: endpoint.model,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 150, completion_tokens: 80, total_tokens: 230, completion_tokens_details: { reasoning_tokens: 0 } },
  }));
}

async function observeLegacyFusion(s: Scenario, shots: ReturnType<typeof shotInputs>, blueprint: Obj) {
  const requests: Array<{ wireBodyHash: string; promptHash: string; model: string; shotId: string }> = [];
  const agent = new PromptFusionAgent({ semanticRefinement: false, llmMaxRetries: 1 });
  agent._getLLMEngine = () => ({
    async reasonStructured(prompt: string, schema: { shots: Array<{ shotId: string; fields: Obj }> }) {
      const target = schema.shots[0]!, shot = shots.find(row => row.shotId === target.shotId)!;
      const result = await completeVideoTextTask({ endpoint, scene: "video.preproduction.plan", requireJson: true,
        messages: [{ role: "user", content: prompt }], fetchImpl: (async (_url, init) => {
          const wire = String(init?.body);
          requests.push({ wireBodyHash: creativeTextHash(wire), promptHash: creativeTextHash(prompt), model: JSON.parse(wire).model, shotId: shot.shotId });
          return successEnvelope(`baseline-${s.id}-${shot.shotId}`, { shots: [{ shotId: shot.shotId, fields: fixtureFields(s, shot, Object.keys(target.fields)) }] });
        }) as typeof fetch });
      return { success: true, data: result.value };
    },
  });
  const rows: Obj[] = [];
  const config = blueprint.config as Obj, characterSystem = blueprint.character_system as { characters: unknown[] };
  for (const shot of shots) {
    rows.push(await agent._fuseSingleShotWithDeadline(shot, config.aspectRatio, characterSystem.characters, blueprint, Date.now() + 300_000));
  }
  return { rows, requests };
}

async function readRun(scope: CreativeScope, runId: string) {
  const operationRows = await owner.query(
    `SELECT operation_key,state,request_hash,request,cost,receipt,dispatched_at IS NOT NULL AS dispatched
     FROM video_pipeline_operations WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 ORDER BY operation_key`,
    [scope.tenantId, scope.workspaceId, scope.projectId]);
  const statuses = await owner.query(
    "SELECT id,status,next_action,plan_hash FROM video_pipeline_runs WHERE workspace_id=$1 AND project_id=$2 ORDER BY created_at,id",
    [scope.workspaceId, scope.projectId]);
  const artifacts = await owner.query("SELECT role,sha256,metadata FROM video_artifacts WHERE pipeline_run_id=$1 ORDER BY role,sha256", [runId]);
  return { operations: operationRows.rows, runs: statuses.rows, artifacts: artifacts.rows };
}

async function crashAfterDispatch(s: Scenario, input: CompileCreativeInput, contract: Session["contract"], runId: string) {
  // A real child exits after observing the exact HTTP body. No afterModelCall or
  // finish runs, so a new service instance has only its PG rows to rely on.
  const service = pathToFileURL(path.join(engineRoot, "apps/server/src/video/creative-service.ts")).href;
  const runtime = pathToFileURL(path.join(engineRoot, "packages/video-studio/src/creative-runtime.ts")).href;
  const textClient = pathToFileURL(path.join(engineRoot, "packages/video-studio/src/video-text-client.ts")).href;
  const archiveHost = pathToFileURL(path.join(engineRoot, "apps/server/src/video/archive-host.ts")).href;
  const code = `
    import { createHash } from "node:crypto";
    import { writeSync } from "node:fs";
    import { createCreativeExecutionSession } from ${JSON.stringify(service)};
    import { withCreativeBudget } from ${JSON.stringify(runtime)};
    import { completeVideoTextTask } from ${JSON.stringify(textClient)};
    import { acquireProjectLease } from ${JSON.stringify(archiveHost)};
    const data = JSON.parse(process.argv[1]);
    const lease = await acquireProjectLease(data.session.scope, data.session.projectId);
    if (!lease) throw new Error("fixture lost execution lease before crash injection");
    const session = await createCreativeExecutionSession(data.session);
    await session.beginStage("restartProbe");
    const prompt = JSON.stringify({ contractHash: data.session.expectedContract.hash, intent: data.session.rawIntent, caseId: data.caseId });
    await withCreativeBudget(session, () => completeVideoTextTask({
      endpoint: data.endpoint, scene: "video.preproduction.plan", requireJson: true,
      messages: [{ role: "user", content: prompt }],
      fetchImpl: async (_url, init) => {
        const sha = text => createHash("sha256").update(text).digest("hex");
        writeSync(1, JSON.stringify({ wireBodyHash: sha(init.body), promptHash: sha(prompt), model: JSON.parse(init.body).model, bytes: Buffer.byteLength(init.body) }) + "\\n");
        process.exit(73);
      },
    }));
  `;
  const args = { caseId: s.id, endpoint, session: { scope: scopeBase, projectId: input.scope.projectId, runId,
    rawIntent: input.rawIntent, metadata: input.metadata, isMarketing: input.isMarketing, mode: "enforce", model: endpoint.model,
    expectedContract: contract } };
  return new Promise<Obj>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code, JSON.stringify(args)],
      { cwd: engineRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const stdout: string[] = [], stderr: string[] = [];
    child.stdout.setEncoding("utf8").on("data", data => stdout.push(data));
    child.stderr.setEncoding("utf8").on("data", data => stderr.push(data));
    child.once("error", error => { clearTimeout(deadline); reject(error); });
    child.once("close", status => {
      clearTimeout(deadline);
      if (status !== 73) return reject(new Error(`restart injection exit=${status} ${stderr.join("").slice(-1600)}`));
      try { resolve(JSON.parse(stdout.join("").trim().split("\n").at(-1)!)); }
      catch (error) { reject(error); }
    });
  });
}

describe.runIf(isolated)("real creative evaluation disturbance matrix", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    benchmarkRoot = await mkdtemp(path.join(tmpdir(), "creative-evaluation-fixture-"));
    vi.stubEnv("HR_WORK_DIR", benchmarkRoot);
    vi.stubEnv("ARCHIVE_AUTO_RESUME", "0");
    vi.stubEnv("VM_CREATIVE_BUDGET_CNY", "10");
    vi.stubEnv("VM_CREATIVE_MAX_CALLS", "30");
    vi.stubEnv("VM_CREATIVE_MAX_TOKENS", "30000000");
    vi.stubEnv("VM_CREATIVE_MAX_WALL_MS", "120000");
    vi.stubEnv("VM_CREATIVE_MODEL_PRICES", JSON.stringify({ [endpoint.model]: { inputCnyPerMillion: 0.01, outputCnyPerMillion: 0.03 } }));
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: engineRoot, encoding: "utf8" }).trim();
    for (const file of [nativePath, fileURLToPath(import.meta.url),
      path.join(engineRoot, "packages/video-studio/src/constraint-compiler.ts"),
      path.join(engineRoot, "packages/video-studio/src/creative-runtime.ts"),
      path.join(engineRoot, "apps/server/src/video/creative-service.ts"),
      path.join(engineRoot, "apps/server/src/video/creative-api-service.ts"),
      path.join(engineRoot, "apps/server/src/video/creative-router.ts"),
      path.join(engineRoot, "packages/db/migrations/0062_video_creative_contracts.sql")]) {
      artifactHashes[path.relative(engineRoot, file)] = creativeTextHash((await readFile(file)).toString("utf8"));
    }
    schemaHash = creativeHash({ fields: labels, nativeSourceHash: artifactHashes[path.relative(engineRoot, nativePath)] });
    await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'creative matrix fixture','pro')", [scopeBase.tenantId]);
    await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'creative matrix fixture',$1,'general')",
      [scopeBase.workspaceId, scopeBase.tenantId]);
    await owner.query("INSERT INTO members (id,workspace_id,member_no,name,role,status) VALUES ($1,$2,$3,'fixture owner','owner','active')",
      [fixtureMemberId, scopeBase.workspaceId, fixtureIdentity.memberNo]);
    const { videoRouter } = await import("./router.js");
    caller = videoRouter.createCaller({ identity: fixtureIdentity, session: fixtureIdentity, partnerIdentity: null, headers: new Headers() });
  }, 30_000);

  afterAll(async () => {
    const output = process.env.CREATIVE_EVALUATION_MATRIX_OUT;
    try {
      if (output) await writeFile(output, JSON.stringify({
        schemaVersion: "workloom.creative-evaluation-matrix/v1", dataMode: "fixture", sourceCommit, sourceHashes: artifactHashes,
        expectedCases: fixtures.length, executedCases: records.length, passedCases: records.filter(caseResult => caseResult.passed === true).length,
        cases: records.sort((a, b) => String(a.id).localeCompare(String(b.id))),
        providerMode: "local fixture at actual HTTP dispatch", chargeableProviderRequests: 0,
      }, null, 2) + "\n");
    } finally {
      vi.unstubAllEnvs();
      if (owner) await Promise.all([owner.end(), getAppPool().end()]);
      if (benchmarkRoot) await rm(benchmarkRoot, { recursive: true, force: true });
    }
  });

  it.each(fixtures)("$id $route $combination $disturbance", async s => {
    const scope = { ...scopeBase, projectId: `fixture-${s.id}-${randomUUID()}` };
    const fixture = inputs(s, scope), { seed } = fixture, runId = randomUUID();
    const requests: Array<{ wireBodyHash: string; promptHash: string; model: string; bytes: number; shotId: string }> = [];
    const evidence: Obj = { ...s, sourceCommit, schemaHash, model: endpoint.model, rawIntentHash: creativeTextHash(seed.rawIntent),
      sourceInputHash: creativeHash(seed), factsHash: seed.facts?.hash ?? null, steps: [], outboundRequests: requests,
      preconditions: { dataMode: "fixture", scope, initialContractRevision: 0, persistedBudgetCny: 10, finiteRequestLimit: 30,
        nativeFieldKeys: fieldKeys, planInputRoute: s.route, privateSourceFixture: Boolean(seed.facts), authorizedVoiceFixture: fixture.castVoice,
        productVisualMode: fixture.abstract ? "abstract_without_product_appearance" : "no_named_product" } };
    records.push(evidence);
    let lease: Awaited<ReturnType<typeof acquireProjectLease>> = null;
    try {
      await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'creative matrix fixture',$3,'fixture')",
        [scope.projectId, scope.workspaceId, s.route]);
      const steps: string[] = evidence.steps as string[];
      steps.push("Invoke the mounted tRPC studio.compileIntent using a current member record; verify current source, PG replay and idempotent response.");
      const intakeRequest = { projectId: scope.projectId, rawIntent: seed.rawIntent, metadata: seed.metadata as Parameters<typeof caller.studio.compileIntent>[0]["metadata"],
        expectedRevision: 0, idempotencyKey: `matrix-intake:${s.id}` };
      try {
        const provisional = await caller.studio.compileIntent(intakeRequest);
        const replay = await caller.studio.compileIntent(intakeRequest);
        expect(replay).toEqual(provisional);
        expect(provisional).toMatchObject({ scope, rawIntent: seed.rawIntent, route: s.route, revision: 1 });
        expect(await creativeTx(scope, client => latestCreativeContract(client, scope))).toMatchObject({ hash: provisional.hash });
        evidence.intake = { status: provisional.feasibility.status, revision: provisional.revision, hash: provisional.hash, idempotentReadback: true };
      } catch (error) {
        if (!fixture.anticipatedCode || !["BAD_REQUEST", "CONFLICT", "PRECONDITION_FAILED"].includes(errorCode(error))) throw error;
        evidence.intake = { code: errorCode(error) };
      }
      steps.push("Resolve current customer cast, delivery, and visual applicability, then persist the authorized fixture source in scoped PG.");
      let contract: Session["contract"] | undefined, visual: ReturnType<typeof extractProductVisualAuthority> | undefined;
      let rejection: string | undefined;
      try {
        requirementCast(seed.metadata!);
        seed.profile = { ...normalizePrdProductionProfile(seed.metadata!) };
        if (fixture.abstract) visual = extractProductVisualAuthority(fixture.g1(seed.rawIntent, seed.metadata!));
        evidence.compiledInputHash = creativeHash(seed);
        contract = await saveContract(seed);
        evidence.contractHash = contract.hash;
        evidence.feasibility = contract.feasibility;
        if (contract.feasibility.status !== "feasible") rejection = contract.feasibility.findings[0]?.code ?? contract.feasibility.status;
      } catch (error) {
        rejection = errorCode(error);
      }
      if (fixture.anticipatedCode) {
        evidence.expected = { code: fixture.anticipatedCode, outbound: 0 };
        evidence.actual = { code: rejection ?? null };
        expect(rejection).toBe(fixture.anticipatedCode);
        const db = await readRun(scope, runId);
        expect(db.operations).toHaveLength(0); expect(db.runs).toHaveLength(0);
        evidence.ledger = db;
        evidence.usage = { knownMicros: 0, unknownRequests: 0 };
        return;
      }
      expect(rejection).toBeUndefined();
      if (!contract) throw new Error("missing scoped compiled contract");
      const approved = contract;
      if (s.disturbance === "restart_unknown") {
        evidence.expected = { exit: 73, durableState: "dispatched", restartError: "CREATIVE_USAGE_UNKNOWN", runState: "reconciling", newDispatches: 0 };
        steps.push("Fork a new worker, persist reservation, and terminate at the recorded transport boundary before a receipt.");
        evidence.processExit = await crashAfterDispatch(s, seed, approved, runId);
        const prior = await readRun(scope, runId);
        expect(prior.operations).toHaveLength(1);
        expect(prior.operations[0]).toMatchObject({ state: "dispatched", dispatched: true, cost: { reserved: true } });
        steps.push("Recreate the service against the same PG state and attempt the same execution without a receipt.");
        await expect.poll(async () => {
          lease ??= await acquireProjectLease(scope, scope.projectId);
          return lease !== null;
        }, { timeout: 1500 }).toBe(true);
        await expect(startSession(seed, runId, approved)).rejects.toMatchObject({ code: "CREATIVE_USAGE_UNKNOWN" });
        const resumed = await readRun(scope, runId);
        expect(resumed.operations).toEqual(prior.operations);
        expect(resumed.artifacts).toEqual(prior.artifacts);
        expect(resumed.runs).toHaveLength(1);
        expect(resumed.runs[0]).toMatchObject({ status: "reconciling", next_action: "reconcile" });
        evidence.actual = { exit: 73, durableState: prior.operations[0].state, restartError: "CREATIVE_USAGE_UNKNOWN", newDispatches: 0,
          runStateBeforeRestart: prior.runs[0]?.status ?? null, runStateAfterRestart: resumed.runs[0]?.status ?? null };
        evidence.ledger = resumed;
        evidence.outboundRequestCount = 1;
        evidence.usage = { knownMicros: 0, unknownRequests: 1 };
        evidence.reconciliation = "No provider usage readback exercised; reservation remains open.";
        return;
      }
      lease = await acquireProjectLease(scope, scope.projectId);
      expect(lease).not.toBeNull();
      const session = await startSession(seed, runId, approved);
      await session.beginStage("phase3");
      const shots = shotInputs(s, approved);
      const agent = new PromptFusionAgent({ semanticRefinement: false });
      const generate = async (prompt: string, schemaValue: unknown) => {
        const schema = schemaValue as { shots: Array<{ shotId: string; fields: Obj }> };
        const target = schema.shots[0]!, shot = shots.find(row => row.shotId === target.shotId)!;
        expect(Object.keys(target.fields)).toEqual(fieldKeys);
        const compiledPrompt = prompt + (currentCreativeModelSlice() ?? "");
        const result = await completeVideoTextTask({
          endpoint, scene: "video.preproduction.plan", requireJson: true, timeoutMs: 150,
          messages: [{ role: "user", content: compiledPrompt }],
          fetchImpl: (async (_url, init) => {
            const wire = String(init?.body);
            requests.push({ wireBodyHash: creativeTextHash(wire), promptHash: creativeTextHash(compiledPrompt), model: JSON.parse(wire).model,
              bytes: Buffer.byteLength(wire), shotId: shot.shotId });
            const active = await readRun(scope, runId);
            expect(active.operations.find(row => row.operation_key === `creative.model:${requests.length}`)).toMatchObject({
              state: "dispatched", dispatched: true, cost: { reserved: true },
            });
            if (s.disturbance === "concurrent_revision" && requests.length === 1) {
              // Independent scoped transaction commits an updated raw revision
              // while this native/model request is in flight.
              const next = await saveContract({ ...seed, rawIntent: seed.rawIntent + "\n已确认补充：保持开场结构。" });
              evidence.concurrentRevision = { priorHash: approved.hash, currentHash: next.hash, revision: next.revision };
            }
            if (s.disturbance === "timeout_failure" && requests.length === 2) {
              const signal = init?.signal;
              if (!signal) throw new Error("missing transport timeout signal");
              await new Promise((_, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              });
            }
            return successEnvelope(`fixture-${s.id}-${requests.length}`, { shots: [{ shotId: shot.shotId, fields: fixtureFields(s, shot, fieldKeys) }] });
          }) as typeof fetch,
        });
        return result.value;
      };
      const runtime = new CreativeRuntime({ contract: approved, model: endpoint.model, nativeSchemaHash: schemaHash, fields: { keys: fieldKeys, labels },
        cache: { read: session.readCache, write: session.writeCache }, assertCurrent: session.assertCurrent, onEvent: session.onEvent,
        ...(visual ? { visualAuthority: visual } : {}), generate,
      });
      steps.push("Run the actual native single-shot fusion and final prompt compiler through the budgeted provider protocol.");
      const state = { shots, result: { stages: {} }, adaptedBlueprint: { config: { aspectRatio: approved.profile.aspectRatio }, character_system: { characters: fixture.castVoice ? [{ id: approvedId, name: approvedName }] : [] } } };
      let output: Obj | undefined, failure: unknown;
      try {
        output = await withCreativeBudget(session, () => withCreativeRuntime(runtime, () => runtime.executePhase3(state, agent)));
        await session.completeStage("phase3", output);
        await session.finish({ success: true });
      } catch (error) {
        failure = error;
        await session.finish({ success: false, error });
      }
      const db = await readRun(scope, runId);
      evidence.ledger = db;
      evidence.planHash = session.planHash;
      evidence.outboundRequestCount = requests.length;
      evidence.usage = { knownMicros: db.operations.filter(row => row.cost.reserved === false).reduce((total, row) => total + row.cost.micros, 0),
        unknownRequests: db.operations.filter(row => row.cost.reserved === true).length };
      evidence.actual = { state: db.runs[0]?.status ?? null, code: failure ? errorCode(failure) : null };
      if (s.disturbance === "normal") {
        evidence.expected = { stage: "passed", outbound: shots.length };
        expect(failure).toBeUndefined(); expect(output?.success).toBe(true);
        expect(db.runs[0]?.status).toBe("completed"); expect(db.operations).toHaveLength(shots.length);
        expect(db.operations.every(row => row.state === "accepted" && row.cost.reserved === false)).toBe(true);
        expect(requests).toHaveLength(shots.length);
        const resultShots = output!.shots as Array<{ duration: number; prompt: string; fields: Obj }>;
        expect(resultShots.reduce((sum, row) => sum + row.duration, 0)).toBe(approved.profile.contentDuration);
        if (fixture.timed) {
          expect(approved.profile.contentDuration).toBe(57); expect(approved.profile.subtitleMode).toBe("sidecar");
          expect(resultShots[0]?.prompt).toContain("屏上独立图形文字：节点关系");
          expect(resultShots[0]?.prompt).toContain("字幕旁挂");
        }
        if (fixture.castVoice) {
          expect(resultShots[0]?.prompt).toContain(approvedName); expect(resultShots[0]?.prompt).toContain(narrator);
        }
        if (fixture.claimCoverage) {
          expect(resultShots[0]?.prompt).toContain(firstClaim); expect(resultShots[0]?.prompt).not.toContain(secondClaim);
          expect(resultShots[1]?.prompt).toContain(secondClaim);
        }
        if (fixture.abstract) {
          expect(resultShots[0]?.prompt).toContain(ABSTRACT_PRODUCT_RENDER_RULE);
          expect(resultShots[0]?.prompt).toContain("暖橙色为主"); expect(resultShots[0]?.prompt).toContain("手鼓");
        }
        evidence.output = { outputHash: creativeHash(output), prompts: resultShots.map(row => creativeTextHash(row.prompt)),
          fields: resultShots.map(row => creativeHash(row.fields)), exactContentSeconds: approved.profile.contentDuration };
        const baseline = await observeLegacyFusion(s, shots, state.adaptedBlueprint);
        expect(baseline.requests).toHaveLength(shots.length);
        expect(baseline.rows.every(row => row.degraded !== true && typeof row.prompt === "string")).toBe(true);
        const baselineFields = baseline.rows.map(row => row.fields);
        const fieldDiffs = resultShots.map((row, index) => creativeDiff(baselineFields[index], row.fields));
        evidence.baseline = { scope: "pinned legacy native fusion seam on identical fixture", outboundRequests: baseline.requests,
          outputHashes: baseline.rows.map(row => creativeTextHash(String(row.prompt))), fieldDiffs,
          comparedWholePipeline: false, artsCompared: false };
      } else if (s.disturbance === "timeout_failure") {
        evidence.expected = { code: "CREATIVE_USAGE_UNKNOWN", stage: "reconciling", outbound: 2 };
        expect(errorCode(failure)).toBe("CREATIVE_USAGE_UNKNOWN");
        expect(db.runs[0]?.status).toBe("reconciling");
        expect(db.operations.map(row => row.state)).toEqual(["accepted", "unknown"]);
        expect(db.operations[1]?.cost.reserved).toBe(true);
        expect(db.artifacts.filter(row => row.role === "creative-cache")).toHaveLength(1);
        expect(requests).toHaveLength(2);
      } else {
        evidence.expected = { code: "CREATIVE_CONTRACT_STALE", stage: "failed", outbound: 1 };
        expect(errorCode(failure)).toBe("CREATIVE_CONTRACT_STALE");
        expect(db.runs[0]?.status).toBe("failed");
        expect(db.artifacts.filter(row => row.role === "creative-cache")).toHaveLength(0);
        expect(requests).toHaveLength(1);
        expect(await creativeTx(scope, client => latestCreativeContract(client, scope))).toMatchObject({ revision: approved.revision + 1 });
      }
    } catch (error) {
      evidence.assertionFailure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await lease?.release();
      evidence.outboundRequestCount ??= requests.length;
      evidence.passed = evidence.assertionFailure === undefined;
    }
  }, 30_000);
});
