import { describe, expect, it } from "vitest";
import {
  applyRouteToMetadata,
  buildPipelineIntent,
  describeRouteDecision,
  productFromMetadata,
  productFromText,
  routeVideoPipeline,
  scoreRoute,
  stripRoutingDirective,
} from "./pipeline-router.js";

/**
 * T-2026-0925-0002：自动化分流矩阵。
 *
 * 断言口径（对应产品所有者要求「不确定就主动问，别花钱做用户不想要的片子」）：
 *   - 显式声明 / 强线索 → 直接判定，不问；
 *   - 只有弱线索、或干脆没有线索 → **必须** 落到 clarify；
 *   - 判定营销片但缺商品名 → **必须** 落到 clarify（情报五站以商品为锚）；
 *   - 叙事判定不得残留 `dataMining`（否则情报层会被 vendor 误触发）。
 */
describe("视频管线自动化分流", () => {
  it("用户显式声明营销片 + 商品名 → 营销片，直接开工", async () => {
    const d = await routeVideoPipeline({ text: "走营销片，商品名：星野空气循环扇，突出静音卖点" });
    expect(d.route).toBe("marketing");
    expect(d.product?.name).toBe("星野空气循环扇");
    expect(d.product?.source).toBe("text");
    expect(d.via).toBe("rule");
    expect(d.clarify).toBeUndefined();
  });

  it("用户显式声明叙事片 → 通用管线", async () => {
    const d = await routeVideoPipeline({ text: "走叙事片，拍一条苏州平江路的清晨故事" });
    expect(d.route).toBe("narrative");
    expect(d.confidence).toBeGreaterThan(0.9);
  });

  it("「给X做一条种草视频」→ 营销片 + 从原文取到商品名", async () => {
    const d = await routeVideoPipeline({ text: "给三顿半做一条抖音种草视频，突出冷萃口感" });
    expect(d.route).toBe("marketing");
    expect(d.product?.name).toBe("三顿半");
  });

  it("强营销线索但没给商品名 → 澄清（缺商品锚点），不猜商品", async () => {
    const d = await routeVideoPipeline({ text: "做一条带货视频，走小红书，要能下单转化" });
    expect(d.route).toBe("clarify");
    expect(d.clarify?.missing).toEqual(["product"]);
    expect(d.clarify?.question).toContain("商品名");
    expect(d.product).toBeUndefined();
  });

  it("题材清晰的叙事需求 → 通用管线（不触发情报层）", async () => {
    const d = await routeVideoPipeline({ text: "拍一条关于苏州平江路的城市人文短片，讲讲桥和船的故事" });
    expect(d.route).toBe("narrative");
    expect(d.signals.narrative.length).toBeGreaterThan(0);
  });

  it("信息不足（「帮我做个视频」）→ 澄清路由，而不是默认营销片", async () => {
    const d = await routeVideoPipeline({ text: "帮我做个视频" });
    expect(d.route).toBe("clarify");
    expect(d.clarify?.missing).toEqual(["route"]);
    expect(d.clarify?.question).toContain("走营销片");
  });

  it("metadata 带商品锚点 + 意图含糊 → 按营销片立项（要卖东西是硬信号）", async () => {
    const d = await routeVideoPipeline({
      text: "做一条 30 秒的片子",
      metadata: { dataMining: { name: "星野空气循环扇", brand: "星野" } },
    });
    expect(d.route).toBe("marketing");
    expect(d.product?.name).toBe("星野空气循环扇");
    expect(d.product?.brand).toBe("星野");
    expect(d.product?.source).toBe("metadata");
  });

  it("显式叙事优先于 metadata 商品锚点（用户口径最大）", async () => {
    const d = await routeVideoPipeline({
      text: "走叙事片，别做广告",
      metadata: { brief: { product: "星野空气循环扇" } },
    });
    expect(d.route).toBe("narrative");
  });

  it("调用方显式指定 kind（补跑）→ 不重复询问，直接沿用", async () => {
    const d = await routeVideoPipeline({ text: "随便什么", explicit: "narrative" }, {});
    expect(d.route).toBe("narrative");
    expect(d.via).toBe("metadata");
  });

  it("LLM 仲裁：规则摇摆时可采纳（带商品名，不需要再澄清）", async () => {
    const d = await routeVideoPipeline(
      { text: "围绕我们的服务做条片子" },
      { llmCall: async () => JSON.stringify({ route: "marketing", confidence: 0.82, product: { name: "星野安装服务", category: "本地生活" }, rationale: "服务推广属营销片" }) },
    );
    expect(d.route).toBe("marketing");
    expect(d.via).toBe("llm");
    expect(d.product?.name).toBe("星野安装服务");
    expect(d.product?.source).toBe("llm");
  });

  it("LLM 仲裁：判 marketing 但不给商品 → 仍要澄清商品名", async () => {
    const d = await routeVideoPipeline(
      { text: "围绕我们的服务做条片子" },
      { llmCall: async () => JSON.stringify({ route: "marketing", confidence: 0.9, product: null, rationale: "服务推广" }) },
    );
    expect(d.route).toBe("clarify");
    expect(d.clarify?.missing).toEqual(["product"]);
  });

  it("LLM 仲裁超时/异常 → 不升级为营销片，落回澄清", async () => {
    const d = await routeVideoPipeline(
      { text: "围绕我们的服务做条片子" },
      { llmCall: async () => { throw new Error("boom"); } },
    );
    expect(d.route).toBe("clarify");
  });

  it("LLM 仲裁输出非法 JSON → 落回澄清（不静默采信）", async () => {
    const d = await routeVideoPipeline(
      { text: "围绕我们的服务做条片子" },
      { llmCall: async () => "我觉得是营销片吧" },
    );
    expect(d.route).toBe("clarify");
  });

  it("营销判定写入 metadata.dataMining（激活 vendor Layer -2 的数据契约）", async () => {
    const d = await routeVideoPipeline({ text: "走营销片，商品名：星野空气循环扇", metadata: { keep: 1 } });
    const md = applyRouteToMetadata({ keep: 1, brief: { audience: "租房年轻人" } }, d);
    expect(md.keep).toBe(1);
    expect(md.dataMining).toMatchObject({ name: "星野空气循环扇" });
    expect((md.brief as Record<string, unknown>).product).toBe("星野空气循环扇");
    expect((md.brief as Record<string, unknown>).audience).toBe("租房年轻人");
    expect(md.pipelineRoute).toMatchObject({ kind: "marketing" });
  });

  it("叙事判定显式清除 dataMining / brief.product（防情报层误触发）", async () => {
    const d = await routeVideoPipeline({ text: "走叙事片，讲讲这座桥" });
    const md = applyRouteToMetadata(
      { dataMining: { name: "星野空气循环扇" }, brief: { product: "星野空气循环扇", duration: 30 } },
      d,
    );
    expect(md.dataMining).toBeUndefined();
    expect((md.brief as Record<string, unknown>).product).toBeUndefined();
    expect((md.brief as Record<string, unknown>).duration).toBe(30);
    expect(md.pipelineRoute).toMatchObject({ kind: "narrative" });
  });

  it("否定营销表述不误判（「不要营销腔」）", async () => {
    const verdict = scoreRoute("做一条记录苏州河日常的短片，不要营销腔");
    expect(verdict.marketingSignals).toContain("否定营销表述");
    expect(verdict.marketingScore).toBeLessThanOrEqual(verdict.narrativeScore);
  });

  it("商品名抽取只认显式声明（不做词频猜测）", () => {
    expect(productFromText("商品名：星野空气循环扇")?.name).toBe("星野空气循环扇");
    expect(productFromText("给三顿半拍一条开箱")?.name).toBe("三顿半");
    expect(productFromText("拍一条关于咖啡的视频")).toBeUndefined();
  });

  it("metadata 商品锚点支持三种登记口径", () => {
    expect(productFromMetadata({ dataMining: { name: "A" } })?.name).toBe("A");
    expect(productFromMetadata({ brief: { product: "B", brand: { name: "B牌" } } })?.brand).toBe("B牌");
    expect(productFromMetadata({ products: [{ name: "C" }] })?.name).toBe("C");
  });

  it("决策摘要可读（写事件/回执共用）", async () => {
    const marketing = await routeVideoPipeline({ text: "走营销片，商品名：星野空气循环扇" });
    expect(describeRouteDecision(marketing)).toContain("营销片管线");
    const clarify = await routeVideoPipeline({ text: "帮我做个视频" });
    expect(describeRouteDecision(clarify)).toContain("待澄清");
  });

  it("分流指令不进入创作意图（真机：主题被解析成「走营销片」质量 0/5）", () => {
    expect(stripRoutingDirective("走营销片：给米家空气净化器 4 Lite 做一条抖音种草视频"))
      .toBe("给米家空气净化器 4 Lite 做一条抖音种草视频");
    expect(stripRoutingDirective("帮我按营销管线做一条带货视频"))
      .toBe("做一条带货视频");
    expect(stripRoutingDirective("拍一条关于苏州平江路的短片")).toBe("拍一条关于苏州平江路的短片");
  });

  it("需求口径块：时长/画幅/平台写进意图，供生成器与 G2 监制核对", () => {
    const intent = buildPipelineIntent("走营销片：给米家空气净化器 4 Lite 做一条抖音种草视频", {
      durationSec: 30, aspectRatio: "9:16", platform: "抖音", goal: "种草",
    });
    expect(intent).toContain("给米家空气净化器 4 Lite 做一条抖音种草视频");
    expect(intent).toContain("[需求口径]");
    expect(intent).toContain("时长：30秒");
    expect(intent).toContain("画幅：9:16");
    expect(intent).not.toContain("走营销片");
  });

  /* ================= T-2026-0926-0008：第三条线（口播解说片） ================= */

  it("显式声明「走口播片」→ explainer（不跑情报、不问商品）", async () => {
    const decision = await routeVideoPipeline({ text: "走口播片：给我们的获客系统做一条讲解视频" });
    expect(decision.route).toBe("explainer");
    expect(decision.via).toBe("rule");
    expect(decision.clarify).toBeUndefined();
  });

  it("口播/讲解线索严格领先 → explainer；卖货线索仍走 marketing", async () => {
    const explainer = await routeVideoPipeline({ text: "做一条口播解说，讲清我们这套获客系统怎么跑闭环" });
    expect(explainer.route).toBe("explainer");
    expect(explainer.signals.explainer.length).toBeGreaterThan(0);

    const marketing = await routeVideoPipeline({ text: "给米家空气净化器做一条抖音种草带货视频，突出卖点" });
    expect(marketing.route).toBe("marketing");
  });

  it("口播线索与商品线索并存且不领先 → 不擅自换线（回到既有判定/澄清）", async () => {
    // "讲解 + 商品" 双信号：口播分不严格领先 → 不应被判成 explainer
    const decision = await routeVideoPipeline({ text: "给这款筋膜枪做一条讲解视频，突出静音和便携" });
    expect(decision.route).not.toBe("explainer");
  });

  it("澄清话术含第三条线的选项（用户能自己说「走口播片」）", async () => {
    const decision = await routeVideoPipeline({ text: "帮我做个视频" });
    expect(decision.route).toBe("clarify");
    expect(decision.clarify?.question).toContain("口播解说片");
    expect(decision.clarify?.question).toContain("走口播片");
  });
});

