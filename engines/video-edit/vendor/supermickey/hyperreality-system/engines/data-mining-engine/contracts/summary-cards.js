'use strict';

/**
 * SummaryCards — 下游消费摘要卡生成器
 * ------------------------------------------------------------
 * 核心设计：各环节只拿切片，不读全档。
 * 六张卡，每张对应一个下游消费方的最小必要情报面：
 *   brief_card        → MarketingBriefParser：自动回填 Brief
 *   theme_card        → CreativeThemeGenerator：主题创意的事实底座
 *   insight_card      → RequirementDiscoveryEngine：洞察的证据锚点
 *   prd_card          → PRDGenerator：卖点→镜头映射依据
 *   portrait_manifest → ProductPortraitBranch：搜图交接（免重复检索）
 *   router_material   → MarketingSkillRouter：钩子选型素材
 *
 * 卡片纪律：
 *   - inferred 级条目不进入任何卡片
 *   - 卡片只承载"结论 + 证据强度"，完整溯源回档案查证
 *   - 卡片体积受控（每类条目封顶），防止情报过载冲垮下游上下文
 */

const CARD_LIMITS = {
  selling_points: 6,
  praise: 6,
  pain: 5,
  verbatim: 6,
  scenarios: 4,
  competitors: 3,
  data_points: 5,
  conflicts: 5,
  questions: 5
};

function _usable(item) {
  return item && (item.confidence === 'confirmed' || item.confidence === 'reported');
}

function _nature(item) {
  return String(item?.claim_nature || item?.nature || 'user');
}

function _claimText(item) {
  const point = String(item?.point || item?.aspect || '').trim();
  return (point.match(/^官方主打「(.+?)」$/) || [])[1] || point;
}

function _unique(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value || '').trim())
    .filter(Boolean))];
}

function _priceProhibited(restrictions) {
  return (Array.isArray(restrictions) ? restrictions : []).some(value =>
    /(?:不写|不得|禁止|不展示|不出现|不提及|不播报)[^。；\n]{0,100}价格|价格[^。；\n]{0,100}(?:不得|禁止|不展示|不出现|不提及|不播报)/u.test(String(value || ''))
  );
}

function _restrictions(dossier, policy = {}) {
  const values = Array.isArray(policy.restrictions) ? [...policy.restrictions] : [];
  for (const gap of dossier.gaps || []) {
    const value = String(gap || '');
    if (/\[A2\]|有效评价样本 0 条/.test(value)) {
      values.push('没有可核实用户评价：禁止用户口碑、评分、人数、销量或使用效果共识主张');
    }
    if (/\[A3\]|无有效竞品/.test(value)) {
      values.push('没有可核实竞品证据：禁止对比、竞品弱点或市场领先主张');
    }
  }
  for (const [key, value] of Object.entries(dossier.identity?.specs || {})) {
    const text = String(value ?? '');
    if (/(不具备|不可|不得|禁止|仅限|只适用|限制|not eligible|not for)/i.test(`${key}${text}`)) {
      values.push(`必须保留来源限定：${key}：${text}`);
    }
  }
  return _unique(values);
}

function _hookDataPoints(dossier, restrictions) {
  const points = (dossier.hook_material?.data_points || []).slice(0, CARD_LIMITS.data_points);
  return _priceProhibited(restrictions)
    ? points.filter(point => !/(?:^|[：:])\s*(?:价格|售价|指导价)|(?:CNY|RMB|人民币)\s*\d|(?:¥|￥)\s*\d/i.test(String(point)))
    : points;
}

function _referenceImagePolicy(dossier) {
  const images = dossier.visual_assets?.images || [];
  const highRisk = images.filter(image => image.license_risk === 'high');
  return {
    assets: images.map(image => ({
      id: image.id, license_risk: image.license_risk, licensed_for_delivery: image.license_risk !== 'high',
    })),
    high_risk_count: highRisk.length,
    licensed_for_delivery: highRisk.length === 0 && images.length > 0,
    usage_policy: highRisk.length
      ? '高授权风险图片仅作外观与型号一致性核对，不得直接用于商业成片；正式投放前须取得授权或改用已清权素材'
      : '参考图仍需在正式投放前核对来源、商标与商业使用授权',
  };
}

