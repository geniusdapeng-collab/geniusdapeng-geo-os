/** 转化漏斗健康线单测：组件缺失 / 私信响应 / 询盘跟进 / 爆款挂载 / 线索-到店断点 */
import { describe, expect, it } from "vitest";
import { analyzeFunnel } from "../src/analyzers/funnel.js";
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

describe("analyzeFunnel · 主页转化组件", () => {
  it("零组件 → P1 且带 LEADS 估算；缺 1 项 → P2；齐全不报", () => {
    const zero = makeSnapshot({ accounts: [makeAccount({ profile: { avatar: true, bio: true, showcase: false, booking: false, contact: false } })] });
    const f = analyzeFunnel(zero, CTX).find((x) => x.title.includes("零转化组件"))!;
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ amount: 4, currency: "LEADS" }); // 20000×0.0002
    const partial = makeSnapshot({ accounts: [makeAccount({ profile: { avatar: true, bio: true, showcase: true, booking: false, contact: true } })] });
    expect(analyzeFunnel(partial, CTX).find((x) => x.title.includes("转化组件不全"))!.severity).toBe("P2");
    expect(analyzeFunnel(makeSnapshot(), CTX).filter((x) => x.title.includes("组件"))).toHaveLength(0);
  });
});

describe("analyzeFunnel · 私信响应断点", () => {
  const dm = (over: Record<string, unknown>) => ({
    accountId: "acc-1",
    messageId: "DM-1",
    text: "请问周末还有亲子房吗",
    receivedAt: hoursAgo(20),
    ...over,
  });

  it("高意向私信 >12h 未响应 → P0；普通私信 >12h 未响应 → P1", () => {
    const s = makeSnapshot({ directMessages: [dm({ isInquiry: true })] });
    const f = analyzeFunnel(s, CTX).find((x) => x.title.includes("私信未响应"))!;
    expect(f.severity).toBe("P0");
    expect(f.estimatedImpact).toMatchObject({ amount: 1, currency: "LEADS" });
    const normal = makeSnapshot({ directMessages: [dm({})] });
    expect(analyzeFunnel(normal, CTX).find((x) => x.title.includes("私信未响应"))!.severity).toBe("P1");
  });

  it("12h 内已响应不报；响应耗时 >12h → P1", () => {
    const fast = makeSnapshot({ directMessages: [dm({ respondedAt: hoursAgo(18) })] }); // 2h 响应
    expect(analyzeFunnel(fast, CTX).filter((x) => x.title.includes("私信"))).toHaveLength(0);
    const slow = makeSnapshot({ directMessages: [dm({ respondedAt: hoursAgo(2) })] }); // 18h 才响应
    expect(analyzeFunnel(slow, CTX).find((x) => x.title.includes("私信响应超时"))!.severity).toBe("P1");
  });
});

describe("analyzeFunnel · 询盘跟进断点", () => {
  it("询盘 60h 未跟进 → P1 且按 1 条线索流失计；48h 内不报", () => {
    const s = makeSnapshot({ leads: [{ accountId: "acc-1", leadId: "LD-1", inquiryAt: hoursAgo(60) }] });
    const f = analyzeFunnel(s, CTX).find((x) => x.title.includes("线索跟进断点"))!;
    expect(f.severity).toBe("P1");
    expect(f.calculation.result).toBe("60h > 48h");
    expect(f.estimatedImpact).toMatchObject({ amount: 1, currency: "LEADS", confidence: "baseline" });
    const fresh = makeSnapshot({ leads: [{ accountId: "acc-1", leadId: "LD-2", inquiryAt: hoursAgo(30) }] });
    expect(analyzeFunnel(fresh, CTX).filter((x) => x.title.includes("线索跟进断点"))).toHaveLength(0);
  });
});

describe("analyzeFunnel · 爆款未挂组件", () => {
  it("播放 ≥3×基准 且零挂载 → P1，线索损失=播放×0.1%", () => {
    const hit = content({ contentId: "HIT", publishedAt: daysAgo(40), plays: 30000, hasConversionComponent: false });
    const base = Array.from({ length: 6 }, (_, i) => content({ contentId: `B-${i}`, publishedAt: daysAgo(12 + i), plays: 5000 }));
    const s = makeSnapshot({ contents: [hit, ...base] });
    const f = analyzeFunnel(s, CTX).find((x) => x.title.includes("爆款未挂转化组件"))!;
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ amount: 30, currency: "LEADS", confidence: "baseline" });
    // 挂了组件的爆款不报
    const mounted = makeSnapshot({ contents: [{ ...hit, hasConversionComponent: true }, ...base] });
    expect(analyzeFunnel(mounted, CTX).filter((x) => x.title.includes("爆款未挂"))).toHaveLength(0);
  });
});

describe("analyzeFunnel · 线索-到店断点", () => {
  it("已跟进 >7 天无到店 → 聚合 P2；已到店/未跟进（归子项3）不计", () => {
    const stalled = [0, 1].map((i) => ({
      accountId: "acc-1",
      leadId: `LD-S${i}`,
      inquiryAt: daysAgo(10 + i),
      followedUpAt: daysAgo(9 + i),
    }));
    const visited = { accountId: "acc-1", leadId: "LD-V", inquiryAt: daysAgo(10), followedUpAt: daysAgo(9), visitedAt: daysAgo(8) };
    const unfollowed = { accountId: "acc-1", leadId: "LD-U", inquiryAt: daysAgo(10) };
    const s = makeSnapshot({ leads: [...stalled, visited, unfollowed] });
    const f = analyzeFunnel(s, CTX).find((x) => x.title.includes("线索-到店断点"))!;
    expect(f.severity).toBe("P2");
    expect(f.calculation.inputs.stalledCount).toBe(2);
  });
});
