/** GEO 可见度线单测：关键词缺席 / 竞对截流 / 引用亲和度 */
import { describe, expect, it } from "vitest";
import { analyzeGeo } from "../src/analyzers/geo.js";
import { CTX, makeSnapshot } from "./helpers.js";

const query = (over: Record<string, unknown>) => ({
  hotelId: "H-1",
  query: "杭州西湖边亲子酒店推荐",
  type: "category" as const,
  priority: "P1" as const,
  mentioned: false,
  competitorsCited: [] as string[],
  platform: "deepseek",
  ...over,
});

describe("analyzeGeo · 关键词缺席", () => {
  it("P0 品牌词未提及 → P1 且带 LEADS 估算；品类词未提及 → P2", () => {
    const brand = makeSnapshot({ geoQueries: [query({ query: "云栖酒店怎么样", type: "brand", priority: "P0" })] });
    const f = analyzeGeo(brand, CTX).find((x) => x.title.includes("未引用"))!;
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ amount: 3, currency: "LEADS", period: "monthly" });
    const cat = makeSnapshot({ geoQueries: [query({})] });
    const fc = analyzeGeo(cat, CTX).find((x) => x.title.includes("未引用"))!;
    expect(fc.severity).toBe("P2");
    expect(fc.estimatedImpact).toBeUndefined();
  });

  it("已提及的 query 不报缺席", () => {
    const s = makeSnapshot({ geoQueries: [query({ mentioned: true, firstRecommended: true })] });
    expect(analyzeGeo(s, CTX)).toHaveLength(0);
  });
});

describe("analyzeGeo · 竞对截流", () => {
  it("品类词竞对被引己方缺席 → P1；品牌词被截胡升 P0", () => {
    const s = makeSnapshot({ geoQueries: [query({ competitorsCited: ["竞对A", "竞对B"] })] });
    const f = analyzeGeo(s, CTX).find((x) => x.title.includes("竞对截流"))!;
    expect(f.severity).toBe("P1");
    expect(f.estimatedImpact).toMatchObject({ amount: 2, currency: "LEADS" });
    const hijack = makeSnapshot({ geoQueries: [query({ query: "云栖酒店怎么样", type: "brand", priority: "P0", competitorsCited: ["竞对A"] })] });
    const fh = analyzeGeo(hijack, CTX).find((x) => x.title.includes("竞对截流"))!;
    expect(fh.severity).toBe("P0");
    expect(fh.estimatedImpact).toMatchObject({ amount: 4, currency: "LEADS" });
  });

  it("我方与竞对同被引用（未缺席）不报截流", () => {
    const s = makeSnapshot({ geoQueries: [query({ mentioned: true, competitorsCited: ["竞对A"] })] });
    expect(analyzeGeo(s, CTX)).toHaveLength(0);
  });
});

describe("analyzeGeo · 引用亲和度", () => {
  it("缺 FAQ 块/结构化数据 → 聚合 P2；双健全不报", () => {
    const s = makeSnapshot({
      geoQueries: [query({ mentioned: true })],
      geoAssets: [
        { hotelId: "H-1", assetId: "GA-1", title: "官网首页", hasFaqBlock: false, hasStructuredData: true },
        { hotelId: "H-1", assetId: "GA-2", title: "亲子房落地页", hasFaqBlock: false, hasStructuredData: false },
        { hotelId: "H-1", assetId: "GA-3", title: "FAQ 页", hasFaqBlock: true, hasStructuredData: true },
      ],
    });
    const fs = analyzeGeo(s, CTX);
    expect(fs).toHaveLength(1);
    expect(fs[0]!.severity).toBe("P2");
    expect(fs[0]!.calculation.inputs).toMatchObject({ noFaq: 2, noStructuredData: 1, affected: 2 });
    const ok = makeSnapshot({
      geoQueries: [query({ mentioned: true })],
      geoAssets: [{ hotelId: "H-1", assetId: "GA-1", title: "FAQ 页", hasFaqBlock: true, hasStructuredData: true }],
    });
    expect(analyzeGeo(ok, CTX)).toHaveLength(0);
  });
});
