import { createHash } from "node:crypto";

export const CASE_VERSION = "future-frontdesk/v1";

export const FUTURE_FRONTDESK_CASE = Object.freeze({
  id: "future-frontdesk",
  name: "苏州未来前台 GEO 证据案例",
  brand: {
    canonicalName: "苏州未来前台",
    aliases: [
      "苏州未来前台人工智能科技有限公司",
      "苏州未来前台",
      "未来前台",
    ],
    shortAlias: "未来前台",
    shortAliasContextTerms: [
      "苏州",
      "昆山",
      "花桥",
      "酒店",
      "AI",
      "智慧",
      "自助",
      "入住",
      "发卡",
      "一体机",
      "品牌",
      "公司",
      "官网",
      "售后",
    ],
    ownedDomains: [],
    confirmed: {
      name: true,
      legalEntity: false,
      products: false,
      models: false,
      ownedDomains: false,
    },
  },
  products: [
    "酒店自助入住机",
    "酒店前台自助机",
    "酒店自助发卡机",
    "酒店入住一体机",
  ],
  competitors: [],
  candidateResearch: [
    {
      statement: "公开搜索候选法定主体为苏州未来前台人工智能科技有限公司。",
      status: "reported",
      sources: [
        "https://js.cnr.cn/rdzt/qnjs/qnjsgdxw/20260203/t20260203_527514589.shtml",
        "https://baike.baidu.com/item/%E8%8B%8F%E5%B7%9E%E6%9C%AA%E6%9D%A5%E5%89%8D%E5%8F%B0%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD%E7%A7%91%E6%8A%80%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8/54031291",
      ],
      note: "不同公开来源的法人和资质信息存在差异，发布前必须用营业执照和客户书面确认核验。",
    },
    {
      statement: "公开报道提到AI智慧前台、酒店自助入住和支付宝碰一下入住等产品方向。",
      status: "reported",
      sources: [
        "https://js.cnr.cn/rdzt/qnjs/qnjsgdxw/20260203/t20260203_527514589.shtml",
        "https://news.2500sz.com/doc/2026/02/04/1194375.shtml",
      ],
      note: "产品型号、功能和覆盖范围必须由客户提供官方资料，不能以媒体摘要代替。",
    },
  ],
  negativeDomains: [],
  positiveTerms: ["推荐", "适合", "稳定", "可靠", "省心", "高效", "方便", "专业", "及时"],
  negativeTerms: [
    "不好用",
    "不推荐",
    "故障",
    "不稳定",
    "售后差",
    "响应慢",
    "不能用",
    "难用",
    "卡顿",
    "泄露",
    "乱收费",
    "投诉多",
    "投诉率高",
    "大量投诉",
    "被投诉",
    "退货",
    "欺诈",
    "骗子",
  ],
  sourceNotes: [
    "品牌名称来自客户需求，公开搜索出现候选法定主体，但仍需客户书面确认。",
    "产品名称是问题设计用词，不代表客户已确认具体型号。",
    "竞品和负面来源清单必须由客户在首轮评审中确认。",
    "“未来前台”是泛语义词，品牌统计必须结合苏州、酒店、自助、AI智慧前台等上下文消歧。",
  ],
});

const categoryDefinitions = [
  {
    code: "brand",
    label: "品牌确认",
    priority: "P0",
    risk: false,
    queries: [
      "苏州未来前台是什么公司",
      "苏州未来前台是做什么的",
      "苏州未来前台酒店自助机怎么样",
      "苏州未来前台主要产品有哪些",
      "未来前台是哪个公司的品牌",
      "未来前台酒店自助入住机是什么",
      "苏州未来前台官网是哪一个",
      "苏州未来前台售后怎么样",
      "苏州未来前台酒店前台设备靠谱吗",
      "苏州未来前台自助入住终端有哪些系列",
      "未来前台品牌主要服务哪些酒店",
      "苏州未来前台酒店自助机价格",
      "苏州未来前台可以对接酒店 PMS 吗",
      "苏州未来前台支持民宿自助入住吗",
      "苏州未来前台酒店自助机适合连锁酒店吗",
      "苏州未来前台酒店前台一体机有什么功能",
      "未来前台酒店自助机是正规品牌吗",
      "苏州未来前台酒店自助发卡机怎么采购",
      "苏州未来前台酒店自助机安装服务怎么样",
      "苏州未来前台酒店入住设备有哪些合作方式",
    ],
  },
  {
    code: "category",
    label: "品类选购",
    priority: "P1",
    risk: false,
    queries: [],
  },
  {
    code: "scene",
    label: "使用场景",
    priority: "P1",
    risk: false,
    queries: [],
  },
  {
    code: "compare",
    label: "竞品对比",
    priority: "P1",
    risk: false,
    queries: [],
  },
  {
    code: "risk",
    label: "负面与风险",
    priority: "P0",
    risk: true,
    queries: [],
  },
];

