export type VideoThinkingMode = "enabled" | "disabled";
export type VideoThinkingEffort = "low" | "high" | "max";
export const VIDEO_SCENE_POLICY_VERSION = "2026-10-30.1" as const;

export interface VideoScenePolicy {
  type: "deterministic" | "structured_generation" | "reasoning_review" | "critical_decision";
  thinking: {
    type: VideoThinkingMode;
    effort?: VideoThinkingEffort;
  };
  responseFormat?: "json_object" | "text";
  generationReviewGroup: string;
  sameModelAs?: string;
}

export const VIDEO_SCENE_POLICIES = Object.freeze({
  "video.preproduction.plan": {
    type: "structured_generation",
    thinking: { type: "enabled", effort: "high" },
    responseFormat: "json_object",
    generationReviewGroup: "video.preproduction",
  },
  "video.preproduction.structured": {
    type: "structured_generation",
    thinking: { type: "enabled", effort: "high" },
    responseFormat: "json_object",
    generationReviewGroup: "video.preproduction",
  },
  "video.quality.producer-review": {
    type: "reasoning_review",
    thinking: { type: "enabled", effort: "high" },
    responseFormat: "json_object",
    generationReviewGroup: "video.preproduction",
    sameModelAs: "video.preproduction.plan",
  },
  "video.quality.plausibility-review": {
    type: "reasoning_review",
    thinking: { type: "enabled", effort: "high" },
    responseFormat: "json_object",
    generationReviewGroup: "video.preproduction",
    sameModelAs: "video.preproduction.plan",
  },
  "video.quality.final-review": {
    type: "critical_decision",
    // Promote to `max` only after a scene-level quality evaluation proves the
    // gain; the initial production policy starts at high.
    thinking: { type: "enabled", effort: "high" },
    responseFormat: "json_object",
    generationReviewGroup: "video.preproduction",
    sameModelAs: "video.preproduction.plan",
  },
  "video.deterministic": {
    type: "deterministic",
    thinking: { type: "disabled" },
    responseFormat: "json_object",
    generationReviewGroup: "video.deterministic",
  },
} as const satisfies Record<string, VideoScenePolicy>);

export type VideoScene = keyof typeof VIDEO_SCENE_POLICIES;

export function resolveVideoScenePolicy(scene: VideoScene): VideoScenePolicy {
  return VIDEO_SCENE_POLICIES[scene];
}

export function videoThinkingBody(scene: VideoScene): Record<string, unknown> {
  const policy = resolveVideoScenePolicy(scene);
  return policy.thinking.type === "enabled"
    ? {
        thinking: { type: "enabled" },
        reasoning_effort: policy.thinking.effort ?? "high",
      }
    : { thinking: { type: "disabled" } };
}