describe("MC-012 explicit negative route declarations", () => {
  const names = { marketing: "营销片", narrative: "通用管线", explainer: "解说管线" } as const;
  const pairs = [
    { denied: "marketing", chosen: "narrative" }, { denied: "marketing", chosen: "explainer" },
    { denied: "narrative", chosen: "marketing" }, { denied: "narrative", chosen: "explainer" },
    { denied: "explainer", chosen: "marketing" }, { denied: "explainer", chosen: "narrative" },
  ] as const;
  const metadata = { dataMining: { name: "测试商品" }, brief: { product: "测试商品", duration: 30 } };

  it.each(pairs.flatMap(pair => [false, true].map(reverse => ({ ...pair, reverse }))))(
    "resolves denied=$denied chosen=$chosen reverse=$reverse and applies the actual product activation boundary",
    async ({ denied, chosen, reverse }) => {
      const clauses = [`不要${names[denied]}`, `走${names[chosen]}`];
      const text = (reverse ? clauses.reverse() : clauses).join("，");
      const decision = await routeVideoPipeline({ text, metadata });
      expect(decision.route).toBe(chosen);
      const routed = applyRouteToMetadata(metadata, decision);
      expect(routed.pipelineRoute).toMatchObject({ kind: chosen });
      if (chosen === "marketing") expect(routed.dataMining).toMatchObject({ name: "测试商品" });
      else {
        expect(routed.dataMining).toBeUndefined();
        expect((routed.brief as Record<string, unknown>).product).toBeUndefined();
      }
      expect(metadata.dataMining.name).toBe("测试商品");
    },
  );

  it.each([
    { text: "不要营销片", denied: "marketing" },
    { text: "不要走通用管线", denied: "narrative" },
    { text: "别用解说管线", denied: "explainer" },
    { text: "不使用营销管线，产品品牌推广投放带货", denied: "marketing" },
    { text: "不需要口播解说，科普教程逐字字幕同步", denied: "explainer" },
  ])("never restores the excluded $denied route through keywords or product metadata", async ({ text, denied }) => {
    const decision = await routeVideoPipeline({ text, metadata });
    expect(decision.route).not.toBe(denied);
    if (denied === "marketing") {
      expect(decision.route).toBe("clarify");
      expect(decision.clarify?.options.some(option => option.key === "marketing")).toBe(false);
    }
  });

  it("rejects a model arbitration result that contradicts an explicit route exclusion", async () => {
    const decision = await routeVideoPipeline({ text: "不要营销片，围绕未来做个视频" }, {
      llmCall: async () => JSON.stringify({ route: "marketing", confidence: 0.99, product: { name: "模型产品" }, rationale: "模拟分类" }),
    });
    expect(decision.route).toBe("clarify");
    expect(decision.product).toBeUndefined();
  });

  it.each(["marketing", "narrative", "explainer"] as const)("retains the caller's explicit %s override for a confirmed historical project", async explicit => {
    const decision = await routeVideoPipeline({ text: `不要${names[explicit]}`, metadata, explicit });
    expect(decision.route).toBe(explicit);
    expect(decision.via).toBe("metadata");
  });

  it.each(["marketing", "narrative", "explainer"] as const)("keeps a positive explicit %s declaration unchanged", async route => {
    const decision = await routeVideoPipeline({ text: `走${names[route]}`, metadata });
    expect(decision.route).toBe(route);
    expect(decision.via).toBe("rule");
  });
});