function _priceContext(dossier, policy = {}) {
  const supplied = policy.priceContext && typeof policy.priceContext === 'object' ? policy.priceContext : {};
  return {
    price_band: dossier.identity.price_band || null,
    price_confidence: dossier.identity.price_confidence || 'unknown',
    price_reported_at: supplied.reportedAt || null,
    price_retrieved_at: supplied.retrievedAt || null,
    price_source_url: supplied.sourceUrl || null,
    price_validity_note: dossier.identity.price_band
      ? (supplied.reportedAt
        ? '价格日期来自来源页面；该价格可能变化，发布前须重新核对'
        : '来源未提供可解析的发布日期；该价格仅为采集时读到的主张，发布前须重新核对')
      : null
  };
}

/** Brief 摘要卡：MarketingBriefParser 自动回填依据 */
function makeBriefCard(dossier, policy = {}) {
  const d = dossier;
  // 用户共识、官方口径、媒体/跨源公开主张分区保存，禁止把非官方来源统一称为官方。
  const userPros = (d.pros_cons.pros || []).filter(p => _nature(p) === 'user' && _usable(p));
  const officialPros = (d.pros_cons.pros || []).filter(p => _nature(p) === 'official' && _usable(p));
  const reportedPros = (d.pros_cons.pros || []).filter(p =>
    !['user', 'official'].includes(_nature(p)) && _usable(p));
  const rankedOfficial = [...officialPros].sort((a, b) => {
    const confidenceRank = (item) => item.confidence === 'confirmed' ? 0 : 1;
    return confidenceRank(a) - confidenceRank(b);
  });
  const ranked = [...userPros.sort((a, b) => (b.mentions || 0) - (a.mentions || 0)), ...rankedOfficial, ...reportedPros];
  const sellingPoints = [];
  for (const p of ranked) {
    const text = _claimText(p);
    if (!sellingPoints.includes(text)) sellingPoints.push(text);
    if (sellingPoints.length >= CARD_LIMITS.selling_points) break;
  }

  const topScenario = (d.usage.scenarios || [])[0];
  const topCompetitor = (d.competitors || [])[0];
  const confirmedClaims = [...officialPros, ...reportedPros].filter(p => p.confidence === 'confirmed').length;
  const reportedClaims = reportedPros.filter(p => p.confidence === 'reported').length;

  return {
    card: 'brief_card',
    product: d.identity.name,
    category: d.identity.category,
    sellingPoints,
    sellingPointEvidence: ranked.slice(0, CARD_LIMITS.selling_points).map(p => ({
      point: _claimText(p), nature: _nature(p), confidence: p.confidence,
      source_refs: Array.isArray(p.source_refs) ? p.source_refs : [],
    })),
    audience: topScenario ? `${topScenario.persona}${topScenario.scene ? `（${topScenario.scene}）` : ''}` : undefined,
    competitor: topCompetitor ? topCompetitor.name : undefined,
    productHero: d.visual_assets.hero_image_id ? {
      heroImageId: d.visual_assets.hero_image_id,
      ..._referenceImagePolicy(d),
    } : undefined,
    reference_image_policy: _referenceImagePolicy(d),
    evidence_note: `卖点来自 ${userPros.length} 条用户共识 + ${confirmedClaims} 条官方/交叉确认公开主张 + ${reportedClaims} 条单源公开主张，完整溯源见档案 ${d.product_id}`,
    restrictions: _restrictions(d, policy)
  };
}

