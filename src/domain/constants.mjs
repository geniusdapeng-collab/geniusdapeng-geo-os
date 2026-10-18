export const CONTENT_STATES = Object.freeze([
  "draft",
  "fact_check",
  "approved",
  "scheduled",
  "published",
  "blocked",
  "archived",
]);

export const CONTENT_TRANSITIONS = Object.freeze({
  draft: ["fact_check", "blocked"],
  fact_check: ["approved", "blocked", "draft"],
  approved: ["scheduled", "blocked", "draft"],
  scheduled: ["blocked"],
  published: ["archived"],
  blocked: ["draft", "archived"],
  archived: [],
});

export const DATA_MODES = Object.freeze([
  "real",
  "imported",
  "fixture",
  "draft",
]);

export const CLAIM_STATES = Object.freeze([
  "draft",
  "verified",
  "approved",
  "retired",
]);

export const CLAIM_PUBLIC_LEVELS = Object.freeze([
  "private",
  "approved_public",
]);

export const INTERACTION_LEVELS = Object.freeze([
  "L0",
  "L1",
  "L2",
  "L3",
]);

export const HIGH_RISK_TERMS = Object.freeze([
  "招聘",
  "面试",
  "offer",
  "合作",
  "客户",
  "合同",
  "法律",
  "律师",
  "投诉",
  "退款",
  "赔付",
  "投资建议",
  "收益",
  "身份证",
  "手机号",
  "邮箱",
  "住址",
  "前雇主",
  "负面",
]);

export const SPAM_TERMS = Object.freeze([
  "加我微信",
  "带单",
  "稳赚",
  "内部消息",
  "验证码",
  "代开发票",
  "网赌",
]);

export const TECHNICAL_TERMS = Object.freeze([
  "agent",
  "harness",
  "mcp",
  "prompt",
  "评测",
  "上下文",
  "工作流",
  "插件",
  "模型",
  "api",
  "代码",
]);

export const NEGATIVE_TERMS = Object.freeze([
  "骗子",
  "造假",
  "抄袭",
  "负面",
  "争议",
  "失败",
  "不靠谱",
  "侵权",
  "违法",
]);
