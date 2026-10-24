/**
 * 引擎编排（行业薄封装）：LINE_ORDER + precheckLine 组装 LineDef[]，逐线执行/软预算/降级/
 * 编号/排序纪律全部交给 @workloom/audit-core 内核 runFastScan，本层只做：
 *  1) 获客双线七线的检线定义（precheck 数据源覆盖度预判 + 时间预算预判）；
 *  2) 对外 API 适配——行业报告视图（一店一份 + 集团总览 + 链路分组 + Top10）形状保持不变。
 * 输出：一店一份 + 集团总览 + 「流量→转化→成交」链路分组 + 按年化挽回降序 Top10。
 */
import { runFastScan as runCoreFastScan, round2, yearlyFactor } from "../../base/audit-core/index.js";
import type { Finding as CoreFinding, LineDef } from "../../base/audit-core/index.js";
import { analyzeChannel } from "./analyzers/channel.js";
import { analyzeFunnel } from "./analyzers/funnel.js";
import { analyzeGeo } from "./analyzers/geo.js";
import { analyzeGrowth } from "./analyzers/growth.js";
import { analyzeInventory } from "./analyzers/inventory.js";
import { analyzePrice } from "./analyzers/price.js";
import { analyzeReputation } from "./analyzers/reputation.js";
import type { AnalyzerContext } from "./analyzers/util.js";
import type {
  AuditLine,
  AuditReport,
  AuditSnapshot,
  ChainStage,
  FastScanOptions,
  Finding,
  HotelReport,
  LineCoverage,
  Severity,
} from "./types.js";

/** 线的执行顺序（对齐 SKILL.md 步骤 2→6：酒店运营线 → 获客转化线） */
const LINE_ORDER: readonly AuditLine[] = [
  "hotel_price",
  "hotel_inventory",
  "hotel_channel",
  "hotel_reputation",
  "growth",
  "geo",
  "funnel",
];

const ANALYZERS: Record<AuditLine, (s: AuditSnapshot, ctx: AnalyzerContext) => Finding[]> = {
  hotel_price: analyzePrice,
  hotel_inventory: analyzeInventory,
  hotel_channel: analyzeChannel,
  hotel_reputation: analyzeReputation,
  growth: analyzeGrowth,
  geo: analyzeGeo,
  funnel: analyzeFunnel,
};

/** 默认保底价（R2 口径 ¥380；一店一档缺失时回退并标注） */
export const DEFAULT_FLOOR_PRICE = 380;

/** 线 → 链路环节（报告按「流量→转化→成交」分组） */
export const CHAIN_OF_LINE: Record<AuditLine, ChainStage> = {
  growth: "traffic",
  geo: "traffic",
  funnel: "conversion",
  hotel_price: "deal",
  hotel_inventory: "deal",
  hotel_channel: "deal",
  hotel_reputation: "deal",
};

/**
 * 数据源覆盖度预判：某线所需数据集全空 → not-covered；关键子集缺失 → partial。
 */
