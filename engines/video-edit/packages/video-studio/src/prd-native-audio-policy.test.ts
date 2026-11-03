import { describe, expect, it } from "vitest";
import { compileCreativeContract } from "./constraint-compiler.js";
import { effectivePrdModelSchema, preparePrdAuthority, prdAuthorityPrompt, validatePrdModelPayload } from "./prd-authority.js";
import { PRDSchema, prdFixture } from "./prd-authority.test-support.js";

describe("native shot audio and non-executable audience copy", () => {
  it("carries the single source-audio rule in the model contract without rewriting failed prose", () => {
    const f = prdFixture();
    try {
      const { tenantId, workspaceId, projectId } = f.scope;
      const creativeContract = compileCreativeContract({ scope: { tenantId, workspaceId, projectId }, isMarketing: true,
        rawIntent: "制作30秒的短片，原生赛车音效，无对白。", metadata: f.metadata });
      const authority = preparePrdAuthority({ metadata: f.metadata, marketing: f.marketing, workDir: f.workDir,
        projectId, creativeContract });
      const schema = effectivePrdModelSchema("production", PRDSchema, f.contract, authority.nativeShotAudioPolicy);
      const { audioSpecification } = schema.properties as Record<string,{properties:Record<string,{enum?:string[]}>}>;
      const permitted = audioSpecification!.properties.musicStyle!.enum;
      expect(permitted).toHaveLength(1);
      expect(permitted?.[0]).toMatch(/禁止镜头外配乐.*正式后期/);
      const inconsistent = structuredClone(f.production);
      inconsistent.audioSpecification.musicStyle = "无配乐煽情，尾段仅留极轻鼓点。";
      expect(() => validatePrdModelPayload(inconsistent, "production", PRDSchema, f.contract, authority.profile, authority.nativeShotAudioPolicy))
        .toThrow(/audioSpecification\/musicStyle/);
      expect(inconsistent.audioSpecification.musicStyle).toContain("极轻鼓点");
      const compliant = structuredClone(f.production);
      compliant.audioSpecification.musicStyle = permitted![0]!;
      expect(validatePrdModelPayload(compliant, "production", PRDSchema, f.contract, authority.profile, authority.nativeShotAudioPolicy))
        .toEqual(compliant);
      expect(prdAuthorityPrompt(authority, f.contract)).toContain("受众分析中的传播措辞只用于内部策划");
      // Legacy callers keep their original schema. This contract is private to enforced native production.
      expect(validatePrdModelPayload(inconsistent, "production", PRDSchema, f.contract, authority.profile)).toEqual(inconsistent);
    } finally { f.cleanup(); }
  });
});
