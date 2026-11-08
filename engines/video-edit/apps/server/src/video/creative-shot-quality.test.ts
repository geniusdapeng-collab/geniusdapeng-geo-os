import { describe, expect, it, vi } from "vitest";
import type { CreativeContract, CreativeShot, CreativeShotReviewContext, WorkloomLLMEngine } from "@hyperreality/video-studio";
import { CREATIVE_SHOT_QUALITY_IDS, createCreativeShotQualityReviewer } from "./creative-shot-quality.js";

const context: CreativeShotReviewContext = {
  contract: { hash: "a".repeat(64) } as CreativeContract,
  shot: {
    schemaVersion: "workloom.creative-shot/v1", id: "S01", sceneId: "SC01", revision: 1,
    contractHash: "a".repeat(64), sourceHash: "b".repeat(64), parentHash: null, duration: 10,
    purpose: "展示窗边动作", informationTask: [], claimIds: [], subject: "人物", action: "站在窗边",
    visual: "窗边", sound: "环境声", textLayers: [], assetRefs: [], constraintIds: [],
    fields: { 场景: "窗边", 动作: "站在窗边", 摄影机运动: "固定机位" },
    fieldOrder: ["场景", "动作", "摄影机运动"], prompt: "窗边固定机位，人物站在窗边。",
  } as CreativeShot,
  source: { shotId: "S01", scene: "窗边", action: "按开关", duration: 10 },
  previousAccepted: null,
  nextSource: null,
  fields: {
    keys: ["scene", "action", "camera_movement"],
    labels: { scene: "场景", action: "动作", camera_movement: "摄影机运动" },
  },
  attempt: 0,
};

function checks(overrides: Partial<Record<(typeof CREATIVE_SHOT_QUALITY_IDS)[number], {
  pass: boolean; field?: string; evidence: string; repair?: string;
}>> = {}) {
  return CREATIVE_SHOT_QUALITY_IDS.map(id => ({
    id,
    pass: true,
    evidence: `${id} source-backed pass`,
    ...(overrides[id] ?? {}),
  }));
}

describe("source-bound creative shot quality reviewer", () => {
  it("maps a semantic failure to only currently present native fields", async () => {
    const llm = {
      reasonStructured: vi.fn(async () => ({
        success: true,
        data: {
          shotId: "S01",
          checks: checks({ SQ1_SUBJECT_ACTION: { pass: false, field: "action",
            evidence: "当前动作是站着，原始来源是按开关", repair: "补上按下窗边开关的可见动作" } }),
        },
      })),
    } as unknown as Pick<WorkloomLLMEngine, "reasonStructured">;
    const result = await createCreativeShotQualityReviewer(llm)(context);
    expect(result.findings).toEqual([expect.objectContaining({
      code: "SQ1_SUBJECT_ACTION_INVALID",
      targetId: "S01",
      fieldPath: "fields.动作",
      allowedChanges: ["fields.动作"],
      ownerStage: "creative",
      blocking: true,
    })]);
    expect(result.checks).toHaveLength(5);
    expect(llm.reasonStructured).toHaveBeenCalledOnce();
  });

  it("allows one technical JSON correction without changing the source bytes", async () => {
    const good = { shotId: "S01", checks: checks() };
    const llm = {
      reasonStructured: vi.fn()
        .mockResolvedValueOnce({ success: true, data: { shotId: "S01", checks: [] } })
        .mockResolvedValueOnce({ success: true, data: good }),
    } as unknown as Pick<WorkloomLLMEngine, "reasonStructured">;
    await expect(createCreativeShotQualityReviewer(llm)(context)).resolves.toMatchObject({ findings: [] });
    expect(llm.reasonStructured).toHaveBeenCalledTimes(2);
    const prompts = vi.mocked(llm.reasonStructured).mock.calls.map(call => String(call[0]));
    expect(prompts[0]).toBe(prompts[1]!.replace("\n上一次响应未通过技术校验。重新独立评审同一批字节，只返回要求的 JSON 对象。", ""));
  });

  it("fails closed after one correction if a fixed question is missing", async () => {
    const llm = {
      reasonStructured: vi.fn(async () => ({
        success: true,
        data: { shotId: "S01", checks: checks().slice(0, 4) },
      })),
    } as unknown as Pick<WorkloomLLMEngine, "reasonStructured">;
    await expect(createCreativeShotQualityReviewer(llm)(context)).rejects.toThrow("CREATIVE_SHOT_REVIEW_UNVERIFIED");
    expect(llm.reasonStructured).toHaveBeenCalledTimes(2);
  });
});