function precheckLine(line: AuditLine, s: AuditSnapshot): { coverage: LineCoverage; note?: string } {
  switch (line) {
    case "hotel_price": {
      if (s.channelPrices.length === 0) return { coverage: "not-covered", note: "房价日历源缺失，价格健康线未覆盖" };
      if (s.hotels.every((h) => h.floorPrice === undefined))
        return { coverage: "partial", note: `一店一档保底价未采集，按默认 ¥${DEFAULT_FLOOR_PRICE} 判定（破防子项估算口径）` };
      if (s.holidays.length === 0) return { coverage: "partial", note: "节假日期历缺失，远期日历异常子项降级" };
      return { coverage: "covered" };
    }
    case "hotel_inventory": {
      if (s.roomDays.length === 0) return { coverage: "not-covered", note: "房态源缺失，房态库存健康线未覆盖" };
      if (s.roomDays.every((r) => r.maintenanceRooms === undefined)) return { coverage: "partial", note: "问题房字段未采集，问题房占比/漏售维修判定子项降级" };
      return { coverage: "covered" };
    }
    case "hotel_channel": {
      if (s.channelBills.length === 0 && s.orders.length === 0) return { coverage: "not-covered", note: "渠道账单与订单源均缺失，渠道健康线未覆盖" };
      if (s.channelBills.length === 0) return { coverage: "partial", note: "渠道账单缺失，佣金勾稽子项降级" };
      if (s.orders.length === 0) return { coverage: "partial", note: "订单源缺失，渠道依赖度子项降级" };
      if (s.hotels.every((h) => h.channels.every((c) => c.commissionRate === undefined)))
        return { coverage: "partial", note: "渠道佣金协议比例缺失，佣金勾稽子项降级" };
      return { coverage: "covered" };
    }
    case "hotel_reputation": {
      if (s.reviews.length === 0) return { coverage: "not-covered", note: "评价源缺失，口碑健康线未覆盖" };
      if (s.hotels.every((h) => h.rating === undefined || h.ratingDelta30d === undefined))
        return { coverage: "partial", note: "门店评分/评分趋势未采集，评分下滑子项降级" };
      return { coverage: "covered" };
    }
    case "growth": {
      if (s.accounts.length === 0) return { coverage: "not-covered", note: "社媒账号源缺失，账号与内容健康线未覆盖" };
      if (s.contents.length === 0) return { coverage: "partial", note: "内容数据源缺失，限流/断更/选题子项降级" };
      return { coverage: "covered" };
    }
    case "geo": {
      if (s.geoQueries.length === 0) return { coverage: "not-covered", note: "GEO 能见度快照缺失，GEO 可见度线未覆盖" };
      if (s.geoAssets.length === 0) return { coverage: "partial", note: "GEO 内容资产快照缺失，引用亲和度子项降级" };
      return { coverage: "covered" };
    }
    case "funnel": {
      if (s.accounts.length === 0 && s.directMessages.length === 0 && s.leads.length === 0)
        return { coverage: "not-covered", note: "主页组件/私信/线索源均缺失，转化漏斗线未覆盖" };
      if (s.directMessages.length === 0) return { coverage: "partial", note: "私信快照缺失，私信响应子项降级" };
      if (s.leads.length === 0) return { coverage: "partial", note: "线索漏斗记录缺失，询盘跟进/到店断点子项降级" };
      return { coverage: "covered" };
    }
  }
}

/** 严重度计数器 */
function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) c[f.severity] += 1;
  return c;
}

/** 发现的年化归一值（Top10 排序口径：monthly ×12，one-off/yearly 原值；LEADS/FANS 同口径原值参与） */
function annualized(f: Finding): number {
  const i = f.estimatedImpact;
  return i ? i.amount * yearlyFactor(i.period) : 0;
}

const severityRank: Record<Severity, number> = { P0: 0, P1: 1, P2: 2 };

/** 排序口径：严重度优先，同年化挽回降序 */
function bySeverityThenImpact(a: Finding, b: Finding): number {
  return severityRank[a.severity] - severityRank[b.severity] || annualized(b) - annualized(a);
}

/**
 * 快速体检主入口：快照 → 双线七分析器 → 报告。
 * 行业薄封装：检线定义交给内核 runFastScan 执行，报告视图在本层适配。
 * 纯函数（除耗时计量）：同一快照 + 同一 now 必得同一报告正文。
 */
