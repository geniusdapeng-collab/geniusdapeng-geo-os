/** 真实 PG、RLS、发行/消费/供应商适配器与事件；只替换模型网络回包，不花真实额度。 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gatewayAppend } from "@workloom/base/workdata";
import { ABSTRACT_PRODUCT_RENDER_RULE } from "@hyperreality/video-studio";
import { authorizeRenderSubmission, listProductionShots, loadQualifiedRenderInput, qualifyProductionShot } from "./production-authority.js";
import { prepareMarketingFacts, finalizeMarketingFacts } from "./marketing-authority.js";
import { renderSha256 } from "./gen/compiled-request.js";
import { submitGenJob } from "./gen/submit.js";
import { projectRunLockKey } from "./archive-host.js";
import { acceptPortraitArchiveReuse, portraitReuseEvidence } from "./portrait-reuse-acceptance.js";
import { portraitReuseFixture } from "./portrait-reuse.test-support.js";

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_APP_URL);
describe.runIf(RUN_DB)("正式生成资格活库契约", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  // 只有两个连接：并发回归会揭露每个租约再借第二连接造成的池耗尽。
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL, max: 2, connectionTimeoutMillis: 3000 });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const suffix = randomBytes(6).toString("hex");
  const scope = { tenantId: `t-authority-${suffix}`, workspaceId: `w-authority-${suffix}` };
  const other = { tenantId: `t-authority-other-${suffix}`, workspaceId: `w-authority-other-${suffix}` };
  let dir: string, projectId: string, sourceId: string, seq = 0;
  let env: NodeJS.ProcessEnv, approved = true;
  let calls: Array<{ url: string; body: string }>, providerCalls: number;
  const gates = ["G2_THEME", "G3_INSIGHT", "G4_PRD", "G5_PORTRAIT", "G6_PROMPT", "G7_FINAL"];

  beforeAll(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "authority-pg-")));
    for (const ctx of [scope, other]) {
      await owner.query("INSERT INTO tenants (id,name,plan) VALUES ($1,'正式资格契约','community')", [ctx.tenantId]);
      await owner.query("INSERT INTO workspaces (id,tenant_id,name,slug,industry) VALUES ($1,$2,'正式资格契约',$1,'general')", [ctx.workspaceId, ctx.tenantId]);
    }
  });
  beforeEach(async () => {
    projectId = `P-${suffix}-${++seq}`; sourceId = `SR-${suffix}-${seq}`;
    env = { HR_WORK_DIR: dir, WORKLOOM_RENDER_SIGNING_SECRET: "pg-test-render-signing-secret-more-than-32-bytes",
      VOLCENGINE_ARK_API_KEY: "pg-test-provider", LLM_BASE_URL: "https://judge.example.test", LLM_API_KEY: "pg-test-judge", LLM_MODEL: "deepseek-flash" };
    approved = true; providerCalls = 0; calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      calls.push({ url: String(url), body: String(init.body) });
      if (String(url).endsWith("/chat/completions")) return new Response(JSON.stringify({
        id: `judge-${suffix}-${seq}`,
        model: "deepseek-flash",
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify({ approved, score: approved ? 95 : 30, issues: approved ? [] : ["不合格"], suggestions: [], reason: "测试裁决" }) },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, completion_tokens_details: { reasoning_tokens: 0 } },
      }));
      providerCalls++;
      return new Response(JSON.stringify({ id: `provider-${suffix}-${seq}` }));
    }));
    await owner.query("INSERT INTO video_projects (id,workspace_id,title,kind,created_by) VALUES ($1,$2,'正式资格契约片','narrative','MEM-T')", [projectId, scope.workspaceId]);
    const root = path.join(dir, "archive", scope.workspaceId, projectId);
    await mkdir(path.join(root, "stages/preproduction"), { recursive: true });
    const proofs = [];
    for (const gate of gates) {
      const file = path.join(dir, "workspaces", scope.workspaceId, "gates", projectId, "attempt-1", `${gate}.md`);
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "完整预生产门内容");
      proofs.push(gate === "G5_PORTRAIT" ? { gate, status: "not_applicable", approved: true, basis: "no-characters-or-products" }
        : { gate, status: "passed", approved: true, via: "llm", degraded: false, model: "test-judge", evidence: [{ path: file, sha256: renderSha256("完整预生产门内容"), scope: "complete-text" }] });
    }
    const prompts = JSON.stringify({ stageId: "preproduction", attempt: 1, pipelineKind: "narrative", shots: [
      { shotId: "S1", durationSec: 5, degraded: false, prompt: "固定机位拍摄窗边玻璃杯。", fields: { durationSec: 5 } },
    ] });
    await writeFile(path.join(root, "stages/preproduction/attempt-1.prompts.json"), prompts);
    const output = JSON.stringify({ success: true, degraded: false, promptsRef: "stages/preproduction/attempt-1.prompts.json", promptsSha256: renderSha256(prompts),
      productionEvidence: { schemaVersion: "workloom.preproduction-authority/v1", issuer: "workloom.studio-worker", ...scope, projectId,
        runId: `RUN-${seq}`, attempt: 1, pipelineKind: "narrative", gates: proofs } });
    await writeFile(path.join(root, "stages/preproduction/attempt-1.output.json"), output);
    await owner.query(`INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,status,run_id,output_ref,output_sha256)
      VALUES ($1,$2,$3,'preproduction',1,'done',$4,'stages/preproduction/attempt-1.output.json',$5)`, [sourceId, scope.workspaceId, projectId, `RUN-${seq}`, renderSha256(output)]);
    await gatewayAppend(gateway, { ...scope, actor: { id: "video-studio", type: "system" } }, {
      who: { id: "video-studio", type: "system" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString(), channel: "inapp" },
      object: { type: "video_project", id: projectId },
      decision: { action: "video.scene_policy.selected", after: { runId: `RUN-${seq}`, id: null, version: null, sourceSha256: null,
        reason: "原始需求未命中已安装片型", evidence: [] } }, rule_impact: [],
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  // 不删除 append-only 资格/五元事件；专属测试作用域留作真实回归证据。
  afterAll(async () => { await Promise.all([owner.end(), app.end(), gateway.end()]); await rm(dir, { recursive: true, force: true }); });

  const issue = (pool = app) => qualifyProductionShot({ app: pool, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1",
    modelId: "doubao-seedance-2-5", params: { aspectRatio: "16:9" }, mode: "manual", env });
  async function input(token: string, pool = app) {
    return { ...await loadQualifiedRenderInput(app, scope, token, env), app: pool, gateway, scope, actor: "MEM-ORIGINAL",
      qualificationToken: token, fenceLevel: "auto", fenceImpacts: [], env };
  }
  async function scoped<T>(ctx: typeof scope, run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.workspace_id',$2,true)", [ctx.tenantId, ctx.workspaceId]);
      const result = await run(client); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  function faultPool(needle: string) {
    let used = false;
    return { connect: async () => { const client = await app.connect(); return {
      query: (sql: string, values?: unknown[]) => { if (!used && sql.includes(needle)) { used = true; throw new Error("injected atomic failure"); } return client.query(sql, values); },
      release: (discard?: boolean) => client.release(discard),
    }; } } as unknown as pg.Pool;
  }

  async function marketingSource(abstract = false) {
    const root = path.join(dir, "archive", scope.workspaceId, projectId);
    const body = "星野 F3 风扇支持 9 档风量；9 档不是能耗等级。", sourceUrl = "https://source.example.com/f3";
    const marketingSourceId = `SRC-${renderSha256(`${sourceUrl}\n${renderSha256(body)}`).slice(0, 24)}`;
    const imageUrl = `${sourceUrl}/hero.png`;
    const snapshot = { sourceId: marketingSourceId, requestedUrl: sourceUrl, finalUrl: sourceUrl, redirectChain: [], fetchedAt: new Date().toISOString(), contentType: "text/plain", rawSha256: renderSha256(body), textSha256: renderSha256(body), bytes: Buffer.byteLength(body), text: body, assetUrls: abstract ? [] : [imageUrl] };
    const prepared = await prepareMarketingFacts({ scope: { ...scope, projectId, runId: `RUN-${seq}`, attempt: 1 }, root, env,
      intent: abstract ? "介绍星野 F3 的风量档位；只使用抽象示意图，不展示产品外观。" : "介绍星野 F3 的风量档位", metadata: { brief: { product: "星野 F3" } },
      llm: { reason: async prompt => {
        const stage = /当前阶段：(A[123])/.exec(prompt)?.[1];
        return { success: true, data: stage === "A1" ? { payload: { identity: { name: "星野 F3", specs: { 风量: "9 档" } }, images: abstract ? [] : [{ url: imageUrl, page_url: sourceUrl }] }, citations: ["/identity/name", "/identity/specs/风量"].map(pointer => ({ pointer, sourceId: snapshot.sourceId, quote: body })) }
          : { payload: stage === "A2" ? { reviews: [] } : { competitors: [] }, citations: [], noEvidenceReason: "本次未取得可核实的评价/竞品" } };
      } }, dependencies: { search: async () => [{ title: "规格", url: sourceUrl, snippet: "不是正文" }], fetchSource: async () => ({ snapshot, rawBytes: Buffer.from(body) }) } });
    const promptsFile = path.join(root, "stages/preproduction/attempt-1.prompts.json"), outputFile = path.join(root, "stages/preproduction/attempt-1.output.json");
    const prompts = JSON.parse(await readFile(promptsFile, "utf8")); prompts.pipelineKind = "marketing";
    prompts.shots[0].prompt = abstract ? `暖橙光点聚合为抽象格网；旁白：星野 F3 有 9 档风量。${ABSTRACT_PRODUCT_RENDER_RULE}` : "窗边展示星野 F3 风扇，字幕：风量 9 档。";
    const saved = await finalizeMarketingFacts(prepared, prompts.shots, env);
    const g1File = path.join(dir, "workspaces", scope.workspaceId, "gates", projectId, "attempt-1", "G1_DOSSIER.md");
    await writeFile(g1File, prepared.g1Content);
    const output = JSON.parse(await readFile(outputFile, "utf8"));
    output.marketingFactsRef = saved.ref; output.marketingFactsSha256 = saved.sha256;
    output.productionEvidence.pipelineKind = "marketing"; output.productionEvidence.gates.unshift({ gate: "G1_DOSSIER", status: "passed", approved: true, via: "llm", degraded: false, model: "test-judge", evidence: [{ path: g1File, sha256: renderSha256(prepared.g1Content), scope: "complete-text" }] });
    const promptBytes = JSON.stringify(prompts); await writeFile(promptsFile, promptBytes); output.promptsSha256 = renderSha256(promptBytes);
    const bytes = JSON.stringify(output); await writeFile(outputFile, bytes);
    await owner.query("UPDATE video_projects SET kind='marketing' WHERE id=$1", [projectId]);
    await owner.query("UPDATE production_stage_runs SET output_sha256=$2 WHERE id=$1", [sourceId, renderSha256(bytes)]);
    return { root, prepared, output, outputFile, prompts, promptsFile, g1File };
  }

  async function portraitProof(state: Awaited<ReturnType<typeof marketingSource>>) {
    // A complete, tiny PNG fixture. Role comes only from the G5 index and the
    // independently attested file digest, never from its name or caller text.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVmsAAAAASUVORK5CYII=", "base64");
    const root = path.join(dir, "workspaces", scope.workspaceId, "characters", projectId);
    await mkdir(root, { recursive: true });
    const characters: Record<string, string> = {}, evidence: Array<{ path: string; sha256: string; scope: string }> = [];
    for (const [i, angle] of ["front", "threeQuarter", "closeup", "side", "product"].entries()) {
      const file = path.join(root, `${angle}.png`);
      const bytes = i === 0 ? png : Buffer.concat([png, Buffer.from([i])]);
      await writeFile(file, bytes);
      evidence.push({ path: file, sha256: renderSha256(bytes), scope: "image" });
      if (angle !== "product") characters[angle] = file;
    }
    const index = { schemaVersion: "workloom.portrait-index/v1", projectId, generatedAt: new Date().toISOString(),
      characters: { "fixture-person-2fe0d6c3": { kind: "character", id: "fixture person", name: "合成人物甲", files: characters } },
      products: { "fixture-product": { kind: "product", id: "fixture-product", files: { front: evidence.at(-1)!.path } } } };
    const indexFile = path.join(root, "portrait-index.json"), indexText = JSON.stringify(index);
    await writeFile(indexFile, indexText);
    evidence.push({ path: indexFile, sha256: renderSha256(indexText), scope: "complete-text" });
    const gate = state.output.productionEvidence.gates.find((item: { gate: string }) => item.gate === "G5_PORTRAIT");
    Object.assign(gate, { status: "passed", approved: true, via: "llm", degraded: false, model: "test-judge", evidence });
    delete gate.basis;
    const bytes = JSON.stringify(state.output);
    await writeFile(state.outputFile, bytes);
    await owner.query("UPDATE production_stage_runs SET output_sha256=$2 WHERE id=$1", [sourceId, renderSha256(bytes)]);
    return { png, character: evidence[0]!, product: evidence.at(-2)!, indexFile, indexText };
  }

  it("MC-011 an accepted G5 character reference is discoverable, reviewed as an image, and dispatched as exactly frozen bytes", async () => {
    const state = await marketingSource(true);
    const fixture = portraitReuseFixture(path.join(dir, "workspaces", scope.workspaceId), projectId);
    const proof = acceptPortraitArchiveReuse(fixture.input), character = fixture.outputs.front!;
    const gate = state.output.productionEvidence.gates.find((item: { gate: string }) => item.gate === "G5_PORTRAIT");
    Object.assign(gate, { status: "passed", approved: true, via: "archive-reuse-acceptance", degraded: false, model: null,
      archiveReuse: proof, evidence: portraitReuseEvidence(proof) });
    delete gate.basis;
    const output = JSON.stringify(state.output);
    await writeFile(state.outputFile, output);
    await owner.query("UPDATE production_stage_runs SET output_sha256=$2 WHERE id=$1", [sourceId, renderSha256(output)]);
    const ref = `portrait:sha256:${character.sha256}`;
    const listing = await listProductionShots({ app, scope, projectId, env });
    expect(listing).toMatchObject({ characterReferences: expect.arrayContaining([{ ref, characterId: "c1", angle: "front" }]) });
    const qualification = await qualifyProductionShot({ app, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1", modelId: "doubao-seedance-2-5",
      params: { aspectRatio: "16:9", referenceImageUrls: [ref] }, env });
    expect(qualification.params.referenceImageUrls).toEqual([ref]);
    const png = await readFile(character.path), indexText = await readFile(fixture.indexPath);
    const image = `data:image/png;base64,${png.toString("base64")}`;
    const stored = (await owner.query("SELECT compiled_request,producer_verdict FROM production_qualifications WHERE id=$1", [qualification.qualificationId])).rows[0];
    expect(stored.producer_verdict.evidence).toContainEqual({ path: character.path, sha256: character.sha256, scope: "image" });
    expect(calls.at(-1)?.body).toContain(image);
    expect(calls.at(-1)?.body).toContain(ref);
    expect(stored.compiled_request.body.content).toEqual([
      { type: "text", text: state.prompts.shots[0].prompt },
      { type: "image_url", role: "reference_image", image_url: { url: image } },
    ]);
    const approved = await input(qualification.qualificationToken);
    await writeFile(character.path, "changed portrait bytes");
    await expect(submitGenJob(approved)).rejects.toThrow("PREPRODUCTION_GATES_UNVERIFIED");
    await writeFile(character.path, png);
    await writeFile(fixture.indexPath, `${indexText.toString("utf8")} `);
    await expect(submitGenJob(approved)).rejects.toThrow("PREPRODUCTION_GATES_UNVERIFIED");
    expect(providerCalls).toBe(0);
    await writeFile(fixture.indexPath, indexText);
    await submitGenJob(approved);
    expect(calls.at(-1)?.body).toBe(stored.compiled_request.bodyJson);
    expect((await submitGenJob(approved)).deduped).toBe(true);
    expect(providerCalls).toBe(1);
  });

  it("MC-011 ordinary G5 approval does not grant inline upload rights for a real or unproven face", async () => {
    const proof = await portraitProof(await marketingSource(true));
    const callsBefore = calls.length;
    expect((await listProductionShots({ app, scope, projectId, env })).characterReferences).toBeUndefined();
    for (const ref of [`portrait:sha256:${proof.character.sha256}`, `portrait:sha256:${proof.product.sha256}`, `portrait:sha256:${"f".repeat(64)}`,
      "asset://opaque-image", `data:image/png;base64,${proof.png.toString("base64")}`]) {
      await expect(qualifyProductionShot({ app, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1", modelId: "doubao-seedance-2-5",
        params: { aspectRatio: "16:9", referenceImageUrls: [ref] }, env })).rejects.toThrow("PRODUCT_VISUAL_REFERENCE_UNVERIFIED");
    }
    const ref = `portrait:sha256:${proof.character.sha256}`;
    await expect(qualifyProductionShot({ app, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1", modelId: "doubao-seedance-2-5",
      params: { referenceImageUrls: [ref, ref] }, env })).rejects.toThrow("PRODUCT_VISUAL_REFERENCE_UNVERIFIED");
    await expect(qualifyProductionShot({ app, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1", modelId: "hf-seedance-2-0-t2v",
      params: { referenceImageUrls: [ref] }, env: { ...env, HF_API_KEY_ID: "fixture-id", HF_API_KEY_SECRET: "fixture-secret" } }))
      .rejects.toThrow("PRODUCT_VISUAL_REFERENCE_UNVERIFIED");
    expect(calls).toHaveLength(callsBefore);
    expect(providerCalls).toBe(0);
  });

  it("MC-011 no-image marketing signs and sends the exact abstract prompt; opaque visual attachments never reach a judge or supplier", async () => {
    const state = await marketingSource(true);
    const previousCalls = calls.length;
    for (const attachment of [{ firstFrameUrl: "https://example.test/opaque.png" }, { referenceImageUrls: ["https://example.test/unverified.png"] },
      { referenceVideoUrls: ["https://example.test/unverified.mp4"] }, { extra: { product_reference: "https://example.test/product.png" } }]) {
      await expect(qualifyProductionShot({ app, scope, actor: "MEM-ORIGINAL", projectId, shotId: "S1", modelId: "doubao-seedance-2-5",
        params: { aspectRatio: "16:9", ...attachment }, mode: "manual", env })).rejects.toThrow("PRODUCT_VISUAL_REFERENCE_UNVERIFIED");
    }
    expect(calls).toHaveLength(previousCalls);
    const qualification = await issue();
    const result = await submitGenJob(await input(qualification.qualificationToken));
    expect(result.mock).toBe(false);
    expect(providerCalls).toBe(1);
    expect(JSON.parse(calls.at(-1)!.body).content).toEqual([{ type: "text", text: state.prompts.shots[0].prompt }]);
    expect(calls.at(-2)!.body).toContain("abstract_without_product_appearance");
  });

  it("MC-011 changed mode or altered prompt cannot reuse a signed request before send; restored original can send once", async () => {
    const state = await marketingSource(true), qualification = await issue();
    const original = await readFile(state.g1File);
    await writeFile(state.g1File, state.prepared.g1Content.replace("不展示产品外观", "展示产品外观"));
    await expect(submitGenJob(await input(qualification.qualificationToken))).rejects.toThrow();
    expect(providerCalls).toBe(0);
    await writeFile(state.g1File, original);
    const altered = await input(qualification.qualificationToken);
    altered.script = { ...altered.script, md: "展示产品包装" };
    await expect(submitGenJob(altered)).rejects.toThrow("QUALIFICATION_REQUEST_MISMATCH");
    expect(providerCalls).toBe(0);
    await submitGenJob(await input(qualification.qualificationToken));
    await submitGenJob(await input(qualification.qualificationToken));
    expect(providerCalls).toBe(1);
  });

  it("营销完整来源事实包→资格签发→Ark适配器提交（网络替身）；A2/A3缺证据用途限制保留", async () => {
    const state = await marketingSource(); expect(state.prepared.bundle.restrictions).toHaveLength(2);
    const qualification = await issue(); const result = await submitGenJob(await input(qualification.qualificationToken));
    expect(result.mock).toBe(false); expect(providerCalls).toBe(1);
    expect((await owner.query("SELECT status FROM production_qualifications WHERE id=$1", [qualification.qualificationId])).rows[0].status).toBe("passed");
    const repeated = await issue(); expect(repeated).toEqual(qualification);
  });
  it("营销签发后原文改变/新attempt不能提交；accepted补账继续只认原内容", async () => {
    const state = await marketingSource(), qualification = await issue();
    const textFile = path.join(state.root, state.prepared.bundle.sources[0]!.textRef), original = await readFile(textFile);
    await writeFile(textFile, "changed"); await expect(submitGenJob(await input(qualification.qualificationToken))).rejects.toThrow("MARKETING_FACTS_CHANGED"); expect(providerCalls).toBe(0);
    await writeFile(textFile, original);
    await expect(submitGenJob(await input(qualification.qualificationToken, faultPool("INSERT INTO render_jobs")))).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    expect(providerCalls).toBe(1);
    await owner.query("INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,status) VALUES ($1,$2,$3,'preproduction',2,'running')", [`SR-mk-new-${suffix}-${seq}`, scope.workspaceId, projectId]);
    await writeFile(textFile, "changed again");
    const retry = await submitGenJob(await input(qualification.qualificationToken)); expect(retry.deduped).toBe(true); expect(providerCalls).toBe(1);
  });
  it("营销G1失败或审核其他事实包不得签发，缺G1不能只靠其余六门", async () => {
    const state = await marketingSource();
    for (const variant of ["failed", "wrong-bound", "missing"]) {
      const output = structuredClone(state.output);
      if (variant === "failed") output.productionEvidence.gates[0].approved = false;
      if (variant === "wrong-bound") {
        const file = output.productionEvidence.gates[0].evidence[0].path;
        await writeFile(file, "另一事实包"); output.productionEvidence.gates[0].evidence[0].sha256 = renderSha256("另一事实包");
      }
      if (variant === "missing") output.productionEvidence.gates.shift();
      const bytes = JSON.stringify(output); await writeFile(state.outputFile, bytes);
      await owner.query("UPDATE production_stage_runs SET output_sha256=$2 WHERE id=$1", [sourceId, renderSha256(bytes)]);
      await expect(issue()).rejects.toThrow();
    }
    expect(providerCalls).toBe(0);
    expect((await owner.query("SELECT id FROM production_qualifications WHERE project_id=$1", [projectId])).rowCount).toBe(0);
  });

  it("服务签发→加载→真实Ark适配器提交；审核JSON字节等于POST；原子记录完整", async () => {
    const qualification = await issue();
    const result = await submitGenJob(await input(qualification.qualificationToken));
    expect(result).toMatchObject({ mock: false, provider: "seedance", deduped: false, requestHash: qualification.requestHash });
    const stored = await owner.query("SELECT compiled_request FROM production_qualifications WHERE id=$1", [qualification.qualificationId]);
    const sent = calls.find(call => call.url.endsWith("/contents/generations/tasks"));
    expect(sent).toEqual({ url: stored.rows[0].compiled_request.endpoint, body: stored.rows[0].compiled_request.bodyJson });
    const events = await owner.query(`SELECT payload->'decision'->>'action' AS action FROM biz_events WHERE workspace_id=$1 AND (
      payload->'decision'->'after'->>'qualificationId'=$2 OR payload->'decision'->'after'->>'jobId'=$3
      OR (payload->'decision'->>'action'='video.scene_policy.selected' AND payload->'object'->>'id'=$4)) ORDER BY seq`,
    [scope.workspaceId, qualification.qualificationId, result.jobId, projectId]);
    expect(events.rows.map(row => row.action)).toEqual(["video.scene_policy.selected", "render.qualification", "model.call", "render.submit"]);
    expect((await owner.query("SELECT status FROM render_scripts WHERE id=$1", [qualification.scriptId])).rows[0].status).toBe("submitted");
    const repeatQualification = await issue(); expect(repeatQualification).toEqual(qualification);
    expect((await submitGenJob(await input(repeatQualification.qualificationToken))).deduped).toBe(true); expect(providerCalls).toBe(1);
    expect(calls.filter(call => call.url.endsWith("/chat/completions"))).toHaveLength(1);
  });
  it("裸查询/错租户/错工作区看不到资格；应用角色不能注入跨scope资格", async () => {
    const qualification = await issue();
    expect((await app.query("SELECT id FROM production_qualifications WHERE id=$1", [qualification.qualificationId])).rows).toHaveLength(0);
    for (const ctx of [other, { ...scope, tenantId: other.tenantId }, { ...scope, workspaceId: other.workspaceId }]) {
      expect((await scoped(ctx, client => client.query("SELECT id FROM production_qualifications WHERE id=$1", [qualification.qualificationId]))).rows).toHaveLength(0);
      await expect(loadQualifiedRenderInput(app, ctx, qualification.qualificationToken, env)).rejects.toThrow("QUALIFICATION_SCOPE_MISMATCH");
    }
    const copy = (await owner.query("SELECT to_jsonb(q) AS data FROM production_qualifications q WHERE id=$1", [qualification.qualificationId])).rows[0].data;
    copy.id = `PQ-forged-${suffix}-${seq}`; copy.seq = -seq;
    await expect(scoped(other, client => client.query("INSERT INTO production_qualifications SELECT (jsonb_populate_record(NULL::production_qualifications,$1::jsonb)).*", [JSON.stringify(copy)])))
      .rejects.toThrow(/row-level security|source is not current/);
    expect(providerCalls).toBe(0);
  });
  it("owner也不能更新或删除资格；已签发脚本正文不可改，状态投影可以改", async () => {
    const qualification = await issue();
    await expect(owner.query("UPDATE production_qualifications SET status='failed' WHERE id=$1", [qualification.qualificationId])).rejects.toThrow("append-only");
    await expect(owner.query("DELETE FROM production_qualifications WHERE id=$1", [qualification.qualificationId])).rejects.toThrow("append-only");
    await expect(owner.query("UPDATE render_scripts SET md='forged' WHERE id=$1", [qualification.scriptId])).rejects.toThrow("immutable");
    await expect(owner.query("DELETE FROM render_scripts WHERE id=$1", [qualification.scriptId])).rejects.toThrow("immutable");
    await expect(scoped({ ...scope, tenantId: other.tenantId }, client => client.query("UPDATE render_scripts SET md='forged-via-hidden-qualification' WHERE id=$1", [qualification.scriptId]))).rejects.toThrow("immutable");
    expect((await owner.query("UPDATE render_scripts SET status='approved' WHERE id=$1 RETURNING id", [qualification.scriptId])).rowCount).toBe(1);
  });
  it("资格事件失败时脚本、资格与事件同事务全回滚，未留下可使用的半证书", async () => {
    const before = (await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rows[0].n;
    await expect(issue(faultPool("append_event_insert"))).rejects.toThrow("injected atomic failure");
    for (const table of ["render_scripts", "production_qualifications"]) expect((await owner.query(`SELECT id FROM ${table} WHERE project_id=$1`, [projectId])).rows).toHaveLength(0);
    expect((await owner.query("SELECT count(*)::int AS n FROM biz_events WHERE workspace_id=$1", [scope.workspaceId])).rows[0].n).toBe(before);
    expect(providerCalls).toBe(0);
  });
  it("最新拒绝会覆盖旧通过的消费资格；旧记录保留且不发第二份脚本", async () => {
    const qualification = await issue(); approved = false;
    await expect(issue()).rejects.toThrow("PRODUCTION_REVIEW_REJECTED");
    const rows = await owner.query("SELECT status FROM production_qualifications WHERE project_id=$1 ORDER BY seq", [projectId]);
    expect(rows.rows.map(row => row.status)).toEqual(["passed", "failed"]);
    expect((await owner.query("SELECT id FROM render_scripts WHERE project_id=$1", [projectId])).rowCount).toBe(1);
    await expect(loadQualifiedRenderInput(app, scope, qualification.qualificationToken, env)).rejects.toThrow("QUALIFICATION_SUPERSEDED");
    expect(providerCalls).toBe(0);
  });
  it("新attempt即使running也使旧通过失效，直接SQL伪造旧源新资格也拒绝", async () => {
    const qualification = await issue();
    await owner.query("INSERT INTO production_stage_runs (id,workspace_id,project_id,stage_id,attempt,status) VALUES ($1,$2,$3,'preproduction',2,'running')", [`SR-new-${suffix}-${seq}`, scope.workspaceId, projectId]);
    await expect(submitGenJob(await input(qualification.qualificationToken))).rejects.toThrow("PREPRODUCTION_REQUIRED");
    await expect(owner.query(`INSERT INTO production_qualifications SELECT (jsonb_populate_record(NULL::production_qualifications,
      (SELECT to_jsonb(q) FROM production_qualifications q WHERE q.id=$1) || jsonb_build_object('id',$2::text,'seq',nextval('production_qualifications_seq_seq')))).*`, [qualification.qualificationId, `PQ-forged-${suffix}-${seq}`]))
      .rejects.toThrow("source is not current");
    expect(providerCalls).toBe(0);
  });
  it("shared提交lease阻止预生产/发行exclusive lease，不阻止另一提交；释放后可再取得", async () => {
    const qualification = await issue(), request = await input(qualification.qualificationToken);
    const held = await authorizeRenderSubmission(request); const observer = await owner.connect();
    try {
      expect((await observer.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [projectRunLockKey(scope, projectId)])).rows[0].ok).toBe(false);
      await expect(issue()).rejects.toThrow("QUALIFICATION_BUSY");
      const second = await authorizeRenderSubmission(request); await second.release();
    } finally { await held.release(); observer.release(); }
    const next = await issue(); expect(next.qualificationId).not.toBe(qualification.qualificationId);
  });
  it("100个同key真实提交在2连接池内不死锁；只有一个供应商调用和一个job", async () => {
    const qualification = await issue(), request = await input(qualification.qualificationToken);
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => submitGenJob(request)));
    const successful = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof submitGenJob>>> => result.status === "fulfilled");
    expect(successful.length).toBeGreaterThan(0); expect(new Set(successful.map(result => result.value.jobId)).size).toBe(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason.code).toMatch(/^SUBMISSION_(IN_PROGRESS|UNVERIFIED)$/);
    expect(providerCalls).toBe(1);
    expect((await owner.query("SELECT id FROM render_jobs WHERE script_id=$1", [qualification.scriptId])).rowCount).toBe(1);
    expect((await owner.query("SELECT dispatch_count,state FROM generation_submissions WHERE script_id=$1", [qualification.scriptId])).rows).toEqual([{ dispatch_count: 1, state: "finalized" }]);
  }, 20_000);
  it("accepted补账跨过expiry/source变更但不能改内容或换key，且不重发", async () => {
    const qualification = await issue(), request = await input(qualification.qualificationToken, faultPool("INSERT INTO render_jobs"));
    await expect(submitGenJob(request)).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    expect((await owner.query("SELECT state FROM generation_submissions WHERE script_id=$1", [qualification.scriptId])).rows[0].state).toBe("accepted");
    await owner.query("UPDATE production_stage_runs SET status='failed' WHERE id=$1", [sourceId]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    const retry = await input(qualification.qualificationToken);
    await expect(submitGenJob({ ...retry, idempotencyKey: "fresh-key" })).rejects.toThrow("QUALIFICATION_IDEMPOTENCY_MISMATCH");
    await expect(submitGenJob({ ...retry, params: { durationSec: 10 } })).rejects.toThrow("QUALIFICATION_REQUEST_MISMATCH");
    expect((await submitGenJob(retry)).deduped).toBe(true); expect(providerCalls).toBe(1);
  });
});
