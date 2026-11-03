import { describe, it, expect } from "vitest";
import { compileCreativeContract, buildCreativeShots, validateCreativeShots, compileCreativePrompt, validatePatchDelta, creativeCacheKey, creativeTextHash, creativeHash, creativeCanonical, assertCreativeContract } from "./constraint-compiler.js";
const scope = { tenantId: "T", workspaceId: "W", projectId: "P" };
const base = () => compileCreativeContract({ scope, rawIntent: "制作一条30秒的故事", requiredFields: ["场景", "动作"] });
const native = () => [{ shotId: "s1", duration: 15, prompt: "阳光照进房间", fields: { 场景: "阳光照进房间", 动作: "开窗" } }, { shotId: "s2", duration: 15, prompt: "夜晚关灯", fields: { 场景: "夜晚关灯", 动作: "关灯" } }];
describe("source-bound creative contract compiler", () => {
  it("retains exact intent, immutable scope and content budget", () => {
    const input = { scope, rawIntent: "30秒的故事", metadata: { brief: { duration: 30, productionRequirements: { openWithCover: true, coverIntroSeconds: 5 } } } };
    const c = compileCreativeContract(input);
    expect(c.profile.contentDuration).toBe(25); expect(c.rawIntentHash).toBe(creativeTextHash(input.rawIntent));
    expect(Object.isFrozen(c.profile)).toBe(true); expect(c.hash).toBe(compileCreativeContract(input).hash);
  });
  it("does not turn every available fact into required film coverage", () => {
    const facts = { content: "Claim A. Claim B.", hash: creativeTextHash("Claim A. Claim B."), claims: [{ id: "A", text: "Claim A.", sourceRef: "source:A" }, { id: "B", text: "Claim B.", sourceRef: "source:B" }] };
    const c = compileCreativeContract({ scope, rawIntent: "30秒的营销片", isMarketing: true, facts, requiredClaimIds: ["A"] });
    expect(c.coverage.map(x => x.claimId)).toEqual(["A"]); expect(c.facts?.claims).toHaveLength(2);
    expect(() => compileCreativeContract({ scope, rawIntent: "营销片", facts, requiredClaimIds: ["invented"] })).toThrow("FACT_COVERAGE_INVALID");
  });
  it("blocks conflicting or infeasible timing before paid calls", () => {
    const c = compileCreativeContract({ scope, rawIntent: "制作一条60秒的故事", metadata: { brief: { duration: 30 } } });
    expect(c.feasibility.status).toBe("blocked"); expect(c.feasibility.findings[0]?.code).toBe("CONSTRAINT_CONFLICT");
    const no = compileCreativeContract({ scope, rawIntent: "5秒的故事", bounds: { minShots: 2, minShotSeconds: 3 } });
    expect(no.feasibility.findings.some(f => f.code === "CONSTRAINT_TIMING_INFEASIBLE")).toBe(true);
  });
  it("rejects a resolved native profile that replaces explicit customer specifications", () => {
    const c = compileCreativeContract({ scope, rawIntent: "制作一条60秒的故事，画幅16:9", metadata: { brief: { duration: 60, aspect_ratio: "16:9", productionRequirements: { frameRate: 24, resolution: "4K", subtitleMode: "sidecar", openWithCover: true, coverIntroSeconds: 3 } } }, profile: { targetDuration: 30, aspectRatio: "9:16", frameRate: 30, resolution: "1080p", subtitleMode: "none", openWithCover: true, coverIntroSeconds: 5 } });
    expect(c.feasibility.status).toBe("blocked");
    const paths = c.feasibility.findings.filter(f => f.code === "CONSTRAINT_CONFLICT").map(f => f.fieldPath);
    for (const field of ["profile.finalDuration", "profile.aspectRatio", "profile.frameRate", "profile.resolution", "profile.subtitleMode", "profile.coverIntroSeconds"]) expect(paths).toContain(field);
    expect(() => assertCreativeContract(c)).toThrow("CONSTRAINT_CONFLICT");
  });
  it("binds coverage constraints to exact accepted fact bytes and source", () => {
    const facts = { content: "Claim A.", hash: creativeTextHash("Claim A."), claims: [{ id: "A", text: "Claim A.", sourceRef: "accepted:g1:17#A" }] };
    const c = compileCreativeContract({ scope, rawIntent: "营销片", facts, requiredClaimIds: ["A"] });
    expect(c.constraints.find(x => x.id === "claim.A")?.sourceRef).toBe(`fact:${facts.hash};source:accepted:g1:17#A`);
  });
  it("verifies decoded source text while preserving the original JSON evidence bytes", () => {
    const value = '第一行\n第二行 "quoted" \\ source';
    const content = JSON.stringify({ claims: [{ value }] });
    const facts = { content, hash: creativeTextHash(content), claims: [{ id: "A", text: value, sourceRef: "accepted:g1:17#A" }] };
    expect(compileCreativeContract({ scope, rawIntent: "营销片", facts }).facts?.content).toBe(content);
    expect(() => compileCreativeContract({ scope, rawIntent: "营销片", facts: { ...facts, claims: [{ ...facts.claims[0]!, text: "invented" }] } })).toThrow("FACT_EVIDENCE_INVALID");
  });
  it("does not authorize absent or forged marketing facts", () => {
    expect(compileCreativeContract({ scope, rawIntent: "营销片", isMarketing: true }).feasibility.status).toBe("needs_input");
    expect(() => compileCreativeContract({ scope, rawIntent: "营销片", facts: { content: "real", hash: "0".repeat(64), claims: [] } })).toThrow("FACT_EVIDENCE_INVALID");
  });
  it.each(["制作一分钟的故事", "Create a one-minute story"])("preserves an unambiguous whole-film minute: %s", rawIntent => {
    expect(compileCreativeContract({ scope, rawIntent }).profile.finalDuration).toBe(60);
  });
  it("uses an explicit raw aspect ratio before system defaults", () => {
    const c = compileCreativeContract({ scope, rawIntent: "制作30秒故事，画幅16:9" });
    expect(c.profile.aspectRatio).toBe("16:9"); expect(c.feasibility.status).toBe("feasible");
    expect(c.constraints.find(rule => rule.id === "delivery.aspectRatio")?.source).toBe("customer");
    const aliased = compileCreativeContract({ scope, rawIntent: "故事", metadata: { brief: { aspect_ratio: "4:3" } } });
    expect(aliased.constraints.find(rule => rule.id === "delivery.aspectRatio")).toMatchObject({ value: "4:3", source: "customer" });
  });
  it.each(["拍一条叙事短片，成片时长60秒，总时长30秒。", "成片时长60秒，总时长半分钟。"])("blocks contradictory whole-film duration declarations: %s", rawIntent => {
    const c = compileCreativeContract({ scope, rawIntent });
    expect(c.feasibility.status).toBe("blocked");
    expect(c.feasibility.findings.some(f => f.code === "CONSTRAINT_CONFLICT" && f.fieldPath === "intent.finalDuration")).toBe(true);
  });
  it("does not confuse cover timing with a whole-film duration", () => {
    const c = compileCreativeContract({ scope, rawIntent: "成片时长一分钟，封面时长3秒。" });
    expect(c.profile.finalDuration).toBe(60); expect(c.feasibility.status).toBe("feasible");
  });
  it("persists a non-numeric duration as a blocked contract with the exact source value", () => {
    const c = compileCreativeContract({ scope, rawIntent: "故事", metadata: { brief: { duration: "invalid" } } });
    expect(c.feasibility.status).toBe("blocked"); expect(c.sourceMetadata).toEqual({ brief: { duration: "invalid" } });
    expect(() => creativeCanonical(c)).not.toThrow();
  });
  it("retains metadata provenance and rejects Unicode/key injection", () => {
    const c = compileCreativeContract({ scope, rawIntent: "制作30秒故事", metadata: { brief: { music: "钢琴" } } });
    expect(c.sourceMetadata).toEqual({ brief: { music: "钢琴" } });
    expect(c.constraints.find(x => x.id === "customer.music")?.sourceRef).toContain(c.sourceMetadataHash);
    expect(c.constraints.find(x => x.id === "customer.music")?.severity).toBe("hard");
    expect(c.constraints.find(x => x.id === "creative.art-rubric")?.severity).toBe("soft");
    expect(() => compileCreativeContract({ scope, rawIntent: "bad\ud800" })).toThrow("CREATIVE_JSON_INVALID");
    expect(() => buildCreativeShots(base(), [{ ...native()[0], fields: { "scene\n】": "bad" } }])).toThrow("CREATIVE_FIELD_NAME_INVALID");
  });
  it("compiles actual patched fields while preserving unrelated shot bytes", () => {
    const c = base(), shots = buildCreativeShots(c, native()); expect(validateCreativeShots(c, shots)).toEqual([]);
    const before = creativeCanonical(shots[1]), patched = structuredClone(shots[0]!); patched.fields.动作 = "轻轻开窗";
    expect(validatePatchDelta(shots[0]!, patched, ["fields.动作"])).toEqual(["fields.动作"]);
    expect(compileCreativePrompt(c, patched)).toContain("轻轻开窗"); expect(creativeCanonical(shots[1])).toBe(before);
  });
  it.each(["contractHash", "id", "sourceHash", "claimIds", "assetRefs"])("forbids authority mutation despite declared allowed path %s", key => {
    const shot = buildCreativeShots(base(), native())[0]!, after = structuredClone(shot) as unknown as Record<string, unknown>;
    after[key] = Array.isArray(after[key]) ? ["forged"] : "forged";
    expect(() => validatePatchDelta(shot, after as unknown as typeof shot, [key])).toThrow("PATCH_SCOPE_VIOLATION");
  });
  it("requires progress and refuses tampered contracts", () => {
    const c = base(), shot = buildCreativeShots(c, native())[0]!;
    expect(() => validatePatchDelta(shot, shot, ["fields"])).toThrow("REPAIR_NO_PROGRESS");
    const forged = structuredClone(c); forged.profile.frameRate = 60;
    expect(() => assertCreativeContract(forged)).toThrow("CREATIVE_CONTRACT_STALE");
  });
  it("binds cache to scope and each effective dependency", () => {
    const input = { scope, contractHash: base().hash, upstreamHashes: [creativeHash(native())], schemaVersion: "v1", model: "model", promptVersion: "p1", policyVersion: "1", config: {} };
    const first = creativeCacheKey(input);
    for (const delta of [{ scope: { ...scope, workspaceId: "OTHER" } }, { model: "other" }, { policyVersion: "2" }, { config: { foo: true } }]) expect(creativeCacheKey({ ...input, ...delta })).not.toBe(first);
  });
  it.each([NaN, Infinity, undefined, BigInt(1), new Date()])("rejects non-durable JSON %s", value => expect(() => creativeCanonical({ value })).toThrow("CREATIVE_JSON_INVALID"));
  it("reports duplicate IDs, invalid duration and empty fields", () => {
    const c = base(), shots = buildCreativeShots(c, native()); shots[1]!.id = shots[0]!.id; shots[0]!.duration = 16; shots[1]!.fields.动作 = "";
    const codes = validateCreativeShots(c, shots).map(f => f.code);
    expect(codes).toContain("CREATIVE_SHOT_STALE"); expect(codes).toContain("CREATIVE_SHOT_DURATION"); expect(codes).toContain("CREATIVE_FIELD_MISSING");
  });
});
