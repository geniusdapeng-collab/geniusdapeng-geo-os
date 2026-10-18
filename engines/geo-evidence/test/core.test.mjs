import test from "node:test";
import assert from "node:assert/strict";
import {
  FUTURE_FRONTDESK_CASE,
  analyzeAnswer,
  buildFutureFrontdeskQueries,
  computeMetrics,
  parseCitations,
} from "../lib/core.mjs";

test("future front desk case builds exactly 100 unique queries", () => {
  const queries = buildFutureFrontdeskQueries();
  assert.equal(queries.length, 100);
  assert.equal(new Set(queries.map((query) => query.id)).size, 100);
  assert.equal(new Set(queries.map((query) => query.text)).size, 100);
  assert.deepEqual(
    Object.fromEntries([...new Set(queries.map((query) => query.category))]
      .map((category) => [category, queries.filter((query) => query.category === category).length])),
    { brand: 20, category: 25, scene: 25, compare: 15, risk: 15 },
  );
});

test("ambiguous short brand alias is not counted without context", () => {
  const query = { id: "q1", text: "酒店未来会怎么发展", category: "scene" };
  const result = analyzeAnswer(query, "未来前台将更加智能化。", FUTURE_FRONTDESK_CASE);
  assert.equal(result.brandMentioned, false);
  assert.equal(result.ambiguousMentions.length, 1);
});

test("full brand name negative claim is attributed to brand", () => {
  const query = { id: "q2", text: "苏州未来前台酒店自助机怎么样", category: "brand" };
  const result = analyzeAnswer(
    query,
    "苏州未来前台的酒店自助机被反馈卡顿，售后响应慢。",
    FUTURE_FRONTDESK_CASE,
  );
  assert.equal(result.brandMentioned, true);
  assert.equal(result.brandNegative, true);
  assert.equal(result.industryNegative, false);
});

test("generic industry negative does not become brand negative", () => {
  const query = { id: "q3", text: "酒店自助机不好用怎么办", category: "risk" };
  const result = analyzeAnswer(
    query,
    "酒店自助机不好用通常来自网络、证件识别、房卡写入或售后问题。采购前应现场验证。",
    FUTURE_FRONTDESK_CASE,
  );
  assert.equal(result.brandMentioned, false);
  assert.equal(result.brandNegative, false);
  assert.equal(result.industryNegative, true);
});

test("uncertainty or absence of complaint evidence is not brand negative", () => {
  const query = { id: "q4", text: "苏州未来前台售后投诉多吗", category: "risk" };
  const result = analyzeAnswer(
    query,
    "目前无法根据现有信息判断苏州未来前台售后投诉是否多。可核验资料中没有投诉数量、投诉率或处理情况统计，不能作为它的投诉证据。",
    FUTURE_FRONTDESK_CASE,
  );
  assert.equal(result.brandMentioned, true);
  assert.equal(result.brandNegative, false);
  assert.equal(result.sentiment, "neutral");
});

test("missing reliability evidence is not treated as a direct negative claim", () => {
  const query = { id: "q5", text: "苏州未来前台酒店自助机怎么样", category: "brand" };
  const result = analyzeAnswer(
    query,
    "苏州未来前台的公开信息缺少独立测评、价格、故障率、售后和真实住客反馈，所以不能简单下结论说很好或不好。",
    FUTURE_FRONTDESK_CASE,
  );
  assert.equal(result.brandMentioned, true);
  assert.equal(result.brandNegative, false);
});

test("citation parser extracts markdown and bare domains", () => {
  const citations = parseCitations(
    "参考 [官方资料](https://www.example.com/a) 和 https://docs.example.com/b。",
  );
  assert.equal(citations.length, 2);
  assert.deepEqual(citations.map((citation) => citation.domain), ["www.example.com", "docs.example.com"]);
});

test("metrics use successful samples and brand-mentioned denominator for negative rate", () => {
  const rows = [
    {
      status: "success",
      evidenceHash: "a",
      analysis: { brandMentioned: true, brandNegative: true, firstRecommendation: true, citations: [{}], ownedCitations: [] },
    },
    {
      status: "success",
      evidenceHash: "b",
      analysis: { brandMentioned: true, brandNegative: false, firstRecommendation: false, citations: [], ownedCitations: [] },
    },
    {
      status: "success",
      evidenceHash: "c",
      analysis: { brandMentioned: false, brandNegative: false, firstRecommendation: false, citations: [{}], ownedCitations: [] },
    },
    { status: "failed", analysis: {}, evidenceHash: null },
  ];
  const metrics = computeMetrics(rows);
  assert.equal(metrics.successRate, 0.75);
  assert.equal(metrics.evidenceCoverageRate, 1);
  assert.equal(metrics.mentionRate, 2 / 3);
  assert.equal(metrics.brandNegativeMentionRate, 0.5);
  assert.equal(metrics.negativeExposureRate, 1 / 3);
  assert.equal(metrics.firstRecommendationRate, 1 / 3);
});
