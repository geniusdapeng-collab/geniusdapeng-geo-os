/** 渠道健康线单测：佣金错算 / 账单勾稽 / 单渠道依赖 */
import { describe, expect, it } from "vitest";
import { analyzeChannel } from "../src/analyzers/channel.js";
import { daysAgo, makeSnapshot } from "./helpers.js";
import { CTX } from "./helpers.js";

const order = (id: string, channel: string, amount: number, nights: number) => ({
  hotelId: "H-1",
  orderId: id,
  channel,
  roomTypeId: "RT-KING",
  amount,
  currency: "CNY",
  nights,
  status: "completed" as const,
  checkIn: "2026-08-10",
  createdAt: daysAgo(10),
});

const bill = (channel: string, lines: { lineId: string; type: "order" | "commission"; refId: string; amount: number }[]) => ({
  hotelId: "H-1",
  channel,
  billId: `BILL-${channel}`,
  period: "2026-08",
  lines: lines.map((l) => ({ ...l, currency: "CNY" })),
});

describe("analyzeChannel · 佣金错算", () => {
  it("实提比应提多 0.6pp 且差额 >500 → P1，exact 置信度", () => {
    const s = makeSnapshot({
      orders: [order("O-1", "ctrip", 20000, 2)],
      channelBills: [bill("ctrip", [
        { lineId: "BL-1", type: "order", refId: "O-1", amount: 20000 },
        { lineId: "BL-2", type: "commission", refId: "O-1", amount: 3600 }, // 应提 3000，多提 600（3pp）
      ])],
    });
    const fs = analyzeChannel(s, CTX);
    const f = fs.find((x) => x.title.includes("佣金错算"))!;
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ amount: 600, confidence: "exact" });
  });

  it("偏差 ≤0.5pp 不报；小额错算（≤500）P2", () => {
    const ok = makeSnapshot({
      orders: [order("O-1", "ctrip", 20000, 2)],
      channelBills: [bill("ctrip", [{ lineId: "BL-2", type: "commission", refId: "O-1", amount: 3050 }])], // 0.25pp
    });
    expect(analyzeChannel(ok, CTX).filter((f) => f.title.includes("佣金错算"))).toHaveLength(0);
    const small = makeSnapshot({
      orders: [order("O-1", "meituan", 5000, 1)],
      channelBills: [bill("meituan", [{ lineId: "BL-2", type: "commission", refId: "O-1", amount: 650 }])], // 应提 600，差 50（1pp）
    });
    const f = analyzeChannel(small, CTX).find((x) => x.title.includes("佣金错算"))!;
    expect(f.severity).toBe("P2");
  });
});

describe("analyzeChannel · 账单勾稽", () => {
  it("账单订单行金额 ≠ PMS 订单 → P1；无匹配订单 → P2", () => {
    const s = makeSnapshot({
      orders: [order("O-1", "ctrip", 20000, 2)],
      channelBills: [bill("ctrip", [
        { lineId: "BL-1", type: "order", refId: "O-1", amount: 19800 },
        { lineId: "BL-2", type: "order", refId: "O-GHOST", amount: 999 },
      ])],
    });
    const fs = analyzeChannel(s, CTX);
    expect(fs.find((f) => f.title.includes("勾稽差异"))!.severity).toBe("P1");
    expect(fs.find((f) => f.title.includes("无法勾稽"))!.severity).toBe("P2");
  });
});

describe("analyzeChannel · 单渠道依赖", () => {
  it("依赖度 >60% → P1；>80% 升 P0；≤60% 不报", () => {
    const s = makeSnapshot({
      orders: [order("O-1", "ctrip", 14000, 14), order("O-2", "meituan", 6000, 6)], // 70%
    });
    const f = analyzeChannel(s, CTX).find((x) => x.title.includes("单渠道依赖"))!;
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("70.0%");
    const heavy = makeSnapshot({ orders: [order("O-1", "ctrip", 18000, 18), order("O-2", "meituan", 2000, 2)] }); // 90%
    expect(analyzeChannel(heavy, CTX).find((x) => x.title.includes("单渠道依赖"))!.severity).toBe("P0");
    const balanced = makeSnapshot({ orders: [order("O-1", "ctrip", 6000, 6), order("O-2", "meituan", 4000, 4)] }); // 60% 恰好不越线
    expect(analyzeChannel(balanced, CTX).filter((x) => x.title.includes("单渠道依赖"))).toHaveLength(0);
  });

  it("健康账单 + 均衡渠道零发现", () => {
    const s = makeSnapshot({
      orders: [order("O-1", "ctrip", 10000, 10), order("O-2", "meituan", 10000, 10)],
      channelBills: [
        bill("ctrip", [
          { lineId: "BL-1", type: "order", refId: "O-1", amount: 10000 },
          { lineId: "BL-2", type: "commission", refId: "O-1", amount: 1500 },
        ]),
      ],
    });
    expect(analyzeChannel(s, CTX)).toHaveLength(0);
  });
});