describe("MC-013 dispatched video duration defaults", () => {
  it("adds the dispatch default only when the customer gave no duration expression", () => {
    const intent = buildPipelineIntent("走叙事片：拍一条山间日出的故事", {
      defaultDurationSec: 30, platform: "抖音",
    });
    expect(intent).toContain("拍一条山间日出的故事");
    expect(intent).toContain("[需求口径] 时长：30秒；平台：抖音");
  });

  it.each([
    "拍一条60秒的山间日出故事", "拍一条 60 秒的山间日出故事", "拍一条1分钟的故事",
    "拍一条一分钟的故事", "拍一条一分半钟的故事", "拍一条半分钟的故事",
    "Create a 60-second story", "Create a 1 minute story", "Create a 60s story", "Create a 1min story",
    "Create a one-minute story", "Create a ninety second story", "Create a half-hour story",
    "Create a one and a half minute story", "Create a story lasting an hour",
    "时长：0秒，拍日出故事", "时长：-30秒，拍日出故事", "时长：未定，拍日出故事",
    "拍日出故事，60秒或90秒", "每镜5秒，拍日出故事", "片长不限，拍日出故事",
  ])("preserves the original duration expression without inventing a total for %s", text => {
    const intent = buildPipelineIntent(text, { defaultDurationSec: 30, platform: "抖音" });
    expect(intent).toBe(`${text}\n[需求口径] 平台：抖音`);
  });

  it("keeps the existing explicitly structured duration contract", () => {
    const intent = buildPipelineIntent("拍一条山间日出故事", {
      durationSec: 60, defaultDurationSec: 30, platform: "抖音",
    });
    expect(intent).toContain("[需求口径] 时长：60秒；平台：抖音");
    expect(intent).not.toContain("时长：30秒");
  });
});

