'use strict';

/**
 * A4 CrossVerifier — 交叉验证官（本模块的命脉）
 * ------------------------------------------------------------
 * 职责：在档案装订前做最后一道事实审判。
 * 四把法尺：
 *   1. 置信度定级：
 *      confirmed  官方来源，或 >=2 个独立来源交叉一致
 *      reported   单一非官方来源
 *      inferred   无源或纯推理 —— 禁止进入 pros/cons 事实区
 *   2. 冲突裁决：同一事实多来源打架（如价格差 >30%），
 *      官方来源优先；无官方则取多数派；无法裁决则记 conflict 并降级
 *   3. 无源清洗：任何没挂证据的条目直接从事实区清除，移交 gaps
 *   4. 优缺点签发：只有 confirmed + reported 级条目才能进入
 *      pros_cons 事实区，且每条标注 evidence_strength
 *
 * 输出：verified 数据包 + verification_report（审判记录，备查）
 */

class CrossVerifier {
  constructor(opts = {}) {
    this.agentName = 'CrossVerifier';
    this.conflictPriceRatio = opts.conflictPriceRatio || 0.3; // 价格冲突阈值
  }

  /**
   * @param {object} packs { a1, a2, a3 } 三个采集 Agent 的出站 payload
   * @param {object} ctx { ledger } EvidenceLedger 实例
   */
  verify(packs = {}, ctx = {}) {
    const { ledger } = ctx;
    const report = {
      graded: { confirmed: 0, reported: 0, inferred: 0 },
      purged: [],
      conflicts: [],
      checks_run: []
    };

    if (!ledger) throw new Error('[A4] 缺 EvidenceLedger，无法执行验证');

    // ===== 1. 评价观点定级（A2 产出）=====
    const gradePoint = (item, claimPrefix) => {
      const refs = Array.isArray(item.source_refs) ? item.source_refs : [];
      if (refs.length === 0) {
        report.purged.push(`${claimPrefix}: "${item.point}" 无证据，清除出事实区`);
        report.graded.inferred += 1;
        return null;
      }
      /**
       * 官方来源或 >=2 独立来源 → confirmed。
       *
       * 【2026-09-25 修复】原实现两处失真：
       *   ① `const official = refs.some(() => false)` 是恒 false 的桩——评价类永远拿不到官方级；
       *   ② `Math.max(refs.length, item.mentions || 1)` 把**提及次数**当独立来源数，
       *      一条评价被复读十次即升 confirmed，直接违背铁律二（≥2 个**独立**来源）。
       * 现改为向证据账本查渠道级别与 host 去重后的独立来源数；账本查不到编号时按 reported 保守处理。
       */
      const claimKey = `${claimPrefix}:${item.aspect || item.point}`;
      const official = ledger.hasOfficialAmong(refs);
      const independent = ledger.independentSourceCountForRefs(refs);
      const channels = ledger.classCountsAmong(refs);
      const confidence = (official || independent >= 2) ? 'confirmed' : 'reported';
      report.graded[confidence] += 1;
      report.checks_run.push(
        `${claimKey} -> ${confidence}（证据 ${refs.length} 条 / 独立来源 ${independent}`
        + `（官方 ${channels.official} · 电商 ${channels.ecommerce} · 社区 ${channels.community} · 未知 ${channels.unknown}）`
        + ` / 提及 ${item.mentions || 1} 次；提及次数不参与定级）`
      );
      return { ...item, confidence, evidence_strength: official || independent >= 2 ? 'strong' : 'single' };
    };

    const verifiedPraise = (packs.a2?.praise_points || []).map(p => gradePoint(p, 'voc.praise')).filter(Boolean);
    const verifiedPain = (packs.a2?.pain_points || []).map(p => gradePoint(p, 'voc.pain')).filter(Boolean);

    // ===== 2. 身份事实冲突检查（A1 产出）=====
    const identity = { ...(packs.a1?.identity || {}) };
    const priceRefs = ledger.forClaim('identity.price_band');
    if (priceRefs.length >= 2) {
      // 价格带无数字时的防御（原实现 match() 返回 null 后直接 .map 会抛 TypeError）
      const nums = (String(identity.price_band || '').match(/\d+(\.\d+)?/g) || []).map(Number);
      if (nums.length >= 2) {
        const spread = (Math.max(...nums) - Math.min(...nums)) / Math.min(...nums);
        if (spread > this.conflictPriceRatio) {
          const officialPrice = ledger.hasOfficialSource('identity.price_band');
          report.conflicts.push({
            field: 'identity.price_band',
            detail: `价格样本离散度 ${(spread * 100).toFixed(0)}% 超过阈值 ${this.conflictPriceRatio * 100}%`,
            resolution: officialPrice ? '以官方渠道价格为准，区间保留供参考' : '无官方来源，价格带降级为 reported，下游引用须标注浮动'
          });
          identity.price_confidence = officialPrice ? 'confirmed' : 'reported';
        } else {
          identity.price_confidence = ledger.hasOfficialSource('identity.price_band') ? 'confirmed' : 'reported';
        }
      } else {
        identity.price_confidence = 'reported';
      }
    } else if (identity.price_band) {
      identity.price_confidence = 'reported';
    } else {
      identity.price_confidence = null;
    }

    // 字段名 official_selling_points 是历史合同；只有证据账本确认的官方渠道才是 official。
    // 媒体、电商、社区的单源或跨源公开主张必须保留为公开主张，不能仅因落在这个字段就升级成官方口径。
    identity.official_selling_points = (identity.official_selling_points || []).map(item => {
      const point = typeof item === 'string' ? item : String(item?.point || '');
      const refs = ledger.forClaim(`identity.official_selling_points:${point}`);
      const refIds = refs.map(entry => entry.id);
      const official = ledger.hasOfficialAmong(refIds);
      const independent = ledger.independentSourceCountForRefs(refIds);
      return {
        point,
        confidence: official || independent >= 2 ? 'confirmed' : 'reported',
        claim_nature: official ? 'official' : independent >= 2 ? 'cross-confirmed-public' : 'media-reported',
        source_nature: official ? 'official' : independent >= 2 ? 'cross-confirmed-public' : 'media-reported-single-source',
        evidence_strength: official || independent >= 2 ? 'strong' : 'single',
        source_refs: refIds
      };
    });
    identity.selling_points_field_note = 'official_selling_points 是历史字段名；source_nature 与 evidence_strength 才表示真实来源性质，media-reported 不是厂商官方确认';

    // ===== 3. 竞品数据定级（A3 产出）=====
    const competitors = (packs.a3?.competitors || []).map(c => {
      const refs = Array.isArray(c.source_refs) ? c.source_refs : [];
      const independent = ledger.independentSourceCountForRefs(refs);
      return {
        ...c,
        confidence: independent >= 2 ? 'confirmed' : 'reported',
        evidence_strength: independent >= 2 ? 'strong' : 'single'
      };
    });

    // ===== 4. 优缺点签发 =====
    // 优点 = 已验证称赞点 + confirmed/reported 级公开卖点。
    // reported 是单源但已绑定可核实原文的事实，必须保留并标注证据强度；
    // 只有 inferred 或无源条目才能被排除，不能把“非官方”误当成“无事实”。
    const pros = verifiedPraise.map(p => ({
      point: p.point,
      aspect: p.aspect,
      mentions: p.mentions,
      quote: p.quote,
      confidence: p.confidence,
      evidence_strength: p.evidence_strength,
      source_refs: p.source_refs,
      claim_nature: 'user'
    }));
    for (const osp of identity.official_selling_points) {
      if (osp.confidence !== 'confirmed' && osp.confidence !== 'reported') continue;
      const already = pros.some(p => osp.point.includes(p.aspect) || p.point.includes(osp.point.slice(0, 4)));
      if (!already) {
        const refs = Array.isArray(osp.source_refs) ? osp.source_refs : [];
        const official = osp.claim_nature === 'official';
        pros.push({
          point: osp.point,
          aspect: official ? 'official_claim' : 'reported_claim',
          mentions: 0,
          quote: '',
          confidence: osp.confidence,
          evidence_strength: osp.evidence_strength || (refs.length >= 2 ? 'strong' : 'single'),
          source_refs: refs,
          claim_nature: osp.claim_nature
        });
      }
    }

    const cons = verifiedPain.map(p => ({
      point: p.point,
      aspect: p.aspect,
      root_cause: p.root_cause,
      mentions: p.mentions,
      quote: p.quote,
      confidence: p.confidence,
      evidence_strength: p.evidence_strength,
      source_refs: p.source_refs
    }));

    return {
      verified: {
        identity,
        praise_points: verifiedPraise,
        pain_points: verifiedPain,
        verbatim: (packs.a2?.verbatim || []).filter(v => (v.source_refs || []).length > 0),
        scenarios: packs.a2?.scenarios || [],
        competitors,
        differentiation: packs.a3?.differentiation || { our_opening: [], crowded_points: [], weakness_openings: [] }
      },
      pros,
      cons,
      verification_report: report,
      gaps: [
        ...(packs.a1?.gaps || []).map(g => `[A1] ${g}`),
        ...(packs.a2?.gaps || []).map(g => `[A2] ${g}`),
        ...(packs.a3?.gaps || []).map(g => `[A3] ${g}`),
        ...report.purged.map(p => `[A4清洗] ${p}`)
      ]
    };
  }
}

module.exports = { CrossVerifier };
