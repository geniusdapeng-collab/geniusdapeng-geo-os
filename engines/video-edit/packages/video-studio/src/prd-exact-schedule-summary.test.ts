import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { compileCreativeContract } from "./constraint-compiler.js";
import { bindExactPrdShotSchedule, exactPrdShotSchedule, renderExactPrdShotSchedule } from "./prd-authority-bridge.js";

const require = createRequire(import.meta.url);
const vendor = "../../../vendor/supermickey/hyperreality-system/engines/prd-generator";
const { PRDGenerator } = require(`${vendor}/prd-generator.js`);
const { generateSummary } = require(`${vendor}/utils/prd-summary.js`);
const renderer = Object.create(PRDGenerator.prototype);
const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace", projectId: "VID-fixture" };
// Real attempt-12 numeric structure, with fixture text. The five approved beats
// fit the same three production segments without changing any native estimate.
const beats = [3, 7, 10, 5, 5].map((duration, i) => ({ id: ["opening", "scene-1", "scene-2", "scene-3", "ending"][i]!, duration }));
const originalStory = "客户原始叙事全文\n\n## 7. 场景规划\n\n此标题也可以出现在原文。";
const label = "5 个叙事节点 / 3 个制作镜头段，每段 10 秒";
function fixture() {
  const value = {
    _originalStoryText: originalStory,
    projectDefinition: { projectName: "测试项目" },
    productPositioning: { targetDuration: 30 },
    scenePlan: {
      scenes: beats.map(({ id, duration }, index) => ({ sceneId: id, sequence: index + 1, duration })),
      shotMapping: beats.map(({ id }, index) => ({ sceneId: id, estimatedShots: [2, 2, 3, 2, 2][index]!, shotBreakdownHint: ["tracking"] })),
    },
    productionConstraints: { technicalConstraints: ["原技术要求 A", "原技术要求 B", "原技术要求 C", "原技术要求 D", "原技术要求 E"] },
    deliveryStandard: { deliverables: [{ item: "video_master", spec: "MP4/H.265, 1080p", priority: "required" }] },
  };
  return { ...value, prdSummary: generateSummary(value) };
}

describe("G4 exact production schedule summary", () => {
  it("uses the explicit schedule in the real native summary, delivery and production constraints while retaining raw G3 mapping", () => {
    const value = fixture();
    const originalPlan = structuredClone(value.scenePlan);
    const plan = exactPrdShotSchedule(compileCreativeContract({ scope, rawIntent: "成片30秒，恰好3个10秒镜头段。" }), beats);
    const native = renderer.generateMarkdown(value) as string;
    expect(native).toContain("| 场景 | 5 场景 / 11 预估镜头 |");
    bindExactPrdShotSchedule(value, plan);
    const markdown = renderExactPrdShotSchedule(renderer.generateMarkdown(value), value, plan);
    expect(value.prdSummary.scenes).toBe(label);
    expect(value.prdSummary.humanReadable).toContain(label);
    expect(markdown).toContain(`| 叙事节点与制作镜头段 | ${label} |`);
    expect(markdown).not.toContain("5 场景 / 11 预估镜头");
    expect(markdown).toContain(`客户明确制作时序：${label}，内容合计 30 秒`);
    expect(markdown).toContain(`按客户明确制作时序验收：${label}，内容合计 30 秒`);
    expect(markdown).toContain(originalStory);
    expect(markdown).toContain("以下逐节点「预估镜头」保留原生构图提示及其估算");
    expect(markdown.match(/- \*\*预估镜头\*\*/gu)).toHaveLength(5);
    expect(value.scenePlan).toEqual(originalPlan);
    expect(value.productionConstraints.technicalConstraints).toHaveLength(5);
    expect(value.productionConstraints.technicalConstraints[4]).toContain("原技术要求 E");
  });

  it("retains vendor structured fields and Markdown bytes when no exhaustive schedule was declared", () => {
    const value = fixture(), before = structuredClone(value);
    const plan = exactPrdShotSchedule(compileCreativeContract({ scope, rawIntent: "成片30秒，拍运动广告。" }), beats);
    const markdown = renderer.generateMarkdown(value) as string;
    bindExactPrdShotSchedule(value, plan);
    expect(value).toEqual(before);
    expect(renderExactPrdShotSchedule(markdown, value, plan)).toBe(markdown);
  });
});