/** 主题摘要卡：创意主题的事实底座 */
function makeThemeCard(dossier, policy = {}) {
  const d = dossier;
  const hasCompetitors = Array.isArray(d.competitors) && d.competitors.length > 0;
  return {
    card: 'theme_card',
    product: d.identity.name,
    category: d.identity.category,
    emotional_anchors: (d.voice_of_customer.praise_points || []).filter(_usable).slice(0, 3).map(p => p.aspect),
    avoid_pits: (d.voice_of_customer.pain_points || []).filter(_usable).slice(0, 3).map(p => ({
      aspect: p.aspect, root_cause: p.root_cause
    })),
    differentiation_space: hasCompetitors ? d.differentiation.our_opening || [] : [],
    crowded_space: hasCompetitors ? d.differentiation.crowded_points || [] : [],
    differentiation_status: hasCompetitors ? 'competitor-evidence-present' : 'not-evaluated: no verified competitor evidence',
    top_scenarios: (d.usage.scenarios || []).slice(0, CARD_LIMITS.scenarios),
    verbatim_spark: (d.voice_of_customer.verbatim || []).slice(0, 3).map(v => v.text),
    restrictions: _restrictions(d, policy)
  };
}

/** 洞察摘要卡：需求洞察的证据锚点 */
function makeInsightCard(dossier, policy = {}) {
  const d = dossier;
  const pros = (d.pros_cons.pros || []).filter(_usable);
  const userClaims = pros.filter(p => _nature(p) === 'user');
  const officialClaims = pros.filter(p => _nature(p) === 'official');
  const reportedClaims = pros.filter(p => !['user', 'official'].includes(_nature(p)));
  const hasCompetitors = Array.isArray(d.competitors) && d.competitors.length > 0;
  const price = _priceContext(d, policy);
  return {
    card: 'insight_card',
    product: d.identity.name,
    audience_profile: (d.usage.scenarios || []).slice(0, CARD_LIMITS.scenarios).map(s => ({
      persona: s.persona, scene: s.scene, moment: s.moment, mentions: s.mentions
    })),
    consensus_points: userClaims.slice(0, CARD_LIMITS.praise).map(p => ({
      point: _claimText(p), confidence: p.confidence, mentions: p.mentions
    })),
    official_claims: officialClaims.slice(0, CARD_LIMITS.praise).map(p => ({
      point: _claimText(p), confidence: p.confidence
    })),
    reported_claims: reportedClaims.slice(0, CARD_LIMITS.praise).map(p => ({
      point: _claimText(p), nature: _nature(p), confidence: p.confidence, mentions: 0,
      source_refs: Array.isArray(p.source_refs) ? p.source_refs : [],
      evaluation_nature: 'source-claim-not-user-review',
    })),
    complaint_map: (d.pros_cons.cons || []).filter(_usable).slice(0, CARD_LIMITS.pain).map(c => ({
      point: c.point, root_cause: c.root_cause, confidence: c.confidence, mentions: c.mentions
    })),
    market_position: {
      ...price,
      our_opening: hasCompetitors ? d.differentiation.our_opening || [] : [],
      crowded_points: hasCompetitors ? d.differentiation.crowded_points || [] : [],
      opening_status: hasCompetitors ? 'competitor-evidence-present' : 'not-evaluated: no verified competitor evidence'
    },
    competitor_briefs: (d.competitors || []).slice(0, CARD_LIMITS.competitors).map(c => ({
      name: c.name, price_band: c.price_band, selling_points: c.selling_points, weakness: c.weakness_notes || ''
    })),
    restrictions: _restrictions(d, policy)
  };
}

