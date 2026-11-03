import { describe, expect, it } from "vitest";
import * as visual from "./product-visual-authority.js";
const { extractProductVisualAuthority } = visual;

function fixture(images: unknown[], product?: unknown) {
  return JSON.stringify({
    facts: {
      schemaVersion: "workloom.marketing-facts/v1",
      stages: [{ stage: "A1", facts: { status: "source_bound", payload: { images } } }],
    },
    ...(product === undefined ? {} : { requestedMetadata: { brief: { product } } }),
  });
}

describe("G1 product visual authority", () => {
  const abstractIntent = "为 Atlas 软件做暖橙色营销视频。只用抽象界面和示意图，不展示产品外观，保留旁白和环境声。";
  function clientArtifact(intent: string, productionRequirements?: Record<string, unknown>) {
    const source = JSON.parse(fixture([], "Atlas"));
    source.requestedIntent = intent;
    source.requestedMetadata.brief.productionRequirements = productionRequirements;
    return JSON.stringify(source);
  }
  it("MC-011 derives no-appearance authority from current original words without changing creative direction", () => {
    const result = extractProductVisualAuthority(clientArtifact(abstractIntent));
    expect(result).toMatchObject({ mode: "abstract_without_product_appearance", required: false, product: "Atlas", images: [],
      modeEvidence: { source: "requestedIntent", value: "不展示产品外观" } });
    expect(result.rule).toContain("不得生成或展示");
  });
  it("MC-011 accepts the exact structured customer choice and rejects contradictory appearance requirements", () => {
    const requirements = { visualMode: "abstract_without_product_appearance" };
    expect(extractProductVisualAuthority(clientArtifact("为 Atlas 做暖橙配色宣传", requirements))).toMatchObject({
      mode: "abstract_without_product_appearance", modeEvidence: { source: "requestedMetadata.brief.productionRequirements.visualMode", value: requirements.visualMode },
    });
    expect(() => extractProductVisualAuthority(clientArtifact("给 Atlas 软件包装一个实物特写", requirements))).toThrow("PRODUCT_VISUAL_MODE_CONFLICT");
    expect(() => extractProductVisualAuthority(clientArtifact(abstractIntent, { visualMode: "verified_product_appearance" }))).toThrow("PRODUCT_VISUAL_MODE_CONFLICT");
    expect(() => extractProductVisualAuthority(clientArtifact("不展示产品外观除非拍摄产品包装"))).toThrow("PRODUCT_VISUAL_MODE_CONFLICT");
    expect(() => extractProductVisualAuthority(clientArtifact("不展示产品外观，但需要实拍产品包装"))).toThrow("PRODUCT_VISUAL_MODE_CONFLICT");
    expect(extractProductVisualAuthority(clientArtifact("不展示产品外观，但需要保留旁白")).mode).toBe("abstract_without_product_appearance");
  });
  it.each(["抽象界面风格，需要拍产品演示", "不展示未核实硬件，真实界面仍要拍", "不要使用商品图片", "提到「不展示产品外观」这个旧需求", "并非不展示产品外观"])("MC-011 does not grant an exception for %s", intent => {
    expect(() => extractProductVisualAuthority(clientArtifact(intent))).toThrow("PRODUCT_VISUAL_AUTHORITY_REQUIRED");
  });
  it("MC-011 checks positive action and exact prompt payload without blocking the product name or scoped negative instructions", () => {
    const mode = extractProductVisualAuthority(clientArtifact(abstractIntent));
    const check = Reflect.get(visual, "assertProductVisualContent");
    expect(() => check(mode, { prompt: "暖橙色光点组网，旁白：Atlas。\n22.【负面约束】不展示商品外观。" }, "final")).not.toThrow();
    expect(() => check(mode, { actions: [{ actorId: "$product", description: "运作" }] }, "G3")).toThrow("PRODUCT_VISUAL_CONTENT_CONFLICT");
    expect(() => check(mode, { prompt: "禁止添加字幕，但展示产品包装；随后切回抽象光点" }, "G6")).toThrow("PRODUCT_VISUAL_CONTENT_CONFLICT");
    expect(() => check(mode, { prompt: "不妨直接展示产品包装" }, "G6")).toThrow("PRODUCT_VISUAL_CONTENT_CONFLICT");
    expect(() => check(mode, { prompt: "无背景噪音地呈现产品包装" }, "G6")).toThrow("PRODUCT_VISUAL_CONTENT_CONFLICT");
    expect(() => check(mode, { prompt: "禁止产品外观并展示产品包装" }, "G6")).toThrow("PRODUCT_VISUAL_CONTENT_CONFLICT");
    expect(() => check(mode, { prompt: "22.【负面约束】不得展示商品外观；展示实际产品包装。" }, "G6")).toThrow("PRODUCT_VISUAL_CONTENT_CONFLICT");
  });
  it("no explicit product means appearance authority is not applicable", () => {
    expect(extractProductVisualAuthority(fixture([]))).toMatchObject({ required: false, product: null, images: [] });
  });

  it("explicit product without an accepted image fails closed", () => {
    expect(() => extractProductVisualAuthority(fixture([], "820RR-RC"))).toThrow("PRODUCT_VISUAL_AUTHORITY_REQUIRED");
  });

  it("returns only deduplicated HTTP(S) images from the accepted A1 payload", () => {
    const image = { url: "https://media.example.com/bike.png", page_url: "https://source.example.com/post",
      source: "source.example.com", angle: "side", license_risk: "high" };
    const result = extractProductVisualAuthority(fixture([image, image, { url: "file:///private.png", page_url: "file:///private" }], "820RR-RC"));
    expect(result).toMatchObject({
      required: true,
      product: "820RR-RC",
      images: [{ url: "https://media.example.com/bike.png", pageUrl: "https://source.example.com/post",
        source: "source.example.com", angle: "side", licenseRisk: "high" }],
    });
    expect(result.rule).toContain("只能引用本次 G1 A1 已接受图片");
  });

  it("joins source-image license risk from the accepted portrait manifest", () => {
    const image = { url: "https://media.example.com/bike.png", page_url: "https://source.example.com/post" };
    const value = JSON.parse(fixture([image], "820RR-RC"));
    value.facts.cards = { portrait_manifest: { reference_images: [
      { ...image, angle: "unknown", license_risk: "high" },
    ] } };
    expect(extractProductVisualAuthority(JSON.stringify(value))).toMatchObject({
      images: [{ url: image.url, angle: "unknown", licenseRisk: "high" }],
    });
  });
});

