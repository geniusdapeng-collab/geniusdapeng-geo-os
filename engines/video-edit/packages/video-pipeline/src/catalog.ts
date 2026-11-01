import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  compileVideoPipelineDocument,
  findVideoPipelineWaitCycles,
  type CompiledVideoPipelinePlan,
  type VideoPipelineWaitCycle,
} from "./compiled-plan.js";
import {
  createVideoGateRegistry,
  VIDEO_GATES,
  type VideoGateRegistration,
} from "./adapters.js";
import { VIDEO_SYSTEM_AUTO_APPROVAL_POLICY } from "./auto-approval.js";

export interface VideoPipelineDocumentInput {
  sourcePath: string;
  document: unknown;
}

export interface CallCycle {
  members: string[];
}

export interface VideoPipelineCatalog {
  plans: CompiledVideoPipelinePlan[];
  byKey: Map<string, CompiledVideoPipelinePlan>;
  missingGateRegistrations: string[];
  missingPolicyGates: string[];
  waitCycles: VideoPipelineWaitCycle[];
  callCycles: CallCycle[];
  unresolvedCalls: Array<{ planKey: string; nodeKey: string; target: string }>;
  resolvedCalls: Array<{
    planKey: string;
    nodeKey: string;
    target: string;
    adapterId: string;
    childPlanHash: string;
  }>;
  actionGates: [];
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function documentQuest(document: unknown, sourcePath: string): string {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`PIPELINE_CATALOG_DOCUMENT_INVALID: ${sourcePath}`);
  }
  const quest = (document as Record<string, unknown>).quest;
  if (typeof quest !== "string" || !quest.trim()) {
    throw new Error(`PIPELINE_CATALOG_QUEST_MISSING: ${sourcePath}`);
  }
  return quest.trim();
}

function findCallCycles(
  plans: CompiledVideoPipelinePlan[],
): CallCycle[] {
  const edges = new Map(plans.map((plan) => [
    plan.key,
    plan.nodes.filter((node) => node.kind === "call").map((node) =>
      node.kind === "call" ? node.pipelineKey : ""),
  ]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const cycles: CallCycle[] = [];
  const seenCycles = new Set<string>();
  const visit = (key: string): void => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") {
      const start = stack.indexOf(key);
      const members = stack.slice(start);
      const canonical = [...members].sort((left, right) => left.localeCompare(right, "en"));
      const signature = canonical.join("\0");
      if (!seenCycles.has(signature)) {
        seenCycles.add(signature);
        cycles.push({ members });
      }
      return;
    }
    state.set(key, "visiting");
    stack.push(key);
    for (const target of edges.get(key) ?? []) visit(target);
    stack.pop();
    state.set(key, "done");
  };
  for (const plan of plans) visit(plan.key);
  return cycles;
}

export function compileVideoPipelineCatalog(
  inputs: VideoPipelineDocumentInput[],
): VideoPipelineCatalog {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("PIPELINE_CATALOG_EMPTY");
  }
  const quests = inputs.map((input) => documentQuest(input.document, input.sourcePath));
  if (new Set(quests).size !== quests.length) throw new Error("PIPELINE_CATALOG_DUPLICATE_QUEST");
  const knownPipelines = uniqueSorted(quests);
  const actualGateIds = uniqueSorted(inputs.flatMap((input) => {
    if (!input.document || typeof input.document !== "object" || Array.isArray(input.document)) return [];
    const steps = (input.document as Record<string, unknown>).steps;
    if (!Array.isArray(steps)) return [];
    return steps.flatMap((step) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return [];
      const gate = (step as Record<string, unknown>).gate;
      return typeof gate === "string" && gate.trim() ? [gate.trim()] : [];
    });
  }));
  const registeredGateIds = new Set(VIDEO_GATES.map((gate) => gate.id));
  const missingGateRegistrations = actualGateIds.filter((gate) => !registeredGateIds.has(gate));
  const registryExtensions: VideoGateRegistration[] = missingGateRegistrations.map((id) => ({
    id,
    checkSetVersion: `${id.toLowerCase()}/catalog/v1`,
    rubricVersion: `${id.toLowerCase()}/catalog/v1`,
    authority: "host_rule",
  }));
  const gateRegistry = createVideoGateRegistry(registryExtensions);
  const plans = inputs.map((input) => compileVideoPipelineDocument(input.document, {
    knownPipelines,
    gateRegistry,
  }));
  const byKey = new Map(plans.map((plan) => [plan.key, plan]));
  const missingPolicyGates = actualGateIds.filter((gate) =>
    !VIDEO_SYSTEM_AUTO_APPROVAL_POLICY.gates.has(gate));
  const unresolvedCalls = plans.flatMap((plan) => plan.nodes.flatMap((node) =>
    node.kind === "call" && !byKey.has(node.pipelineKey)
      ? [{ planKey: plan.key, nodeKey: node.key, target: node.pipelineKey }]
      : []));
  const resolvedCalls = plans.flatMap((plan) => plan.nodes.flatMap((node) => {
    if (node.kind !== "call") return [];
    const child = byKey.get(node.pipelineKey);
    return child ? [{
      planKey: plan.key,
      nodeKey: node.key,
      target: node.pipelineKey,
      adapterId: node.adapterId,
      childPlanHash: child.planHash,
    }] : [];
  }));
  return {
    plans,
    byKey,
    missingGateRegistrations,
    missingPolicyGates,
    waitCycles: plans.flatMap((plan) => findVideoPipelineWaitCycles(plan.nodes)),
    callCycles: findCallCycles(plans),
    unresolvedCalls,
    resolvedCalls,
    actionGates: [],
  };
}

export function loadVideoPipelineCatalog(files: string[]): VideoPipelineCatalog {
  const inputs = files.map((sourcePath) => ({
    sourcePath,
    document: parseYaml(readFileSync(sourcePath, "utf8")),
  }));
  return compileVideoPipelineCatalog(inputs);
}

export function assertVideoPipelineCatalog(catalog: VideoPipelineCatalog): VideoPipelineCatalog {
  if (catalog.missingGateRegistrations.length > 0) {
    throw new Error(`PIPELINE_CATALOG_GATE_REGISTRATION_MISSING: ${catalog.missingGateRegistrations.join(",")}`);
  }
  if (catalog.missingPolicyGates.length > 0) {
    throw new Error(`PIPELINE_CATALOG_POLICY_MISSING: ${catalog.missingPolicyGates.join(",")}`);
  }
  if (catalog.waitCycles.length > 0) {
    throw new Error(`PIPELINE_CATALOG_WAIT_CYCLE: ${JSON.stringify(catalog.waitCycles[0])}`);
  }
  if (catalog.callCycles.length > 0) {
    throw new Error(`PIPELINE_CATALOG_CALL_CYCLE: ${catalog.callCycles[0]?.members.join(",") ?? "unknown"}`);
  }
  if (catalog.unresolvedCalls.length > 0) {
    throw new Error(`PIPELINE_CATALOG_CALL_TARGET_MISSING: ${JSON.stringify(catalog.unresolvedCalls[0])}`);
  }
  return catalog;
}
