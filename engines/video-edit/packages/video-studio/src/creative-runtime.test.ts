import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetCircuit } from "@workloom/base/model-router";
import { buildCreativeShots, compileCreativeContract, compileCreativePrompt, creativeHash, creativeTextHash, type CreativeShot } from "./constraint-compiler.js";
import { CreativeRuntime, withCreativeBudget, withCreativeRuntime, type CreativeBudgetHooks, type CreativeRuntimeOptions } from "./creative-runtime.js";
import { creativeCandidateHash, CREATIVE_ART_DIMENSIONS, type CreativeCandidateAssessment } from "./creative-evaluation.js";
import { WorkloomLLMEngine } from "./llm-adapter.js";
import { DEEPSEEK_FLASH_MODEL } from "./llm-config.js";
import { installPrdProductionBridge } from "./prd-authority-bridge.js";

type Obj = Record<string, unknown>;
const require = createRequire(import.meta.url);
const vendor = "../../../vendor/supermickey/hyperreality-system/engines/";
const { PromptFusionAgent } = require(`${vendor}production-engine/agents/prompt-fusion-agent.js`) as { PromptFusionAgent: new (options?: Obj) => Obj };
const { FIELD_NAME_CN: labels, CRITICAL_FIELDS } = require(`${vendor}field-standardizer.js`) as {
  FIELD_NAME_CN: Record<string, string>; CRITICAL_FIELDS: Record<"p0" | "p1" | "p2" | "p3", string[]>;
};
const requiredKeys = [...CRITICAL_FIELDS.p0, ...CRITICAL_FIELDS.p1];
const keys = [...requiredKeys, ...CRITICAL_FIELDS.p2, ...CRITICAL_FIELDS.p3];
const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace", projectId: "fixture-project" };
const endpoint = "https://offline-fixture.invalid/v1";
beforeEach(() => resetCircuit());
afterEach(() => resetCircuit());
const contract = compileCreativeContract({ scope, rawIntent: "成片20秒；画幅16:9。记录窗台光线移动。",
  metadata: { brief: { duration: 20, aspectRatio: "16:9" } }, bounds: { minShotSeconds: 3, maxShotSeconds: 15 },
  requiredFields: requiredKeys.filter(key => key !== "dialogue").map(key => labels[key]!) });