/** PRD 摘要卡：卖点→镜头映射依据 */
function makePrdCard(dossier, policy = {}) {
  const d = dossier;
  const claimEvidence = (d.pros_cons.pros || []).filter(_usable);
  const restrictions = _restrictions(d, policy);
  const price = _priceContext(d, policy);
  return {
    card: 'prd_card',
    product: d.identity.name,
    demo_scenes: (d.usage.scenarios || []).slice(0, CARD_LIMITS.scenarios).map(s => ({
      scene: s.scene || s.moment, persona: s.persona, mentions: s.mentions,
      suggest_fn: 'demo' // 演示节拍的场景来源
    })),
    selling_point_evidence: claimEvidence.slice(0, CARD_LIMITS.praise).map(p => ({
      point: _claimText(p), nature: _nature(p), confidence: p.confidence,
      source_refs: Array.isArray(p.source_refs) ? p.source_refs : [],
    })),
    compliance_redlines: _unique([
      ...restrictions,
      ...(d.pros_cons.cons || []).filter(_usable).map(c =>
        `不得宣称与「${c.aspect}」相关的绝对化优势（用户有真实吐槽，宣称即翻车）`
      )
    ]),
    hook_candidates: {
      data_points: _hookDataPoints(d, restrictions),
      conflicts: (d.hook_material.conflicts || []).slice(0, CARD_LIMITS.conflicts),
      questions: (d.hook_material.questions || []).slice(0, CARD_LIMITS.questions)
    },
    price_evidence: d.identity.price_band ? price : null,
    reference_image_policy: _referenceImagePolicy(d),
    restrictions
  };
}

/** 定妆照图档 manifest：ProductPortraitBranch 搜图交接 */
function makePortraitManifest(dossier, policy = {}) {
  const d = dossier;
  const highRisk = (d.visual_assets.images || []).filter(img => img.license_risk === 'high');
  const usagePolicy = highRisk.length
    ? `其中 ${highRisk.length} 张为高授权风险参考图，只可核对外观，不得直接用于商业成片；正式投放前须由权利人授权或改用已清权素材`
    : '所选参考图仍需在正式投放前核对来源、商标与商业使用授权';
  return {
    card: 'portrait_manifest',
    product_id: d.product_id,
    product_name: d.identity.name,
    hero_image_id: d.visual_assets.hero_image_id,
    needs_more_reference: d.visual_assets.needs_more_reference,
    reference_images: (d.visual_assets.images || []).map(img => ({
      id: img.id, url: img.url, source: img.source, angle: img.angle,
      license_risk: img.license_risk, fetched_at: img.fetched_at
    })),
    licensed_for_delivery: highRisk.length === 0 && (d.visual_assets.images || []).length > 0,
    usage_policy: usagePolicy,
    handoff_note: highRisk.length
      ? '情报档案预填参考图，定妆照分支免重复检索；执行方须核对图片真实性与型号一致性，并仅作外观参考，不得把高授权风险图片直接用于商业成片'
      : '情报档案预填参考图，定妆照分支免重复检索；执行方须核对图片真实性、型号一致性与商业授权',
    restrictions: _restrictions(d, policy)
  };
}

/** 技能路由素材卡：MarketingSkillRouter 钩子选型 */
function makeRouterMaterial(dossier, policy = {}) {
  const d = dossier;
  const restrictions = _restrictions(d, policy);
  return {
    card: 'router_material',
    category: d.identity.category,
    product_kind: /服务|课程|培训|咨询|软件|SaaS|APP|App/.test(String(d.identity.category || '')) ? 'service' : 'physical',
    hook_material: {
      data_points: _hookDataPoints(d, restrictions),
      conflicts: (d.hook_material.conflicts || []).slice(0, CARD_LIMITS.conflicts),
      questions: (d.hook_material.questions || []).slice(0, CARD_LIMITS.questions)
    },
    style_hints: {
      has_strong_data: (d.hook_material.data_points || []).length > 0,
      has_conflict: (d.hook_material.conflicts || []).length > 0,
      has_question: (d.hook_material.questions || []).length > 0
    },
    restrictions
  };
}

function makeAllCards(dossier, policy = {}) {
  return {
    brief_card: makeBriefCard(dossier, policy),
    theme_card: makeThemeCard(dossier, policy),
    insight_card: makeInsightCard(dossier, policy),
    prd_card: makePrdCard(dossier, policy),
    portrait_manifest: makePortraitManifest(dossier, policy),
    router_material: makeRouterMaterial(dossier, policy)
  };
}

module.exports = { makeAllCards, makeBriefCard, makeThemeCard, makeInsightCard, makePrdCard, makePortraitManifest, makeRouterMaterial, CARD_LIMITS };
