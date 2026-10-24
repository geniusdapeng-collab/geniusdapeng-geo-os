/** 引擎编排单测：覆盖度降级 / 编号 / 一店一份 / 链路分组 / Top10 / 时间纪律 */
import { describe, expect, it } from "vitest";
import { runFastScan, CHAIN_OF_LINE, DEFAULT_FLOOR_PRICE } from "../src/engine.js";
import { dateDaysAhead, daysAgo, hoursAgo, makeSnapshot, NOW } from "./helpers.js";

describe("runFastScan · 覆盖度与降级", () => {
  it("全空快照：七线全 not-covered，报告仍有效产出", () => {
    const s = makeSnapshot({ accounts: [] });
    const r = runFastScan(s, { now: NOW });
    for (const v of Object.values(r.coverage)) expect(v).toBe("not-covered");
    expect(r.overview.findingCount).toBe(0);
    expect(r.coverageNotes.length).toBeGreaterThanOrEqual(7);
  });

  it("节假日期历缺失 → hotel_price 标 partial；GEO 资产缺失 → geo 标 partial", () => {
    const s = makeSnapshot({
      channelPrices: [{ hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(3), channel: "ctrip", price: 500, currency: "CNY" }],
      geoQueries: [{ hotelId: "H-1", query: "云栖酒店怎么样", type: "brand", priority: "P0", mentioned: true, competitorsCited: [] }],
    });
    const r = runFastScan(s, { now: NOW });
    expect(r.coverage.hotel_price).toBe("partial");
    expect(r.coverage.geo).toBe("partial");
    expect(r.coverage.hotel_inventory).toBe("not-covered");
  });

  it("时间预算耗尽 → 全部线 not-covered 且备注留痕（时间纪律）", () => {
    const s = makeSnapshot();
    const r = runFastScan(s, { now: NOW, timeBudgetMinutes: 0 });
    for (const v of Object.values(r.coverage)) expect(v).toBe("not-covered");
    expect(r.coverageNotes.some((n) => n.includes("时间预算耗尽"))).toBe(true);
  });
});

describe("runFastScan · 报告组装", () => {
  const rich = () =>
    makeSnapshot({
      channelPrices: [
        { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(5), channel: "ctrip", price: 528, currency: "CNY" },
        { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(5), channel: "meituan", price: 600, currency: "CNY" },
        { hotelId: "H-1", roomTypeId: "RT-KING", date: dateDaysAhead(6), channel: "fliggy", price: 360, currency: "CNY" },
      ],
      reviews: [{ hotelId: "H-1", reviewId: "RV-1", rating: 2, createdAt: hoursAgo(36), content: "空调坏了" }],
      leads: [{ accountId: "acc-1", leadId: "LD-1", inquiryAt: hoursAgo(60) }],
      geoQueries: [{ hotelId: "H-1", query: "云栖酒店怎么样", type: "brand", priority: "P0", mentioned: false, competitorsCited: [] }],
    });

  it("Finding 统一编号 FND-<LINE>-<序号> 且全局唯一", () => {
    const r = runFastScan(rich(), { now: NOW });
    const all = r.hotels.flatMap((h) => h.findings);
    expect(all.length).toBeGreaterThan(0);
    const ids = all.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of all) expect(f.id).toMatch(new RegExp(`^FND-${f.line.toUpperCase()}-\\d{3}$`));
  });

  it("一店一份：社媒/GEO 发现经账号挂属归集到门店，合计按计量单位分桶", () => {
    const r = runFastScan(rich(), { now: NOW });
    expect(r.hotels).toHaveLength(1);
    const h = r.hotels[0]!;
    expect(h.counts.P0).toBeGreaterThanOrEqual(1); // 破保底价
    expect(h.totalRecoverableByUnit.LEADS).toBeGreaterThanOrEqual(1); // 询盘流失
    expect(r.overview.hotelCount).toBe(1);
    expect(r.overview.findingCount).toBe(h.findings.length);
  });

  it("链路分组：growth/geo → traffic，funnel → conversion，hotel_* → deal", () => {
    const r = runFastScan(rich(), { now: NOW });
    for (const f of r.chainGroups.traffic) expect(CHAIN_OF_LINE[f.line]).toBe("traffic");
    for (const f of r.chainGroups.conversion) expect(f.line).toBe("funnel");
    for (const f of r.chainGroups.deal) expect(f.line.startsWith("hotel_")).toBe(true);
    expect(r.chainGroups.traffic.some((f) => f.line === "geo")).toBe(true);
    expect(r.chainGroups.conversion.some((f) => f.title.includes("线索跟进断点"))).toBe(true);
    expect(r.chainGroups.deal.some((f) => f.title.includes("倒挂"))).toBe(true);
  });

  it("Top10 按年化挽回降序（monthly ×12）", () => {
    const s = rich();
    s.orders = [
      { hotelId: "H-1", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 5280, currency: "CNY", nights: 10, status: "completed", checkIn: dateDaysAhead(1), createdAt: daysAgo(5) },
    ];
    const r = runFastScan(s, { now: NOW });
    expect(r.top10.length).toBeGreaterThan(0);
    const annual = r.top10.map((f) => (f.estimatedImpact!.period === "monthly" ? f.estimatedImpact!.amount * 12 : f.estimatedImpact!.amount));
    for (let i = 1; i < annual.length; i += 1) expect(annual[i - 1]!).toBeGreaterThanOrEqual(annual[i]!);
  });

  it("确定性：同快照同 now 两次运行报告正文一致（除耗时）", () => {
    const a = runFastScan(rich(), { now: NOW });
    const b = runFastScan(rich(), { now: NOW });
    const strip = ({ elapsedMs: _e, ...rest }: typeof a) => rest;
    expect(strip(a)).toEqual(strip(b));
  });

  it("默认保底价常量口径 ¥380（R2）", () => {
    expect(DEFAULT_FLOOR_PRICE).toBe(380);
  });
});
