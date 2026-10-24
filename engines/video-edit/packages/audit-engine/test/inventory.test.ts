/** 房态库存健康线单测：超售 / 漏售 / 问题房占比 / 连住断档 */
import { describe, expect, it } from "vitest";
import { analyzeInventory } from "../src/analyzers/inventory.js";
import { CTX, dateDaysAhead, makeSnapshot } from "./helpers.js";

const roomDay = (over: Partial<Parameters<typeof Object>[0]> & Record<string, unknown>) => ({
  hotelId: "H-1",
  roomTypeId: "RT-KING",
  date: dateDaysAhead(3),
  channel: "ctrip",
  totalRooms: 20,
  sold: 12,
  maintenanceRooms: 1,
  available: 7,
  closed: false,
  ...over,
});

describe("analyzeInventory · 超售", () => {
  it("PMS 已售 > 实盘 → P0（R18 熔断口径），超卖间数精确", () => {
    const s = makeSnapshot({ roomDays: [roomDay({ sold: 21 })] });
    const fs = analyzeInventory(s, CTX);
    const f = fs.find((x) => x.title.includes("超售"))!;
    expect(f.severity).toBe("P0");
    expect(f.calculation.result).toBe("21 > 20");
  });

  it("渠道可售为负 → P0；同房型同日跨渠道行只计一次 PMS 超售", () => {
    const s = makeSnapshot({
      roomDays: [roomDay({ sold: 21 }), roomDay({ channel: "meituan", sold: 21, available: -2 })],
    });
    const fs = analyzeInventory(s, CTX);
    expect(fs.filter((f) => f.title.includes("超售"))).toHaveLength(1);
    expect(fs.some((f) => f.title.includes("可售为负"))).toBe(true);
    expect(fs.every((f) => f.severity === "P0")).toBe(true);
  });
});

describe("analyzeInventory · 漏售", () => {
  it("渠道关房但 PMS 有净房且无维修占用 → P1", () => {
    const s = makeSnapshot({
      roomDays: [
        roomDay({ date: dateDaysAhead(5), channel: "meituan", sold: 10, maintenanceRooms: 0, available: 0, closed: true }),
        roomDay({ date: dateDaysAhead(6), channel: "meituan", sold: 10, maintenanceRooms: 0, available: 0, closed: true }),
      ],
    });
    const fs = analyzeInventory(s, CTX);
    const f = fs.find((x) => x.title.includes("关房未售"))!;
    expect(f.severity).toBe("P1");
    expect(f.calculation.inputs.unsoldRoomNights).toBe(20); // (20-10) × 2 天
  });

  it("满房关房（净房=0）属合理，不报漏售", () => {
    const s = makeSnapshot({
      roomDays: [roomDay({ channel: "meituan", sold: 20, maintenanceRooms: 0, available: 0, closed: true })],
    });
    expect(analyzeInventory(s, CTX).filter((f) => f.title.includes("关房未售"))).toHaveLength(0);
  });
});

describe("analyzeInventory · 问题房占比 / 连住断档", () => {
  it("问题房占比 >10% → P1；≤10% 不报", () => {
    const s = makeSnapshot({ roomDays: [roomDay({ maintenanceRooms: 3 })] }); // 3/20=15%
    const fs = analyzeInventory(s, CTX);
    const f = fs.find((x) => x.title.includes("问题房占比"))!;
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("15.0% > 10%");
    const ok = makeSnapshot({ roomDays: [roomDay({ maintenanceRooms: 2 })] }); // 10% 恰好不越线
    expect(analyzeInventory(ok, CTX).filter((f) => f.title.includes("问题房占比"))).toHaveLength(0);
  });

  it("连住断档：前后日可售、当日关房无维修 → P2；有维修占用不报", () => {
    const s = makeSnapshot({
      roomDays: [
        roomDay({ date: dateDaysAhead(4), channel: "meituan" }),
        roomDay({ date: dateDaysAhead(5), channel: "meituan", maintenanceRooms: 0, available: 0, closed: true }),
        roomDay({ date: dateDaysAhead(6), channel: "meituan" }),
      ],
    });
    const fs = analyzeInventory(s, CTX);
    const f = fs.find((x) => x.title.includes("房态断档"))!;
    expect(f.severity).toBe("P2");
    const withM = makeSnapshot({
      roomDays: [
        roomDay({ date: dateDaysAhead(4), channel: "meituan" }),
        roomDay({ date: dateDaysAhead(5), channel: "meituan", maintenanceRooms: 2, available: 0, closed: true }),
        roomDay({ date: dateDaysAhead(6), channel: "meituan" }),
      ],
    });
    expect(analyzeInventory(withM, CTX).filter((f) => f.title.includes("房态断档"))).toHaveLength(0);
  });

  it("健康房态零发现", () => {
    const s = makeSnapshot({ roomDays: [roomDay({})] });
    expect(analyzeInventory(s, CTX)).toHaveLength(0);
  });
});