describe("MC-012 common local negation grammar", () => {
  const names = { marketing: "营销片", narrative: "通用管线", explainer: "解说管线" } as const;
  const metadata = { dataMining: { name: "测试商品" }, brief: { product: "测试商品", duration: 30 } };
  const pairs = [
    { denied: "marketing", chosen: "narrative" }, { denied: "marketing", chosen: "explainer" },
    { denied: "narrative", chosen: "marketing" }, { denied: "narrative", chosen: "explainer" },
    { denied: "explainer", chosen: "marketing" }, { denied: "explainer", chosen: "narrative" },
  ] as const;
  it.each(pairs.flatMap(pair => ["别选", "不要选", "就不做了"].flatMap(grammar => [false, true].map(reverse => ({ ...pair, grammar, reverse })))))(
    "handles $grammar for denied=$denied chosen=$chosen reverse=$reverse at actual activation boundaries",
    async ({ denied, chosen, grammar, reverse }) => {
      const negative = grammar === "就不做了" ? `${names[denied]}${grammar}` : `${grammar}${names[denied]}`;
      const clauses = [negative, `走${names[chosen]}`];
      const decision = await routeVideoPipeline({ text: (reverse ? clauses.reverse() : clauses).join("，"), metadata });
      expect(decision.route).toBe(chosen);
      const applied = applyRouteToMetadata(metadata, decision);
      expect(applied.pipelineRoute).toMatchObject({ kind: chosen });
      expect(applied.dataMining).toEqual(chosen === "marketing" ? { name: "测试商品" } : undefined);
    },
  );

  it.each(["别选营销片，但又走营销片", "走营销片，营销片就不做了"])("clarifies a contradictory local route request: %s", async text => {
    const decision = await routeVideoPipeline({ text, metadata });
    expect(decision.route).toBe("clarify");
    expect(decision.clarify?.missing).toEqual(["route"]);
  });
});

