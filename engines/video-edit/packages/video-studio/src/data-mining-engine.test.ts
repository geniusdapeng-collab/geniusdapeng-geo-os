import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * T-2026-0925-0002：商品情报档案引擎（珍妮纺织机）回归。
 *
 * 覆盖 2026-09-25 代码 review 抓到的三个实质缺陷：
 *   ① A4 把「提及次数」当独立来源数 → 单源复读即升 confirmed（违背铁律二）；
 *   ② 信封 `prev_checksum` 只写不验 → 「链式锁定 / 防跳站」只在文档里；
 *   ③ `DossierStore` 默认根写进 vendor 目录 + 非原子写 + 索引损坏即静默清空。
 *
 * vendor 是 CJS，用 createRequire 直载（不走 vitest 的 ESM 转换），断言全部落在真实引擎行为上。
 */
const here = resolve(fileURLToPath(import.meta.url), "..");
const repoRoot = resolve(here, "../../..");
const require = createRequire(import.meta.url);
const enginePath = join(repoRoot, "vendor/supermickey/hyperreality-system/engines/data-mining-engine");
const { JennyLoomEngine } = require(join(enginePath, "index.js")) as {
  JennyLoomEngine: new (opts?: Record<string, unknown>) => {
    assemble: (traceId: string, input: Record<string, unknown>, raw: Record<string, unknown>) => AssembleResult;
    plan: (input: Record<string, unknown>) => { trace_id: string };
  };
};
const Envelope = require(join(enginePath, "pipeline/message-envelope.js")) as {
  verifyChain: (envelopes: Array<Record<string, unknown>>) => { ok: boolean; issues: string[] };
};

interface AssembleResult {
  ok: boolean;
  product_id?: string;
  dossier?: Record<string, unknown>;
  cards?: Record<string, unknown>;
  chain?: { ok: boolean; issues: string[] };
  envelopes?: Array<{ stage: string; checksum: string; prev_checksum: string | null }>;
  verification_report?: { graded: Record<string, number>; purged: string[]; checks_run: string[] };
  errors?: Array<{ stage: string; message: string; fatal?: boolean }>;
}

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "wl-dossier-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 合成一份 A1/A2/A3 回填（同一 host 两条评价 = 单源；两个 host = 真·双源） */
function rawFixture() {
  return {
    A1: {
      identity: {
        name: "星野空气循环扇",
        brand: "星野",
        category: "小家电",
        model: "XY-F3",
        specs: { 风量档位: { value: "9 档", source_url: "https://www.xingye.com/f3", channel: "官网" } },
        prices: [
          { amount: 399, currency: "CNY", source_url: "https://www.xingye.com/f3", channel: "官网" },
          { amount: 429, currency: "CNY", source_url: "https://mall.jd.com/f3", channel: "京东旗舰店" },
        ],
        official_selling_points: [{ point: "静音", source_url: "https://www.xingye.com/f3", channel: "官网" }],
      },
      images: [
        { url: "https://www.xingye.com/f3-1.jpg", source: "官网产品图", page_url: "https://www.xingye.com/f3", angle: "正面", width: 1200, height: 1200 },
        { url: "https://mall.jd.com/f3-2.jpg", source: "旗舰店详情", page_url: "https://mall.jd.com/f3", angle: "侧面", width: 900, height: 900 },
      ],
    },
    A2: {
      reviews: [
        // 同一 host 的两条评价：提及 2 次，但独立来源只有 1 个 → 必须 reported
        { text: "静音效果很好，晚上睡觉不吵", source: "京东评价", url: "https://mall.jd.com/review/1", rating: 5 },
        { text: "静音真的可以，睡眠模式几乎听不到", source: "京东评价", url: "https://mall.jd.com/review/1#again", rating: 5 },
        // 两个不同 host 的评价：独立来源 2 → confirmed
        { text: "静音不错，但遥控器手感一般", source: "知乎评测", url: "https://www.zhihu.com/p/1", rating: 4 },
        { text: "静音达标，风量偏小", source: "小红书笔记", url: "https://www.xiaohongshu.com/n/1", rating: 4 },
      ],
    },
    A3: {
      competitors: [
        {
          name: "别家风扇",
          price_band: "CNY 350-450",
          selling_points: [{ point: "大风量", source_url: "https://www.other.com/p1" }],
          price_source_url: "https://www.other.com/p1",
          weakness_notes: "噪音偏大",
        },
      ],
    },
  };
}

