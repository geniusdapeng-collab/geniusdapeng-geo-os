/** 账号与内容健康线单测：限流 / 违规 / 断更 / 低效选题 / 高潜未复用 */
import { describe, expect, it } from "vitest";
import { analyzeGrowth } from "../src/analyzers/growth.js";
import { CTX, daysAgo, hoursAgo, makeAccount, makeSnapshot } from "./helpers.js";

const content = (over: Record<string, unknown>) => ({
  accountId: "acc-1",
  contentId: "C-1",
  title: "房间实拍",
  publishedAt: daysAgo(10),
  plays: 5000,
  likes: 100,
  comments: 10,
  shares: 5,
  hasConversionComponent: true,
  ...over,
});

/** n 条基准内容（>7 天前，进入基准池） */
const baselineContents = (n: number, plays = 5000) =>
  Array.from({ length: n }, (_, i) => content({ contentId: `B-${i}`, publishedAt: daysAgo(10 + i), plays }));

describe("analyzeGrowth · 限流信号", () => {
  it("连续 3 条播放 < 基准 50% → P1；连续 ≥5 条升 P0", () => {
    const low3 = [0, 1, 2].map((i) => content({ contentId: `L-${i}`, publishedAt: hoursAgo(24 + i * 20), plays: 1000 }));
    const s = makeSnapshot({ contents: [...low3, ...baselineContents(5)] });
    const fs = analyzeGrowth(s, CTX);
    const f = fs.find((x) => x.title.includes("疑似限流"))!;
    expect(f.severity).toBe("P1");
    const low5 = [0, 1, 2, 3, 4].map((i) => content({ contentId: `L-${i}`, publishedAt: hoursAgo(12 + i * 12), plays: 800 }));
    const s5 = makeSnapshot({ contents: [...low5, ...baselineContents(6)] });
    expect(analyzeGrowth(s5, CTX).find((x) => x.title.includes("疑似限流"))!.severity).toBe("P0");
  });

  it("最新一条播放正常即打断连击，不报限流", () => {
    const mixed = [
      content({ contentId: "N-0", publishedAt: hoursAgo(10), plays: 6000 }),
      content({ contentId: "L-1", publishedAt: hoursAgo(30), plays: 900 }),
      content({ contentId: "L-2", publishedAt: hoursAgo(50), plays: 900 }),
    ];
    const s = makeSnapshot({ contents: [...mixed, ...baselineContents(5)] });
    expect(analyzeGrowth(s, CTX).filter((f) => f.title.includes("疑似限流"))).toHaveLength(0);
  });
});

describe("analyzeGrowth · 违规与敏感操作", () => {
  it("90 天内 major 违规 P0 / minor P1 / warning P2；窗口外不报", () => {
    const mk = (level: "warning" | "minor" | "major", days: number) =>
      makeAccount({ violations: [{ violationId: `V-${level}`, type: "搬运判定", occurredAt: daysAgo(days), level }] });
    expect(analyzeGrowth(makeSnapshot({ accounts: [mk("major", 10)] }), CTX)[0]!.severity).toBe("P0");
    expect(analyzeGrowth(makeSnapshot({ accounts: [mk("minor", 10)] }), CTX)[0]!.severity).toBe("P1");
    expect(analyzeGrowth(makeSnapshot({ accounts: [mk("warning", 10)] }), CTX)[0]!.severity).toBe("P2");
    expect(analyzeGrowth(makeSnapshot({ accounts: [mk("major", 100)] }), CTX)).toHaveLength(0);
  });

  it("敏感操作 ≥3 次 → P1（G16 口径）", () => {
    const s = makeSnapshot({ accounts: [makeAccount({ sensitiveOps30d: 4 })] });
    const f = analyzeGrowth(s, CTX).find((x) => x.title.includes("敏感操作"))!;
    expect(f.severity).toBe("P1");
    expect(analyzeGrowth(makeSnapshot({ accounts: [makeAccount({ sensitiveOps30d: 2 })] }), CTX)).toHaveLength(0);
  });
});

describe("analyzeGrowth · 断更与节律", () => {
  it("断更 9 天 → P1；>14 天升 P0；挽回=粉丝×0.5%/周×周数", () => {
    const s = makeSnapshot({ contents: [content({ publishedAt: daysAgo(9) })] });
    const f = analyzeGrowth(s, CTX).find((x) => x.title.includes("断更"))!;
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ amount: 129, currency: "FANS", confidence: "estimate" }); // 20000×0.005×9/7
    const s15 = makeSnapshot({ contents: [content({ publishedAt: daysAgo(15) })] });
    expect(analyzeGrowth(s15, CTX).find((x) => x.title.includes("断更"))!.severity).toBe("P0");
  });

  it("节律达成 <70% → P2；7 天内正常更新不报断更", () => {
    const s = makeSnapshot({
      accounts: [makeAccount({ expectedPostsPerWeek: 5 })],
      contents: [content({ publishedAt: daysAgo(2) }), content({ contentId: "C-2", publishedAt: daysAgo(5) })],
    });
    const fs = analyzeGrowth(s, CTX);
    expect(fs.filter((f) => f.title.includes("断更"))).toHaveLength(0);
    expect(fs.find((f) => f.title.includes("节律不足"))!.severity).toBe("P2");
  });
});

describe("analyzeGrowth · 低效选题与高潜未复用", () => {
  it("近20条完播<15%占比>50% → P1（样本 ≥10）", () => {
    const low = Array.from({ length: 12 }, (_, i) =>
      content({ contentId: `LC-${i}`, publishedAt: daysAgo(1 + i * 0.5), plays: 2000, completionRate: 0.1 }),
    );
    const ok4 = Array.from({ length: 4 }, (_, i) =>
      content({ contentId: `HC-${i}`, publishedAt: daysAgo(7 + i), plays: 6000, completionRate: 0.4 }),
    );
    const s = makeSnapshot({ contents: [...low, ...ok4] });
    const f = analyzeGrowth(s, CTX).find((x) => x.title.includes("低效选题"))!;
    expect(f.severity).toBe("P1");
  });

  it("历史爆款（≥3×基准）选题近30天 0 复用 → P2", () => {
    const hit = content({ contentId: "HIT", title: "爆款·泳池落日", publishedAt: daysAgo(40), plays: 30000, topic: "泳池落日" });
    const s = makeSnapshot({ contents: [hit, ...baselineContents(6)] });
    const f = analyzeGrowth(s, CTX).find((x) => x.title.includes("高潜素材未复用"))!;
    expect(f.severity).toBe("P2");
    expect(f.evidence[0]!.fields!.topic).toBe("泳池落日");
    // 近 30 天有同选题复刻 → 不报
    const reused = makeSnapshot({
      contents: [hit, content({ contentId: "REUSE", publishedAt: daysAgo(3), plays: 4000, topic: "泳池落日" }), ...baselineContents(6)],
    });
    expect(analyzeGrowth(reused, CTX).filter((x) => x.title.includes("高潜素材未复用"))).toHaveLength(0);
  });
});