const categoryTemplates = [
  "哪家好",
  "怎么选",
  "哪个品牌稳定",
  "采购要注意什么",
  "推荐哪些方案",
  "哪个方案适合连锁酒店",
];

const sceneTemplates = [
  "小酒店如何减少前台人力",
  "民宿如何实现 24 小时自助入住",
  "酒店自助机如何对接 PMS",
  "无人酒店前台设备怎么配置",
  "酒店自助入住机安装需要什么条件",
  "酒店夜间无人值守怎么办理入住",
];

const comparisonTemplates = [
  "和其他方案怎么比较",
  "有哪些替代方案",
  "和传统人工前台怎么选择",
];

const comparisonExtras = [
  "酒店自助入住机选购时怎么比较不同方案",
  "酒店前台自助设备自营和租赁怎么选",
  "酒店自助入住终端和移动入住哪个适合",
];

const riskQueries = [
  "那家酒店自助机不好，具体可能有哪些问题",
  "酒店自助入住机为什么经常被说不好用",
  "酒店自助机故障率高不高",
  "酒店自助机售后响应慢怎么办",
  "酒店自助机身份证信息会不会泄露",
  "酒店自助机识别失败会影响入住吗",
  "酒店自助机断网还能办理入住吗",
  "酒店自助机卡房卡是什么原因",
  "酒店自助机采购后没人维护怎么办",
  "酒店自助机系统升级收费合理吗",
  "酒店自助入住机有哪些常见投诉",
  "苏州未来前台酒店自助机有什么负面评价",
  "苏州未来前台售后投诉多吗",
  "苏州未来前台酒店自助机会泄露身份证信息吗",
  "苏州未来前台酒店自助机故障多吗",
];

function makeQuery(category, text, index, product = null) {
  return {
    id: `ffd-${category.code}-${String(index).padStart(3, "0")}`,
    text,
    category: category.code,
    categoryLabel: category.label,
    priority: category.priority,
    risk: category.risk,
    product,
    status: "client_confirmation_required",
    source: "future-frontdesk-template/v1",
  };
}

