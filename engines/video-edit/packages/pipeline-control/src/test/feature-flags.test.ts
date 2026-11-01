import { describe, expect, it } from "vitest";
import { loadPipelineFeatureFlags } from "../feature-flags.js";

describe("pipeline feature flags", () => {
  it("reads the canonical coordinator flag", () => {
    expect(loadPipelineFeatureFlags({ PIPELINE_COORDINATOR: "shadow" }).coordinator).toBe("shadow");
    expect(loadPipelineFeatureFlags({ PIPELINE_COORDINATOR: "enforce" }).coordinator).toBe("enforce");
  });

  it("accepts the legacy flag only when it agrees with the canonical flag", () => {
    expect(loadPipelineFeatureFlags({ PIPELINE_CONTROL_PLANE: "shadow" }).coordinator).toBe("shadow");
    expect(loadPipelineFeatureFlags({
      PIPELINE_COORDINATOR: "enforce",
      PIPELINE_CONTROL_PLANE: "enforce",
    }).coordinator).toBe("enforce");
    expect(() => loadPipelineFeatureFlags({
      PIPELINE_COORDINATOR: "enforce",
      PIPELINE_CONTROL_PLANE: "shadow",
    })).toThrow(/PIPELINE_COORDINATOR.*PIPELINE_CONTROL_PLANE|conflict/i);
  });

  it("fails closed on invalid canonical or legacy values", () => {
    expect(() => loadPipelineFeatureFlags({ PIPELINE_COORDINATOR: "on" })).toThrow(/PIPELINE_COORDINATOR/);
    expect(() => loadPipelineFeatureFlags({ PIPELINE_CONTROL_PLANE: "on" })).toThrow(/PIPELINE_CONTROL_PLANE/);
  });
});