it("MC-012 describes an explainer decision with the actual third-pipeline label", async () => {
  const decision = await routeVideoPipeline({ text: "走解说管线，讲解天文知识" });
  expect(decision.route).toBe("explainer");
  expect(describeRouteDecision(decision)).toContain("口播解说片管线");
  expect(describeRouteDecision(decision)).not.toContain("叙事片管线");
});

it("MC-012 offers every route named in the route clarification question", async () => {
  const decision = await routeVideoPipeline({ text: "帮我做个视频" });
  expect(decision.route).toBe("clarify");
  expect(decision.clarify?.question).toContain("口播解说片");
  expect(decision.clarify?.options.map(option => option.key)).toEqual(["marketing", "narrative", "explainer"]);
});

describe("MC-012 finite local negation and modal grammar", () => {
  const names = { marketing: "营销片", narrative: "通用管线", explainer: "解说管线" } as const;
  const metadata = { dataMining: { name: "测试商品" }, brief: { product: "测试商品" } };
  const pairs = [
    { denied: "marketing", chosen: "narrative" }, { denied: "marketing", chosen: "explainer" },
    { denied: "narrative", chosen: "marketing" }, { denied: "narrative", chosen: "explainer" },
    { denied: "explainer", chosen: "marketing" }, { denied: "explainer", chosen: "narrative" },
  ] as const;
  const modalActions = ["不想走", "不希望用", "不愿意做", "不打算选择", "不准备跑", "不考虑使用", "没打算走", "没有计划用", "无意采用"];
  it.each(pairs.flatMap(pair => modalActions.flatMap(modal => [false, true].map(reverse => ({ ...pair, modal, reverse })))))(
    "handles $modal denied=$denied chosen=$chosen reverse=$reverse without activating an excluded pipeline",
    async ({ denied, chosen, modal, reverse }) => {
      const clauses = [`${modal}${names[denied]}`, `走${names[chosen]}`];
      const decision = await routeVideoPipeline({ text: (reverse ? clauses.reverse() : clauses).join("，"), metadata });
      expect(decision.route).toBe(chosen);
      const applied = applyRouteToMetadata(metadata, decision);
      expect(applied.pipelineRoute).toMatchObject({ kind: chosen });
      expect(applied.dataMining).toEqual(chosen === "marketing" ? { name: "测试商品" } : undefined);
    },
  );

  it.each(["marketing", "narrative", "explainer"] as const)("clarifies double negation around %s rather than inferring a paid route", async route => {
    for (const prefix of ["不是不想走", "不要不走", "并非不希望用"]) {
      const decision = await routeVideoPipeline({ text: `${prefix}${names[route]}`, metadata });
      expect(decision.route).toBe("clarify");
      expect(decision.clarify?.missing).toEqual(["route"]);
    }
  });

  it.each(["不乐意尝试营销片", "没兴趣选营销片", "无意愿做营销片"])("does not use a product anchor to override a locally negative but unsupported phrasing: %s", async text => {
    const decision = await routeVideoPipeline({ text, metadata });
    expect(decision.route).toBe("clarify");
  });
});

