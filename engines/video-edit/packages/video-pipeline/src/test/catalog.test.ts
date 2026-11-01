import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadVideoPipelineCatalog } from "../catalog.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const PIPELINE_DIRS = [
  "bundles/ai-video/pipelines",
  "bundles/geo-growth/pipelines",
  "bundles/hotel/pipelines",
  "bundles/video-edit/pipelines",
];

function pipelineFiles(): string[] {
  return PIPELINE_DIRS.flatMap((directory) =>
    readdirSync(resolve(ROOT, directory))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => resolve(ROOT, directory, name)),
  ).sort();
}

describe("video pipeline catalog", () => {
  it("compiles every shipped pipeline and proves gate and topology coverage", () => {
    const catalog = loadVideoPipelineCatalog(pipelineFiles());
    expect(catalog.plans).toHaveLength(13);
    expect(catalog.missingGateRegistrations).toEqual([]);
    expect(catalog.missingPolicyGates).toEqual([]);
    expect(catalog.waitCycles).toEqual([]);
    expect(catalog.callCycles).toEqual([]);
  });

  it("keeps gates pure and requires side effects to be separate stages", () => {
    const catalog = loadVideoPipelineCatalog(pipelineFiles());
    const narrative = catalog.byKey.get("narrative-film");
    expect(narrative).toBeDefined();
    const promptGate = narrative!.nodes.find((node) => node.key === "g6-prompt-confirm");
    const materialGate = narrative!.nodes.find((node) => node.key === "material-authorize");
    const materialAction = narrative!.nodes.find((node) => node.key === "material-generate");
    const deliveryGate = narrative!.nodes.find((node) => node.key === "delivery-authorize");
    const deliveryAction = narrative!.nodes.find((node) => node.key === "deliver");
    expect(promptGate?.kind).toBe("gate");
    expect(promptGate?.kind === "gate" ? promptGate.action : null).toBeNull();
    expect(materialGate?.kind).toBe("gate");
    expect(materialGate?.sideEffect).toBe("none");
    expect(materialAction?.kind).toBe("stage");
    expect(materialAction?.sideEffect).toBe("provider");
    expect(deliveryGate?.kind).toBe("gate");
    expect(deliveryGate?.sideEffect).toBe("none");
    expect(deliveryAction?.kind).toBe("stage");
    expect(deliveryAction?.sideEffect).toBe("local");
  });

  it("reports unresolved child calls and action executors instead of treating them as executable", () => {
    const catalog = loadVideoPipelineCatalog(pipelineFiles());
    expect(catalog.unresolvedCalls).toEqual([]);
    const resolvedProduction = catalog.resolvedCalls.find((call) =>
      call.planKey === "marketing-film" && call.nodeKey === "production");
    expect(resolvedProduction?.target).toBe("narrative-film");
    expect(resolvedProduction?.adapterId).toBe("pipeline.child");
    expect(resolvedProduction?.childPlanHash).toBe(catalog.byKey.get("narrative-film")?.planHash);
    const production = catalog.byKey.get("marketing-film")?.nodes.find((node) => node.key === "production");
    expect(production?.kind).toBe("call");
    expect(production?.kind === "call" ? production.adapterId : null).toBe("pipeline.child");
    expect(catalog.actionGates).toEqual([]);
  });
});
