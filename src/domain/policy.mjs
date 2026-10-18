import {
  HIGH_RISK_TERMS,
  NEGATIVE_TERMS,
  SPAM_TERMS,
  TECHNICAL_TERMS,
} from "./constants.mjs";
import { PolicyError } from "./errors.mjs";

const SENSITIVE_PATTERNS = Object.freeze([
  { kind: "email", pattern: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "phone", pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { kind: "cn_id", pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { kind: "access_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})\b/g },
  { kind: "secret_assignment", pattern: /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}/gi },
]);

function includesAny(text, terms) {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

export function scanSensitiveText(text) {
  const value = String(text ?? "");
  const findings = [];

  for (const { kind, pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    const count = [...value.matchAll(pattern)].length;
    if (count > 0) {
      findings.push({
        code: "SENSITIVE_CONTENT",
        kind,
        count,
        message: `内容包含疑似 ${kind}，必须删除或改为受控占位符。`,
      });
    }
  }

  return findings;
}

export function classifyInteraction(text, { approvedFaq = false } = {}) {
  const value = String(text ?? "").trim();
  const lower = value.toLowerCase();
  const reasons = [];

  if (!value) {
    throw new PolicyError("EMPTY_INTERACTION", "互动内容不能为空。");
  }

  if (includesAny(value, SPAM_TERMS)) {
    reasons.push("命中垃圾或诱导信息的特征");
    return {
      level: "L3",
      category: "spam",
      action: "do_not_engage_or_route_to_safety_queue",
      requiresHuman: false,
      reasons,
    };
  }

  if (includesAny(value, HIGH_RISK_TERMS)) {
    reasons.push("命中招聘、客户、法律、财务、隐私或负面风险词");
    return {
      level: "L0",
      category: "high_risk",
      action: "human_only",
      requiresHuman: true,
      reasons,
    };
  }

  if (approvedFaq) {
    reasons.push("调用方声明为已批准 FAQ");
    return {
      level: "L2",
      category: "approved_faq",
      action: "allow_only_through_approved_channel",
      requiresHuman: false,
      reasons,
    };
  }

  if (includesAny(lower, TECHNICAL_TERMS) || lower.includes("?") || value.includes("？")) {
    reasons.push("属于技术、产品或行业问题");
    return {
      level: "L1",
      category: "expert_question",
      action: "draft_then_human_confirm",
      requiresHuman: true,
      reasons,
    };
  }

  reasons.push("未命中白名单，按保守策略进入草稿确认");
  return {
    level: "L1",
    category: "general",
    action: "draft_then_human_confirm",
    requiresHuman: true,
    reasons,
  };
}

export function validateContentForApproval(content, claims, { now = new Date() } = {}) {
  const findings = [];

  if (!content.title?.trim()) {
    findings.push({ code: "TITLE_REQUIRED", message: "内容标题不能为空。" });
  }
  if (!content.body?.trim()) {
    findings.push({ code: "BODY_REQUIRED", message: "内容正文不能为空。" });
  }
  if (!Array.isArray(content.platforms) || content.platforms.length === 0) {
    findings.push({ code: "PLATFORM_REQUIRED", message: "至少选择一个目标平台。" });
  }

  const claimMap = new Map(claims.map((claim) => [claim.id, claim]));
  const claimIds = Array.isArray(content.claimIds) ? content.claimIds : [];

  if (!content.opinion && claimIds.length === 0) {
    findings.push({
      code: "EVIDENCE_REQUIRED",
      message: "非观点内容必须绑定至少一条已批准 Claim。",
    });
  }

  for (const claimId of claimIds) {
    const claim = claimMap.get(claimId);
    if (!claim) {
      findings.push({
        code: "CLAIM_NOT_FOUND",
        message: `找不到 Claim ${claimId}。`,
      });
      continue;
    }
    if (claim.state !== "approved") {
      findings.push({
        code: "CLAIM_NOT_APPROVED",
        message: `Claim ${claimId} 尚未批准。`,
      });
    }
    if (claim.expiresAt && new Date(claim.expiresAt).getTime() < now.getTime()) {
      findings.push({
        code: "CLAIM_EXPIRED",
        message: `Claim ${claimId} 已过期。`,
      });
    }
  }

  findings.push(...scanSensitiveText(`${content.title}\n${content.body}`));

  if (findings.length > 0) {
    throw new PolicyError("CONTENT_APPROVAL_BLOCKED", "内容未通过事实或安全闸门。", findings);
  }
}

export function validatePublication({ account, content, receipt, now = new Date() }) {
  const findings = [];

  if (!account) {
    findings.push({ code: "ACCOUNT_NOT_FOUND", message: "找不到目标账号。" });
  } else {
    if (account.status !== "active") {
      findings.push({ code: "ACCOUNT_NOT_ACTIVE", message: "目标账号尚未启用。" });
    }
    if (account.policyStatus !== "reviewed") {
      findings.push({
        code: "PLATFORM_POLICY_NOT_REVIEWED",
        message: "账号的平台规则尚未完成人工确认。",
      });
    }
  }

  if (!content) {
    findings.push({ code: "CONTENT_NOT_FOUND", message: "找不到待发布内容。" });
  } else if (content.status !== "scheduled") {
    findings.push({
      code: "CONTENT_NOT_SCHEDULED",
      message: "只有已排期内容可以登记发布回执。",
    });
  }

  if (!receipt || typeof receipt !== "object") {
    findings.push({ code: "RECEIPT_REQUIRED", message: "缺少发布回执。" });
  } else {
    if (!["real", "imported"].includes(receipt.dataMode)) {
      findings.push({
        code: "RECEIPT_DATA_MODE_INVALID",
        message: "fixture 或 draft 回执不能证明真实发布。",
      });
    }
    if (!/^https?:\/\//i.test(receipt.url ?? "")) {
      findings.push({
        code: "RECEIPT_URL_INVALID",
        message: "发布回执必须包含可回读的公开 URL。",
      });
    }
    if (!receipt.publishedAt || Number.isNaN(new Date(receipt.publishedAt).getTime())) {
      findings.push({
        code: "RECEIPT_TIME_INVALID",
        message: "发布回执必须包含有效的发布时间。",
      });
    }
    if (!receipt.capturedBy?.trim()) {
      findings.push({
        code: "RECEIPT_OWNER_REQUIRED",
        message: "发布回执必须记录采集人或发布人。",
      });
    }
    if (receipt.publishedAt && new Date(receipt.publishedAt).getTime() > now.getTime() + 60_000) {
      findings.push({
        code: "RECEIPT_TIME_IN_FUTURE",
        message: "发布时间不能晚于当前时间。",
      });
    }
  }

  if (findings.length > 0) {
    throw new PolicyError("PUBLICATION_BLOCKED", "发布回执未通过治理闸门。", findings);
  }
}

export function isClaimPubliclyExportable(claim, { now = new Date() } = {}) {
  if (!claim || claim.state !== "approved" || claim.publicLevel !== "approved_public") {
    return false;
  }
  if (claim.expiresAt && new Date(claim.expiresAt).getTime() < now.getTime()) {
    return false;
  }
  return scanSensitiveText(claim.text).length === 0;
}

export function hasNegativeMention(answer) {
  return includesAny(String(answer ?? ""), NEGATIVE_TERMS);
}