describe("MC-012 bounded postposed and coordinated exclusions", () => {
  const metadata = { dataMining: { name: "测试商品" }, brief: { product: "测试商品" } };
  const names = { marketing: "营销片", narrative: "通用管线", explainer: "解说管线" } as const;
  it.each([
    "禁止走营销片", "禁用营销片", "无兴致选择营销片", "非营销片",
    "营销片不想走了", "营销片不希望使用", "营销片不考虑采用",
  ])("honors clear local negative declaration: %s", async negative => {
    expect((await routeVideoPipeline({ text: `${negative}，走通用管线`, metadata })).route).toBe("narrative");
  });

  it.each(["营销片不是不能走", "不是不走营销片，走通用管线"])("clarifies ambiguous double negatives including postposed forms: %s", async text => {
    expect((await routeVideoPipeline({ text, metadata })).route).toBe("clarify");
  });

  it.each(["营销片不要用旁白", "营销片不需要配音"])("does not interpret an in-film audio restriction as a route exclusion: %s", async requirement => {
    expect((await routeVideoPipeline({ text: `${requirement}，走营销片`, metadata })).route).toBe("marketing");
  });

  const groups = [
    { denied: ["marketing", "narrative"], chosen: "explainer" },
    { denied: ["marketing", "explainer"], chosen: "narrative" },
    { denied: ["narrative", "explainer"], chosen: "marketing" },
  ] as const;
  const coordinatedCases = groups.flatMap(group =>
    ["和", "及", "、"].flatMap(joiner =>
      ["都不要", "均不用"].flatMap(negative =>
        [false, true].map(reverse => ({ ...group, joiner, negative, reverse })))));
  it.each(coordinatedCases)(
    "excludes the whole $denied group with $joiner/$negative before choosing $chosen reverse=$reverse",
    async ({ denied, chosen, joiner, negative, reverse }) => {
      const clauses = [`${names[denied[0]]}${joiner}${names[denied[1]]}${negative}`, `走${names[chosen]}`];
      const decision = await routeVideoPipeline({ text: (reverse ? clauses.reverse() : clauses).join("，"), metadata });
      expect(decision.route).toBe(chosen);
      const projected = applyRouteToMetadata(metadata, decision);
      expect(projected.pipelineRoute).toMatchObject({ kind: chosen });
      expect(projected.dataMining).toEqual(chosen === "marketing" ? { name: "测试商品" } : undefined);
    },
  );
});
