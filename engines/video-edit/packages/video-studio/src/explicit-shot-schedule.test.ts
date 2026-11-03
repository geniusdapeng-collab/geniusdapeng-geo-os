import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { buildCreativeShots, compileCreativeContract, creativeTextHash, validateCreativeShots, type CreativeContract } from "./constraint-compiler.js";
import { CreativeRuntime, withCreativeBudget, withCreativeRuntime } from "./creative-runtime.js";
import { installPrdProductionBridge } from "./prd-authority-bridge.js";

type RecordValue = Record<string, unknown>;
const require = createRequire(import.meta.url);
const vendor = "../../../vendor/supermickey/hyperreality-system/engines/";
const { ScriptGenerator } = require(`${vendor}script-engine/core/script-generator.js`);
const { ScriptBlueprintAdapter } = require(`${vendor}script-engine/core/adapter.js`);
const { standardizeShot, validateShot, CRITICAL_FIELDS } = require(`${vendor}field-standardizer.js`);
const scope = { tenantId: "test-tenant", workspaceId: "test-workspace", projectId: "test-project" };
const exactIntent = "制作运动短片，成片30秒，必须恰好3个10秒镜头段。";
const exact = compileCreativeContract({ scope, rawIntent: exactIntent });
const narrative = compileCreativeContract({ scope, rawIntent: "制作一条30秒的运动短片。" });
const scenes = (durations: number[]) => {
  let start = 0;
  return durations.map(duration => {
    const timing = { start, duration, end: start + duration };
    start = timing.end;
    return { timing };
  });
};
const unused = (...names: string[]): RecordValue => Object.fromEntries(names.map(name => [name, vi.fn()]));
function run<T>(contract: CreativeContract, completeStage: (stage: string, output: unknown) => Promise<void>, operation: () => Promise<T>) {
  const runtime = new CreativeRuntime({
    contract, model: "offline-fixture", nativeSchemaHash: creativeTextHash("fixture"),
    fields: { keys: ["scene"], labels: { scene: "场景" } },
    cache: { read: async () => null, write: async () => {} },
    generate: async () => { throw new Error("unexpected provider call"); },
    completeStage,
  });
  const uncalled = async () => { throw new Error("unexpected model budget use"); };
  return withCreativeBudget({ beforeModelCall: uncalled, afterModelCall: uncalled }, () => withCreativeRuntime(runtime, operation));
}

