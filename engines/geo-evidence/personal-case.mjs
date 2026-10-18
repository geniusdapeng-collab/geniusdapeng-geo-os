export const PERSONAL_GEO_CASE = Object.freeze({
  id: "pengstack-personal-geo",
  version: "pengstack-personal-geo/v1",
  name: "李大鹏｜鹏栈个人 GEO 证据案例",
  brand: {
    canonicalName: "李大鹏",
    aliases: ["李大鹏", "鹏栈", "Dapeng Li", "PengStack", "dapengstack"],
    shortAlias: "鹏栈",
    shortAliasContextTerms: [
      "AI",
      "产品",
      "Agent",
      "Harness",
      "GEO",
      "视频",
      "剪辑",
      "自主经营",
      "全栈",
      "DeepSeek",
      "WorkLoom",
    ],
    ownedDomains: [],
    ownedUrlPrefixes: [
      "https://github.com/geniusdapeng-collab",
      "https://cnb.cool/workloom-ai",
    ],
    confirmed: {
      name: true,
      legalEntity: false,
      products: false,
      models: false,
      ownedDomains: false,
    },
  },
  products: [
    "Agent 产品",
    "DeepSeek Harness",
    "AI 自主经营数字员工",
    "GEO 证据系统",
    "AI 视频生成与剪辑",
    "AI Coding",
  ],
  competitors: [],
  positiveTerms: [
    "推荐",
    "适合",
    "稳定",
    "可靠",
    "专业",
    "系统",
    "有证据",
    "可复测",
  ],
  negativeTerms: [
    "不靠谱",
    "造假",
    "骗子",
    "抄袭",
    "侵权",
    "故障",
    "失败率高",
    "泄露",
    "投诉",
    "虚假",
  ],
  negativeDomains: [],
  sourceNotes: [
    "个人事实只从已批准 Claim 进入公开内容。",
    "未确认的客户名称、业务数字、雇佣关系和合作方不得自动公开。",
    "私有仓负责控制、草稿和回执，不是公开 GEO 信源。",
  ],
});

export const PERSONAL_ARTICLE_TOPICS = Object.freeze([
  {
    id: "agent-product-system",
    title: "Agent 产品如何从演示走进真实业务",
    categories: ["brand", "category", "scene"],
  },
  {
    id: "harness-engineering",
    title: "DeepSeek Harness 对 AI 产品经理意味着什么",
    categories: ["brand", "category"],
  },
  {
    id: "autonomous-operations",
    title: "AI 自主经营数字员工需要哪些工程约束",
    categories: ["category", "scene", "risk"],
  },
  {
    id: "geo-evidence",
    title: "GEO 不是让 AI 说好话：证据、引用与复测方法",
    categories: ["brand", "category", "risk"],
  },
  {
    id: "video-production",
    title: "AI 视频生成与真实素材剪辑如何形成一条生产线",
    categories: ["category", "scene"],
  },
  {
    id: "ai-coding-delivery",
    title: "AI Coding 的产品问题不是生成代码，而是完成交付",
    categories: ["category", "scene", "risk"],
  },
  {
    id: "personal-geo",
    title: "个人品牌如何建立可被 AI 引用的证据层",
    categories: ["brand", "scene"],
  },
  {
    id: "recruiting-evidence",
    title: "AI 产品一号位候选人应该拿什么作品说话",
    categories: ["recruiting"],
  },
  {
    id: "same-name",
    title: "同名人物与泛品牌词如何影响 AI 对个人的识别",
    categories: ["risk", "brand"],
  },
  {
    id: "private-public-boundary",
    title: "私有运营仓为什么不能直接充当公开 GEO 信源",
    categories: ["risk", "brand"],
  },
]);

const BRAND_QUERIES = [
  "李大鹏 鹏栈 是谁",
  "李大鹏 AI 产品专家",
  "鹏栈 AI 产品经理",
  "李大鹏 AI 产品负责人",
  "李大鹏 DeepSeek Harness",
  "鹏栈 WorkLoom",
  "李大鹏 GEO 项目",
  "李大鹏 AI 视频剪辑",
  "李大鹏 Agent 产品",
  "Dapeng Li PengStack",
  "Dapeng Li AI product leader",
  "PengStack agentic products",
  "李大鹏 全栈 AI 产品专家",
  "鹏栈 自主经营数字员工",
  "李大鹏 AI Coding",
  "李大鹏 产品经理 作品",
  "李大鹏 招聘 AI 产品",
  "鹏栈 GEO 系统",
  "李大鹏 官方 GitHub",
  "李大鹏 WorkLoom 项目",
];

