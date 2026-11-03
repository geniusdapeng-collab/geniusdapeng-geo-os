import {
  assertCreativeContract, creativeHash, validateCreativeShots,
  type CreativeContract, type CreativeFinding, type CreativeShot,
} from "./constraint-compiler.js";

export const CREATIVE_ART_RUBRIC_VERSION = "workloom.creative-art-rubric/v1";
export const CREATIVE_ART_DIMENSIONS = ["readability", "hookPayoff", "emotionalProgression", "visualContrast", "brandFit", "novelty"] as const;
export type CreativeArtDimension = typeof CREATIVE_ART_DIMENSIONS[number];
export type CreativeArtScores = Record<CreativeArtDimension, { score: number; evidence: string }>;
interface RequestEvidence { model: string; requestId: string; promptHash: string; responseHash?: string }
export interface CreativeProductReferenceReceipt {
  ref: string; assetId: string; productId: string; productName: string;
  sha256: string; bytes: number; mimeType: string;
  authorizationBasis: "owner-confirmed-reference-use";
  ownerManifestSha256: string; g1ContentSha256: string; g1ImageIndex: number;
}
export interface CreativeCandidateAssessment {
  candidateId: string;
  shots: CreativeShot[];
  /** Host-only projection of the matched registered image and current G1. */
  trustedProductReferences?: CreativeProductReferenceReceipt[];
  generation: RequestEvidence;
  review: RequestEvidence & {
    contractHash: string;
    candidateHash: string;
    rubricVersion?: typeof CREATIVE_ART_RUBRIC_VERSION;
    findings: CreativeFinding[];
    scores: CreativeArtScores;
  };
}

const sha256 = /^[a-f0-9]{64}$/;
const fullCommit = /^[a-f0-9]{40}$/;
const invalid = (detail: string): never => { throw new Error(`CREATIVE_EVALUATION_INVALID: ${detail}`); };
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const natural = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function creativeCandidateHash(contractHash: string, shots: CreativeShot[]): string {
  return creativeHash({ contractHash, shots });
}

function validScores(value: unknown): value is CreativeArtScores {
  return isRecord(value) && Object.keys(value).length === CREATIVE_ART_DIMENSIONS.length
    && CREATIVE_ART_DIMENSIONS.every(dimension => {
      const row = value[dimension];
      return isRecord(row) && finiteNonnegative(row.score) && row.score <= 100 && text(row.evidence);
    });
}

/** Rank only hard-valid candidates with separate, current, same-model review evidence. */
export function rankCreativeCandidates(input: {
  contract: CreativeContract; generationModel: string; candidates: CreativeCandidateAssessment[];
}): { eligible: Array<{ candidateId: string; candidateHash: string; score: number }>;
  rejected: Array<{ candidateId: string; code: string; findings: CreativeFinding[] }> } {
  assertCreativeContract(input.contract);
  if (input.contract.feasibility.status !== "feasible") invalid("rank requires a feasible current contract");
  if (!text(input.generationModel) || input.candidates.length > 3
    || new Set(input.candidates.map(item => item.candidateId)).size !== input.candidates.length
    || input.candidates.some(item => !text(item.candidateId))) invalid("invalid model or candidate set");
  const requestIds = input.candidates.flatMap(item => [item.generation?.requestId, item.review?.requestId]).filter(text);
  const eligible: Array<{ candidateId: string; candidateHash: string; score: number }> = [];
  const rejected: Array<{ candidateId: string; code: string; findings: CreativeFinding[] }> = [];
  for (const { candidateId, shots, generation, review } of input.candidates) {
    const candidateHash = creativeCandidateHash(input.contract.hash, shots);
    if (!generation || !review || generation.model !== input.generationModel || review.model !== input.generationModel
      || !text(generation.requestId) || !text(review.requestId)
      || requestIds.filter(id => id === generation.requestId).length !== 1
      || requestIds.filter(id => id === review.requestId).length !== 1
      || !sha256.test(generation.promptHash) || !sha256.test(review.promptHash) || generation.promptHash === review.promptHash
      || (generation.responseHash !== undefined && !sha256.test(generation.responseHash))
      || (review.responseHash !== undefined && !sha256.test(review.responseHash))
      || review.contractHash !== input.contract.hash || review.candidateHash !== candidateHash
      || (review.rubricVersion ?? CREATIVE_ART_RUBRIC_VERSION) !== CREATIVE_ART_RUBRIC_VERSION
      || !Array.isArray(review.findings) || review.findings.some(finding => !finding || !text(finding.code)
        || !text(finding.targetId) || !text(finding.fieldPath) || typeof finding.blocking !== "boolean")
      || !validScores(review.scores)) {
      rejected.push({ candidateId, code: "CREATIVE_ART_REVIEW_UNVERIFIED", findings: [] });
      continue;
    }
    const findings = [...validateCreativeShots(input.contract, shots), ...review.findings].filter(finding => finding.blocking);
    if (findings.length) {
      rejected.push({ candidateId, code: "CREATIVE_ART_HARD_CONSTRAINT", findings });
      continue;
    }
    const score = CREATIVE_ART_DIMENSIONS.reduce((sum, dimension) => sum + review.scores[dimension].score, 0) / CREATIVE_ART_DIMENSIONS.length;
    eligible.push({ candidateId, candidateHash, score });
  }
  eligible.sort((a, b) => b.score - a.score || (a.candidateId < b.candidateId ? -1 : 1));
  return { eligible, rejected };
}

