/**
 * 获客转化线·承接与转化漏斗健康（fast-scan SKILL.md 步骤 6）
 * 五个子项：
 *  1) 主页转化组件缺失：团购/预约/联系方式全无 P1（零承接）；缺 1-2 项 P2
 *  2) 私信响应断点：未响应 >12h P1（高意向咨询未响应升 P0——询盘当面流失）
 *  3) 询盘跟进断点：询盘后 >48h 未跟进 P1（每条按 1 条线索流失计）
 *  4) 爆款未挂转化组件：播放 ≥3×基准 且零挂载 P1，按基准转化率估算线索损失
 *  5) 线索-到店转化断点：已跟进但 >7 天无到店记录（聚合 P2，线索沉淀在对话框里没有变成到店）
 */
import type { AuditSnapshot, Finding } from "../types.js";
import { baselinePlays, hoursSince, makeFinding, round2, type AnalyzerContext } from "./util.js";

/** 私信响应红线（小时；高意向未响应升 P0） */
export const DM_RESPONSE_HOURS = 12;
/** 询盘跟进断点红线（小时） */
export const LEAD_FOLLOWUP_HOURS = 48;
/** 爆款口径：播放 ≥ 3× 基准 */
export const HIT_MULTIPLE = 3;
/** 爆款播放→线索基准转化率（私信/表单/点击，类目基准 0.1%） */
export const LEAD_CONV_RATE = 0.001;
/** 主页零承接的月度线索损失经验系数：粉丝 × 0.02% */
export const NO_COMPONENT_LEAD_RATE = 0.0002;
/** 线索-到店断点口径：已跟进但 N 天无到店记录 */
export const LEAD_NO_VISIT_DAYS = 7;