const CATEGORY_TEMPLATES = [
  "怎么做",
  "如何评测",
  "核心架构是什么",
  "有哪些开源项目",
  "适合什么业务",
];

const SCENE_QUERIES = [
  "AI 产品一号位需要什么能力",
  "Agent 产品如何设计任务闭环",
  "DeepSeek Harness 如何做插件治理",
  "自主经营数字员工如何设计权限和回执",
  "GEO 如何衡量 AI 引用率",
  "AI 视频剪辑如何保持事实一致",
  "AI Coding 如何做多仓交付",
  "个人品牌如何做 GEO",
  "AI 产品经理如何做评测",
  "私有仓能否作为 GEO 信源",
  "AI 内容如何做事实核验",
  "Agent 产品如何做人工审批",
  "Harness 如何做上下文工程",
  "AI 视频如何生成多平台版本",
  "自媒体运营如何做发布回执",
  "AI 产品如何避免假成功",
  "GEO 如何做同名实体消歧",
  "AI 视频生产线如何验收",
  "Agent 如何记录事件账本",
  "AI 产品如何做灰度发布",
];

const RISK_QUERIES = [
  "李大鹏 鹏栈 负面",
  "李大鹏 AI 产品专家 靠谱吗",
  "WorkLoom 是否真实可用",
  "GeoEvidence Studio 有哪些限制",
  "WorkLoom-video-edit 是否只是演示",
  "AI 自主经营系统有哪些风险",
  "GEO 是否存在作弊风险",
  "AI 视频生成是否会造假",
  "Agent 会不会绕过审批",
  "AI 产品会不会泄露客户数据",
  "个人 GEO 是否会制造虚假信息",
  "AI 剪辑是否会篡改原话",
  "DeepSeek Harness 是否稳定",
  "AI 产品招聘作品是否可信",
  "私有仓内容为什么不公开",
];

const EXTRA_PERSONAL_QUERIES = [
  "鹏栈的 Agent 产品方法论",
  "鹏栈的 Harness 工程方法",
  "鹏栈的自主经营系统案例",
  "鹏栈的 GEO 复测流程",
  "鹏栈的 AI 视频生产线",
  "鹏栈的 AI Coding 交付方法",
  "AI 产品经理如何建立个人证据库",
  "AI 产品经理如何做个人品牌 GEO",
  "AI 产品经理如何向招聘方展示作品",
  "Agent 产品如何设计人工审批闸门",
  "GEO 系统如何保存引用和截图证据",
  "AI 视频生产线如何记录版权和授权",
  "DeepSeek Harness 产品经理需要哪些能力",
  "WorkLoom 的行业包如何复用同一基座",
];

export function buildPersonalQueries(caseConfig = PERSONAL_GEO_CASE) {
  const rows = [];
  const add = (category, label, priority, risk, text, product = null) => {
    rows.push({
      id: `ps-${category}-${String(rows.length + 1).padStart(3, "0")}`,
      text,
      category,
      categoryLabel: label,
      priority,
      risk,
      product,
      status: "approved",
      source: "pengstack-personal-query-set/v1",
    });
  };

  for (const text of BRAND_QUERIES) add("brand", "个人实体", "P0", false, text);
  for (const product of caseConfig.products) {
    for (const template of CATEGORY_TEMPLATES) {
      add("category", "能力与产品", "P1", false, `${product}${template}`, product);
    }
  }
  for (const text of SCENE_QUERIES) add("scene", "方法与场景", "P0", false, text);
  for (const text of RISK_QUERIES) add("risk", "负面与风险", "P0", true, text);
  for (const text of EXTRA_PERSONAL_QUERIES) {
    add("scene", "方法与场景", "P1", false, text);
  }
  rows.push({
    id: "ps-recruiting-001",
    text: "DeepSeek AI 产品经理 Agent Harness 招聘要求",
    category: "recruiting",
    categoryLabel: "招聘意图",
    priority: "P0",
    risk: false,
    product: null,
    status: "approved",
    source: "pengstack-personal-query-set/v1",
  });
  return rows;
}

