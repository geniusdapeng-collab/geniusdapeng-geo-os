import { TEXT_PRIMARY_MODEL } from "./registry.mjs";
import { modelError } from "./errors.mjs";

const THINKING_HIGH = Object.freeze({ type: "enabled", effort: "high" });
const THINKING_LOW = Object.freeze({ type: "enabled", effort: "low" });
const THINKING_DISABLED = Object.freeze({ type: "disabled" });

const SCENES = Object.freeze({
  "geo.answer.synthesize": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "text",
    outputBudget: "maximum",
    generationReviewGroup: "geo.answer",
  }),
  "geo.visibility.answer": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "text",
    outputBudget: "maximum",
    generationReviewGroup: "geo.visibility",
  }),
  "content.draft": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
  }),
  "strategy.plan": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
  }),
  "text.adapt": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
  }),
  "translation.localize": Object.freeze({
    type: "structured_generation",
    // Start at low for strict name/qualifier fidelity. Promote only after a
    // scene-level comparison against disabled mode proves a quality gain.
    thinking: THINKING_LOW,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
  }),
  "text.revise": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
  }),
  "text.polish": Object.freeze({
    type: "structured_generation",
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
  }),
  "quality.check": Object.freeze({
    type: "reasoning_review",
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
    sameModelAs: "text.adapt",
  }),
  "quality.final": Object.freeze({
    type: "critical_decision",
    // `max` requires an evidence-backed evaluation. Until that evaluation is
    // recorded, the final independent review starts at high.
    thinking: THINKING_HIGH,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.publish",
    sameModelAs: "text.adapt",
  }),
  "format.transform": Object.freeze({
    type: "deterministic",
    thinking: THINKING_DISABLED,
    responseFormat: "json_object",
    outputBudget: "maximum",
    generationReviewGroup: "content.format",
  }),
});

export const MODEL_POLICY = Object.freeze({
  schemaVersion: "workloom.model-policy/v1",
  policyVersion: "2026-10-30.1",
  modelKey: TEXT_PRIMARY_MODEL.key,
  defaults: Object.freeze({
    outputBudget: "maximum",
    fallback: "same-model-only",
    generationReviewModel: "same",
  }),
  scenes: SCENES,
});

export function resolveScenePolicy(scene, overrides = {}) {
  const base = MODEL_POLICY.scenes[scene];
  if (!base) {
    throw modelError("MODEL_SCENE_UNKNOWN", `未登记的模型场景：${String(scene)}`);
  }
  const policy = {
    scene,
    modelKey: MODEL_POLICY.modelKey,
    ...base,
    ...overrides,
    thinking: { ...(base.thinking ?? {}), ...(overrides.thinking ?? {}) },
  };
  if (policy.sameModelAs && MODEL_POLICY.scenes[policy.sameModelAs]
    && MODEL_POLICY.scenes[policy.sameModelAs].generationReviewGroup !== policy.generationReviewGroup) {
    throw modelError("MODEL_REVIEW_MODEL_MISMATCH", "生成与评审场景不属于同一模型组。");
  }
  return Object.freeze(policy);
}

export function policyReceipt(policy) {
  return {
    schemaVersion: MODEL_POLICY.schemaVersion,
    policyVersion: MODEL_POLICY.policyVersion,
    scene: policy.scene,
    type: policy.type,
    thinking: { ...policy.thinking },
    responseFormat: policy.responseFormat,
    outputBudget: policy.outputBudget,
    fallback: MODEL_POLICY.defaults.fallback,
    generationReviewGroup: policy.generationReviewGroup,
    sameModelAs: policy.sameModelAs ?? null,
  };
}
