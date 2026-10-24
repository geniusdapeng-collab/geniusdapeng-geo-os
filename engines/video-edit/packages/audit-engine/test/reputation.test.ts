/** 口碑健康线单测：差评 SLA / 评分双红线 / 关键词聚集 */
import { describe, expect, it } from "vitest";
import { analyzeReputation } from "../src/analyzers/reputation.js";
import { CTX, hoursAgo, makeSnapshot } from "./helpers.js";

const review = (over: Record<string, unknown>) => ({
  hotelId: "H-1",
  reviewId: "RV-1",
  channel: "ctrip",
  rating: 2,
  createdAt: hoursAgo(30),
  ...over,
});

describe("analyzeReputation · 差评响应 SLA", () => {
  it("差评 36h 未回 → P1（R19 24h SLA）", () => {
    const s = makeSnapshot({ reviews: [review({ createdAt: hoursAgo(36) })] });
    const fs = analyzeReputation(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P1");
    expect(fs[0]!.calculation.result).toBe("36h > 24h");
  });

  it("差评 >72h 未回升 P0；已回复/4 星以上不报", () => {
    const s = makeSnapshot({ reviews: [review({ createdAt: hoursAgo(80) })] });
    expect(analyzeReputation(s, CTX)[0]!.severity).toBe("P0");
    const replied = makeSnapshot({ reviews: [review({ createdAt: hoursAgo(50), repliedAt: hoursAgo(49) })] });
    expect(analyzeReputation(replied, CTX)).toHaveLength(0);
    const good = makeSnapshot({ reviews: [review({ rating: 5, createdAt: hoursAgo(50) })] });
    expect(analyzeReputation(good, CTX)).toHaveLength(0);
  });
});

describe("analyzeReputation · 评分双红线", () => {
  it("评分 <4.2 且 30 天下滑 >0.3 → P1；单条件不命中不报", () => {
    const s = makeSnapshot({
      hotels: [{ hotelId: "H-1", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [], rating: 4.1, ratingDelta30d: -0.4 }],
    });
    const fs = analyzeReputation(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P1");
    const single = makeSnapshot({
      hotels: [{ hotelId: "H-1", hotelName: "云栖酒店", currency: "CNY", timezone: "Asia/Shanghai", channels: [], rating: 4.1, ratingDelta30d: -0.1 }],
    });
    expect(analyzeReputation(single, CTX)).toHaveLength(0);
  });
});

describe("analyzeReputation · 关键词聚集", () => {
  it("近30天同关键词差评 ≥3 条 → P1；「安全」聚集升 P0", () => {
    const mk = (kw: string, n: number) =>
      Array.from({ length: n }, (_, i) => review({ reviewId: `RV-${kw}-${i}`, createdAt: hoursAgo(10 + i), content: `${kw}太差了` }));
    const s = makeSnapshot({ reviews: [...mk("隔音", 3)] });
    const fs = analyzeReputation(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P1");
    expect(fs[0]!.title).toContain("「隔音」");
    const safety = makeSnapshot({ reviews: [...mk("安全", 3)] });
    expect(analyzeReputation(safety, CTX)[0]!.severity).toBe("P0");
  });

  it("2 条不聚集；30 天窗口外不计", () => {
    // 已回复（排除差评 SLA 子项干扰，只验证聚集口径）
    const mk = (n: number, h: (i: number) => number) =>
      Array.from({ length: n }, (_, i) =>
        review({ reviewId: `RV-${i}`, createdAt: hoursAgo(h(i)), repliedAt: hoursAgo(h(i) - 1), content: "热水不热" }),
      );
    expect(analyzeReputation(makeSnapshot({ reviews: mk(2, (i) => 10 + i) }), CTX)).toHaveLength(0);
    expect(analyzeReputation(makeSnapshot({ reviews: mk(3, (i) => 24 * 31 + i) }), CTX)).toHaveLength(0);
  });
});