describe("exact registered reference lamp area", () => {
  const authority: visual.ProductVisualAuthority = { mode: "verified_product_appearance", modeEvidence: null, required: true,
    product: "张雪机车 820RR-RC", images: [], rule: "exact registered source only" };
  const source = { productId: "zxmoto-820rr-rc", sha256: "575d2bb914d62fafecfa34e16dd8b37ce06e5f020ff1872a7d9a8b489c2e888d" };
  const guarded = visual.registeredProductReferenceOmitsMirrors([source]);
  it.each([
    "最后一帧收到奖杯金属边缘的一道高光与赛道边赛车灯区同框的特写",
    "赛车静止停在赛道边，灯区在暖光下与奖杯高光同框收束",
    "登记原图可见的车灯亮起",
    "对照登记原图保留尾灯",
    "按本次登记原图保持车灯；随后独立特写灯区",
    "按本次登记原图给车灯独立特写",
  ])("rejects an unverified or operational vehicle lamp instruction (%s)", description => {
    expect(guarded).toBe(true);
    expect(() => visual.assertProductVisualContent(authority, { description }, "G3 SceneArchitect", guarded)).toThrow("PRODUCT_VISUAL_DETAIL_UNVERIFIED");
    for (const references of [[{ ...source, productId: "other" }], [source, { ...source, sha256: "0".repeat(64) }]]) {
      expect(() => visual.assertProductVisualContent(authority, { description }, "G3 SceneArchitect",
        visual.registeredProductReferenceOmitsMirrors(references))).not.toThrow();
    }
  });

  it.each([
    "车身外观只按本次登记原图核对整流罩、灯区、排气与涂装",
    "用已授权实物参考图保持车身整流罩、灯区、排气和涂装一致",
    "奖杯高光与赛道边的整车同框收束",
    "奖杯特写与整车同框，车灯区仅随整体车身保留本次登记原图可见的静态外形",
    "维修区灯区提供中性顶光",
    "禁止无来源锚点的车灯区特写",
    visual.INSPECTED_RC_REFERENCE_DETAIL_RULE,
  ])("preserves source-bound static appearance and valid omission instructions (%s)", description => {
    expect(() => visual.assertProductVisualContent(authority, { description }, "G3 SceneArchitect", guarded)).not.toThrow();
  });
});
