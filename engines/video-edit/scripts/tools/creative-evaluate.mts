/**
 * Read-only analyzer for authorized, sanitized observations.
 * Use: node --import tsx scripts/tools/creative-evaluate.mts metrics --input FILE
 *      node --import tsx scripts/tools/creative-evaluate.mts shadow --input FILE
 *      node --import tsx scripts/tools/creative-evaluate.mts rollout --input FILE
 */
import { readFile, stat } from "node:fs/promises";
import { loadPipelineFeatureFlags } from "../../packages/pipeline-control/src/feature-flags.js";
import { compareCreativeShadow, evaluateCreativeReceipts } from "../../packages/video-studio/src/creative-evaluation.js";

const usage = "creative-evaluate <metrics|shadow|rollout> --input <sanitized JSON>";
const modes = new Set(["off", "shadow", "enforce"]);
function validateRollout(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rollout input must be an object");
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(key => !["current", "next", "scope", "pinned"].includes(key))
    || !modes.has(String(config.current)) || !modes.has(String(config.next))
    || !Array.isArray(config.pinned)) throw new Error("rollout requires current/next modes and pinned run receipts");
  const current = loadPipelineFeatureFlags({ PIPELINE_COORDINATOR: String(config.current) }).coordinator;
  if (config.scope !== undefined && typeof config.scope !== "string") throw new Error("scope must be a configured route selector");
  const next = loadPipelineFeatureFlags({ PIPELINE_COORDINATOR: String(config.next), PIPELINE_SCOPE: config.scope });
  const ids = new Set<string>();
  for (const value of config.pinned) {
    if (!value || typeof value !== "object" || typeof value.runId !== "string" || !value.runId
      || ids.has(value.runId) || !modes.has(value.mode) || typeof value.planHash !== "string" || !/^[a-f0-9]{64}$/.test(value.planHash)
      || typeof value.schemaVersion !== "string" || !value.schemaVersion.trim()) throw new Error("invalid or duplicate pinned run receipt");
    ids.add(value.runId);
  }
  return { current, newRuns: next.coordinator, scope: next.scope, inFlight: config.pinned.map(run => ({
    runId: run.runId, mode: run.mode, planHash: run.planHash, schemaVersion: run.schemaVersion,
  })), rollback: current !== "off" && next.coordinator === "off", automaticThresholdTuning: false };
}

async function main(): Promise<void> {
  const [command, flag, input, ...extra] = process.argv.slice(2);
  if (command === "--help") { console.log(usage); return; }
  if (!["metrics", "shadow", "rollout"].includes(command ?? "") || flag !== "--input" || !input || extra.length) throw new Error(usage);
  const info = await stat(input);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("evaluation input must be a bounded regular JSON file");
  const data: unknown = JSON.parse(await readFile(input, "utf8"));
  const report = command === "metrics" ? evaluateCreativeReceipts(data)
    : command === "shadow" ? compareCreativeShadow(data) : validateRollout(data);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
