/**
 * 测试辅助：确定性快照工厂 + 分析器上下文。
 * 所有测试锚定固定钟 NOW，保证纯函数断言可复现。
 */
import type { AnalyzerContext } from "../src/analyzers/util.js";
import type { AuditSnapshot, SocialAccountInfo } from "../src/types.js";

/** 固定锚定时间（差评时长/私信时长/近 30 天窗口以此为界） */
export const NOW = new Date("2026-08-27T12:00:00+08:00");

export const CTX: AnalyzerContext = { now: NOW, floorPriceDefault: 380 };

/** 相对固定钟的 ISO 时间 */
export function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 3_600_000).toISOString();
}
export function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}
export function dateDaysAgo(d: number): string {
  return daysAgo(d).slice(0, 10);
}
/** 固定钟之后 N 天的 YYYY-MM-DD（房价日历用） */
export function dateDaysAhead(d: number): string {
  return new Date(NOW.getTime() + d * 86_400_000).toISOString().slice(0, 10);
}

/** 健康基线账号（各测试按需覆盖字段） */
export function makeAccount(overrides: Partial<SocialAccountInfo> = {}): SocialAccountInfo {
  return {
    accountId: "acc-1",
    hotelId: "H-1",
    platformId: "douyin",
    accountName: "云栖酒店官方号",
    followers: 20000,
    profile: { avatar: true, bio: true, showcase: true, booking: true, contact: true },
    violations: [],
    ...overrides,
  };
}

/** 最小可用快照：一店（云栖酒店，保底价 380）+ 一账号；各测试按需覆盖字段 */
export function makeSnapshot(overrides: Partial<AuditSnapshot> = {}): AuditSnapshot {
  return {
    snapshotId: "SNAP-TEST",
    generatedAt: NOW.toISOString(),
    hotels: [
      {
        hotelId: "H-1",
        hotelName: "云栖酒店",
        currency: "CNY",
        timezone: "Asia/Shanghai",
        floorPrice: 380,
        roomCount: 60,
        channels: [
          { channel: "ctrip", commissionRate: 0.15 },
          { channel: "meituan", commissionRate: 0.12 },
          { channel: "fliggy", commissionRate: 0.1 },
        ],
      },
    ],
    roomTypes: [{ hotelId: "H-1", roomTypeId: "RT-KING", name: "豪华大床房", basePrice: 550, currency: "CNY" }],
    channelPrices: [],
    roomDays: [],
    orders: [],
    channelBills: [],
    reviews: [],
    holidays: [],
    accounts: [makeAccount()],
    contents: [],
    directMessages: [],
    leads: [],
    geoQueries: [],
    geoAssets: [],
    ...overrides,
  };
}
