/**
 * 获客转化线·账号与内容健康（fast-scan SKILL.md 步骤 5）
 * 七个子项：
 *  账号健康：
 *   1) 限流风险信号：最新内容连续 ≥3 条播放量 < 历史基准 50%（≥5 条升级 P0——疑似持续限流）
 *   2) 违规记录与敏感操作：90 天内 major 违规 P0 / minor P1 / warning P2；敏感操作 ≥3 次 P1（G16 域只读核查）
 *  内容节律：
 *   3) 断更：距上次发布 >7 天 P1（>14 天升级 P0）；低于自设节律 70% P2
 *   4) 低效选题聚集：近 20 条中完播率 <15% 占比 >50% P1
 *   5) 高潜素材未复用：历史爆款（≥3×基准）选题近 30 天 0 复用 P2
 */
import type { AuditSnapshot, ContentRecord, Finding } from "../types.js";
import { baselinePlays, daysSince, makeFinding, round2, round4, windowStart, type AnalyzerContext } from "./util.js";

/** 限流判定：环比下滑阈值（相对基准播放量） */
export const LIMIT_DROP_RATIO = 0.5;
/** 连续低播放条数红线（≥3 命中，≥5 升级 P0） */
export const LIMIT_STREAK_MIN = 3;
export const LIMIT_STREAK_P0 = 5;
/** 涨粉转化率基准（播放→粉丝，类目经验值 0.3%） */
export const FOLLOW_RATE = 0.003;
/** 敏感操作次数红线（近 30 天） */
export const SENSITIVE_OPS_MAX = 3;
/** 违规追溯窗口（天） */
export const VIOLATION_WINDOW_DAYS = 90;
/** 断更红线（天），>14 天升级 P0 */
export const STALE_DAYS_P1 = 7;
export const STALE_DAYS_P0 = 14;
/** 断更粉丝流失经验系数：每周 0.5% */
export const STALE_UNFOLLOW_WEEKLY = 0.005;
/** 节律达成率下限（实际/自设 < 70% 命中） */
export const CADENCE_MIN_RATIO = 0.7;
/** 低效选题口径：完播率 <15% 且占比 >50%（近 20 条，样本 ≥10） */
export const LOW_COMPLETION = 0.15;
export const LOW_COMPLETION_SHARE = 0.5;
export const RECENT_WINDOW = 20;
export const MIN_SAMPLE = 10;
/** 爆款口径：播放 ≥ 3× 基准；复用窗口 30 天 */
export const HIT_MULTIPLE = 3;
export const REUSE_WINDOW_DAYS = 30;

/** 取账号最近 N 条（按发布时间倒序） */
function recentContents(contents: ContentRecord[], n: number): ContentRecord[] {
  return [...contents].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, n);
}