export const CREATIVE_EVALUATION_VERSION = "workloom.creative-evaluation/v1";
export type CreativeEvaluationDataMode = "fixture" | "authorized-readback";
type Route = "narrative" | "marketing";
type Arm = "baseline" | "candidate";
type State = "qualified" | "blocked" | "needs_input" | "cancelled" | "unknown" | "failed";
export interface CreativeEvaluationObservation {
  sampleId: string;
  route: Route;
  arm: Arm;
  /** Digest of the authorized evaluation input, shared across the two comparison arms. */
  inputHash: string;
  contractHash: string;
  sourceCommit: string;
  receiptHash: string;
  model: string;
  promptHashes: string[];
  state: State;
  firstPassHard: boolean;
  hardLegal: boolean | null;
  independentlyExpectedLegal: boolean | null;
  budgetStatus: "within" | "exhausted" | "unknown";
  nonCustomerInterventions: number;
  timeToQualifiedMs: number | null;
  outboundRequests: number;
  knownCostCny: number;
  unknownCostRequests: number;
  stagesStarted: number;
  stagesRedone: number;
  factualViolation: boolean | null;
}
export interface CreativeBlindPair {
  sampleId: string; route: Route; inputHash: string;
  baselineReceiptHash: string; candidateReceiptHash: string; judgmentReceiptHash: string;
  rubricVersion: typeof CREATIVE_ART_RUBRIC_VERSION;
  /** Left/right labels reflect blinded display order, randomized by the importing operator. */
  baselineShownAs: "left" | "right";
  preference: "left" | "right" | "tie";
}
export interface CreativeEvaluationDataset {
  schemaVersion: typeof CREATIVE_EVALUATION_VERSION;
  dataMode: CreativeEvaluationDataMode;
  observations: CreativeEvaluationObservation[];
  blindPairs?: CreativeBlindPair[];
}

function validateObservation(row: CreativeEvaluationObservation): void {
  if (!row || !text(row.sampleId) || !["narrative", "marketing"].includes(row.route) || !["baseline", "candidate"].includes(row.arm)
    || !fullCommit.test(row.sourceCommit) || ![row.inputHash, row.contractHash, row.receiptHash].every(hash => sha256.test(hash))
    || !text(row.model) || !Array.isArray(row.promptHashes) || row.promptHashes.some(hash => !sha256.test(hash))
    || !["qualified", "blocked", "needs_input", "cancelled", "unknown", "failed"].includes(row.state)
    || !["within", "exhausted", "unknown"].includes(row.budgetStatus) || typeof row.firstPassHard !== "boolean"
    || [row.hardLegal, row.independentlyExpectedLegal, row.factualViolation].some(value => value !== null && typeof value !== "boolean")
    || ![row.nonCustomerInterventions, row.outboundRequests, row.unknownCostRequests, row.stagesStarted, row.stagesRedone].every(natural)
    || !finiteNonnegative(row.knownCostCny) || (row.timeToQualifiedMs !== null && !finiteNonnegative(row.timeToQualifiedMs))
    || row.unknownCostRequests > row.outboundRequests || row.stagesRedone > row.stagesStarted
    || (row.state === "qualified") !== (row.timeToQualifiedMs !== null)
    || (row.state === "qualified" && row.hardLegal === null)
    || (row.unknownCostRequests > 0 && row.budgetStatus !== "unknown")
    || (row.outboundRequests > 0 && row.promptHashes.length === 0)) invalid("observation is inconsistent or unbound");
}

