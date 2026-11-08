import { describe, expect, it } from "vitest";
import { aggregateCreativeTelemetry } from "./creative-api-service.js";

describe("creative per-shot telemetry aggregation", () => {
  it("combines event funnel fields with per-shot model usage without inventing totals", () => {
    const result = aggregateCreativeTelemetry({
      contractHash: "a".repeat(64),
      run: { id: "RUN-1", status: "failed", next_action: "manual_fix", created_at: "2026-11-08T10:00:00.000Z" },
      events: [
        { created_at: "2026-11-08T10:00:01.000Z", metadata: {
          kind: "creative.shot.accepted", shotId: "S02", sourceHash: "b".repeat(64), outputHash: "c".repeat(64),
          technicalRetries: 1, repairAttempts: 2, semanticReviews: 3, elapsedMs: 4_500,
          promptChars: 2_100, promptBytes: 5_400, cacheReused: true,
        } },
        { created_at: "2026-11-08T10:00:02.000Z", metadata: {
          kind: "creative.shot.failed", shotId: "S01", sourceHash: "d".repeat(64),
          failureCode: "CREATIVE_REPAIR_LIMIT", technicalRetries: 1, repairAttempts: 2,
          semanticReviews: 3, elapsedMs: 8_000, promptChars: 3_200, promptBytes: 8_000,
        } },
      ],
      costs: [
        { shot_id: "S01", calls: "6", tokens: "12000", micros: "25000" },
        { shot_id: "S02", calls: "4", tokens: "9000", micros: "15000" },
        { shot_id: "UNRELATED", calls: "99", tokens: "999999", micros: "999999" },
      ],
    });
    expect(result.run).toEqual({ id: "RUN-1", status: "failed", nextAction: "manual_fix", createdAt: "2026-11-08T10:00:00.000Z" });
    expect(result.shots).toEqual([
      expect.objectContaining({ shotId: "S01", status: "failed", failureCode: "CREATIVE_REPAIR_LIMIT",
        calls: 6, tokens: 12_000, costCny: 0.025, promptChars: 3_200 }),
      expect.objectContaining({ shotId: "S02", status: "accepted", failureCode: null,
        calls: 4, tokens: 9_000, costCny: 0.015, cacheReused: true }),
    ]);
  });
});