export function analyzeGrowth(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];

  for (const acc of snapshot.accounts) {
    const contents = snapshot.contents.filter((v) => v.accountId === acc.accountId);

    /* ---------- 子项 1：限流风险信号（连续 ≥3 条播放 < 基准 50%） ---------- */
    const sorted = recentContents(contents, Number.MAX_SAFE_INTEGER);
    if (sorted.length >= LIMIT_STREAK_MIN) {
      const base = baselinePlays(contents, ctx.now);
      if (base > 0) {
        let streak = 0;
        const streakIds: string[] = [];
        for (const v of sorted) {
          if (v.plays < base * LIMIT_DROP_RATIO) {
            streak += 1;
            streakIds.push(v.contentId);
          } else {
            break;
          }
        }
        if (streak >= LIMIT_STREAK_MIN) {
          const lostPlays = streakIds.reduce((s, id) => {
            const v = sorted.find((x) => x.contentId === id)!;
            return s + (base - v.plays);
          }, 0);
          findings.push(
            makeFinding({
              line: "growth",
              severity: streak >= LIMIT_STREAK_P0 ? "P0" : "P1",
              hotelId: acc.hotelId,
              subjectId: acc.accountId,
              title: `${acc.accountName} 疑似限流：连续 ${streak} 条播放量不足基准 50%`,
              description: `最新 ${streak} 条内容播放量均低于历史基准（中位 ${Math.round(base)}）的 50%，断崖式下滑是限流/降权的典型信号。`,
              suggestion: "核查近 30 天违规通知与敏感操作；暂停搬运/硬广内容，连发 3-5 条高完播原创观察推荐恢复；必要时申诉。",
              evidence: streakIds.map((id) => {
                const v = sorted.find((x) => x.contentId === id)!;
                return { kind: "content", id, fields: { plays: v.plays, baseline: Math.round(base) } };
              }),
              calculation: {
                formula: "连续 N 条 plays < 基准播放量(近7天前中位数) × 0.5，N ≥ 3",
                inputs: { accountId: acc.accountId, baseline: Math.round(base), streak, dropRatio: LIMIT_DROP_RATIO },
                result: `${streak} ≥ ${LIMIT_STREAK_MIN}`,
              },
              estimatedImpact: {
                amount: Math.round(lostPlays * FOLLOW_RATE),
                currency: "FANS",
                period: "monthly",
                confidence: "baseline",
                basis: `播放缺口 ${Math.round(lostPlays)} × 涨粉转化率基准 0.3%（类目基准估算）`,
              },
            }),
          );
        }
      }
    }

    /* ---------- 子项 2：违规记录与敏感操作（G16 域只读核查） ---------- */
    for (const vio of acc.violations) {
      const days = daysSince(ctx.now, vio.occurredAt);
      if (days > VIOLATION_WINDOW_DAYS) continue;
      findings.push(
        makeFinding({
          line: "growth",
          severity: vio.level === "major" ? "P0" : vio.level === "minor" ? "P1" : "P2",
          hotelId: acc.hotelId,
          subjectId: acc.accountId,
          title: `${acc.accountName} ${Math.floor(days)} 天前有 ${vio.level} 违规记录：${vio.type}`,
          description: `违规发生于 ${vio.occurredAt}（${vio.level}），权重处罚期内推荐量会被压制。`,
          suggestion: vio.level === "major" ? "立即停止同类操作并按平台流程申诉；处罚期内只做原创合规内容养号。" : "归档取证，复盘触发点，纳入发布前预检清单（G9 必审纪律）。",
          evidence: [{ kind: "violation", id: vio.violationId, fields: { type: vio.type, level: vio.level, daysAgo: Math.floor(days) } }],
          calculation: {
            formula: "违规 level 映射严重度 且 now − occurredAt ≤ 90d",
            inputs: { violationId: vio.violationId, level: vio.level, daysAgo: round2(days) },
            result: `${vio.level} / ${Math.floor(days)}d`,
          },
        }),
      );
    }
    if ((acc.sensitiveOps30d ?? 0) >= SENSITIVE_OPS_MAX) {
      findings.push(
        makeFinding({
          line: "growth",
          severity: "P1",
          hotelId: acc.hotelId,
          subjectId: acc.accountId,
          title: `${acc.accountName} 近 30 天敏感操作 ${acc.sensitiveOps30d} 次（防关联/风控风险）`,
          description: "频繁改绑/换设备/改实名等敏感操作会触发平台风控，矩阵账号还可能被判关联。",
          suggestion: "冻结非必要账号变更；矩阵账号隔离登录环境与操作节奏（G16 纪律）。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { sensitiveOps30d: acc.sensitiveOps30d ?? 0 } }],
          calculation: {
            formula: "sensitiveOps30d ≥ 3",
            inputs: { accountId: acc.accountId, sensitiveOps30d: acc.sensitiveOps30d ?? 0 },
            result: `${acc.sensitiveOps30d} ≥ ${SENSITIVE_OPS_MAX}`,
          },
        }),
      );
    }

    if (contents.length === 0) continue;

    /* ---------- 子项 3：断更 / 节律不足 ---------- */
    const latest = contents.reduce((a, b) => (Date.parse(a.publishedAt) > Date.parse(b.publishedAt) ? a : b));
    const silentDays = daysSince(ctx.now, latest.publishedAt);
    if (silentDays > STALE_DAYS_P1) {
      const weeks = silentDays / 7;
      findings.push(
        makeFinding({
          line: "growth",
          severity: silentDays > STALE_DAYS_P0 ? "P0" : "P1",
          hotelId: acc.hotelId,
          subjectId: acc.accountId,
          title: `${acc.accountName} 断更 ${Math.floor(silentDays)} 天（上次发布 ${latest.publishedAt.slice(0, 10)}）`,
          description: `停更期间推荐权重持续衰减，粉丝触达断档${silentDays > STALE_DAYS_P0 ? "，已超过两周，账号进入冷启动回退区" : ""}。`,
          suggestion: "48 小时内恢复更新，先用历史高完播选题复刻一条重启推荐；此后固定节律。",
          evidence: [{ kind: "content", id: latest.contentId, fields: { publishedAt: latest.publishedAt, silentDays: Math.floor(silentDays) } }],
          calculation: {
            formula: "now − max(publishedAt) > 7d（>14d 升级 P0）",
            inputs: { accountId: acc.accountId, silentDays: round2(silentDays), lastContentId: latest.contentId },
            result: `${Math.floor(silentDays)}d > ${STALE_DAYS_P1}d`,
          },
          estimatedImpact: {
            amount: Math.round(acc.followers * STALE_UNFOLLOW_WEEKLY * weeks),
            currency: "FANS",
            period: "one-off",
            confidence: "estimate",
            basis: `粉丝 ${acc.followers} × 断更流失经验系数 0.5%/周 × ${round2(weeks)} 周`,
          },
        }),
      );
    }
    if (acc.expectedPostsPerWeek !== undefined && acc.expectedPostsPerWeek > 0) {
      const expected30d = (acc.expectedPostsPerWeek * 30) / 7;
      const actual30d = contents.filter((v) => Date.parse(v.publishedAt) >= windowStart(ctx.now, 30)).length;
      if (actual30d < expected30d * CADENCE_MIN_RATIO && silentDays <= STALE_DAYS_P1) {
        findings.push(
          makeFinding({
            line: "growth",
            severity: "P2",
            hotelId: acc.hotelId,
            subjectId: acc.accountId,
            title: `${acc.accountName} 发布节律不足：近 30 天 ${actual30d} 条 / 自设 ${round2(expected30d)} 条`,
            description: `节律达成率 ${Math.round((actual30d / expected30d) * 100)}% 低于 70%，更新不稳定影响粉丝预期与权重累积。`,
            suggestion: "按自设节律排期囤稿；至少保底每周稳定产出。",
            evidence: [{ kind: "account", id: acc.accountId, fields: { actual30d, expected30d: round2(expected30d) } }],
            calculation: {
              formula: "近30天发布数 < 自设条/周 × 30/7 × 70%",
              inputs: { actual30d, expected30d: round2(expected30d), ratio: round4(actual30d / expected30d) },
              result: `${Math.round((actual30d / expected30d) * 100)}% < 70%`,
            },
          }),
        );
      }
    }

    /* ---------- 子项 4：低效选题聚集（近20条完播<15%占比>50%） ---------- */
    const recent = recentContents(contents, RECENT_WINDOW).filter((v) => v.completionRate !== undefined);
    if (recent.length >= MIN_SAMPLE) {
      const low = recent.filter((v) => v.completionRate! < LOW_COMPLETION);
      const share = low.length / recent.length;
      if (share > LOW_COMPLETION_SHARE) {
        findings.push(
          makeFinding({
            line: "growth",
            severity: "P1",
            hotelId: acc.hotelId,
            subjectId: acc.accountId,
            title: `${acc.accountName} 低效选题聚集：近 ${recent.length} 条中 ${low.length} 条完播率 <15%（${Math.round(share * 100)}%）`,
            description: "超半数内容完播率低于 15%，选题方向与受众错配，持续拉低账号整体推荐权重。",
            suggestion: "暂停低效选题方向；从近 90 天高完播内容中提炼 3 个选题柱（如「房间实拍」「周边攻略」「客人故事」），集中翻拍。",
            evidence: low.slice(0, 5).map((v) => ({ kind: "content", id: v.contentId, fields: { completionRate: v.completionRate!, plays: v.plays } })),
            calculation: {
              formula: "近20条中 completionRate < 0.15 的占比 > 50%（样本 ≥10）",
              inputs: { sampleSize: recent.length, lowCount: low.length, share: round4(share) },
              result: `${Math.round(share * 100)}% > 50%`,
            },
            estimatedImpact: {
              amount: Math.round(low.reduce((s, v) => s + v.plays, 0) * 0.002),
              currency: "FANS",
              period: "monthly",
              confidence: "estimate",
              basis: `低效内容总播放 × 0.2% 修正后涨粉空间（经验估计）`,
            },
          }),
        );
      }
    }

    /* ---------- 子项 5：高潜素材未复用（历史爆款选题近 30 天 0 复用） ---------- */
    const base = baselinePlays(contents, ctx.now);
    if (base > 0) {
      const reuseStart = windowStart(ctx.now, REUSE_WINDOW_DAYS);
      const recentTopics = new Set(
        contents.filter((v) => Date.parse(v.publishedAt) >= reuseStart && v.topic).map((v) => v.topic!),
      );
      const hitByTopic = new Map<string, ContentRecord>();
      for (const v of contents) {
        if (!v.topic || Date.parse(v.publishedAt) >= reuseStart) continue;
        if (v.plays < base * HIT_MULTIPLE) continue;
        const cur = hitByTopic.get(v.topic);
        if (!cur || v.plays > cur.plays) hitByTopic.set(v.topic, v);
      }
      for (const [topic, hit] of hitByTopic) {
        if (recentTopics.has(topic)) continue;
        findings.push(
          makeFinding({
            line: "growth",
            severity: "P2",
            hotelId: acc.hotelId,
            subjectId: acc.accountId,
            title: `${acc.accountName} 高潜素材未复用：爆款「${hit.title}」（${hit.plays} 播放）选题近 30 天 0 复用`,
            description: `该选题历史播放达基准 ${round2(hit.plays / base)} 倍，已被验证但近 30 天无二剪/复刻/跨平台分发，流量资产闲置。`,
            suggestion: "本周内复刻该选题（换案例/换场景/二剪），并同步分发矩阵其他平台。",
            evidence: [{ kind: "content", id: hit.contentId, fields: { plays: hit.plays, topic, multipleOfBaseline: round2(hit.plays / base) } }],
            calculation: {
              formula: "plays ≥ 基准 × 3 且 同 topic 近 30 天发布数 = 0",
              inputs: { contentId: hit.contentId, plays: hit.plays, baseline: Math.round(base), topic },
              result: `${round2(hit.plays / base)}× 基准，0 复用`,
            },
            estimatedImpact: {
              amount: Math.round(hit.plays * 0.3 * 0.003),
              currency: "FANS",
              period: "one-off",
              confidence: "estimate",
              basis: `复刻预计恢复 30% 播放（${Math.round(hit.plays * 0.3)}）× 涨粉转化 0.3%`,
            },
          }),
        );
      }
    }
  }

  return findings;
}
