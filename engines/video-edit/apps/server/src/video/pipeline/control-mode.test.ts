import { describe, expect, it } from "vitest";
import { loadPipelineFeatureFlags } from "@workloom/pipeline-control";
import { pipelineControlMode } from "./shadow.js";

describe("pipeline control mode compatibility", () => {
  it.each([
    [{}, "off"],
    [{ PIPELINE_COORDINATOR: "shadow" }, "shadow"],
    [{ PIPELINE_COORDINATOR: "enforce" }, "enforce"],
    [{ PIPELINE_CONTROL_PLANE: "shadow" }, "shadow"],
    [{ PIPELINE_COORDINATOR: "enforce", PIPELINE_CONTROL_PLANE: "enforce" }, "enforce"],
  ] as const)("uses the shared loader for %o", (env, expected) => {
    expect(loadPipelineFeatureFlags(env).coordinator).toBe(expected);
    expect(pipelineControlMode(env)).toBe(expected);
  });

  it("fails closed for conflicting canonical and legacy flags", () => {
    const env = { PIPELINE_COORDINATOR: "enforce", PIPELINE_CONTROL_PLANE: "shadow" };
    expect(() => loadPipelineFeatureFlags(env)).toThrow(/PIPELINE_FLAG_CONFLICT|conflict/i);
    expect(() => pipelineControlMode(env)).toThrow(/PIPELINE_FLAG_CONFLICT|conflict/i);
  });
});
