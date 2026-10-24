/** 价格健康线单测：倒挂 / 破保底价 / 远期日历异常 */
import { describe, expect, it } from "vitest";
import { analyzePrice, PARITY_GAP_THRESHOLD } from "../src/analyzers/price.js";
import { CTX, dateDaysAhead, daysAgo, makeSnapshot } from "./helpers.js";

const price = (channel: string, p: number, date = dateDaysAhead(5)) => ({
  hotelId: "H-1",
  roomTypeId: "RT-KING",
  date,
  channel,
  price: p,
  currency: "CNY",
});

describe("analyzePrice · 倒挂", () => {
  it("跨渠道价差 12% > 8% → P1，gap 计算精确", () => {
    const s = makeSnapshot({ channelPrices: [price("ctrip", 528), price("meituan", 600)] });
    const fs = analyzePrice(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.line).toBe("hotel_price");
    expect(fs[0]!.severity).toBe("P1");
    expect(fs[0]!.calculation.result).toBe("12%");
    expect(fs[0]!.title).toContain("12.0%");
  });

  it("价差 >15% 升 P0；≤8% 不报", () => {
    const s = makeSnapshot({ channelPrices: [price("ctrip", 500), price("meituan", 600)] }); // 16.7%
    const fs = analyzePrice(s, CTX);
    expect(fs[0]!.severity).toBe("P0");
    const ok = makeSnapshot({ channelPrices: [price("ctrip", 560), price("meituan", 600)] }); // 6.7%
    expect(analyzePrice(ok, CTX)).toHaveLength(0);
  });

  it("倒挂挽回 = 近30天低价渠道间夜 × 每间夜价差（baseline 置信度）", () => {
    const s = makeSnapshot({
      channelPrices: [price("ctrip", 528), price("meituan", 600)],
      orders: [
        { hotelId: "H-1", orderId: "O-1", channel: "ctrip", roomTypeId: "RT-KING", amount: 5280, currency: "CNY", nights: 10, status: "completed", checkIn: dateDaysAhead(1), createdAt: daysAgo(5) },
      ],
    });
    const fs = analyzePrice(s, CTX);
    expect(fs[0]!.estimatedImpact).toMatchObject({ amount: 720, currency: "CNY", period: "monthly", confidence: "baseline" });
  });
});

describe("analyzePrice · 破保底价", () => {
  it("售价 < 一店一档保底价 380 → P0（R2 熔断口径）", () => {
    const s = makeSnapshot({ channelPrices: [price("fliggy", 360)] });
    const fs = analyzePrice(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P0");
    expect(fs[0]!.calculation.result).toBe("360 < 380");
  });

  it("一店一档缺失回退默认 ¥380 并标注 default-380；≥保底价不报", () => {
    const s = makeSnapshot({
      hotels: [{ hotelId: "H-1", hotelName: "无档案店", currency: "CNY", timezone: "Asia/Shanghai", channels: [] }],
      channelPrices: [price("fliggy", 370)],
    });
    const fs = analyzePrice(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.calculation.inputs.floorSource).toBe("default-380");
    const ok = makeSnapshot({ channelPrices: [price("fliggy", 380)] });
    expect(analyzePrice(ok, CTX)).toHaveLength(0);
  });
});

describe("analyzePrice · 远期日历", () => {
  const weekday = (d: number, p = 500, channel = "ctrip") => price(channel, p, dateDaysAhead(d));

  it("节假日未调价（≤平日中位价 ×1.05）→ P1", () => {
    const s = makeSnapshot({
      channelPrices: [weekday(10), weekday(11), weekday(12), price("ctrip", 500, "2026-10-01")],
      holidays: ["2026-10-01"],
    });
    const fs = analyzePrice(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P1");
    expect(fs[0]!.title).toContain("节假日未调价");
  });

  it("平日价格畸高 >1.5× 中位价 → P2；畸低 <0.6× → P2", () => {
    // 平日基准 800：畸高 1300 > 1200；畸低 460 < 480（均高于保底价 380，避免触发破防子项）
    const s = makeSnapshot({
      channelPrices: [weekday(10, 800), weekday(11, 800), weekday(12, 800), weekday(13, 1300), weekday(14, 460)],
      holidays: ["2026-10-01"],
    });
    const fs = analyzePrice(s, CTX);
    expect(fs).toHaveLength(2);
    expect(fs.every((f) => f.severity === "P2")).toBe(true);
    expect(fs.some((f) => f.title.includes("畸高"))).toBe(true);
    expect(fs.some((f) => f.title.includes("畸低"))).toBe(true);
  });

  it("节假日期历缺失 → 日历子项跳过；平日样本不足不判定", () => {
    const s = makeSnapshot({ channelPrices: [weekday(10), weekday(11), price("ctrip", 500, "2026-10-01")] });
    expect(analyzePrice(s, CTX)).toHaveLength(0);
  });

  it("阈值常量口径：倒挂告警线 8%", () => {
    expect(PARITY_GAP_THRESHOLD).toBe(0.08);
  });
});
