import { describe, expect, it } from "vitest";
import { buildCreativeShots, compileCreativeContract, creativeTextHash } from "./constraint-compiler.js";
import {
  compareCreativeShadow, creativeCandidateHash, CREATIVE_ART_DIMENSIONS, CREATIVE_ART_RUBRIC_VERSION,
  CREATIVE_EVALUATION_VERSION, evaluateCreativeReceipts, rankCreativeCandidates,
  type CreativeArtScores, type CreativeCandidateAssessment, type CreativeEvaluationObservation,
} from "./creative-evaluation.js";

const hash = creativeTextHash;
const model = "fixture-model";
const contract = compileCreativeContract({
  scope: { tenantId: "fixture-tenant", workspaceId: "fixture-workspace", projectId: "fixture-project" },
  rawIntent: "拍摄窗边光影，成片10秒。",
});
function candidate(id: string, score: number, duration = 10): CreativeCandidateAssessment {
  const shots = buildCreativeShots(contract, [{ id: "s1", duration, fields: { scene: "窗边光影缓慢移动" }, prompt: "窗边光影缓慢移动" }]);
  return {
    candidateId: id, shots,
    generation: { model, requestId: `gen-${id}`, promptHash: hash(`gen-${id}`) },
    review: {
      model, requestId: `review-${id}`, promptHash: hash(`review-${id}`), contractHash: contract.hash,
      candidateHash: creativeCandidateHash(contract.hash, shots), rubricVersion: CREATIVE_ART_RUBRIC_VERSION,
      findings: [],
      scores: Object.fromEntries(CREATIVE_ART_DIMENSIONS.map(key => [key, { score, evidence: `s1: ${key} uses the observed lighting change` }])) as CreativeArtScores,
    },
  };
}
function observation(id: string, arm: "baseline" | "candidate", changes: Partial<CreativeEvaluationObservation> = {}): CreativeEvaluationObservation {
  return { sampleId: id, arm, route: "narrative", inputHash: hash(id), contractHash: contract.hash, sourceCommit: "d".repeat(40),
    receiptHash: hash(`${id}-${arm}`), model, promptHashes: [hash(`${id}-prompt`)], state: "qualified", firstPassHard: true,
    hardLegal: true, independentlyExpectedLegal: true, budgetStatus: "within", nonCustomerInterventions: 0,
    timeToQualifiedMs: 1200, outboundRequests: 2, knownCostCny: 0.01, unknownCostRequests: 0,
    stagesStarted: 3, stagesRedone: 0, factualViolation: false, ...changes };
}

describe("independent creative ranking", () => {
  it("ranks the lawful candidate despite a higher artistic score on a duration or factual violation", () => {
    const factual = candidate("factual-failure", 100);
    factual.review.findings.push({ code: "UNSUPPORTED_PRODUCT_CLAIM", targetId: "s1", fieldPath: "fields.scene",
      expected: "only accepted facts", actual: "unsupported outcome", evidence: ["judge-s1"], ownerStage: "G6", allowedChanges: [], blocking: true });
    const result = rankCreativeCandidates({ contract, generationModel: model,
      candidates: [candidate("lawful", 50), candidate("too-short", 98, 4), factual] });
    expect(result.eligible.map(item => item.candidateId)).toEqual(["lawful"]);
    expect(result.rejected.map(item => item.findings.map(finding => finding.code))).toEqual([["CREATIVE_DURATION_SUM"], ["UNSUPPORTED_PRODUCT_CLAIM"]]);
  });
  it.each(["source", "rubric", "same-request", "same-prompt", "different-model", "missing-score-evidence"] as const)("does not score an unverified %s review", kind => {
    const item = candidate(kind, 88);
    if (kind === "source") item.shots[0]!.fields.scene = "评审后替换画面";
    if (kind === "rubric") Reflect.set(item.review, "rubricVersion", "unknown-rubric");
    if (kind === "same-request") item.review.requestId = item.generation.requestId;
    if (kind === "same-prompt") item.review.promptHash = item.generation.promptHash;
    if (kind === "different-model") item.review.model = "other";
    if (kind === "missing-score-evidence") item.review.scores.readability.evidence = "";
    expect(rankCreativeCandidates({ contract, generationModel: model, candidates: [item] })).toEqual({
      eligible: [], rejected: [{ candidateId: kind, code: "CREATIVE_ART_REVIEW_UNVERIFIED", findings: [] }],
    });
  });
});

describe("read-only authorized observation analysis", () => {
  it("counts unknown and failed cases in denominators, withholds exact costs and reports a paired blind comparison", () => {
    const baseline = observation("one", "baseline"), edited = observation("one", "candidate");
    const unknown = observation("two", "candidate", {
      state: "unknown", hardLegal: null, firstPassHard: false, factualViolation: null, timeToQualifiedMs: null, budgetStatus: "unknown",
      unknownCostRequests: 1, nonCustomerInterventions: 1, stagesRedone: 1,
    });
    const report = evaluateCreativeReceipts({
      schemaVersion: CREATIVE_EVALUATION_VERSION, dataMode: "fixture", observations: [baseline, edited, unknown],
      blindPairs: [{ sampleId: "one", route: "narrative", inputHash: baseline.inputHash, baselineReceiptHash: baseline.receiptHash,
        candidateReceiptHash: edited.receiptHash, judgmentReceiptHash: hash("blind"), rubricVersion: CREATIVE_ART_RUBRIC_VERSION,
        baselineShownAs: "right", preference: "left" }],
    });
    expect(report.routes.narrative).toMatchObject({
      candidate: { firstPassHardRate: { value: 0.5 }, budgetCompletionRate: { value: 0.5 },
        nonCustomerInterventionRate: { value: 0.5 }, qualifiedLatencyMs: { count: 1, p50: 1200, p95: 1200 },
        cost: { knownCostCny: 0.02, unknownCostRequests: 1, cnyPerLegalDelivery: null }, terminalStates: { unknown: 1 } },
      blindArt: { count: 1, wins: 1, losses: 0, ties: 0, sampleThresholdReached: false },
    });
    expect(report.routes.marketing?.candidate.firstPassHardRate.value).toBeNull();
  });
  it("keeps failed-job spend in the total and rejects reused receipts", () => {
    const rows = [observation("a", "candidate"), observation("b", "candidate", {
      state: "failed", firstPassHard: false, hardLegal: false, timeToQualifiedMs: null, knownCostCny: 0.04,
    })];
    const data = { schemaVersion: CREATIVE_EVALUATION_VERSION, dataMode: "authorized-readback", observations: rows };
    expect(evaluateCreativeReceipts(data).routes.narrative?.candidate.cost.cnyPerLegalDelivery).toBeCloseTo(0.05);
    expect(() => evaluateCreativeReceipts({ ...data, observations: [rows[0], rows[0]] })).toThrow(/duplicate/);
  });
  it("reports a baseline-versus-shadow gate disagreement while independently detecting observer effects", () => {
    const pair = { inputHash: hash("input"), baseline: { receiptHash: hash("base"), ready: true, hardFindings: [] },
      shadow: { receiptHash: hash("shadow"), feasibility: "blocked", hardFindings: ["SOURCE_STALE"] }, shadowOutboundRequests: 0,
      originalOutputBefore: hash("output"), originalOutputAfter: hash("output") };
    expect(compareCreativeShadow(pair)).toMatchObject({ agrees: false, newHardFindings: ["SOURCE_STALE"], isolated: true });
    expect(compareCreativeShadow({ ...pair, originalOutputAfter: hash("replacement") }).isolated).toBe(false);
  });
});
