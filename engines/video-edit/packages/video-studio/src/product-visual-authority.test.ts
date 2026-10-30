import { describe, expect, it } from "vitest";
import { extractProductVisualAuthority } from "./product-visual-authority.js";

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
