import { describe, expect, it } from "vitest";
import { creativeTextHash } from "@hyperreality/video-studio";
import { observeCreativeShadow } from "./creative-shadow.js";

const scope = { tenantId: "T", workspaceId: "W", projectId: "P" };
describe("creative shadow observation", () => {
  it("preserves a successful legacy output when the candidate contract predicts a hard conflict", () => {
    const output = Object.freeze({ success: true, shots: Object.freeze([{ id: "s1", duration: 30 }]) });
    const report = observeCreativeShadow({ input: { scope, rawIntent: "成片时长60秒", metadata: { brief: { duration: 30 } } },
      baseline: { ready: true, hardFindings: [], output } });
    expect(report.comparison).toMatchObject({ agrees: false, isolated: true, newHardFindings: ["CONSTRAINT_CONFLICT"] });
    expect(report.observation.shadowOutboundRequests).toBe(0);
    expect(report.observation.originalOutputBefore).toBe(report.observation.originalOutputAfter);
    expect(output.shots[0]?.duration).toBe(30);
  });

  it("distinguishes marketing that is still waiting for facts from current bound G1", () => {
    const input = { scope, rawIntent: "营销片", isMarketing: true };
    const baseline = { ready: true, hardFindings: [], output: { success: true } };
    const waiting = observeCreativeShadow({ input, baseline });
    const content = '{"verified":"source body"}';
    const bound = observeCreativeShadow({ input: { ...input, facts: { content, hash: creativeTextHash(content), claims: [] } }, baseline });
    expect(waiting.observation.shadow.feasibility).toBe("needs_input");
    expect(bound.observation.shadow.feasibility).toBe("feasible");
    expect(bound.observation.inputHash).not.toBe(waiting.observation.inputHash);
  });
});
