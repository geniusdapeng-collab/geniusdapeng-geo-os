import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { assertCreativeContract, type CreativeScope } from "@hyperreality/video-studio";
import { CREATIVE_PLAN, latestCreativeContract, scopeValues } from "./creative-service.js";
import { SubmissionError } from "./gen/submission-ledger.js";

const sha256 = /^[a-f0-9]{64}$/;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const reject = (code: string, detail: string): never => { throw new SubmissionError(code, detail); };

/** Called under the existing render/preproduction lease and the same scoped DB session. */
export async function assertCreativeRenderBinding(input: {
  client: PoolClient; scope: CreativeScope; runId: string; attempt: number; promptsSha256: string;
  sourceProof: unknown; readFinal: (storageRef: string, sha256: string) => Promise<Buffer>;
}): Promise<void> {
  const { client, scope, runId } = input;
  const values = scopeValues(scope);
  const pending = await client.query(
    `SELECT 1 FROM video_pipeline_operations WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
       AND kind LIKE 'creative.%' AND state IN ('reserved','dispatched','unknown') LIMIT 1`, values,
  );
  if (pending.rowCount) return reject("CREATIVE_USAGE_UNKNOWN", "当前项目仍有创作费用待对账，不能签发或派发新的生成请求");
  const { rows: [run] } = await client.query<{
    status: string; next_action: string; plan_key: string; plan_hash: string; intent_hash: string;
  }>(`SELECT status,next_action,plan_key,plan_hash,intent_hash FROM video_pipeline_runs
       WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND id=$4`, [...values, runId]);
  if (run?.plan_key !== CREATIVE_PLAN && input.sourceProof === undefined) return;
  const proof = object(input.sourceProof);
  if (!proof || typeof proof.contractHash !== "string" || !sha256.test(proof.contractHash)
    || !run || run.plan_key !== CREATIVE_PLAN || proof.planHash !== run.plan_hash
    || run.status !== "completed" || run.next_action !== "done") {
    return reject("CREATIVE_SOURCE_UNVERIFIED", "当前预生产不是已完成并绑定计划的受控创作运行");
  }
  const contract = await latestCreativeContract(client, scope);
  if (!contract || contract.hash !== proof.contractHash || contract.rawIntentHash !== run.intent_hash) {
    return reject("CREATIVE_SOURCE_CHANGED", "创作合同已变更，旧提示词不能签发或提交");
  }
  try { assertCreativeContract(contract); }
  catch (error) { return reject("CREATIVE_SOURCE_UNVERIFIED", `创作合同无效或已过期：${error instanceof Error ? error.message : String(error)}`); }
  const { rows: [final] } = await client.query<{
    execution_status: string; verification_status: string; disposition: string; contract_hash: string; plan_hash: string;
    storage_ref: string; sha256: string; bytes: string; output_sha256: string; output_manifest_hash: string; bound: boolean;
  }>(`SELECT s.execution_status,s.verification_status,s.disposition,s.contract_hash,s.plan_hash,
      s.output_sha256,s.output_manifest_hash,a.storage_ref,a.sha256,a.bytes,b.run_id IS NOT NULL AS bound
      FROM production_stage_runs s
      LEFT JOIN video_creative_run_contracts b ON b.run_id=s.pipeline_run_id AND b.contract_hash=s.contract_hash
       AND b.tenant_id=$1 AND b.workspace_id=$2 AND b.project_id=$3
      LEFT JOIN video_artifacts a ON a.id=s.output_artifact_id AND a.stage_run_id=s.id AND a.pipeline_run_id=s.pipeline_run_id
       AND a.tenant_id=$1 AND a.workspace_id=$2 AND a.project_id=$3 AND a.role='creative-stage'
      WHERE s.workspace_id=$2 AND s.project_id=$3 AND s.pipeline_run_id=$4 AND s.stage_key='creative:final'
        AND s.item_key IS NULL ORDER BY s.revision DESC LIMIT 1`, [...values, runId]);
  if (!final || !final.bound || final.execution_status !== "completed" || final.verification_status !== "passed" || final.disposition !== "done"
    || final.contract_hash !== contract.hash || final.plan_hash !== run.plan_hash || !sha256.test(final.output_manifest_hash ?? "")
    || !sha256.test(final.sha256 ?? "") || final.output_sha256 !== final.sha256
    || final.storage_ref !== `artifacts/creative/${final.sha256}.json`) {
    return reject("CREATIVE_SOURCE_UNVERIFIED", "当前创作运行没有通过的最终阶段及同源产物");
  }
  let binding: Record<string, unknown> | null;
  try {
    const bytes = await input.readFinal(final.storage_ref, final.sha256);
    if (bytes.length !== Number(final.bytes) || createHash("sha256").update(bytes).digest("hex") !== final.sha256) {
      return reject("CREATIVE_SOURCE_CHANGED", "创作最终产物实际字节已改变");
    }
    const artifact = object(JSON.parse(bytes.toString("utf8")));
    binding = object(artifact?.renderBinding);
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    return reject("CREATIVE_SOURCE_CHANGED", "创作最终产物无法按已记录的摘要读取");
  }
  if (binding?.attempt !== input.attempt || binding.promptsSha256 !== input.promptsSha256) {
    return reject("CREATIVE_SOURCE_CHANGED", "创作最终产物与当前预生产提示词包不一致");
  }
}
