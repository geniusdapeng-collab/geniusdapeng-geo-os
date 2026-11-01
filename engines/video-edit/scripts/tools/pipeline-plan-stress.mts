#!/usr/bin/env -S tsx
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertVideoPipelineCatalog,
  compileVideoPipelineDocument,
  compileVideoPipelineCatalog,
  findVideoPipelineWaitCycles,
  loadVideoPipelineCatalog,
  type CompiledVideoPipelinePlan,
} from "../../packages/video-pipeline/src/index.ts";
import {
  pipelineFeatureFlagDefaults,
  loadPipelineFeatureFlags,
} from "../../packages/pipeline-control/src/index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PIPELINE_DIRS = [
  "bundles/ai-video/pipelines",
  "bundles/geo-growth/pipelines",
  "bundles/hotel/pipelines",
  "bundles/video-edit/pipelines",
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const mode = arg("mode", "all");
const expectedPlans = Number(arg("plans", "13"));
const caseCount = Number(arg("cases", "64"));

function pipelineFiles(): string[] {
  return PIPELINE_DIRS.flatMap((directory) =>
    readdirSync(resolve(ROOT, directory))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => resolve(ROOT, directory, name)),
  ).sort();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertCatalog() {
  const files = pipelineFiles();
  assert(files.length === expectedPlans, `expected ${expectedPlans} plans, found ${files.length}`);
  const catalog = assertVideoPipelineCatalog(loadVideoPipelineCatalog(files));
  assert(catalog.actionGates.length === 0, "gate/action conflation remains in shipped catalog");
  return {
    plans: catalog.plans.map((plan) => ({
      key: plan.key,
      hash: plan.planHash,
      nodes: plan.nodes.length,
      gates: plan.nodes.filter((node) => node.kind === "gate").length,
      calls: plan.nodes.filter((node) => node.kind === "call").length,
    })),
    missingGateRegistrations: catalog.missingGateRegistrations,
    missingPolicyGates: catalog.missingPolicyGates,
    waitCycles: catalog.waitCycles,
    callCycles: catalog.callCycles,
    unresolvedCalls: catalog.unresolvedCalls,
    resolvedCalls: catalog.resolvedCalls,
  };
}

function syntheticPlan(seed: number, nodeCount: number): CompiledVideoPipelinePlan {
  const steps = Array.from({ length: nodeCount }, (_, index) => {
    const depends = index === 0 ? [] : [index - 1];
    if (index > 2 && (seed + index) % 3 === 0) depends.push(index - 2);
    return {
      step_key: `n${index}`,
      name: `Node ${index}`,
      owner: "stress",
      outputs: [`payload_${index}`],
      ...(index === 0 ? {} : { inputs: depends.flatMap((dependency) => [
        `payload_${dependency}`,
      ]) }),
      depends_on: depends.map((dependency) => `n${dependency}`),
    };
  });
  return compileVideoPipelineDocument({
    quest: `stress-${seed}`,
    name: `stress-${seed}`,
    version: "1",
    steps,
  }, { knownPipelines: [`stress-${seed}`] });
}

function assertGraphProperties() {
  const count = Math.max(1, Math.min(caseCount, 1_000));
  let nodes = 0;
  for (let seed = 0; seed < count; seed++) {
    const plan = syntheticPlan(seed, 6 + (seed % 13));
    nodes += plan.nodes.length;
    assert(plan.nodes.length === 6 + (seed % 13), `seed ${seed} lost nodes`);
    assert(findVideoPipelineWaitCycles(plan.nodes).length === 0, `seed ${seed} produced a wait cycle`);
  }
  return { graphs: count, nodes, waitCycles: 0 };
}