const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null });
function sum(rows: CreativeEvaluationObservation[], key: "knownCostCny" | "unknownCostRequests" | "outboundRequests" | "stagesRedone" | "stagesStarted") {
  const total = rows.reduce((value, row) => value + row[key], 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) invalid("observation totals exceed numeric range");
  return total;
}
function percentile(sorted: number[], p: number): number | null {
  return sorted[Math.ceil(sorted.length * p) - 1] ?? null;
}
function summarize(rows: CreativeEvaluationObservation[]) {
  const legal = rows.filter(row => row.state === "qualified" && row.hardLegal === true);
  const latencies = legal.map(row => row.timeToQualifiedMs!).sort((a, b) => a - b);
  const expectedLegal = rows.filter(row => row.independentlyExpectedLegal === true);
  const expectedIllegal = rows.filter(row => row.independentlyExpectedLegal === false);
  const knownCostCny = sum(rows, "knownCostCny"), unknownCostRequests = sum(rows, "unknownCostRequests");
  return {
    sampleCount: rows.length,
    terminalStates: Object.fromEntries(["qualified", "blocked", "needs_input", "cancelled", "unknown", "failed"]
      .map(state => [state, rows.filter(row => row.state === state).length])),
    firstPassHardRate: ratio(rows.filter(row => row.firstPassHard).length, rows.length),
    budgetCompletionRate: ratio(legal.filter(row => row.budgetStatus === "within").length, rows.length),
    nonCustomerInterventionRate: ratio(rows.filter(row => row.nonCustomerInterventions > 0).length, rows.length),
    qualifiedLatencyMs: { count: latencies.length, p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95) },
    outboundRequests: sum(rows, "outboundRequests"),
    cost: {
      knownCostCny: rows.length ? knownCostCny : null, unknownCostRequests, legalDeliveryCount: legal.length,
      // Include spend on failures. Unknown usage makes the exact average unavailable.
      cnyPerLegalDelivery: legal.length && unknownCostRequests === 0 && rows.every(row => row.budgetStatus !== "unknown")
        ? knownCostCny / legal.length : null,
    },
    stageRedoRate: ratio(sum(rows, "stagesRedone"), sum(rows, "stagesStarted")),
    hardFalseAcceptanceRate: ratio(expectedIllegal.filter(row => row.state === "qualified").length, expectedIllegal.length),
    hardFalseRejectionRate: ratio(expectedLegal.filter(row => row.state === "blocked" || row.state === "needs_input").length, expectedLegal.length),
    factViolationRate: ratio(rows.filter(row => row.factualViolation === true).length, rows.filter(row => row.factualViolation !== null).length),
    casesNotQualified: rows.filter(row => row.state !== "qualified" || row.hardLegal !== true).map(row => ({ sampleId: row.sampleId, state: row.state })),
  };
}

