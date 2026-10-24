/**
 * 埋点考卷（双线 8 个埋点，验收用例口径）
 * 每个埋点独立算出且严重度正确：
 *  酒店运营线：① 倒挂 12%（P1）② 破保底价 360<380（P0）③ 超售 21>20（P0）④ 差评 36h 未回（P1）
 *  获客转化线：⑤ 断更 9 天（P1）⑥ GEO 品牌词缺席（P1）⑦ 爆款未挂组件（P1）⑧ 询盘 60h 未跟进（P1）
 */
import { describe, expect, it } from "vitest";
import { runFastScan } from "../src/engine.js";
import type { AuditSnapshot, Finding } from "../src/types.js";
import { dateDaysAhead, daysAgo, hoursAgo, makeAccount, makeSnapshot, NOW } from "./helpers.js";

/** 含 8 个埋点的考卷快照（数据全部硬编码，禁止随机） */
function examSnapshot(): AuditSnapshot {
  const base = { accountId: "acc-1", title: "日常实拍", likes: 100, comments: 10, shares: 5, hasConversionComponent: true };
  return makeSnapshot({
    /* 酒店运营线埋点 */
    channelPrices: [
      // ① 倒挂 12%：携程 528 vs 美团 600（同日同房型）
      { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(5), channel: "ctrip", price: 528, currency: "CNY" },
      { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(5), channel: "meituan", price: 600, currency: "CNY" },
      // ② 破保底价：飞猪 360 < 380
      { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(6), channel: "fliggy", price: 360, currency: "CNY" },
    ],
    roomDays: [
      // ③ 超售：已售 21 > 实盘 20
      { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(7), channel: "ctrip", totalRooms: 20, sold: 21, maintenanceRooms: 0, available: 0, closed: false },
    ],
    reviews: [
      // ④ 差评 36h 未回（>24h SLA，未达 72h P0 线）
      { hotelId: "H-1", reviewId: "RV-BAD-001", channel: "ctrip", rating: 2, createdAt: hoursAgo(36), content: "空调坏了没人修" },
    ],
    /* 获客转化线埋点 */
    accounts: [makeAccount()],
    contents: [
      // ⑦ 爆款未挂组件：30000 播放 = 基准 5000 × 6 倍，零挂载（发布于 40 天前，不破坏断更口径）
      { ...base, contentId: "C-HIT", title: "泳池落日爆款", publishedAt: daysAgo(40), plays: 30000, hasConversionComponent: false },
      // 基准池（>7 天前）+ ⑤ 断更 9 天：最新一条在 9 天前
      ...[0, 1, 2, 3, 4].map((i) => ({ ...base, contentId: `C-B${i}`, publishedAt: daysAgo(9 + i * 2), plays: 5000 })),
      { ...base, contentId: "C-LATEST", publishedAt: daysAgo(9), plays: 4800 },
    ],
    // ⑥ GEO 品牌词缺席：P0 品牌词 AI 搜索未引用我方
    geoQueries: [
      { hotelId: "H-1", query: "云栖酒店怎么样", type: "brand", priority: "P0", mentioned: false, competitorsCited: [], platform: "deepseek" },
    ],
    // ⑧ 询盘 60h 未跟进（>48h SLA）
    leads: [{ accountId: "acc-1", leadId: "LD-EXAM-1", inquiryAt: hoursAgo(60) }],
  });
}

const report = runFastScan(examSnapshot(), { now: NOW });
const all = report.hotels.flatMap((h) => h.findings);
const byTitle = (frag: string): Finding => {
  const f = all.find((x) => x.title.includes(frag));
  if (!f) throw new Error(`埋点未算出：${frag}`);
  return f;
};

describe("埋点考卷 · 酒店运营线", () => {
  it("① 倒挂 12%：hotel_price / P1，gap 精确 12%", () => {
    const f = byTitle("倒挂");
    expect(f.line).toBe("hotel_price");
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("12%");
    expect(f.evidence).toHaveLength(2);
  });

  it("② 破保底价 360<380：hotel_price / P0（R2 熔断口径）", () => {
    const f = byTitle("破保底价");
    expect(f.line).toBe("hotel_price");
    expect(f.severity).toBe("P0");
    expect(f.calculation.result).toBe("360 < 380");
  });

  it("③ 超售 21>20：hotel_inventory / P0（R18 熔断口径）", () => {
    const f = byTitle("超售");
    expect(f.line).toBe("hotel_inventory");
    expect(f.severity).toBe("P0");
    expect(f.calculation.result).toBe("21 > 20");
  });

  it("④ 差评 36h 未回：hotel_reputation / P1（R19 24h SLA，未达 72h P0）", () => {
    const f = byTitle("36h 未回复");
    expect(f.line).toBe("hotel_reputation");
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("36h > 24h");
  });
});

describe("埋点考卷 · 获客转化线", () => {
  it("⑤ 断更 9 天：growth / P1（>7d 未达 14d P0）", () => {
    const f = byTitle("断更 9 天");
    expect(f.line).toBe("growth");
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("9d > 7d");
  });

  it("⑥ GEO 品牌词缺席：geo / P1，LEADS 估算带口径", () => {
    const f = byTitle("云栖酒店怎么样");
    expect(f.line).toBe("geo");
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ currency: "LEADS", confidence: "estimate" });
  });

  it("⑦ 爆款未挂组件：funnel / P1，线索损失=播放×0.1%", () => {
    const f = byTitle("爆款未挂转化组件");
    expect(f.line).toBe("funnel");
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toContain("6× 基准");
    expect(f.estimatedImpact).toMatchObject({ amount: 30, currency: "LEADS" });
  });

  it("⑧ 询盘 60h 未跟进：funnel / P1，按 1 条线索流失计", () => {
    const f = byTitle("60h 未跟进");
    expect(f.line).toBe("funnel");
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("60h > 48h");
    expect(f.estimatedImpact).toMatchObject({ amount: 1, currency: "LEADS" });
  });
});

describe("埋点考卷 · 报告纪律", () => {
  it("8 个埋点全部归集到同一家门店，估算均带 confidence 与 basis", () => {
    expect(report.hotels).toHaveLength(1);
    const h = report.hotels[0]!;
    expect(h.counts.P0).toBe(2); // 破保底价 + 超售
    expect(h.counts.P1).toBeGreaterThanOrEqual(6);
    for (const f of h.findings) {
      if (f.estimatedImpact) {
        expect(f.estimatedImpact.confidence).toMatch(/exact|baseline|estimate/);
        expect(f.estimatedImpact.basis.length).toBeGreaterThan(0);
      }
      expect(f.calculation.formula.length).toBeGreaterThan(0);
    }
  });

  it("链路分组完备：traffic（断更/GEO）+ conversion（爆款/询盘）+ deal（倒挂/破防/超售/差评）", () => {
    expect(report.chainGroups.traffic.some((f) => f.title.includes("断更"))).toBe(true);
    expect(report.chainGroups.traffic.some((f) => f.title.includes("云栖酒店怎么样"))).toBe(true);
    expect(report.chainGroups.conversion.some((f) => f.title.includes("爆款未挂"))).toBe(true);
    expect(report.chainGroups.conversion.some((f) => f.title.includes("60h 未跟进"))).toBe(true);
    expect(report.chainGroups.deal.some((f) => f.title.includes("倒挂"))).toBe(true);
    expect(report.chainGroups.deal.some((f) => f.title.includes("超售"))).toBe(true);
  });
});