export function runFastScan(snapshot: AuditSnapshot, opts: FastScanOptions = {}): AuditReport {
  const timeBudgetMinutes = opts.timeBudgetMinutes ?? 30;
  const budgetMs = timeBudgetMinutes * 60_000;
  const ctx: AnalyzerContext = {
    now: opts.now ?? new Date(snapshot.generatedAt),
    floorPriceDefault: opts.floorPriceDefault ?? DEFAULT_FLOOR_PRICE,
  };
  const startedAt = Date.now();

  // 检线定义：precheck 先做时间预算预判（超时后剩余线 not-covered 出部分报告），再做数据源覆盖度预判；
  // 行业分析器经闭包注入锚定钟与阈值（阈值口径见 AnalyzerContext，分析器签名不变）
  const lines: LineDef<AuditSnapshot>[] = LINE_ORDER.map((line) => ({
    line,
    precheck: (s) => {
      if (Date.now() - startedAt >= budgetMs)
        return { coverage: "not-covered" as const, note: `时间预算耗尽（${timeBudgetMinutes} 分钟），${line} 线未执行` };
      return precheckLine(line, s);
    },
    analyze: (s) => ANALYZERS[line](s, ctx) as unknown as CoreFinding[],
  }));

  const core = runCoreFastScan(snapshot, lines, {
    now: ctx.now,
    softBudgetMs: budgetMs,
    topN: 10,
  });

  /* ---------- 适配层：内核报告 → 行业报告视图 ---------- */
  const coverage = {} as Record<AuditLine, LineCoverage>;
  const coverageNotes: string[] = [];
  for (const lr of core.lineResults) {
    coverage[lr.line as AuditLine] = lr.coverage;
    if (lr.note) coverageNotes.push(lr.note);
  }

  // 统一编号：FND-<LINE>-<全局序号>（覆盖内核线内序号，保持对外编号纪律不变）
  const allFindings: Finding[] = [];
  for (const lr of core.lineResults) {
    for (const f of lr.findings as unknown as Finding[]) {
      f.id = `FND-${lr.line.toUpperCase()}-${String(allFindings.length + 1).padStart(3, "0")}`;
      allFindings.push(f);
    }
  }

  /* ---------- 一店一份 ---------- */
  const byHotel = new Map<string, Finding[]>();
  for (const f of allFindings) {
    const arr = byHotel.get(f.hotelId) ?? [];
    arr.push(f);
    byHotel.set(f.hotelId, arr);
  }
  const sumByUnit = (findings: Finding[]): Record<string, number> => {
    const acc: Record<string, number> = {};
    for (const f of findings) {
      if (!f.estimatedImpact) continue;
      const u = f.estimatedImpact.currency;
      acc[u] = round2((acc[u] ?? 0) + f.estimatedImpact.amount);
    }
    return acc;
  };
  const hotels: HotelReport[] = snapshot.hotels.map((h) => {
    const findings = (byHotel.get(h.hotelId) ?? []).sort(bySeverityThenImpact);
    return {
      hotelId: h.hotelId,
      hotelName: h.hotelName,
      currency: h.currency,
      findings,
      counts: countBySeverity(findings),
      totalRecoverableByUnit: sumByUnit(findings),
    };
  });
  // 有发现但门店不在快照 hotels 里的兜底桶（防御性；正常快照不会触发）
  for (const [hotelId, findings] of byHotel) {
    if (hotels.some((h) => h.hotelId === hotelId)) continue;
    hotels.push({
      hotelId,
      hotelName: hotelId,
      currency: "CNY",
      findings,
      counts: countBySeverity(findings),
      totalRecoverableByUnit: sumByUnit(findings),
    });
  }

  /* ---------- 集团总览 + 链路分组 + Top10 ---------- */
  const chainGroups: Record<ChainStage, Finding[]> = { traffic: [], conversion: [], deal: [] };
  for (const f of allFindings) chainGroups[CHAIN_OF_LINE[f.line]].push(f);
  for (const stage of Object.keys(chainGroups) as ChainStage[]) {
    chainGroups[stage].sort(bySeverityThenImpact);
  }
  const top10 = [...allFindings]
    .filter((f) => f.estimatedImpact)
    .sort((a, b) => annualized(b) - annualized(a))
    .slice(0, 10);

  return {
    reportId: `RPT-${snapshot.snapshotId}`,
    generatedAt: ctx.now.toISOString(),
    snapshotId: snapshot.snapshotId,
    coverage,
    coverageNotes,
    hotels,
    overview: {
      hotelCount: snapshot.hotels.length,
      findingCount: allFindings.length,
      counts: countBySeverity(allFindings),
      totalRecoverableByUnit: sumByUnit(allFindings),
    },
    chainGroups,
    top10,
    elapsedMs: core.durationMs,
    timeBudgetMinutes,
  };
}