function wilson(wins: number, count: number) {
  if (!count) return null;
  const z = 1.959963984540054, p = wins / count, correction = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / correction;
  const margin = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / correction;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/** Read-only metrics: sample coverage and missing usage stay visible in the denominators. */
export function evaluateCreativeReceipts(value: unknown) {
  if (!isRecord(value) || value.schemaVersion !== CREATIVE_EVALUATION_VERSION
    || !["fixture", "authorized-readback"].includes(String(value.dataMode))
    || !Array.isArray(value.observations) || (value.blindPairs !== undefined && !Array.isArray(value.blindPairs))) {
    invalid("invalid evaluation dataset");
  }
  const data = value as unknown as CreativeEvaluationDataset;
  const ids = new Set<string>(), receipts = new Set<string>();
  const index = new Map<string, CreativeEvaluationObservation>();
  const key = (route: string, sampleId: string, arm: string) => creativeHash([route, sampleId, arm]);
  for (const row of data.observations) {
    validateObservation(row);
    const k = key(row.route, row.sampleId, row.arm);
    if (index.has(k) || receipts.has(row.receiptHash)) invalid("duplicate sample arm or receipt");
    index.set(k, row); receipts.add(row.receiptHash);
  }
  for (const row of data.observations) {
    if (row.arm !== "candidate") continue;
    const baseline = index.get(key(row.route, row.sampleId, "baseline"));
    if (baseline && baseline.inputHash !== row.inputHash) invalid("comparison arms must bind the same input");
  }
  const pairs = data.blindPairs ?? [];
  for (const pair of pairs) {
    if (!pair || !["narrative", "marketing"].includes(pair.route) || !text(pair.sampleId)
      || !sha256.test(pair.judgmentReceiptHash) || receipts.has(pair.judgmentReceiptHash)
      || pair.rubricVersion !== CREATIVE_ART_RUBRIC_VERSION || !["left", "right"].includes(pair.baselineShownAs)
      || !["left", "right", "tie"].includes(pair.preference)) invalid("invalid blind judgment");
    const k = key(pair.route, pair.sampleId, "blind");
    const baseline = index.get(key(pair.route, pair.sampleId, "baseline")), candidate = index.get(key(pair.route, pair.sampleId, "candidate"));
    if (ids.has(k) || baseline?.receiptHash !== pair.baselineReceiptHash || candidate?.receiptHash !== pair.candidateReceiptHash
      || baseline?.inputHash !== pair.inputHash || candidate?.inputHash !== pair.inputHash
      || baseline?.state !== "qualified" || candidate?.state !== "qualified" || baseline.hardLegal !== true || candidate.hardLegal !== true) {
      invalid("blind judgment must bind the two legal results for the same source");
    }
    ids.add(k); receipts.add(pair.judgmentReceiptHash);
  }
  return {
    schemaVersion: CREATIVE_EVALUATION_VERSION, dataMode: data.dataMode,
    reportHash: creativeHash(data), automaticThresholdTuning: false,
    routes: Object.fromEntries((["narrative", "marketing"] as const).map(route => {
      const rows = data.observations.filter(row => row.route === route);
      const baseline = rows.filter(row => row.arm === "baseline"), candidate = rows.filter(row => row.arm === "candidate");
      const matchedInputs = candidate.filter(row => index.has(key(route, row.sampleId, "baseline"))).length;
      const blind = pairs.filter(pair => pair.route === route);
      const ties = blind.filter(pair => pair.preference === "tie").length;
      const losses = blind.filter(pair => pair.preference === pair.baselineShownAs).length;
      const wins = blind.length - ties - losses;
      return [route, {
        baseline: summarize(baseline), candidate: summarize(candidate),
        matchedInputs, baselineOnly: baseline.length - matchedInputs, candidateOnly: candidate.length - matchedInputs,
        blindArt: { count: blind.length, wins, losses, ties, winRate: ratio(wins, blind.length),
          winRate95Interval: wilson(wins, blind.length),
          sampleThresholdReached: data.dataMode === "authorized-readback" && blind.length >= 30 },
      }];
    })),
  };
}

export interface CreativeShadowComparison {
  inputHash: string;
  baseline: { receiptHash: string; ready: boolean; hardFindings: string[] };
  shadow: { receiptHash: string; feasibility: "feasible" | "blocked" | "needs_input"; hardFindings: string[] };
  /** Changes caused by the observer itself, measured by the worker receipt. */
  shadowOutboundRequests: number;
  originalOutputBefore: string | null;
  originalOutputAfter: string | null;
}
export function compareCreativeShadow(value: unknown) {
  if (!isRecord(value) || !sha256.test(String(value.inputHash))
    || !isRecord(value.baseline) || !isRecord(value.shadow)) return invalid("invalid shadow comparison");
  const { baseline, shadow } = value;
  const baselineFindings = baseline.hardFindings, shadowFindings = shadow.hardFindings;
  const codes = (value: unknown): value is string[] => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
  if (!sha256.test(String(baseline.receiptHash)) || !sha256.test(String(shadow.receiptHash)) || baseline.receiptHash === shadow.receiptHash
    || !codes(baselineFindings) || !codes(shadowFindings) || typeof baseline.ready !== "boolean"
    || !["feasible", "blocked", "needs_input"].includes(String(shadow.feasibility))
    || !natural(value.shadowOutboundRequests)
    || [value.originalOutputBefore, value.originalOutputAfter].some(hash => hash !== null && !sha256.test(String(hash)))) {
    return invalid("unverified legacy or shadow evidence");
  }
  return {
    inputHash: value.inputHash,
    agrees: baseline.ready === (shadow.feasibility === "feasible"),
    newHardFindings: shadowFindings.filter(code => !baselineFindings.includes(code)).sort(),
    missingHardFindings: baselineFindings.filter(code => !shadowFindings.includes(code)).sort(),
    isolated: value.shadowOutboundRequests === 0 && value.originalOutputBefore === value.originalOutputAfter,
  };
}