function nativeInputs() {
  return { shots: ["s1", "s2"].map((shotId, index) => ({ shotId, sceneId: `SC${index + 1}`, sceneType: "narrative",
    duration: 10, scene: "窗台光线向左移动", action: "光束掠过墙面", dialogueFree: true })),
    adaptedBlueprint: { config: { aspectRatio: "16:9" }, character_system: { characters: [] }, scenes: [] },
    result: { stages: {} as Obj } };
}
function nativeFields(delta: Obj = {}): Obj {
  return { ...Object.fromEntries(requiredKeys.filter(key => key !== "dialogue").map(key => [key, "镜头保留窗台的光线运动及背景细节"])),
    constraint: "画幅9:16，分辨率8K，帧率60；钟面12:30、混合2:1、预算8k",
    baseline: "光线透过窗棂；16:9画幅，8K分辨率，60fps；钟面12:30、混合2:1、预算8k",
    negative: "no text；无水印", ...delta };
}
function envelope(result: unknown, call: number, usage = true) {
  return new Response(JSON.stringify({ id: `fixture-${call}`, model: DEEPSEEK_FLASH_MODEL,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }],
    ...(usage ? { usage: { prompt_tokens: 180, completion_tokens: 260, total_tokens: 440 } } : {}) }));
}
function fixture(opts: {
  cache?: Map<string, unknown>;
  onRequest?: (input: { raw: string; prompt: string; schema: Obj; call: number; signal: AbortSignal | undefined | null }) => Response | Promise<Response>;
  runtime?: Partial<CreativeRuntimeOptions>;
} = {}) {
  const requests: Array<{ raw: string; prompt: string; schema: Obj }> = [];
  const operations: Array<{ request: Parameters<CreativeBudgetHooks["beforeModelCall"]>[0]; receipt?: Parameters<CreativeBudgetHooks["afterModelCall"]>[1] }> = [];
  const events: Array<{ kind: string; payload: Obj }> = [];
  const cache = opts.cache ?? new Map<string, unknown>();
  const fetchImpl = (async (_url, init) => {
    const raw = String(init?.body), message = JSON.parse(raw).messages.at(-1) as { content: string };
    const prompt = message.content, boundary = "【目标JSON结构示例】\n";
    const schema = prompt.includes(boundary) ? JSON.parse(prompt.slice(prompt.lastIndexOf(boundary) + boundary.length).split("\n\n##")[0]!) as Obj : {};
    requests.push({ raw, prompt, schema });
    if (opts.onRequest) return opts.onRequest({ raw, prompt, schema, call: requests.length, signal: init?.signal });
    const shotId = (schema.shots as Array<{ shotId: string }>)[0]!.shotId;
    return envelope({ shots: [{ shotId, fields: nativeFields() }] }, requests.length);
  }) as typeof fetch;
  const llm = new WorkloomLLMEngine({ baseUrl: endpoint, apiKey: "offline-fixture", model: DEEPSEEK_FLASH_MODEL, fetchImpl });
  const hooks: CreativeBudgetHooks = {
    beforeModelCall: async request => { operations.push({ request }); return operations.length - 1; },
    afterModelCall: async (reservation, receipt) => { operations[Number(reservation)]!.receipt = receipt; },
  };
  const options: CreativeRuntimeOptions = { contract, model: DEEPSEEK_FLASH_MODEL, nativeSchemaHash: creativeTextHash("native-schema-v1"),
    fields: { keys, labels, requiredKeys }, cache: { read: async key => cache.has(key) ? structuredClone(cache.get(key)) : null,
      write: async (key, value) => { cache.set(key, structuredClone(value)); } }, onEvent: async event => { events.push(event); },
    generate: async (prompt, schema) => {
      const result = await llm.reasonStructured(prompt, schema, { scene: "video.prompt.synthesis" });
      if (!result.success || !result.data) throw new Error(result.error ?? "missing fixture model output");
      return result.data;
    }, ...opts.runtime };
  const runtime = new CreativeRuntime(options), agent = new PromptFusionAgent({ semanticRefinement: true, llmMaxRetries: 5 });
  const run = <T>(callback: () => Promise<T>) => withCreativeBudget(hooks, () => withCreativeRuntime(runtime, callback));
  return { runtime, requests, operations, events, cache, agent, hooks, llm, run };
}
function fieldsForSchema(schema: Obj, fields: Obj) {
  return { shots: [{ shotId: (schema.shots as Array<{ shotId: string }>)[0]!.shotId, fields }] };
}

