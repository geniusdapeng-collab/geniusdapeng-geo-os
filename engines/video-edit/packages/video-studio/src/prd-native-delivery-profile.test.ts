import { describe, expect, it } from "vitest";
import { compileCreativeContract } from "./constraint-compiler.js";
import { authoritativeDelivery, authoritativeProduct, preparePrdAuthority } from "./prd-authority.js";
import { prdFixture } from "./prd-authority.test-support.js";

describe("effective production delivery in the enforced marketing route", () => {
  it("carries the compiled portrait master and caller platform to both native PRD sections", () => {
    const fixture = prdFixture();
    try {
      const rawIntent = "在抖音做一支30秒的竖屏广告，恰好3个10秒镜头段。";
      const sourceMetadata = { platform: "douyin", durationSec: 30, brief: { product: "Fixture" } };
      const { scope } = fixture.marketing;
      const creativeContract = compileCreativeContract({ scope: { projectId: scope.projectId, workspaceId: scope.workspaceId, tenantId: scope.tenantId },
        rawIntent, metadata: sourceMetadata, isMarketing: true });
      const metadata = { ...sourceMetadata, brief: { ...sourceMetadata.brief, duration: 30 } };
      const input = { metadata, marketing: fixture.marketing, projectId: scope.projectId, workDir: fixture.workDir };
      const authority = preparePrdAuthority({ ...input, creativeContract });
      const expected = { targetDuration: 30, aspectRatio: "9:16", targetPlatform: "抖音", resolution: "1080p", frameRate: 30 };
      expect(authority.profile).toMatchObject({ ...expected, subtitleMode: "none" });
      expect(authority.metadata).toEqual(metadata);
      expect(creativeContract.sourceMetadata).toEqual(sourceMetadata);
      expect(authoritativeProduct({ productPositioning: { aspectRatio: "16:9", resolution: "4K", targetPlatform: "通用" } }, authority.profile))
        .toEqual({ productPositioning: expected });
      const normalized = authoritativeDelivery({ deliveryStandard: { outputFormat: { container: "MP4", videoCodec: "H.265" },
        deliverables: [{ item: "video_master", spec: "MP4/H.265, 4K" }] } }, authority.profile);
      expect(JSON.stringify(normalized)).not.toContain("4K");
      expect(normalized.deliveryStandard).toMatchObject({ outputFormat: expected });
      expect(preparePrdAuthority(input).profile).not.toHaveProperty("resolution");
      expect(() => preparePrdAuthority({ ...input, creativeContract: compileCreativeContract({ scope: { projectId: "different",
        workspaceId: scope.workspaceId, tenantId: scope.tenantId }, rawIntent, metadata: sourceMetadata, isMarketing: true }) }))
        .toThrow("PRD_PROFILE_INVALID");
    } finally { fixture.cleanup(); }
  });
});
