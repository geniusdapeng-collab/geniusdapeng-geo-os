/**
 * archive/stage-log.ts —— 一次性环节记账（渲染提交/渲染轮询/后期/交付段用；T-2026-0926-0002）
 *
 * 与 `StageRunner` 的分工：
 *   - `StageRunner`：**包住一段执行**（预生产），5 写盘点 + 异常固化 + 原样上抛；
 *   - 本模块：**事后记一次结果**（轮询回填、提交动作），调用点已经有结果/错误，只需落盘 + 入台账。
 *
 * 口径：
 *   - 每次"状态迁移"= 新 attempt（append-only，历史不丢）；重复轮询同一 job 不重复记账；
 *   - `status='skipped'`（例如幂等命中旧 job）**只写档案事件，不新开 attempt**——避免把"没做事"
 *     记成一次执行，污染监控的失败率/成本统计（规格书 §6.3 改动 A 的口径澄清）；
 *   - 台账不可用时只 `console.error`，主流程语义零变化（旁路不阻断）。
 */
import { randomUUID } from "node:crypto";
import type { ArchiveStore } from "./store.js";
import { newStageRunId, type StageLedgerWriter, type StageStatus } from "./stage-runner.js";

export interface StageLogInput {
  stageId: string;
  status: Extract<StageStatus, "done" | "failed" | "skipped">;
  /** 入参快照（可空；有值时写 attempt-<n>.input.json 并进 input_ref） */
  input?: Record<string, unknown> | null;
  /** 产物/指针（可空；有值时先落盘再翻状态） */
  output?: Record<string, unknown> | null;
  errorClass?: string | null;
  errorMsg?: string | null;
  cost?: Record<string, unknown>;
  runId?: string | null;
  /** skipped 时的原因（进事件流，便于审计"为什么没做事"） */
  skipReason?: string | null;
}

export interface StageLogResult {
  /** null = 本次没有开新 attempt（skipped 或台账不可用） */
  attempt: number | null;
  /** 回执未核实时指向独立待对账记录，不是已完成 attempt 的产物回执。 */
  outputRef: string | null;
  outputSha256: string | null;
  error: string | null;
}

/**
 * 记一次环节结果。返回 `error` 表示档案侧没记全（调用方可忽略——旁路不阻断）。
 */
export async function logStageOutcome(
  store: ArchiveStore,
  ledger: StageLedgerWriter,
  input: StageLogInput,
): Promise<StageLogResult> {
  const startedAt = Date.now();
  const dir = `stages/${input.stageId}`;
  const result: StageLogResult = { attempt: null, outputRef: null, outputSha256: null, error: null };

  if (input.status === "skipped") {
    // 不新开 attempt：只留事件（口径见文件头）
    try {
      await store.appendJsonl("events.jsonl", {
        kind: "stage.skipped",
        stageId: input.stageId,
        reason: input.skipReason ?? null,
        ...(input.output ?? {}),
      });
    } catch (err) {
      result.error = (err as Error).message;
      console.error(`[archive] skipped 事件写入失败(${input.stageId}): ${result.error}`);
    }
    return result;
  }

  const recovery = async (error: unknown, code: string): Promise<StageLogResult> => {
    result.error = `${code}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[archive] 档案回执待对账(${input.stageId}): ${result.error}`);
    // 业务动作已经返回，档案失败不能要求调用方重复付费。独立保存原结果，
    // 不覆盖任何已认领 attempt；产物指针不能被误认成已完成的台账回执。
    try {
      const recoveryRef = `unclaimed-outcomes/${randomUUID()}.json`;
      const written = await store.writeJsonAtomic(recoveryRef, {
        stageId: input.stageId, intendedStatus: input.status, runId: input.runId ?? null,
        attempt: result.attempt, input: input.input ?? null, output: input.output ?? null,
        cost: input.cost ?? null, errorClass: input.errorClass ?? null, errorMsg: input.errorMsg ?? null,
        receiptError: result.error, recordedAt: new Date().toISOString(),
        recovery: "reconcile-existing-result-do-not-repeat-external-action",
      });
      result.outputRef = recoveryRef;
      result.outputSha256 = written.sha256;
    } catch (archiveError) {
      result.error += `; recovery-write-failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`;
      console.error(`[archive] 待对账结果写入失败(${input.stageId}): ${result.error}`);
    }
    return result;
  };

  let attempt: number;
  let inputRef: string;
  try {
    const claimed = await ledger.claimRun({
      id: newStageRunId(), projectId: store.projectId, stageId: input.stageId,
      inputRefTemplate: `${dir}/attempt-{attempt}.input.json`, runId: input.runId ?? null,
    });
    if (!Number.isSafeInteger(claimed.attempt) || claimed.attempt < 1
      || claimed.inputRef !== `${dir}/attempt-${claimed.attempt}.input.json`) {
      throw new Error("STAGE_CLAIM_INVALID: 台账未返回匹配的 attempt 与 input_ref");
    }
    attempt = claimed.attempt;
    inputRef = claimed.inputRef;
    result.attempt = attempt;
  } catch (err) {
    return recovery(err, "STAGE_CLAIM_UNVERIFIED");
  }

  let finishAttempted = false;
  try {
    if (input.input) {
      await store.writeJsonAtomic(inputRef, {
        stageId: input.stageId, attempt, input: input.input, startedAt: new Date().toISOString(),
      });
    }
    /* 产物先落盘，状态后翻转：失败不得生成缺少产物摘要的 done。 */
    if (input.output) {
      const outputRef = `${dir}/attempt-${attempt}.output.json`;
      const written = await store.writeJsonAtomic(outputRef, input.output);
      result.outputRef = outputRef;
      result.outputSha256 = written.sha256;
    }
    finishAttempted = true;
    await ledger.finishRun({
      projectId: store.projectId, stageId: input.stageId, attempt, status: input.status,
      outputRef: result.outputRef, outputSha256: result.outputSha256,
      errorClass: input.errorClass ?? null, errorMsg: input.errorMsg ? input.errorMsg.slice(0, 500) : null,
      durationMs: Date.now() - startedAt, cost: input.cost,
    });
  } catch (err) {
    if (!finishAttempted) {
      // 文件失败时 PG attempt 确实存在，但原业务动作的完成档案尚未成立。
      // 已尝试终结却丢确认时不写另一终态，保留原回执供对账，避免覆盖未知结果。
      try {
        await ledger.finishRun({
          projectId: store.projectId, stageId: input.stageId, attempt, status: "interrupted",
          outputRef: result.outputRef, outputSha256: result.outputSha256,
          errorClass: "RECEIPT_UNVERIFIED", errorMsg: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
          durationMs: Date.now() - startedAt, cost: input.cost,
        });
      } catch (receiptError) {
        console.error(`[archive] 中断回执未核实(${input.stageId}): ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`);
      }
    }
    return recovery(err, "STAGE_RECEIPT_UNVERIFIED");
  }

  // PG 已确认相同终态，才允许文件投影和完成事件显示该状态。
  try {
    await store.updateLedger(input.stageId, {
      attempt, status: input.status, finishedAt: new Date().toISOString(),
    });
    await store.appendJsonl("events.jsonl", {
      kind: `stage.${input.status}`, stageId: input.stageId, attempt,
      ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    });
  } catch (err) {
    return recovery(err, "STAGE_ARCHIVE_PROJECTION_UNVERIFIED");
  }
  return result;
}