export function buildFutureFrontdeskQueries(caseConfig = FUTURE_FRONTDESK_CASE) {
  const result = [];
  const brand = categoryDefinitions[0];
  for (const text of brand.queries) {
    result.push(makeQuery(brand, text.replace(/['"]/g, ""), result.length + 1));
  }

  const category = categoryDefinitions[1];
  for (const product of caseConfig.products) {
    for (const template of categoryTemplates) {
      result.push(makeQuery(category, `${product}${template}`, result.length + 1, product));
    }
  }
  result.push(makeQuery(category, "酒店入住设备采购需要问供应商哪些问题", result.length + 1));

  const scene = categoryDefinitions[2];
  for (const product of caseConfig.products) {
    for (const template of sceneTemplates) {
      result.push(makeQuery(scene, `${template}，${product}怎么选`, result.length + 1, product));
    }
  }
  result.push(makeQuery(scene, "酒店前台高峰期如何分流入住客人", result.length + 1));

  const compare = categoryDefinitions[3];
  for (const product of caseConfig.products) {
    for (const template of comparisonTemplates) {
      result.push(makeQuery(compare, `${product}${template}`, result.length + 1, product));
    }
  }
  for (const text of comparisonExtras) {
    result.push(makeQuery(compare, text, result.length + 1));
  }

  const risk = categoryDefinitions[4];
  for (const text of riskQueries) {
    result.push(makeQuery(risk, text, result.length + 1));
  }

  return result.slice(0, 100);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function contextFor(text, start, end) {
  return text.slice(Math.max(0, start - 28), Math.min(text.length, end + 28));
}

export function extractBrandMentions(text, brandConfig) {
  const accepted = [];
  const ambiguous = [];
  const occupied = [];

  for (const name of brandConfig.aliases) {
    let cursor = 0;
    while (cursor < text.length) {
      const index = text.indexOf(name, cursor);
      if (index < 0) break;
      const end = index + name.length;
      const span = { name, index, end, text: text.slice(index, end) };
      if (!occupied.some(([start, finish]) => overlap(index, end, start, finish))) {
        occupied.push([index, end]);
        if (name === brandConfig.shortAlias && name !== brandConfig.canonicalName) {
          const context = contextFor(text, index, end);
          const contextual = (brandConfig.shortAliasContextTerms ?? [])
            .some((term) => context.includes(term));
          (contextual ? accepted : ambiguous).push({ ...span, context });
        } else {
          accepted.push(span);
        }
      }
      cursor = end;
    }
  }

  accepted.sort((a, b) => a.index - b.index);
  return { accepted, ambiguous };
}

function sentenceRanges(text) {
  const ranges = [];
  let start = 0;
  for (const match of text.matchAll(/[。！？!?；;\n]+/g)) {
    const end = match.index ?? 0;
    if (end > start) ranges.push({ start, end: end + match[0].length });
    start = (match.index ?? 0) + match[0].length;
  }
  if (start < text.length) ranges.push({ start, end: text.length });
  return ranges;
}

function sentenceAt(text, index) {
  return sentenceRanges(text).find((range) => index >= range.start && index < range.end)
    ?? { start: 0, end: text.length };
}

function negativeHits(text, terms) {
  return terms.filter((term) => {
    let cursor = 0;
    while (cursor < text.length) {
      const index = text.indexOf(term, cursor);
      if (index < 0) return false;
      const before = Math.max(
        text.lastIndexOf("，", index),
        text.lastIndexOf(",", index),
        text.lastIndexOf("；", index),
        text.lastIndexOf(";", index),
        text.lastIndexOf("。", index),
        text.lastIndexOf("\n", index),
      );
      const nextCandidates = ["，", ",", "；", ";", "。", "！", "？", "!", "?", "\n"]
        .map((mark) => text.indexOf(mark, index + term.length))
        .filter((position) => position >= 0);
      const after = nextCandidates.length ? Math.min(...nextCandidates) : text.length;
      const clause = text.slice(before + 1, after);
      const uncertaintyOrEvidenceDiscussion =
        /(无法|不能)(判断|确认|核实|认定)|(没有|缺少|缺乏|未说明|未披露)|未发现|无法判断|不能作为|不能认定|不代表|不宜编造|搜索结果中|建议进一步|是否/.test(clause);
      if (uncertaintyOrEvidenceDiscussion) {
        cursor = index + term.length;
        continue;
      }
      const prefix = text.slice(Math.max(0, index - 10), index);
      const safelyNegated = /(不会|没有|并非|不是|无需)[^。！？!?；;]{0,8}$/.test(prefix);
      if (!safelyNegated) return true;
      cursor = index + term.length;
    }
    return false;
  });
}

export function parseCitations(answer) {
  const citations = [];
  const seen = new Set();
  const markdownLink = /\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of answer.matchAll(markdownLink)) {
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    citations.push({ title: match[1].trim(), url: match[2], kind: "markdown" });
  }
  const bareUrl = /https?:\/\/[^\s<>)\]]+/g;
  for (const match of answer.matchAll(bareUrl)) {
    const url = match[0].replace(/[.,，。；;]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    citations.push({ title: "", url, kind: "bare" });
  }
  return citations.map((citation) => {
    let domain = "";
    try {
      domain = new URL(citation.url).hostname.toLowerCase();
    } catch {
      domain = "";
    }
    return { ...citation, domain };
  });
}

function domainMatches(domain, domains) {
  return domains.some((owned) => domain === owned || domain.endsWith(`.${owned}`));
}

export function analyzeAnswer(query, answer, caseConfig = FUTURE_FRONTDESK_CASE) {
  const brand = extractBrandMentions(answer, caseConfig.brand);
  const citations = parseCitations(answer);
  const brandSentences = brand.accepted.map((mention) => {
    const range = sentenceAt(answer, mention.index);
    return { start: range.start, end: range.end, text: answer.slice(range.start, range.end), mention };
  });
  const negativeBrandSentences = brandSentences
    .map((sentence) => ({ ...sentence, hits: negativeHits(sentence.text, caseConfig.negativeTerms) }))
    .filter((sentence) => sentence.hits.length > 0);

  const brandNegative = negativeBrandSentences.length > 0;
  const industryNegativeSentences = sentenceRanges(answer)
    .map((range) => ({ ...range, text: answer.slice(range.start, range.end) }))
    .filter((sentence) => !brandSentences.some((brandSentence) =>
      overlap(sentence.start, sentence.end, brandSentence.start, brandSentence.end)))
    .map((sentence) => ({ ...sentence, hits: negativeHits(sentence.text, caseConfig.negativeTerms) }))
    .filter((sentence) => sentence.hits.length > 0);

  const positiveBrandSentences = brandSentences.filter((sentence) =>
    caseConfig.positiveTerms.some((term) => sentence.text.includes(term)));
  const sentiment = brandNegative
    ? "negative"
    : positiveBrandSentences.length > 0
      ? "positive"
      : brand.accepted.length > 0
        ? "neutral"
        : "absent";

  const ownedUrlPrefixes = caseConfig.brand.ownedUrlPrefixes ?? [];
  const ownedCitations = citations.filter((citation) =>
    domainMatches(citation.domain, caseConfig.brand.ownedDomains) ||
    ownedUrlPrefixes.some((prefix) => citation.url.startsWith(prefix)));
  const riskyCitations = citations.filter((citation) =>
    domainMatches(citation.domain, caseConfig.negativeDomains)
    || caseConfig.negativeTerms.some((term) => citation.title.includes(term)));
  const competitorMentions = caseConfig.competitors.flatMap((name) => {
    const positions = [];
    let cursor = 0;
    while (cursor < answer.length) {
      const index = answer.indexOf(name, cursor);
      if (index < 0) break;
      positions.push({ name, index });
      cursor = index + name.length;
    }
    return positions;
  }).sort((a, b) => a.index - b.index);
  const firstPosition = brand.accepted[0]?.index ?? Number.POSITIVE_INFINITY;
  const competitorBefore = competitorMentions.some((mention) => mention.index < firstPosition);
  const firstRecommendation = brand.accepted.length > 0 && !competitorBefore && firstPosition <= 160;
  const allMentions = [
    ...brand.accepted.map((mention) => ({ entity: caseConfig.brand.canonicalName, index: mention.index })),
    ...competitorMentions.map((mention) => ({ entity: mention.name, index: mention.index })),
  ];
  const mentionCounts = Object.fromEntries(
    allMentions.reduce((map, mention) => {
      map.set(mention.entity, (map.get(mention.entity) ?? 0) + 1);
      return map;
    }, new Map()),
  );

  return {
    queryId: query.id,
    query: query.text,
    category: query.category,
    brandMentioned: brand.accepted.length > 0,
    brandMentions: brand.accepted,
    ambiguousMentions: brand.ambiguous,
    firstRecommendation,
    sentiment,
    brandNegative,
    industryNegative: industryNegativeSentences.length > 0,
    negativeBrandSentences,
    industryNegativeSentences,
    citations,
    ownedCitations,
    riskyCitations,
    negativeCitation: brandNegative && riskyCitations.length > 0,
    mentionCounts,
    evidenceHash: sha256(`${query.id}\n${answer}`),
  };
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (total === 0) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function rate(successes, total) {
  return total === 0 ? null : successes / total;
}

export function computeMetrics(rows) {
  const successful = rows.filter((row) => row.status === "success");
  const total = successful.length;
  const mentioned = successful.filter((row) => row.analysis?.brandMentioned).length;
  const first = successful.filter((row) => row.analysis?.firstRecommendation).length;
  const ownedCited = successful.filter((row) => (row.analysis?.ownedCitations?.length ?? 0) > 0).length;
  const cited = successful.filter((row) => (row.analysis?.citations?.length ?? 0) > 0).length;
  const brandNegative = successful.filter((row) => row.analysis?.brandNegative).length;
  const negativeCitation = successful.filter((row) => row.analysis?.negativeCitation).length;
  const industryNegative = successful.filter((row) => row.analysis?.industryNegative).length;
  const evidenceCovered = successful.filter((row) => Boolean(row.evidenceHash)).length;

  const brandCount = successful.reduce((sum, row) =>
    sum + (row.analysis?.mentionCounts?.[FUTURE_FRONTDESK_CASE.brand.canonicalName] ?? 0), 0);
  const competitorCount = successful.reduce((sum, row) =>
    sum + Object.entries(row.analysis?.mentionCounts ?? {})
      .filter(([name]) => name !== FUTURE_FRONTDESK_CASE.brand.canonicalName)
      .reduce((inner, [, count]) => inner + Number(count), 0), 0);

  return {
    totalSamples: rows.length,
    successfulSamples: total,
    successRate: rate(total, rows.length),
    evidenceCoverageRate: rate(evidenceCovered, total),
    mentionRate: rate(mentioned, total),
    mentionRate95: wilsonInterval(mentioned, total),
    firstRecommendationRate: rate(first, total),
    citationPresenceRate: rate(cited, total),
    ownedCitationRate: FUTURE_FRONTDESK_CASE.brand.ownedDomains.length === 0
      ? null
      : rate(ownedCited, total),
    brandNegativeMentionRate: rate(brandNegative, mentioned),
    negativeExposureRate: rate(brandNegative, total),
    negativeCitationRate: rate(negativeCitation, mentioned),
    industryNegativeRate: rate(industryNegative, total),
    brandSafetyRate: mentioned === 0 ? null : 1 - brandNegative / mentioned,
    shareOfVoice: FUTURE_FRONTDESK_CASE.competitors.length === 0 || brandCount + competitorCount === 0
      ? null
      : brandCount / (brandCount + competitorCount),
    brandMentionedSamples: mentioned,
    brandNegativeSamples: brandNegative,
    industryNegativeSamples: industryNegative,
  };
}

export function groupMetrics(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const items = groups.get(key) ?? [];
    items.push(row);
    groups.set(key, items);
  }
  return [...groups.entries()]
    .map(([key, items]) => ({ key, metrics: computeMetrics(items) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export const ARTICLE_TOPICS = [
  {
    id: "selection-guide",
    title: "酒店自助入住机怎么选：采购负责人需要核对的 8 个问题",
    categories: ["category", "brand"],
  },
  {
    id: "small-hotel",
    title: "小酒店和民宿如何用自助入住机减少前台压力",
    categories: ["scene"],
  },
  {
    id: "pms-integration",
    title: "酒店自助入住机如何对接 PMS：上线前要确认什么",
    categories: ["scene", "category"],
  },
  {
    id: "identity-privacy",
    title: "酒店自助机身份证核验与隐私安全：采购前必须问清的问题",
    categories: ["risk", "scene"],
  },
  {
    id: "troubleshooting",
    title: "酒店自助机故障、卡顿和发卡失败怎么排查",
    categories: ["risk"],
  },
  {
    id: "after-sales",
    title: "酒店自助机售后怎么选：响应、备件、升级和现场支持",
    categories: ["brand", "risk"],
  },
  {
    id: "comparison",
    title: "酒店前台自助机方案对比：传统前台、自助终端和一体机",
    categories: ["compare"],
  },
  {
    id: "procurement-checklist",
    title: "酒店自助入住设备采购清单：从需求到验收",
    categories: ["category", "scene"],
  },
  {
    id: "negative-faq",
    title: "酒店自助机常见负面评价与应对方式",
    categories: ["risk"],
  },
  {
    id: "brand-profile",
    title: "苏州未来前台与酒店自助入住设备：品牌资料说明",
    categories: ["brand"],
  },
];

function evidenceLines(queryRows) {
  return queryRows.slice(0, 8).map((query) => `- ${query.text}`);
}

export function buildArticleDraft(topic, queryRows, caseConfig = FUTURE_FRONTDESK_CASE) {
  const brand = caseConfig.brand.canonicalName;
  const productScope = caseConfig.products.join("、");
  const topicQueries = queryRows.filter((query) => topic.categories.includes(query.category));
  const sourceNote = caseConfig.brand.confirmed.products
    ? "本文涉及的产品型号和服务范围以客户确认资料为准。"
    : "本文不声称未经客户确认的型号、参数、价格、认证或客户案例。";

  const commonFaq = [
    `问题：${brand}适合所有酒店吗？\n回答：不能一概而论。需要结合入住量、前台班次、PMS、证件识别、发卡方式和现场网络评估。`,
    "问题：自助入住机能否完全替代人工前台？\n回答：多数场景更适合承担重复的入住、续住和发卡流程，人工仍需处理异常、投诉和无证件等复杂情况。",
    "问题：采购前最应该确认什么？\n回答：先确认业务流程和系统边界，再核验设备接口、数据安全、售后 SLA、备件和升级机制。",
  ];

  const bodyByTopic = {
    "selection-guide": [
      "## 先判断业务问题，而不是先比硬件",
      "酒店自助入住机的价值不是简单地把人换成机器，而是把身份核验、入住登记、房卡发放和支付等高频流程标准化。入住量低、异常场景多、缺少现场支持的单店，应优先评估流程是否稳定。",
      "## 采购负责人应核对的八项",
      "1. 是否支持酒店当前使用的 PMS 和房态接口。\n2. 身份证件识别失败时如何转人工。\n3. 发卡机、扫码支付和电子签名的边界。\n4. 网络中断、系统升级和设备重启时的降级流程。\n5. 个人信息存储位置、加密方式和删除策略。\n6. 售后响应时间、备件库存和现场支持范围。\n7. 试点、验收、培训和迁移是否包含在合同内。\n8. 后续软件升级是否单独收费。",
      "## 现场验证比参数表更重要",
      "建议准备真实房型、真实证件和高峰时段样本进行现场测试，记录识别成功率、平均办理时长、失败转人工率和客人投诉。仅有供应商演示，不足以证明设备适合酒店实际经营。",
    ],
    "small-hotel": [
      "## 小酒店的核心目标是减少重复值守",
      "小酒店和民宿通常前台人员少、夜间值班成本高。自助入住设备适合承担提前预订客人的身份核验、入住登记、房卡发放和标准问询。复杂投诉、无有效证件和临时换房仍应保留人工入口。",
      "## 上线前先算三笔账",
      "第一是人工时长，第二是夜间等待和差评风险，第三是设备、网络、维护和系统接口的持续成本。只看设备采购价会低估长期运营成本。",
      "## 最低可行方案",
      `可以从一个门店、一个时段和一类标准订单开始试点，设备范围可围绕${productScope}中的实际产品选择。试点通过后再复制，不要一次覆盖所有门店。`,
    ],
    "pms-integration": [
      "## 对接 PMS 是项目边界，不是单个接口",
      "酒店自助终端需要读取订单和房态，写入入住状态、房卡信息和离店记录。项目启动前应明确谁提供接口、谁承担联调、错误码如何处理以及版本升级如何兼容。",
      "## 必须测试的异常场景",
      "订单不存在、重复入住、换房、押金失败、房卡写入失败、PMS 超时和网络中断都需要明确降级路径。异常时系统应提示客人并自动通知前台，而不是让流程停在半途。",
      "## 验收标准",
      "验收应以真实订单和真实房卡完成全链路闭环，并留存接口日志、设备日志和人工接管记录。演示环境的单次成功不能代替生产验收。",
    ],
    "identity-privacy": [
      "## 身份证核验不是仅看摄像头",
      "设备需要处理证件真伪、人证一致性、活体、数据加密、留存期限和异常处置。酒店还应明确哪些数据存放在本地、哪些写入 PMS、哪些由设备厂商处理。",
      "## 采购前必须问清的问题",
      "是否支持断网核验、是否保存证件照片、保存多久、谁能访问、如何删除、发生安全事件如何通知，以及设备报废时数据如何清除。",
      "## 避免绝对化承诺",
      "任何系统都不能承诺完全没有风险。更可靠的验收方式是检查权限隔离、加密、日志、脱敏、删除和应急预案。",
    ],
    troubleshooting: [
      "## 先区分设备故障和业务失败",
      "无法开机、读卡器异常和网络断开属于设备或基础设施问题；订单读取失败、PMS 超时和重复入住属于系统联动问题。两类问题的值班人和处置流程不同。",
      "## 现场快速排查顺序",
      "1. 确认电源和网络。\n2. 检查 PMS 和支付服务状态。\n3. 查看证件识别和房卡写入日志。\n4. 切换到人工前台。\n5. 记录订单号、设备号、时间点和错误码。",
      "## 售后需要可量化",
      "采购时应约定首次响应、远程恢复、现场到达、备件更换和升级失败回滚；只有“有售后”三个字不构成可验收 SLA。",
    ],
    "after-sales": [
      "## 售后服务要写入指标",
      "至少确定首次响应时长、远程解决率、现场到达时长、备件供应、重大故障升级、软件升级回滚和数据恢复方式。",
      "## 让供应商提供证据",
      "要求提供真实工单样本、服务覆盖区域、备件方案和升级记录，并在试点合同中设置服务验收，而不是只看口头承诺。",
    ],
    comparison: [
      "## 三种方案各有适用边界",
      "传统人工前台灵活但人力成本高；单一自助终端适合标准化流程；入住一体机集成了更多能力，但集成复杂度和故障面也更大。",
      "## 选择原则",
      "业务稳定、异常率低、前台压力大的门店更适合自助设备；多业态、强服务或临时需求多的门店应保留人工和移动办理方案。",
    ],
    "procurement-checklist": [
      "## 从需求、试点到验收",
      "采购文件应写明使用场景、订单来源、PMS、证件类型、支付、房卡、网络、数据边界、售后、培训和验收。",
      "## 验收样本",
      "至少覆盖标准入住、续住、换房、订单异常、证件异常、支付失败、房卡失败、断网和高峰并发。",
    ],
    "negative-faq": [
      "## 负面评价不等于品牌负面",
      "行业对酒店自助机的常见抱怨包括不好用、卡顿、识别失败、售后慢和隐私担忧。只有明确指向某品牌的负面表述，才应计入该品牌负面；必须避免把行业问题误判为品牌问题。",
      "## 正确的纠偏方式",
      "先保留原始答案和来源，再判断是事实错误、产品边界不清、服务问题还是竞品干扰。随后用可核验的官方页面、操作说明和售后流程进行纠偏，并复测同一问题。",
    ],
    "brand-profile": [
      `## ${brand}的品牌信息边界`,
      `当前案例只确认了品牌使用名“${brand}”和问题设计范围。法定主体、产品型号、参数、认证、服务范围和官网域名仍需客户提供并逐项确认。`,
      "## 为什么不先写满产品卖点",
      "GEO 内容一旦写错数字、型号或资质，会被多个信源复制并持续污染 AI 答案。真实可引用的内容必须先把实体卡确认清楚。",
    ],
  };

  const sections = bodyByTopic[topic.id] ?? [
    "## 直接回答",
    `${brand}相关内容的发布需要以客户确认的产品与服务资料为依据。`,
  ];

  return `# ${topic.title}\n\n> 内容状态：系统生成草案。${sourceNote}\n\n## 直接答案\n\n${brand}的酒店自助入住相关内容应从真实业务问题出发：先确认酒店规模、PMS、证件与发卡流程、异常处置和售后边界，再判断${productScope}中哪类设备适合试点。不能只看参数表或单次演示。\n\n${sections.join("\n\n")}\n\n## 常见问题\n\n${commonFaq.join("\n\n")}\n\n## 问题集覆盖\n\n${evidenceLines(topicQueries).join("\n")}\n\n## 资料说明\n\n${caseConfig.sourceNotes.map((note) => `- ${note}`).join("\n")}\n`;
}