function assertExecutionContracts() {
  const catalog = assertVideoPipelineCatalog(loadVideoPipelineCatalog(pipelineFiles()));
  const narrative = catalog.byKey.get("narrative-film");
  const marketing = catalog.byKey.get("marketing-film");
  assert(narrative && marketing, "required plans missing");
  const materialGate = narrative.nodes.find((node) => node.key === "material-authorize");
  const materialAction = narrative.nodes.find((node) => node.key === "material-generate");
  const deliveryGate = narrative.nodes.find((node) => node.key === "delivery-authorize");
  const deliveryAction = narrative.nodes.find((node) => node.key === "deliver");
  assert(materialGate?.kind === "gate" && materialGate.sideEffect === "none", "material gate must be pure");
  assert(materialAction?.kind === "stage" && materialAction.sideEffect === "provider", "material action must be a provider stage");
  assert(deliveryGate?.kind === "gate" && deliveryGate.sideEffect === "none", "delivery gate must be pure");
  assert(deliveryAction?.kind === "stage" && deliveryAction.sideEffect === "local", "delivery action must be a local stage");
  const productionCall = marketing.nodes.find((node) => node.key === "production");
  assert(productionCall?.kind === "call" && catalog.byKey.has(productionCall.pipelineKey), "marketing child plan is unresolved");
  return {
    materialGate: materialGate.key,
    materialAction: materialAction.key,
    deliveryGate: deliveryGate.key,
    deliveryAction: deliveryAction.key,
    childCall: productionCall.pipelineKey,
  };
}

function assertFlags() {
  const cases = [
    [{}, "off"],
    [{ PIPELINE_COORDINATOR: "off" }, "off"],
    [{ PIPELINE_COORDINATOR: "shadow" }, "shadow"],
    [{ PIPELINE_COORDINATOR: "enforce" }, "enforce"],
    [{ PIPELINE_CONTROL_PLANE: "off" }, "off"],
    [{ PIPELINE_CONTROL_PLANE: "shadow" }, "shadow"],
    [{ PIPELINE_CONTROL_PLANE: "enforce" }, "enforce"],
    [{ PIPELINE_COORDINATOR: "shadow", PIPELINE_CONTROL_PLANE: "shadow" }, "shadow"],
    [{ PIPELINE_COORDINATOR: "enforce", PIPELINE_CONTROL_PLANE: "enforce" }, "enforce"],
  ] as const;
  for (const [env, expected] of cases) {
    assert(loadPipelineFeatureFlags(env).coordinator === expected, `flag mismatch for ${JSON.stringify(env)}`);
  }
  for (const env of [
    { PIPELINE_COORDINATOR: "enforce", PIPELINE_CONTROL_PLANE: "shadow" },
    { PIPELINE_COORDINATOR: "on" },
    { PIPELINE_CONTROL_PLANE: "on" },
  ]) {
    let rejected = false;
    try { loadPipelineFeatureFlags(env); } catch { rejected = true; }
    assert(rejected, `invalid/conflicting flags accepted: ${JSON.stringify(env)}`);
  }
  return { accepted: cases.length, rejected: 3, defaults: pipelineFeatureFlagDefaults() };
}

const result: Record<string, unknown> = {
  schemaVersion: "workloom.pipeline-control-stress/v1",
  mode,
  startedAt: new Date().toISOString(),
  passed: true,
};

if (mode === "catalog") {
  result.catalog = assertCatalog();
  result.graphs = assertGraphProperties();
} else if (mode === "contract") {
  result.catalog = assertCatalog();
  result.graphs = assertGraphProperties();
} else if (mode === "execution") {
  result.execution = assertExecutionContracts();
} else if (mode === "flags") {
  result.flags = assertFlags();
} else if (mode === "all") {
  result.catalog = assertCatalog();
  result.graphs = assertGraphProperties();
  result.execution = assertExecutionContracts();
  result.flags = assertFlags();
} else {
  throw new Error(`unknown mode: ${mode}`);
}

result.finishedAt = new Date().toISOString();
process.stdout.write(`${JSON.stringify(result)}\n`);