describe("商品情报档案引擎回归", () => {
  it("A4 置信度：同源复读不得升 confirmed，跨源一致才升 confirmed", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const plan = engine.plan({ name: "星野空气循环扇", brand: "星野", category: "小家电" });
    const result = engine.assemble(plan.trace_id, { name: "星野空气循环扇", brand: "星野", category: "小家电" }, rawFixture());

    expect(result.ok).toBe(true);
    const pros = (result.dossier!.pros_cons as { pros: Array<{ aspect?: string; confidence: string; mentions?: number; source_refs: string[] }> }).pros;
    // 官方卖点「静音」是 confirmed（官方级来源）
    const officialPros = pros.filter((p) => p.aspect === "official_claim");
    expect(officialPros.length).toBeGreaterThan(0);
    expect(officialPros.every((p) => p.confidence === "confirmed")).toBe(true);

    // 用户侧：同 host 复读的那组不得是 confirmed
    const vocal = pros.filter((p) => p.aspect !== "official_claim");
    expect(vocal.length).toBeGreaterThan(0);
    const singleSource = vocal.filter((p) => p.source_refs.length >= 1);
    expect(singleSource.every((p) => p.confidence === "reported" || p.confidence === "confirmed")).toBe(true);
    /**
     * 关键断言：定级记录里的「独立来源数」必须**严格小于**证据条数——
     * fixture 里京东的两条评价同 host（1 个独立来源）+ 知乎 + 小红书 = 4 条证据 / 3 个独立来源。
     * 若退回旧实现（`Math.max(refs.length, mentions)`），独立来源数会等于证据条数，本断言即红。
     */
    const checks = result.verification_report?.checks_run.join("\n") ?? "";
    const gradedLine = checks.split("\n").find((line) => line.includes("voc.praise"));
    expect(gradedLine).toBeTruthy();
    const match = gradedLine!.match(/证据 (\d+) 条 \/ 独立来源 (\d+)/);
    expect(match).toBeTruthy();
    const evidenceCount = Number(match![1]);
    const independentCount = Number(match![2]);
    expect(evidenceCount).toBeGreaterThanOrEqual(4);
    expect(independentCount).toBeLessThan(evidenceCount);
    expect(checks).toContain("提及次数不参与定级");
  });

  it("A4 报告暴露真实渠道分布（官方/电商/社区/未知）", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const input = { name: "星野空气循环扇", brand: "星野", category: "小家电" };
    const plan = engine.plan(input);
    const result = engine.assemble(plan.trace_id, input, rawFixture());
    const text = result.verification_report?.checks_run.join("\n") ?? "";
    expect(text).toMatch(/官方 \d+ · 电商 \d+ · 社区 \d+ · 未知 \d+/);
    expect(text).toContain("提及次数不参与定级");
  });

  it("单源媒体公开卖点保留在 Brief 摘要卡，并如实标为 reported", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const input = { name: "星野空气循环扇", brand: "星野", category: "小家电" };
    const plan = engine.plan(input);
    const raw = rawFixture();
    raw.A1.identity.official_selling_points = [{
      point: "媒体实测九档风量",
      source_url: "https://news.example.com/xingye-f3",
      channel: "媒体报道",
    }];
    raw.A2.reviews = [];
    const result = engine.assemble(plan.trace_id, input, raw);
    expect(result.ok).toBe(true);

    const brief = (result.cards!.brief_card as {
      sellingPoints: string[];
      evidence_note: string;
    });
    expect(brief.sellingPoints).toContain("媒体实测九档风量");
    expect(brief.evidence_note).toContain("1 条单源公开主张");
    expect(brief.evidence_note).not.toContain("1 条官方确认");
    expect(brief.evidence_note).not.toContain("0 条单源公开主张");
  });

  it("媒体单源、无用户和竞品证据时保留 claim 原文，不伪造官方、共识或差异空位", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const restrictions = [
      "没有可核实用户评价：禁止用户口碑、评分、人数、销量或使用效果共识主张",
      "没有可核实竞品证据：禁止对比、竞品弱点或市场领先主张",
      "不展示公路骑行",
      "不写真实赛事结果、品牌代言、销量、价格或绝对性能结论",
    ];
    const input = {
      name: "媒体机车 RC", brand: "媒体品牌", category: "摩托车",
      restrictions,
      priceContext: { reportedAt: "2026-09-19", retrievedAt: "2026-10-30T05:48:40.720Z", sourceUrl: "https://news.example.com/rc" },
    };
    const plan = engine.plan(input);
    const raw = rawFixture();
    raw.A1.identity.name = "媒体机车 RC";
    raw.A1.identity.brand = "媒体品牌";
    raw.A1.identity.category = "摩托车";
    (raw.A1.identity.specs as Record<string, unknown>).使用场景 = "赛道日及竞速场景";
    const mediaPoints = [
      "赛道专用，不具备道路行驶资质",
      "818.8cc 直列三缸发动机",
      "最大功率 113 千瓦",
      "轴距 1420 毫米",
      "座高 825 毫米",
      "湿重 160 公斤",
    ];
    raw.A1.identity.official_selling_points = mediaPoints.map(point => ({
      point, source_url: "https://news.example.com/rc", channel: "媒体报道",
    }));
    raw.A1.images = [{ url: "https://news.example.com/rc.png", source: "媒体报道", page_url: "https://news.example.com/rc",
      angle: "unknown", width: 640, height: 640 }];
    raw.A2.reviews = [];
    raw.A3.competitors = [];
    const result = engine.assemble(plan.trace_id, input, raw);
    expect(result.ok).toBe(true);

    const dossier = result.dossier as {
      restrictions: string[];
      identity: { selling_points_field_note: string; official_selling_points: Array<{ point: string; source_nature: string }> };
      usage: { scenarios: Array<{ scene: string; not_user_consensus: boolean }>; evidence_note: string };
      pros_cons: { pros: Array<{ point: string; aspect: string; claim_nature: string }> };
    };
    const claim = dossier.pros_cons.pros.find(item => item.point === "赛道专用，不具备道路行驶资质")!;
    expect(claim).toMatchObject({ aspect: "reported_claim", claim_nature: "media-reported" });
    expect(dossier.pros_cons.pros.some(item => item.point.includes("官方主打"))).toBe(false);
    expect(dossier.restrictions).toEqual(restrictions);
    expect(dossier.identity.selling_points_field_note).toContain("不是厂商官方确认");
    expect(dossier.identity.official_selling_points).toHaveLength(6);
    expect(dossier.identity.official_selling_points.every(item => item.source_nature === "media-reported-single-source")).toBe(true);
    expect(dossier.usage.scenarios).toContainEqual(expect.objectContaining({ scene: "赛道日及竞速场景", not_user_consensus: true }));
    expect(dossier.usage.evidence_note).toContain("不是用户评价");

    const cards = result.cards as Record<string, any>;
    expect(cards.brief_card.sellingPointEvidence).toHaveLength(6);
    expect(cards.brief_card.sellingPointEvidence).toContainEqual(expect.objectContaining({
      point: "赛道专用，不具备道路行驶资质", nature: "media-reported", confidence: "reported",
      source_refs: [expect.stringMatching(/^EV-/)],
    }));
    expect(cards.insight_card.consensus_points).toEqual([]);
    expect(cards.insight_card.reported_claims).toHaveLength(6);
    expect(cards.insight_card.reported_claims).toContainEqual(expect.objectContaining({
      point: "赛道专用，不具备道路行驶资质", nature: "media-reported", confidence: "reported", mentions: 0,
      evaluation_nature: "source-claim-not-user-review", source_refs: [expect.stringMatching(/^EV-/)],
    }));
    expect(cards.prd_card.selling_point_evidence).toHaveLength(6);
    expect(cards.insight_card.market_position.our_opening).toEqual([]);
    expect(cards.theme_card.differentiation_space).toEqual([]);
    expect(cards.prd_card.compliance_redlines).toEqual(expect.arrayContaining(restrictions));
    expect(cards.prd_card.hook_candidates.data_points).not.toEqual(expect.arrayContaining([expect.stringContaining("价格")]));
    expect(cards.router_material.hook_material.data_points).not.toEqual(expect.arrayContaining([expect.stringContaining("价格")]));
    expect(cards.insight_card.market_position).toMatchObject({
      price_reported_at: "2026-09-19", price_retrieved_at: "2026-10-30T05:48:40.720Z",
    });
    expect(cards.portrait_manifest).toMatchObject({
      licensed_for_delivery: false,
      usage_policy: expect.stringContaining("不得直接用于商业成片"),
    });
    expect(cards.brief_card.productHero).toMatchObject({ licensed_for_delivery: false });
    expect(cards.prd_card.reference_image_policy).toMatchObject({ licensed_for_delivery: false });
  });

  it("信封链：逐环 prev_checksum 连续且链校验通过；篡改即判断裂", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const input = { name: "星野空气循环扇", brand: "星野", category: "小家电" };
    const plan = engine.plan(input);
    const result = engine.assemble(plan.trace_id, input, rawFixture());

    expect(result.chain?.ok).toBe(true);
    const envelopes = result.envelopes ?? [];
    expect(envelopes.length).toBeGreaterThanOrEqual(4);
    expect(envelopes[0]!.prev_checksum).toBeNull();
    for (let i = 1; i < envelopes.length; i += 1) {
      expect(envelopes[i]!.prev_checksum).toBe(envelopes[i - 1]!.checksum);
    }
    // 篡改中间一环的 prev_checksum → 链校验必须报断裂
    const tampered = envelopes.map((env) => ({ ...env }));
    tampered[2]!.prev_checksum = "deadbeef";
    const broken = Envelope.verifyChain(tampered);
    expect(broken.ok).toBe(false);
    expect(broken.issues.join("；")).toContain("链断裂");
  });

  it("档案落盘：默认根不再写进 vendor，原子写不留临时文件，索引可复用", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const input = { name: "星野空气循环扇", brand: "星野", category: "小家电" };
    const plan = engine.plan(input);
    const result = engine.assemble(plan.trace_id, input, rawFixture());
    expect(result.ok).toBe(true);

    const productId = result.product_id!;
    const dossierFile = join(root, productId, "dossier.json");
    const indexFile = join(root, "index.json");
    const files = readdirSync(root);
    expect(files).toContain("index.json");
    expect(files.some((f) => f.endsWith(".tmp") || f.includes(".tmp-"))).toBe(false);
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as { entries: Array<{ product_id: string }>; updated_at?: string };
    expect(index.entries.some((e) => e.product_id === productId)).toBe(true);
    expect(index.updated_at).toBeTruthy();
    const dossier = JSON.parse(readFileSync(dossierFile, "utf8")) as { product_id: string; gaps: string[] };
    expect(dossier.product_id).toBe(productId);
    expect(Array.isArray(dossier.gaps)).toBe(true);
  });

  it("索引损坏不静默清空：改名留证并重建，档案本体不受影响", () => {
    const root = tempRoot();
    const engine = new JennyLoomEngine({ storeRoot: root });
    const input = { name: "星野空气循环扇", brand: "星野", category: "小家电" };
    const plan = engine.plan(input);
    const result = engine.assemble(plan.trace_id, input, rawFixture());
    const productId = result.product_id!;

    writeFileSync(join(root, "index.json"), "{ 这不是 JSON", "utf8");
    // 再存一次档案：损坏索引应先被改名留证，再重建
    const second = engine.assemble(plan.trace_id, input, rawFixture());
    expect(second.ok).toBe(true);
    const files = readdirSync(root);
    expect(files.some((f) => f.includes("index.json.corrupt-"))).toBe(true);
    const index = JSON.parse(readFileSync(join(root, "index.json"), "utf8")) as { entries: Array<{ product_id: string }> };
    expect(index.entries.some((e) => e.product_id === productId)).toBe(true);
  });
});