describe("enforced native creative runtime and HTTP boundary", () => {
  it("uses the actual native late writer and approval seams while retaining verified supplier bytes only in enforce", async () => {
    const root = "../../../vendor/supermickey/hyperreality-system/";
    const entry = require.resolve(`${root}index.js`), source = readFileSync(entry, "utf8");
    const start = source.indexOf("const { enhancedShots, report } = routeAndEnhance(productionResult.shots");
    const end = source.indexOf("console.log(`   ✅ 导演技能注入完成`);", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const applyDirectorSkills = compileFunction(source.slice(start, end), ["routeAndEnhance", "productionResult"], { filename: entry });
    const { routeAndEnhance } = require(`${root}skills/hollywood-cinematography/cinematography-skill-router.js`);
    const { DualArraySync } = require(`${root}utils/dual-array-sync.js`);
    const { PromptGuardian } = require(`${root}engines/prompt-guardian.js`);
    const directory = mkdtempSync(join(tmpdir(), "wl-creative-native-"));
    const confirmStart = source.indexOf("async _confirmPrompts("), confirmEnd = source.indexOf("\n  async _confirmPreproductionResult(", confirmStart);
    const confirm = compileFunction(`return ${source.slice(confirmStart, confirmEnd).replace("async _confirmPrompts", "async function _confirmPrompts")}`, [], { filename: entry })();
    const unused = (...keys: string[]) => Object.fromEntries(keys.map(key => [key, () => { throw new Error(`unexpected fixture seam ${key}`); }]));
    const systemPrototype = { ...unused("create", "_optimizeOpeningTitle", "_generatePromptsReport"), _confirmPrompts: confirm };
    const nativeStandardizer = require(`${root}engines/field-standardizer.js`);
    const dispose = installPrdProductionBridge({ systemPrototype,
      dualSyncPrototype: DualArraySync.prototype, promptGuardianPrototype: PromptGuardian.prototype,
      productionPrototype: unused("produce", "_loadLatestCheckpoint", "_saveCheckpoint", "_clearCheckpoints"),
      phase1Prototype: unused("_shouldGenerateOpening"), refinerPrototype: unused("_normalizeConstraint"),
      costumePrototype: unused("enhance"), fieldGuardPrototype: unused("normalizeAndValidate", "check", "assertOpeningFields"),
      fusionPrototype: unused("_loadSubCheckpoint", "_saveSubCheckpoint", "_clearSubCheckpoint"), qualityGatePrototype: unused("run"),
      deliveryGuardPrototype: unused("verify"), semanticPrototype: unused("_buildPrompt"),
      standardizeShot: nativeStandardizer.standardizeShot, validateShot: nativeStandardizer.validateShot, fields: nativeStandardizer.CRITICAL_FIELDS,
    });
    try {
      const f = fixture({ onRequest: ({ schema, call }) => envelope(fieldsForSchema(schema, nativeFields({
        scene: "雨夜霓虹映在湿润街面", camera_movement: "handheld, close follow", mood: "tense, lonely, noir atmosphere",
      })), call) });
      const input = nativeInputs();
      Object.assign(input.shots[0]!, { description: "雨夜的街头，手持跟拍", camera: "handheld, close follow" });
      Object.assign(input.shots[1]!, { description: "舞蹈场景，斯坦尼康环绕拍摄", camera: "steadicam, circular orbit" });
      let legacyInput: Obj[] = [];
      const guardian = new PromptGuardian({ strictMode: true, logPath: join(directory, "prompt-guardian.json") });
      await f.run(async () => {
        const fused = await f.runtime.executePhase3(input, f.agent);
        await f.runtime.verifyCompiledPhase(fused);
        const originals = fused.shots as Obj[];
        const expected = originals.map(shot => shot.prompt);
        legacyInput = structuredClone(originals);
        const sync = new DualArraySync(), state = sync.detach(originals, originals);
        applyDirectorSkills.call({ dualSync: sync }, routeAndEnhance, state);
        expect(state.shots.every((shot: Obj) => Array.isArray(shot._appliedSkills) && shot._appliedSkills.length > 0)).toBe(true);
        expect(state.shots.map((shot: Obj) => shot.prompt)).toEqual(expected);
        expect(state.prompts.map((shot: Obj) => shot.prompt)).toEqual(expected);
        const advice = guardian.guard(state.prompts);
        expect(advice.advisoryFixes).toEqual(expect.arrayContaining([expect.objectContaining({ type: "dialogue_clean" })]));
        expect(advice.fixes).toEqual([]); expect(advice.prompts).toBe(state.prompts);
        const reports: string[] = [];
        const review = await systemPrototype._confirmPrompts.call({
          _generatePromptsReport: (rows: Obj[]) => rows.map(row => row.prompt).join("\n"),
          _waitForExternalConfirmation: async (type: string, report: string) => {
            expect(type).toBe("prompt"); reports.push(report); return { approved: true };
          },
        }, advice.prompts);
        expect(review.approved).toBe(true); expect(reports).toEqual([expected.join("\n")]);
        await f.runtime.verifyHandoff(state.shots);
        const other = sync.detach(state.shots, state.prompts);
        other.shots[0].prompt += "unauthorized writer";
        sync.syncShotsToPrompts("OtherWriter", other.shots, other.prompts);
        await expect(f.runtime.verifyHandoff(other.prompts)).rejects.toThrow("CREATIVE_COMPILED_CHANGED");
      });
      // Both off and shadow call the vendor without a private creative runtime.
      const sync = new DualArraySync(), legacy = sync.detach(legacyInput, legacyInput);
      applyDirectorSkills.call({ dualSync: sync }, routeAndEnhance, legacy);
      expect(legacy.prompts[0].prompt).not.toBe(legacyInput[0]!.prompt);
      expect(legacy.prompts[0].prompt).toContain("技能增强");
      const legacyGuardian = new PromptGuardian({ logPath: join(directory, "legacy-prompt-guardian.json") });
      expect(legacyGuardian.guard(legacy.prompts).fixes).not.toHaveLength(0);
      expect(f.requests).toHaveLength(2);
      const unsafe = fixture({ onRequest: ({ schema, call }) => envelope(fieldsForSchema(schema, nativeFields({
        scene: call === 1 ? "画面表现痛苦" : "普通窗台光影",
      })), call) });
      await expect(unsafe.run(async () => {
        const fused = await unsafe.runtime.executePhase3(nativeInputs(), unsafe.agent);
        await unsafe.runtime.verifyCompiledPhase(fused);
        expect(() => guardian.guard(fused.shots)).toThrow("CREATIVE_PROMPT_GUARD_REJECTED");
        await expect(unsafe.runtime.verifyHandoff(fused.shots)).rejects.toThrow("CREATIVE_PROMPT_GUARD_REJECTED");
      })).rejects.toThrow("CREATIVE_PROMPT_GUARD_REJECTED");
    } finally { dispose(); rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(["structured brief", "explicit raw text"])("compiles a requested title in the real first shot model wire from %s", async mode => {
    const contractWithTitle = compileCreativeContract({ scope,
      rawIntent: mode === "explicit raw text" ? "成片20秒。片头加标题。" : "成片20秒。",
      metadata: { brief: { duration: 20, ...(mode === "structured brief" ? { productionRequirements: { titleCard: true } } : {}) } },
      bounds: { minShotSeconds: 3, maxShotSeconds: 15 }, requiredFields: contract.requiredFields });
    const title = { title_content: "光经过窗台", subtitle_content: "一日侧影", title_animation: "柔和淡入", title_font_design: "清晰无衬线字体", opening_audio_design: "轻柔环境音" };
    const f = fixture({ runtime: { contract: contractWithTitle }, onRequest: ({ schema, call }) => {
      const template = (schema.shots as { fields: Obj }[])[0]!.fields;
      for (const key of Object.keys(title)) expect(Object.hasOwn(template, key)).toBe(call === 1);
      return envelope(fieldsForSchema(schema, nativeFields(call === 1 ? title : {})), call);
    } });
    await f.run(async () => {
      const fused = await f.runtime.executePhase3(nativeInputs(), f.agent);
      await f.runtime.verifyCompiledPhase(fused);
      const [opening, ordinary] = fused.shots as Obj[];
      expect(opening).toMatchObject({ ...title, title: title.title_content, subtitle: title.subtitle_content });
      expect(opening!.prompt).toContain(title.title_content);
      expect(ordinary).not.toHaveProperty("title_content");
      await f.runtime.verifyHandoff(fused.shots);
    });
    expect(f.requests).toHaveLength(2);
    const noTitle = compileCreativeContract({ scope, rawIntent: "成片20秒，不要片头加标题。", metadata: contract.sourceMetadata });
    expect(fixture({ runtime: { contract: noTitle } }).runtime.usesGeneratedTitle).toBe(false);
  });

  it("fuses the actual native single shot once per shot, preserves story numbers and permits absent P2/P3", async () => {
    const f = fixture();
    const output = await f.run(async () => {
      const fused = await f.runtime.executePhase3(nativeInputs(), f.agent);
      const verified = await f.runtime.verifyCompiledPhase(fused);
      const first = (verified.shots as Obj[])[0]!;
      expect(f.runtime.compiledPromptFor(first, first.fields)).toBe(first.prompt);
      await f.runtime.verifyHandoff(verified.shots);
      return verified;
    });
    expect(f.requests).toHaveLength(2);
    expect(f.operations).toHaveLength(2);
    expect(f.events.filter(event => event.kind === "creative.repair.started")).toHaveLength(0);
    for (const [index, request] of f.requests.entries()) {
      expect(request.prompt).toContain(`当前单镜创作合同切片（只处理 s${index + 1}）`);
      expect(f.operations[index]).toMatchObject({ request: { requestHash: creativeTextHash(request.raw), inputChars: Buffer.byteLength(request.raw),
        maxOutputTokens: JSON.parse(request.raw).max_tokens, attempt: index + 1 }, receipt: { usageKnown: true, success: true, inputTokens: 180, outputTokens: 260 } });
    }
    const shots = output.shots as Obj[];
    expect(shots.map(shot => shot.shotId)).toEqual(["s1", "s2"]);
    expect(shots[0]!.prompt).toContain("钟面12:30、混合2:1、预算8k");
    expect(shots[0]!.prompt).toContain("分辨率1080p");
    expect(shots[0]!.prompt).not.toContain("画幅9:16");
    expect(shots[0]!.prompt).not.toContain("8K分辨率");
    expect(shots[0]!.fields).not.toHaveProperty("makeup");
    expect(shots[0]!.fields).not.toHaveProperty("transition");
  });

  it.each(["duplicate", "reorder", "fields", "prompt"])("refuses %s after native fusion or at handoff", async (mutation) => {
    const f = fixture();
    await f.run(async () => {
      const output = await f.runtime.executePhase3(nativeInputs(), f.agent);
      const shots = output.shots as Obj[];
      const changed = structuredClone(shots);
      if (mutation === "duplicate") changed[1] = changed[0]!;
      if (mutation === "reorder") changed.reverse();
      if (mutation === "fields") (changed[0]!.fields as Obj).scene = "tampered field without changing prompt";
      if (mutation === "prompt") changed[0]!.prompt = "late template rewrite";
      await expect(f.runtime.verifyCompiledPhase({ ...output, shots: changed })).rejects.toThrow(/CREATIVE_(SHOT_UNVERIFIED|SHOT_ORDER_CHANGED|COMPILED_CHANGED)/);
      await f.runtime.verifyCompiledPhase(output);
      await expect(f.runtime.verifyHandoff(changed)).rejects.toThrow(/CREATIVE_(SHOT_UNVERIFIED|SHOT_ORDER_CHANGED|COMPILED_CHANGED)/);
    });
    expect(f.requests).toHaveLength(2);
  });

  it.each(["forged-ir", "foreign-shot", "extra-shot"])("rejects %s in real model response with one HTTP call", async (kind) => {
    const f = fixture({ onRequest: ({ schema, call }) => {
      const value = fieldsForSchema(schema, nativeFields());
      if (kind === "forged-ir") value.shots[0]!.fields._workloomCreativeShot = { claimed: "accepted" };
      if (kind === "foreign-shot") value.shots[0]!.shotId = "foreign";
      if (kind === "extra-shot") value.shots.push({ shotId: "foreign", fields: nativeFields() });
      return envelope(value, call);
    } });
    await expect(f.run(() => f.runtime.executePhase3(nativeInputs(), f.agent))).rejects.toThrow(/CREATIVE_(FORGED_IR|MODEL_SCOPE_CHANGED)/);
    expect(f.requests).toHaveLength(1); expect(f.cache.size).toBe(0);
  });

  it("resumes the accepted first shot after the second fails without repeating the accepted request", async () => {
    const first = fixture({ onRequest: ({ schema, call }) => envelope(call === 1 ? fieldsForSchema(schema, nativeFields()) : { shots: [] }, call) });
    await expect(first.run(() => first.runtime.executePhase3(nativeInputs(), first.agent))).rejects.toThrow("CREATIVE_MODEL_SCOPE_CHANGED");
    expect(first.requests).toHaveLength(2); expect(first.cache.size).toBe(1);
    const next = fixture({ cache: first.cache });
    const finished = await next.run(() => next.runtime.executePhase3(nativeInputs(), next.agent));
    expect(next.requests).toHaveLength(1); expect(next.requests[0]!.prompt).toContain("只处理 s2");
    expect(next.events.filter(event => event.kind === "creative.cache.reused").map(event => event.payload.stage)).toEqual(["shot:s1"]);
    expect((finished.shots as Obj[]).map(shot => shot.shotId)).toEqual(["s1", "s2"]);
  });

  it("rejects a tampered cache, and a changed dependency creates a fresh cache key", async () => {
    const first = fixture(); await first.run(() => first.runtime.executePhase3(nativeInputs(), first.agent));
    const [key, value] = [...first.cache][0]! as [string, Obj];
    (value.output as Obj).prompt = "changed bytes"; first.cache.set(key, value);
    const corrupt = fixture({ cache: first.cache });
    await expect(corrupt.run(() => corrupt.runtime.executePhase3(nativeInputs(), corrupt.agent))).rejects.toThrow("CREATIVE_CACHE_CHANGED");
    expect(corrupt.requests).toHaveLength(0);
    const revised = fixture({ cache: first.cache, runtime: { nativeSchemaHash: creativeTextHash("native-schema-v2") } });
    await revised.run(() => revised.runtime.executePhase3(nativeInputs(), revised.agent));
    expect(revised.requests).toHaveLength(2);
  });

  it("repairs an absent native field once and binds actual diff and derived order", async () => {
    const f = fixture({ onRequest: ({ schema, call }) => {
      if (call === 1) { const fields = nativeFields(); delete fields.action; return envelope(fieldsForSchema(schema, fields), call); }
      if (call === 2) { const patch = structuredClone(schema) as unknown as CreativeShot; patch.fields[labels.action!] = "光线经过木窗边缘"; return envelope(patch, call); }
      return envelope(fieldsForSchema(schema, nativeFields()), call);
    } });
    const fused = await f.run(() => f.runtime.executePhase3(nativeInputs(), f.agent));
    expect(f.requests).toHaveLength(3);
    const first = (fused.shots as Obj[])[0]!;
    expect(first.prompt).toContain("光线经过木窗边缘");
    expect(f.events.find(e => e.kind === "creative.repair.started")?.payload).toMatchObject({ shotId: "s1", attempt: 1,
      signature: expect.stringMatching(/^[a-f0-9]{64}$/), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.events.find(e => e.kind === "creative.repair.applied")?.payload).toMatchObject({ actualDiff: [`fields.${labels.action}`], derivedFieldOrder: expect.arrayContaining([labels.action]) });
  });

  it.each(["same", "outside"])("stops local repair on %s actual diff without another HTTP attempt", async (kind) => {
    const f = fixture({ onRequest: ({ schema, call }) => {
      if (call === 1) { const fields = nativeFields(); delete fields.action; return envelope(fieldsForSchema(schema, fields), call); }
      const patch = structuredClone(schema) as unknown as CreativeShot;
      if (kind === "outside") { patch.fields[labels.action!] = "repair"; patch.id = "changed-id"; }
      return envelope(patch, call);
    } });
    await expect(f.run(() => f.runtime.executePhase3(nativeInputs(), f.agent))).rejects.toThrow(kind === "same" ? "REPAIR_NO_PROGRESS" : "PATCH_SCOPE_VIOLATION");
    expect(f.requests).toHaveLength(2);
  });

  it("caps unresolved repair at two actual local requests", async () => {
    const f = fixture({ onRequest: ({ schema, call }) => {
      if (call === 1) { const fields = nativeFields(); delete fields.action; return envelope(fieldsForSchema(schema, fields), call); }
      const patch = structuredClone(schema) as unknown as CreativeShot;
      patch.fields[labels.action!] = call === 2 ? "" : " ";
      return envelope(patch, call);
    } });
    await expect(f.run(() => f.runtime.executePhase3(nativeInputs(), f.agent))).rejects.toThrow("CREATIVE_REPAIR_LIMIT");
    expect(f.requests).toHaveLength(3);
    expect(f.events.filter(event => event.kind === "creative.repair.started").map(event => event.payload.attempt)).toEqual([1, 2]);
  });

  it("blocks an infeasible actual plan before any model dispatch", async () => {
    const f = fixture(), invalid = nativeInputs(); invalid.shots[1]!.duration = 9;
    await expect(f.run(() => f.runtime.executePhase3(invalid, f.agent))).rejects.toThrow("CREATIVE_NATIVE_PLAN_INFEASIBLE");
    expect(f.requests).toHaveLength(0);
  });

  it("unknown or interrupted usage settles unknown, prevents hidden native retry and freezes later calls", async () => {
    for (const mode of ["missing-usage", "network-drop"]) {
      const f = fixture({ onRequest: ({ schema, call }) => {
        if (mode === "network-drop") throw new Error("fixture socket dropped after dispatch");
        return envelope(fieldsForSchema(schema, nativeFields()), call, false);
      } });
      await expect(f.run(async () => {
        await expect(f.runtime.executePhase3(nativeInputs(), f.agent)).rejects.toThrow("CREATIVE_USAGE_UNKNOWN");
        const later = await f.llm.reasonStructured("no second dispatch", {}, { scene: "video.prompt.synthesis" });
        expect(later.success).toBe(false);
      })).rejects.toThrow("CREATIVE_USAGE_UNKNOWN");
      expect(f.requests).toHaveLength(1);
      expect(f.operations[0]?.receipt).toMatchObject({ usageKnown: false, success: false, actualCny: null });
      expect(f.cache.size).toBe(0);
    }
  });

  it("cancelled in-flight work receives an abort signal and never publishes a late accepted shot", async () => {
    let cancel = false;
    const f = fixture({ onRequest: ({ signal }) => new Promise<Response>((_resolve, reject) => {
      cancel = true;
      signal!.addEventListener("abort", () => reject(new Error("fixture aborted transport")), { once: true });
    }) });
    await expect(withCreativeBudget({ ...f.hooks, shouldAbort: () => cancel }, () => withCreativeRuntime(f.runtime,
      () => f.runtime.executePhase3(nativeInputs(), f.agent)))).rejects.toThrow(/CREATIVE_(USAGE_UNKNOWN|CANCELLED)/);
    expect(f.requests).toHaveLength(1); expect(f.cache.size).toBe(0);
    expect(f.operations[0]?.receipt?.usageKnown).toBe(false);
  });

  it("restores only stage-owned deltas and leaves current G1/G4, identity and spend untouched", async () => {
    const f = fixture(), first = nativeInputs(), current = nativeInputs();
    Object.assign(first.result.stages, { g1: "old", g4: "old", identity: "old", spend: 999 });
    Object.assign(current.result.stages, { g1: "new", g4: "new", identity: "current", spend: 0 });
    await f.run(async () => {
      await f.runtime.nativePhase("phase1", first, async () => {
        Object.assign(first.result, { opening: "window opens", authority: "old" });
        Object.assign(first.result.stages, { opening: "accepted opening", surprise: "must not restore" });
        Object.assign(first.adaptedBlueprint, { genre: "documentary", irrelevant: "must not restore" });
        return { success: true, ...first };
      });
      await f.runtime.nativePhase("phase1", current, async () => { throw new Error("cache miss"); });
    });
    expect(current.result.stages).toEqual({ g1: "new", g4: "new", identity: "current", spend: 0, opening: "accepted opening" });
    expect(current.result).not.toHaveProperty("authority");
    expect(current.adaptedBlueprint).not.toHaveProperty("irrelevant");
    expect(current.adaptedBlueprint).toHaveProperty("genre", "documentary");
  });

  it("holds one executor per scoped project and releases it after failure", async () => {
    const first = fixture(), second = fixture();
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const active = first.run(async () => { started(); await held; throw new Error("fixture phase failed"); });
    await ready;
    await expect(second.run(() => second.runtime.executePhase3(nativeInputs(), second.agent))).rejects.toThrow("CREATIVE_EXECUTOR_BUSY");
    expect(second.requests).toHaveLength(0);
    release(); await expect(active).rejects.toThrow("fixture phase failed");
    await expect(second.run(() => second.runtime.executePhase3(nativeInputs(), second.agent))).resolves.toMatchObject({ success: true });
    expect(second.requests).toHaveLength(2);
  });

  it("sends complete separately reviewed candidate provenance on actual early model requests and keys caches to it", async () => {
    function selection(purpose: string): CreativeCandidateAssessment {
      const shots = buildCreativeShots(contract, nativeInputs().shots.map(shot => ({ ...shot, purpose,
        fields: Object.fromEntries(requiredKeys.map(key => [labels[key]!, "保留窗台光影"])), prompt: "窗台光影" })));
      for (const shot of shots) shot.prompt = compileCreativePrompt(contract, shot);
      const candidateHash = creativeCandidateHash(contract.hash, shots);
      return { candidateId: `candidate-${candidateHash}`, shots,
        generation: { model: DEEPSEEK_FLASH_MODEL, requestId: "fixture-generate", promptHash: creativeHash("generation") },
        review: { model: DEEPSEEK_FLASH_MODEL, requestId: "fixture-review", promptHash: creativeHash("review"),
          contractHash: contract.hash, candidateHash, findings: [],
          scores: Object.fromEntries(CREATIVE_ART_DIMENSIONS.map(key => [key, { score: 85, evidence: purpose }])) as CreativeCandidateAssessment["review"]["scores"] } };
    }
    const first = selection("候选独有的完整景深设计");
    const f = fixture({ runtime: { selectedCandidate: first }, onRequest: ({ call }) => envelope({ accepted: true }, call) });
    await f.run(async () => {
      for (const stage of ["主题", "需求洞察", "PRD"]) {
        const result = await f.llm.reasonStructured(`${stage}原生请求`, { accepted: true }, { scene: "video.preproduction.plan" });
        expect(result.success).toBe(true);
      }
      await f.runtime.nativePhase("phase1", nativeInputs(), async () => ({ success: true, ...nativeInputs() }));
    });
    expect(f.requests).toHaveLength(3);
    for (const request of f.requests) {
      expect(request.prompt).toContain(first.review.candidateHash);
      expect(request.prompt).toContain(contract.hash);
      expect(request.prompt).toContain(first.shots[0]!.purpose);
      expect(request.prompt).toContain(first.review.requestId);
    }
    const changed = fixture({ cache: f.cache, runtime: { selectedCandidate: selection("更新候选") } });
    let recomputed = 0;
    await changed.run(() => changed.runtime.nativePhase("phase1", nativeInputs(), async () => { recomputed++; return { success: true, ...nativeInputs() }; }));
    expect(recomputed).toBe(1);
  });
});
