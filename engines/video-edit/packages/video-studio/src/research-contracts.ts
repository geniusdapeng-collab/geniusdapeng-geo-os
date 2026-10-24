/** Original reviewed research evidence scope, not a PengManager tenant or production authority. */
import type { ProducerVerdict } from "./producer-gate.js";
import type { SourceSnapshot } from "./research-source.js";
import type { ValidatedStageFacts, IntelStage } from "./research-facts.js";
type RecordValue = Record<string, unknown>;
export interface MarketingScope { tenantId: string; workspaceId: string; projectId: string; runId: string; attempt: number }
interface ArchivedSource extends Omit<SourceSnapshot, "text"> { rawRef: string; textRef: string }
interface StageFactsReport {
  stage: IntelStage; facts: ValidatedStageFacts; sourceIds: string[];
  discovery: { queries: unknown[]; candidates: number; fetched: number; omittedCandidates: number; failures: Array<{ url: string; reason: string }> };
  review?: { ref: string; sha256: string; verdict: ProducerVerdict };
}
interface OutputReview { shotId: string; promptSha256: string; fieldsSha256: string; ref: string; sha256: string; verdict: ProducerVerdict }
export interface MarketingFactsBundle {
  schemaVersion: "workloom.marketing-facts/v1"; issuer: "workloom.marketing-authority"; scope: MarketingScope;
  collectedAt: string; policyVersion: "source-claims/v1"; productQuery: RecordValue;
  sources: ArchivedSource[]; stages: StageFactsReport[]; rawByAgent: Record<IntelStage, RecordValue>;
  rawSha256: string; dossier: RecordValue; cards: RecordValue; dossierSha256: string;
  restrictions: string[]; g1ContentSha256: string; outputReviews: OutputReview[];
}
export interface PreparedMarketingFacts {
  bundle: MarketingFactsBundle; g1Content: string; raw: Record<IntelStage, RecordValue>; storeRoot: string;
  root: string; prefix: string;
}