describe("explicit exhaustive shot schedule", () => {
  it("holds both the complete shot count and each individual duration across native candidates", () => {
    const check = (durations: number[]) => validateCreativeShots(exact, buildCreativeShots(exact,
      durations.map((duration, index) => ({ shotId: `s${index}`, duration, prompt: "跟拍", fields: { 场景: "赛道" } }))));
    expect(check([10, 10, 10])).toEqual([]);
    expect(check([5, 6, 9, 5, 5])).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CREATIVE_SHOT_COUNT_INVALID", expected: 3, actual: 5 }),
      expect.objectContaining({ code: "CREATIVE_SHOT_DURATION", targetId: "s0", expected: 10, actual: 5 }),
    ]));
    expect(check([9, 10, 11]).map(finding => finding.targetId)).toEqual(["s0", "s2"]);
  });

  it("rejects incompatible schedules with equal totals and exact timings outside native bounds", () => {
    expect(compileCreativeContract({ scope, rawIntent: `${exactIntent}恰好5个6秒镜头。` }).feasibility.findings)
      .toContainEqual(expect.objectContaining({ code: "CONSTRAINT_CONFLICT", fieldPath: "intent.shotPlan" }));
    expect(compileCreativeContract({ scope, rawIntent: exactIntent, bounds: { maxShotSeconds: 9 } }).feasibility.findings)
      .toContainEqual(expect.objectContaining({ code: "CONSTRAINT_TIMING_INFEASIBLE", fieldPath: "intent.shotPlan" }));
    expect(compileCreativeContract({ scope, rawIntent: `${exactIntent}恰好3×10.0秒镜头。` }).feasibility.status).toBe("feasible");
  });

  it("constrains the actual ScriptGenerator and guards the adapted blueprint before native production", async () => {
    const delegate = vi.fn(async (_value: unknown) => { throw new Error("fixture reached native production"); });
    const stage = vi.fn(async () => {});
    const productionPrototype = { ...unused("_loadLatestCheckpoint", "_saveCheckpoint", "_clearCheckpoints"), produce: delegate };
    const originalBuild = ScriptGenerator.prototype._buildGenerationPrompt;
    const originalDuration = ScriptGenerator.prototype._enforceTargetDuration;
    const originalCall = ScriptGenerator.prototype._callLLM;
    const release = installPrdProductionBridge({
      systemPrototype: unused("create", "_optimizeOpeningTitle", "_generatePromptsReport"),
      productionPrototype, scriptGeneratorPrototype: ScriptGenerator.prototype,
      phase1Prototype: unused("_shouldGenerateOpening"), refinerPrototype: unused("_normalizeConstraint"),
      costumePrototype: unused("enhance"), fieldGuardPrototype: unused("normalizeAndValidate", "check", "assertOpeningFields"),
      fusionPrototype: unused("_loadSubCheckpoint", "_saveSubCheckpoint", "_clearSubCheckpoint"), qualityGatePrototype: unused("run"),
      deliveryGuardPrototype: unused("verify"), semanticPrototype: unused("_buildPrompt"),
      standardizeShot, validateShot, fields: CRITICAL_FIELDS,
    });
    try {
      const generator = Object.create(ScriptGenerator.prototype);
      const response = JSON.stringify({ meta: { title: "测试", scenes_count: 3 }, structure: {
        scenes: scenes([10, 10, 10]).map((scene, index) => ({ ...scene, scene_id: `SC${index}`, scene_type: ["opening", "conflict", "resolution"][index] })),
      } });
      const generate = vi.fn(async (_prompt: string, _options: RecordValue) => ({ success: true, content: response }));
      generator.config = { maxTokens: 24000 };
      generator.llmEngine = { generate };
      const intent = { metadata: { title: "测试", target_duration: 30, _originalStoryText: exactIntent }, constraints: {},
        parsed: { primary_mode: "dramatic" } };
      const template = generator._getDefaultTemplate();
      const build = () => generator._buildGenerationPrompt(intent, template);
      const baseline = build();
      expect(baseline).toBe(originalBuild.call(generator, intent, template));

      await run(exact, stage, async () => {
        const prompt = build();
        expect(prompt).toContain(exactIntent);
        expect(prompt).toContain("structure.scenes 恰好 3 项");
        expect(prompt).toContain("timing.duration 必须为数字 10 秒");
        expect(prompt).toContain("保留上游已审情节顺序");
        await expect(generator._callLLM(prompt)).resolves.toBe(response);
        expect(generate).toHaveBeenCalledExactlyOnceWith(prompt, expect.objectContaining({
          maxTokens: 24000, systemPrompt: expect.stringContaining("严格采用客户指定的 3 个镜头，每个 10 秒"),
        }));
        expect(generate.mock.calls[0]![1].systemPrompt).not.toContain("平均分配时长=没有节奏");
        const rejected = { structure: { scenes: scenes([8, 8, 8]) } };
        const rejectedCopy = structuredClone(rejected);
        expect(() => generator._enforceTargetDuration(rejected, 30)).toThrow("CREATIVE_NATIVE_PLAN_INFEASIBLE");
        expect(rejected).toEqual(rejectedCopy);
        const gapped = scenes([10, 10, 10]);
        gapped[1]!.timing.start += 1;
        expect(() => generator._enforceTargetDuration({ structure: { scenes: gapped } }, 30)).toThrow("CREATIVE_NATIVE_PLAN_INFEASIBLE");
        const raw = { meta: { scenes_count: 3 }, structure: { scenes: scenes([10, 10, 10]) } };
        const rawCopy = structuredClone(raw);
        generator._enforceTargetDuration(raw, 30);
        expect(raw).toEqual(rawCopy);

        await expect(productionPrototype.produce({ scenes: scenes([9, 10, 11]) })).rejects.toThrow("CREATIVE_NATIVE_PLAN_INFEASIBLE");
        expect(delegate).not.toHaveBeenCalled();
        expect(stage).not.toHaveBeenCalled();
        const blueprint = generator._parseLLMResponse(response, intent);
        const adapted = new ScriptBlueprintAdapter().adapt(blueprint);
        expect(adapted.scenes.map((scene: { timing: unknown }) => scene.timing)).toEqual(raw.structure.scenes.map(scene => scene.timing));
        await expect(productionPrototype.produce(adapted)).rejects.toThrow("fixture reached native production");
        expect(delegate).toHaveBeenCalledExactlyOnceWith(adapted);
        expect(stage).toHaveBeenCalledTimes(1);
      });

      await run(narrative, stage, async () => {
        expect(build()).toBe(baseline);
        await expect(generator._callLLM(baseline)).resolves.toBe(response);
        expect(generate.mock.calls[1]![1].systemPrompt).toContain("平均分配时长=没有节奏");
        const legacy = { structure: { scenes: scenes([8, 8, 8]) } };
        generator._enforceTargetDuration(legacy, 30);
        expect(legacy.structure.scenes).toEqual(scenes([10, 10, 10]));
      });
      expect(build()).toBe(baseline);
    } finally { release(); }
    expect(ScriptGenerator.prototype._buildGenerationPrompt).toBe(originalBuild);
    expect(ScriptGenerator.prototype._enforceTargetDuration).toBe(originalDuration);
    expect(ScriptGenerator.prototype._callLLM).toBe(originalCall);
  });
});
