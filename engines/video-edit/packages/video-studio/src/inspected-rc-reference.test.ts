import { describe, expect, it } from "vitest";
import { assertProductVisualContent, INSPECTED_RC_REFERENCE_DETAIL_RULE, registeredProductReferenceOmitsMirrors,
  type ProductVisualAuthority } from "./product-visual-authority.js";

const image = { productId: "zxmoto-820rr-rc", sha256: "575d2bb914d62fafecfa34e16dd8b37ce06e5f020ff1872a7d9a8b489c2e888d" };
const authority: ProductVisualAuthority = { mode: "verified_product_appearance", modeEvidence: null, required: true,
  product: "张雪机车820RR-RC", images: [], rule: "只能使用当前可见原件" };

describe("scoped registered RC image keeps the rider palette separate from the bike", () => {
  const verify = (value: unknown, refs = [image]) =>
    assertProductVisualContent(authority, value, "candidate", registeredProductReferenceOmitsMirrors(refs));
  it.each(["黑红主色，冷灰赛道背景", "黑红车身与暖白终点线对比", "黑红赛车服与车身呼应",
    "车身采用黑红", "black-and-red fairing"])("rejects an unverified generated vehicle palette: %s", value => {
    expect(() => verify({ fields: { 色彩: value }, prompt: `13.【色彩】${value}` })).toThrow("PRODUCT_VISUAL_DETAIL_UNVERIFIED");
  });
  it("retains the rider's explicitly requested colors, an independent vehicle source, and a negative rule", () => {
    expect(() => verify({
      fields: { 色彩: "车手穿黑红皮质护具；车身仅按登记原图涂装，冷灰赛道背景",
        负面约束: "禁止把车身写成黑红涂装" },
      prompt: "13.【色彩】车手穿黑红皮质护具。车身按登记原图。\n" + INSPECTED_RC_REFERENCE_DETAIL_RULE,
    })).not.toThrow();
  });
  it("does not infer a color omission for other or additional reference bytes", () => {
    expect(() => verify("黑红车身", [{ ...image, sha256: "a".repeat(64) }])).not.toThrow();
    expect(() => verify("黑红车身", [{ ...image, productId: "other" }])).not.toThrow();
    expect(() => verify("黑红车身", [image, { ...image, sha256: "a".repeat(64) }])).not.toThrow();
  });
});