export function analyzeFunnel(snapshot: AuditSnapshot, ctx: AnalyzerContext): Finding[] {
  const findings: Finding[] = [];
  const accById = new Map(snapshot.accounts.map((a) => [a.accountId, a]));

  /* ---------- 子项 1：主页转化组件缺失 ---------- */
  for (const acc of snapshot.accounts) {
    const comps: [string, boolean][] = [
      ["团购/券挂载", acc.profile.showcase],
      ["预约组件", acc.profile.booking],
      ["联系方式", acc.profile.contact],
    ];
    const missing = comps.filter(([, ok]) => !ok).map(([n]) => n);
    if (missing.length === comps.length) {
      findings.push(
        makeFinding({
          line: "funnel",
          severity: "P1",
          hotelId: acc.hotelId,
          subjectId: acc.accountId,
          title: `${acc.accountName} 主页零转化组件（无团购/无预约/无联系方式）`,
          description: "内容与主页零转化承接，流量只能沉淀为粉丝，无法变成线索——流量浪费的最大断点。",
          suggestion: "本周内至少开通一项承接组件（团购券/预约/联系方式按业务选）；同步配置私信自动回复兜底。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { showcase: 0, booking: 0, contact: 0 } }],
          calculation: {
            formula: "showcase ∨ booking ∨ contact 全无",
            inputs: { accountId: acc.accountId, followers: acc.followers },
            result: "0/3 组件",
          },
          estimatedImpact: {
            amount: Math.max(1, Math.round(acc.followers * NO_COMPONENT_LEAD_RATE)),
            currency: "LEADS",
            period: "monthly",
            confidence: "estimate",
            basis: `粉丝 ${acc.followers} × 主页访问→线索经验系数 0.02%/月（经验估计）`,
          },
        }),
      );
    } else if (missing.length > 0) {
      findings.push(
        makeFinding({
          line: "funnel",
          severity: "P2",
          hotelId: acc.hotelId,
          subjectId: acc.accountId,
          title: `${acc.accountName} 转化组件不全：缺 ${missing.join("、")}`,
          description: `已有 ${3 - missing.length}/3 项承接组件，缺 ${missing.join("、")}，转化路径不完整。`,
          suggestion: "补齐缺失组件，形成「内容→主页→私信/表单」完整链路。",
          evidence: [{ kind: "account", id: acc.accountId, fields: { missing: missing.join("/") } }],
          calculation: {
            formula: "showcase/booking/contact 存在性核查",
            inputs: { accountId: acc.accountId, missingCount: missing.length },
            result: `缺 ${missing.length}/3`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 2：私信响应断点（未响应 >12h） ---------- */
  for (const dm of snapshot.directMessages) {
    const acc = accById.get(dm.accountId);
    if (!acc) continue;
    const responded = dm.respondedAt !== undefined;
    const waitHours = responded ? (Date.parse(dm.respondedAt!) - Date.parse(dm.receivedAt)) / 3_600_000 : hoursSince(ctx.now, dm.receivedAt);
    if (responded && waitHours <= DM_RESPONSE_HOURS) continue;
    if (!responded && waitHours <= DM_RESPONSE_HOURS) continue;
    const highIntentUnanswered = !responded && dm.isInquiry === true;
    findings.push(
      makeFinding({
        line: "funnel",
        severity: highIntentUnanswered ? "P0" : "P1",
        hotelId: acc.hotelId,
        subjectId: acc.accountId,
        title: `${acc.accountName} 私信${responded ? "响应超时" : "未响应"} ${Math.floor(waitHours)}h${dm.isInquiry ? "（高意向咨询）" : ""}`,
        description: `私信接收于 ${dm.receivedAt}，${responded ? `首次响应耗时 ${Math.floor(waitHours)}h` : "至今未响应"}，超 ${DM_RESPONSE_HOURS}h 响应红线${
          highIntentUnanswered ? "——高意向询盘当面流失，等同到店客人被晾在门口" : ""
        }。`,
        suggestion: "立即人工补回；配置关键词自动回复（房价/房态/地址→话术+预订组件链接）并建立 2h 首响 SLA（G10 评论私信分流纪律同源）。",
        evidence: [{ kind: "dm", id: dm.messageId, fields: { hoursWaiting: Math.floor(waitHours), responded: responded ? 1 : 0, isInquiry: dm.isInquiry ? 1 : 0 } }],
        calculation: {
          formula: `${responded ? "respondedAt − receivedAt" : "未响应 且 now − receivedAt"} > ${DM_RESPONSE_HOURS}h`,
          inputs: { messageId: dm.messageId, hoursWaiting: round2(waitHours), isInquiry: dm.isInquiry ? 1 : 0 },
          result: `${Math.floor(waitHours)}h > ${DM_RESPONSE_HOURS}h`,
        },
        ...(dm.isInquiry
          ? {
              estimatedImpact: {
                amount: 1,
                currency: "LEADS" as const,
                period: "one-off" as const,
                confidence: "baseline" as const,
                basis: "高意向私信超 12h 未承接按 1 条线索流失计（首响 SLA 基准口径）",
              },
            }
          : {}),
      }),
    );
  }

  /* ---------- 子项 3：询盘跟进断点（>48h 未跟进） ---------- */
  for (const lead of snapshot.leads) {
    if (lead.followedUpAt !== undefined) continue;
    const hours = hoursSince(ctx.now, lead.inquiryAt);
    if (hours <= LEAD_FOLLOWUP_HOURS) continue;
    const acc = accById.get(lead.accountId);
    if (!acc) continue;
    findings.push(
      makeFinding({
        line: "funnel",
        severity: "P1",
        hotelId: acc.hotelId,
        subjectId: lead.accountId,
        title: `${acc.accountName} 线索跟进断点：询盘 ${Math.floor(hours)}h 未跟进（${lead.leadId}）`,
        description: `询盘发生于 ${lead.inquiryAt}，超 48h 未跟进，线索转化窗口已基本关闭。`,
        suggestion: "24h 内人工补跟进；建立询盘→跟进 SLA（2h 首响）与看板提醒。",
        evidence: [{ kind: "lead", id: lead.leadId, fields: { hoursUnfollowed: Math.floor(hours), ...(lead.sourceContentId ? { sourceContentId: lead.sourceContentId } : {}) } }],
        calculation: {
          formula: "未跟进 且 now − inquiryAt > 48h",
          inputs: { leadId: lead.leadId, hoursUnfollowed: round2(hours) },
          result: `${Math.floor(hours)}h > ${LEAD_FOLLOWUP_HOURS}h`,
        },
        estimatedImpact: {
          amount: 1,
          currency: "LEADS",
          period: "one-off",
          confidence: "baseline",
          basis: "超 48h 未跟进线索按 1 条流失计（跟进 SLA 基准口径）",
        },
      }),
    );
  }

  /* ---------- 子项 4：爆款未挂转化组件（流量浪费） ---------- */
  for (const acc of snapshot.accounts) {
    const contents = snapshot.contents.filter((v) => v.accountId === acc.accountId);
    if (contents.length === 0) continue;
    const base = baselinePlays(contents, ctx.now);
    if (base <= 0) continue;
    for (const v of contents) {
      if (v.hasConversionComponent) continue;
      if (v.plays < base * HIT_MULTIPLE) continue;
      findings.push(
        makeFinding({
          line: "funnel",
          severity: "P1",
          hotelId: acc.hotelId,
          subjectId: acc.accountId,
          title: `${acc.accountName} 爆款未挂转化组件：「${v.title.slice(0, 20)}」（${v.plays} 播放）`,
          description: `该内容播放达基准 ${round2(v.plays / base)} 倍但零挂载（无团购/券/预约/链接），高流量零承接，线索白白流走。`,
          suggestion: "立即补挂转化组件或评论区置顶引导；同选题后续内容发布即挂载。",
          evidence: [{ kind: "content", id: v.contentId, fields: { plays: v.plays, multipleOfBaseline: round2(v.plays / base), hasConversionComponent: 0 } }],
          calculation: {
            formula: "plays ≥ 基准 × 3 且 hasConversionComponent = false",
            inputs: { contentId: v.contentId, plays: v.plays, baseline: Math.round(base) },
            result: `${round2(v.plays / base)}× 基准，0 挂载`,
          },
          estimatedImpact: {
            amount: Math.round(v.plays * LEAD_CONV_RATE),
            currency: "LEADS",
            period: "one-off",
            confidence: "baseline",
            basis: `播放 ${v.plays} × 播放→线索基准转化率 0.1%（类目基准估算）`,
          },
        }),
      );
    }
  }

  /* ---------- 子项 5：线索-到店转化断点（已跟进 >7 天无到店） ---------- */
  const stalledByAccount = new Map<string, string[]>();
  for (const lead of snapshot.leads) {
    if (lead.followedUpAt === undefined || lead.visitedAt !== undefined) continue;
    if (hoursSince(ctx.now, lead.inquiryAt) <= LEAD_NO_VISIT_DAYS * 24) continue;
    const arr = stalledByAccount.get(lead.accountId) ?? [];
    arr.push(lead.leadId);
    stalledByAccount.set(lead.accountId, arr);
  }
  for (const [accountId, ids] of stalledByAccount) {
    const acc = accById.get(accountId);
    if (!acc) continue;
    findings.push(
      makeFinding({
        line: "funnel",
        severity: "P2",
        hotelId: acc.hotelId,
        subjectId: accountId,
        title: `${acc.accountName} 线索-到店断点：${ids.length} 条已跟进线索超 ${LEAD_NO_VISIT_DAYS} 天无到店记录`,
        description: `已跟进线索 ${ids.length} 条沉淀在对话框超过 ${LEAD_NO_VISIT_DAYS} 天未转化为到店/看房——跟进后缺少到店邀约动作，漏斗在「跟进→到店」一级断裂。`,
        suggestion: "对存量线索做一轮到店邀约（券/下午茶体验/看房礼），并把「跟进后 48h 内发邀约」写入跟进 SOP。",
        evidence: ids.slice(0, 5).map((id) => ({ kind: "lead", id, fields: { stage: "followed-no-visit" } })),
        calculation: {
          formula: `已跟进 且 无 visitedAt 且 now − inquiryAt > ${LEAD_NO_VISIT_DAYS}d`,
          inputs: { accountId, stalledCount: ids.length, windowDays: LEAD_NO_VISIT_DAYS },
          result: `${ids.length} 条停滞`,
        },
        estimatedImpact: {
          amount: ids.length,
          currency: "LEADS",
          period: "one-off",
          confidence: "estimate",
          basis: `停滞线索 ${ids.length} 条，按可挽回口径全量计入（经验估计，实际挽回率取决于邀约动作）`,
        },
      }),
    );
  }

  return findings;
}