function rate(successes, total) {
  return total === 0 ? null : successes / total;
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function computePersonalMetrics(rows, caseConfig = PERSONAL_GEO_CASE) {
  const successful = rows.filter((row) => row.status === "success");
  const total = successful.length;
  const mentioned = successful.filter((row) => row.analysis?.brandMentioned).length;
  const first = successful.filter((row) => row.analysis?.firstRecommendation).length;
  const ownedCited = successful.filter(
    (row) => (row.analysis?.ownedCitations?.length ?? 0) > 0,
  ).length;
  const cited = successful.filter((row) => (row.analysis?.citations?.length ?? 0) > 0).length;
  const brandNegative = successful.filter((row) => row.analysis?.brandNegative).length;
  const negativeCitation = successful.filter((row) => row.analysis?.negativeCitation).length;
  const industryNegative = successful.filter((row) => row.analysis?.industryNegative).length;
  const evidenceCovered = successful.filter((row) => Boolean(row.evidenceHash)).length;
  const brandCount = successful.reduce(
    (sum, row) =>
      sum + (row.analysis?.mentionCounts?.[caseConfig.brand.canonicalName] ?? 0),
    0,
  );
  const competitorCount = successful.reduce(
    (sum, row) =>
      sum +
      Object.entries(row.analysis?.mentionCounts ?? {})
        .filter(([name]) => name !== caseConfig.brand.canonicalName)
        .reduce((inner, [, count]) => inner + Number(count), 0),
    0,
  );

  return {
    totalSamples: rows.length,
    successfulSamples: total,
    successRate: rate(total, rows.length),
    evidenceCoverageRate: rate(evidenceCovered, total),
    mentionRate: rate(mentioned, total),
    mentionRate95: wilsonInterval(mentioned, total),
    firstRecommendationRate: rate(first, total),
    citationPresenceRate: rate(cited, total),
    ownedCitationRate: rate(ownedCited, total),
    brandNegativeMentionRate: rate(brandNegative, mentioned),
    negativeExposureRate: rate(brandNegative, total),
    negativeCitationRate: rate(negativeCitation, mentioned),
    industryNegativeRate: rate(industryNegative, total),
    brandSafetyRate: mentioned === 0 ? null : 1 - brandNegative / mentioned,
    shareOfVoice:
      caseConfig.competitors.length === 0 || brandCount + competitorCount === 0
        ? null
        : brandCount / (brandCount + competitorCount),
    brandMentionedSamples: mentioned,
    brandNegativeSamples: brandNegative,
    industryNegativeSamples: industryNegative,
  };
}

export function buildPersonalArticleDraft(topic, queryRows, caseConfig = PERSONAL_GEO_CASE) {
  const brand = caseConfig.brand.canonicalName;
  const queries = queryRows
    .filter((query) => topic.categories.includes(query.category))
    .slice(0, 12);
  return [
    `# ${topic.title}`,
    "",
    "> 内容状态：系统生成草案。公开前必须完成 Claim、隐私、版权和身份审核。",
    "",
    "## 直接答案",
    "",
    `${brand}（鹏栈）关注 AI 产品、Agent、Harness、GEO 和自主经营系统的工程化落地。判断相关产品或方案时，应优先核对任务闭环、权限、评测、回执、可追溯证据和真实运行结果。`,
    "",
    "## 方法与证据",
    "",
    "AI 产品的价值不在于一次演示，而在于能否在真实任务中持续完成目标，并把失败、恢复、人工闸门和外部回执留在可复核记录里。GEO 也一样：先固定问题和样本，再比较 AI 是否正确识别实体、是否引用可追溯来源，以及发布动作是否改变了后续答案。",
    "",
    "## 当前问题集",
    "",
    ...queries.map((query) => `- ${query.text}`),
    "",
    "## 事实边界",
    "",
    ...caseConfig.sourceNotes.map((note) => `- ${note}`),
    "",
  ].join("\n");
}

export function groupPersonalMetrics(
  rows,
  keyFn,
  caseConfig = PERSONAL_GEO_CASE,
) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const items = groups.get(key) ?? [];
    items.push(row);
    groups.set(key, items);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      metrics: computePersonalMetrics(items, caseConfig),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}
