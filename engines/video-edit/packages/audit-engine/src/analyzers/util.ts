/**
 * 分析器公共工具：与内核（@workloom/audit-core）重复的函数直接 re-export，
 * 只保留获客双线特有辅助（ISO 串时间窗 / pp 修约 / 日期平移 / 基准播放量 / 分析器上下文）。
 * 所有分析器为纯函数：同一份快照 + 同一个 now 必得同一份发现（确定性纪律，可复算）。
 */
import type { AnalyzerContext as CoreAnalyzerContext } from "../../../base/audit-core/index.js";
import { median } from "../../../base/audit-core/index.js";
import type { ContentRecord, Finding } from "../types.js";

// 与内核重复的工具：re-export 内核实现，不再本包重复定义
export { round2, median } from "../../../base/audit-core/index.js";

/** 分析器上下文：锚定时间与可调阈值（由 engine 注入，分析器不读系统时钟） */
export interface AnalyzerContext extends Omit<CoreAnalyzerContext, "line"> {
  /** 默认保底价（一店一档缺失时回退，R2 口径 ¥380） */
  floorPriceDefault: number;
}

/** 百分比修约（pp/占比判定展示用） */
export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 两个 ISO 时间的小时差（now - at） */
export function hoursSince(now: Date, at: string): number {
  return (now.getTime() - Date.parse(at)) / 3_600_000;
}

/** 两个 ISO 时间的天数差（now - at） */
export function daysSince(now: Date, at: string): number {
  return hoursSince(now, at) / 24;
}

/** 近 N 天窗口起点（含边界） */
export function windowStart(now: Date, days: number): number {
  return now.getTime() - days * 86_400_000;
}

/** YYYY-MM-DD 日期序列工具：date ± n 天 */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 账号历史基准播放量：剔除近 7 天后取中位数（限流断崖/爆款判定的共同分母；样本不足返回 0） */
export function baselinePlays(contents: ContentRecord[], now: Date): number {
  const pool = contents
    .filter((v) => Date.parse(v.publishedAt) < windowStart(now, 7))
    .map((v) => v.plays)
    .sort((a, b) => a - b);
  return median(pool);
}

/** 构造发现时统一收口：占位 id（由 engine 统一编号 FND-<line>-<n>） */
export function makeFinding(f: Omit<Finding, "id">): Finding {
  return { ...f, id: "" };
}
