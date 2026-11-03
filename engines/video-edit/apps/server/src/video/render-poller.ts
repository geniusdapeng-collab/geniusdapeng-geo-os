/**
 * video/render-poller.ts —— 渲染结果轮询回填（v3.0 下一迭代：异步任务制第二步）
 *
 * 扫描 render_jobs 中 submitted/rendering 的任务，经 gen-pool poll(task_id) 回填：
 *   succeeded → status='done' + result_url + render.complete 事件（actual_seconds 台账回填）
 *   failed    → status='failed' + render.failed 事件（原因留痕，不静默）
 *   running   → status 推进 'rendering'；查询未核实 → 保留原供应商任务
 * mock 任务（task_id 前缀 mock-）走 MockGenProvider（离线全流程可跑）。
 * 纪律：状态推进与事件同一事务同一 COMMIT（D16 同构）；provider 取自提交事件留痕。
 */
import type pg from "pg";
import { gatewayAppendOnClient } from "@workloom/base/workdata";
import {
  MockGenProvider, genPoolFromEnv, type GenProvider,
} from "@workloom/base/model-router";
import { newId } from "@workloom/shared";
import { videoGenPool } from "./gen/providers.js";
import { downloadToMediaStore, registerRenderedClip } from "./gen/ingest.js";
import { scopedQuery } from "./gen/db.js";
import { findModelByProviderModel } from "./gen/catalog.js";
import { recordRenderCost, usdCnyRate } from "./gen/cost.js";
import { classifyProviderError, logStageOutcome, type ArchiveStore, type StageLedgerWriter } from "@hyperreality/video-studio";
import { makeStageArchive } from "./archive-host.js";
import { sourceUrl } from "./marketing-source-fetcher.js";

interface Scope { tenantId: string; workspaceId: string }

interface OpenJob {
  id: string;
  task_id: string;
  script_id: string;
  project_id: string;
  provider: string | null;
  provider_model: string | null;
  mock: boolean;
  status: "submitted" | "rendering" | "done";
  result_url: string | null;
  asset_id: string | null;
  actual_seconds: number | null;
  actual_cny: string | null;
  actual_usd: string | null;
  cost_completed_at: Date | string | null;
  cost_provider: string | null;
  est_cny: string | null;
  est_usd: string | null;
  created_at: string;
  /** 提交事件原文（provider / request.aspectRatio 等留痕字段一次取回，避免重复扫事件表） */
  submit_payload: { decision?: { after?: { provider?: string; request?: { aspectRatio?: string } } } } | null;
}

/**
 * 超龄是对账信号；供应商仍可能已有可用产物。默认 24h 后在报告中提示，
 * 未取得明确终态前始终保留 task_id，不用本地时间替供应商判失败。
 */
const RENDER_JOB_TIMEOUT_H = Number(process.env.RENDER_JOB_TIMEOUT_H ?? 24);
function renderJobTimedOut(job: OpenJob): boolean {
  if (!(RENDER_JOB_TIMEOUT_H > 0)) return false;
  // created_at 由 pg 返回 Date（也兼容驱动配成字符串的部署），统一走 Date 构造避免格式猜测
  const ageMs = Date.now() - new Date(job.created_at).getTime();
  return Number.isFinite(ageMs) && ageMs > RENDER_JOB_TIMEOUT_H * 3600_000;
}

export interface PollReport {
  checked: number;
  done: number;
  failed: number;
  running: number;
  ingested: number;
  details: Array<{
    jobId: string; status: string; uri?: string; error?: string;
    assetId?: string; ingestError?: string; costError?: string;
  }>;
}

function recordedProvider(job: OpenJob): string | null {
  return job.provider ?? job.submit_payload?.decision?.after?.provider ?? (job.task_id.startsWith("mock-") ? "seedance" : null);
}

/** 真实已接受任务绝不可由 genPoolFromEnv 的 Seedance 模拟兜底接管。 */
function resolveProvider(
  pool: Map<string, GenProvider>,
  job: OpenJob,
  mockPool: Map<string, GenProvider>,
): GenProvider | null {
  const provider = recordedProvider(job);
  const eventProvider = job.submit_payload?.decision?.after?.provider;
  if (!provider || (eventProvider && job.provider && eventProvider !== job.provider)) return null;
  if (job.task_id.startsWith("mock-")) {
    return mockPool.get(provider) ?? mockPool.get("seedance") ?? null;
  }
  const adapter = pool.get(provider);
  return job.mock || !adapter || adapter.providerId !== provider || adapter instanceof MockGenProvider ? null : adapter;
}

function verifiedResultUri(value: unknown, provider: string, mock: boolean): value is string {
  if (typeof value !== "string" || !value || value !== value.trim()) return false;
  if (!mock && (provider === "whiteboard-local" || provider === "remotion-local") && value.startsWith("/")) {
    return !value.startsWith("//");
  }
  try {
    const uri = new URL(value);
    if (uri.username || uri.password) return false;
    if (mock) return uri.protocol === "mock:";
    if (provider === "whiteboard-local" || provider === "remotion-local") {
      return uri.protocol === "file:" && (!uri.host || uri.host === "localhost");
    }
    return Boolean(sourceUrl(value));
  } catch {
    return false;
  }
}

/**
 * 项目 kind → 媒资库片型（narrative / marketing / explainer）。
 *
 * T-2026-0926-0020：0042 起 `explainer`（口播解说片）是合法项目类型，
 * 白板片的产物不该被登记成 narrative——媒资库的片型筛选就是靠这一列。
 * 未知值按叙事片兜底（与既有行为一致，不因新增枚举引入空值）。
 */
export function pipelineKindOf(projectKind: string | null | undefined): "narrative" | "marketing" | "explainer" {
  if (projectKind === "marketing") return "marketing";
  if (projectKind === "explainer") return "explainer";
  return "narrative";
}

async function attachRenderedAsset(app: pg.Pool, gateway: pg.Pool, scope: Scope, job: OpenJob,
  uri: string, actualUnits: number | null, fetchImpl?: typeof fetch) {
  const provider = recordedProvider(job);
  if (!provider || !verifiedResultUri(uri, provider, false) || job.mock || job.task_id.startsWith("mock-")
    || (job.submit_payload?.decision?.after?.provider && job.provider && job.submit_payload.decision.after.provider !== job.provider)) {
    throw new Error("不能核实原任务的素材地址");
  }
  const source = (await scopedQuery<{ md: string; kind: string }>(app, scope,
    `SELECT s.md, p.kind FROM render_scripts s JOIN video_projects p
       ON p.id=s.project_id AND p.workspace_id=s.workspace_id
     WHERE s.workspace_id=$1 AND s.id=$2 AND p.id=$3`, [scope.workspaceId, job.script_id, job.project_id]))[0];
  if (!source) throw new Error("渲染脚本与项目不在当前作用域");
  const media = await downloadToMediaStore(uri, { workspaceId: scope.workspaceId, fetchImpl });
  const registered = await registerRenderedClip(app, gateway, scope, {
    assetId: newId("VA"), kind: "clip", projectId: job.project_id, sha256: media.sha256,
    sourceUrl: uri, localRelPath: media.relPath, provider, providerModel: job.provider_model ?? "",
    jobId: job.id, scriptId: job.script_id, seconds: actualUnits,
    title: `${job.project_id} · ${job.script_id}`, prompt: source.md.slice(0, 4000) || null,
    pipelineKind: pipelineKindOf(source.kind),
    aspectRatio: job.submit_payload?.decision?.after?.request?.aspectRatio ?? null, by: "render-poller",
  });
  const client = await gateway.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const updated = await client.query(
      `UPDATE render_jobs SET asset_id=$5, updated_at=clock_timestamp()
        WHERE id=$1 AND workspace_id=$2 AND task_id=$3 AND result_url=$4 AND status='done' AND asset_id IS NULL`,
      [job.id, scope.workspaceId, job.task_id, uri, registered.assetId]);
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return null;
    }
    await gatewayAppendOnClient(client, { ...scope, actor: { id: "render-poller", type: "system" } }, {
      who: { type: "system", id: "render-poller" },
      context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: new Date().toISOString() },
      object: { type: "render_job", id: job.id },
      decision: {
        action: "render.ingest",
        after: { task_id: job.task_id, provider, asset_id: registered.assetId, sha256: media.sha256, bytes: media.bytes, local_path: media.relPath },
        basis: ["已验证同一供应商任务的真实视频并回读本地字节"],
      },
      rule_impact: [],
    });
    await client.query("COMMIT");
    return { assetId: registered.assetId, localPath: media.relPath, sha256: media.sha256, bytes: media.bytes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function mediaFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/gi, "[供应商地址]").slice(0, 300);
}

export async function pollRenderJobs(
  app: pg.Pool,
  gateway: pg.Pool,
  scope: Scope,
  opts: {
    limit?: number;
    pool?: Map<string, GenProvider>;
    /** 成片入库开关（默认 true；测试可关） */
    ingest?: boolean;
    fetchImpl?: typeof fetch;
    /**
     * 制片档案句柄（T-2026-0926-0002）：
     *   - 缺省（undefined）= 按 HR_WORK_DIR/ARCHIVE_ENABLED 自建；
     *   - `null` = 显式关闭（测试用）；
     *   - 显式传入 = 复用调用方句柄（同一项目多次轮询共用一个 store）。
     */
    archive?: { store: ArchiveStore; ledger: StageLedgerWriter } | null;
  } = {},
): Promise<PollReport> {
  // 生成池：基座 provider（Kling/即梦等）与视频接缝 provider（Ark 带参数 / Higgsfield / MuAPI）合并，
  // 后者优先（同 providerId 时以视频接缝实现为准：带参数与报价口径）。
  const realPool = opts.pool ?? new Map<string, GenProvider>([...genPoolFromEnv(), ...videoGenPool()]);
  const mockPool = new Map<string, GenProvider>([
    ["seedance", new MockGenProvider("seedance")],
    ["kling", new MockGenProvider("kling")],
    ["jimeng", new MockGenProvider("jimeng")],
  ]);
  const report: PollReport = { checked: 0, done: 0, failed: 0, running: 0, ingested: 0, details: [] };
  /** 档案句柄（每个项目一个：同一 job 的多次轮询不会重复开 attempt，只有终态才记账） */
  const archiveCache = new Map<string, { store: ArchiveStore; ledger: StageLedgerWriter } | null>();
  const archiveFor = (projectId: string) => {
    if (opts.archive === null) return null;
    if (opts.archive) return opts.archive;
    if (!archiveCache.has(projectId)) archiveCache.set(projectId, makeStageArchive(scope, projectId));
    return archiveCache.get(projectId) ?? null;
  };

  const client = await app.connect();
  let jobs: OpenJob[];
  try {
    // 事务级 RLS 上下文必须在显式事务内设置（编码铁律）
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    // 开放任务 + 提交事件留痕的供应商（event 回放取 provider，无留痕回退推断）
    const rows = await client.query<OpenJob>(
      `SELECT j.id, j.task_id, j.script_id, j.project_id, j.provider, j.provider_model, j.mock,
              j.status, j.result_url, j.asset_id, j.actual_seconds, j.actual_cny, j.actual_usd, j.est_cny, j.est_usd, j.created_at,
              complete.completed_at AS cost_completed_at, complete.provider AS cost_provider,
              (SELECT e.payload
                 FROM biz_events e
                WHERE e.workspace_id=j.workspace_id AND e.tenant_id=w.tenant_id
                  AND e.payload->'decision'->>'action'='render.submit'
                  AND e.payload->'decision'->'after'->>'jobId'=j.id
                ORDER BY e.seq DESC LIMIT 1) AS submit_payload
         FROM render_jobs j JOIN workspaces w ON w.id=j.workspace_id
         LEFT JOIN budget_ledger b ON b.workspace_id=j.workspace_id AND b.idempotency_key='render:' || j.id
         LEFT JOIN LATERAL (
           SELECT e.created_at AS completed_at, e.payload->'decision'->'after'->>'provider' AS provider FROM biz_events e
            WHERE j.status='done' AND j.actual_cny IS NOT NULL AND b.id IS NULL
              AND e.workspace_id=j.workspace_id AND e.tenant_id=w.tenant_id
              AND e.payload->'object'->>'id'=j.id
              AND e.payload->'decision'->>'action'='render.complete'
              AND e.payload->'decision'->'after'->>'task_id'=j.task_id
              AND NULLIF(e.payload->'decision'->'after'->>'provider','') IS NOT NULL
              AND (j.provider IS NULL OR e.payload->'decision'->'after'->>'provider'=j.provider)
              AND e.payload->'decision'->'after'->'actual_cny'=to_jsonb(j.actual_cny)
            ORDER BY e.seq DESC LIMIT 1
         ) complete ON true
        WHERE j.workspace_id=$1 AND w.tenant_id=$2 AND j.task_id IS NOT NULL
          AND (j.status IN ('submitted','rendering') OR
            (j.status='done' AND j.result_url IS NOT NULL AND NOT j.mock
              AND j.task_id NOT LIKE 'mock-%' AND j.result_url NOT LIKE 'mock:%'
              AND (($4 AND j.asset_id IS NULL) OR complete.completed_at IS NOT NULL)))
        ORDER BY j.updated_at ASC, j.created_at ASC, j.id ASC
        LIMIT $3`,
      [scope.workspaceId, scope.tenantId, opts.limit ?? 20, opts.ingest !== false],
    );
    jobs = rows.rows;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  for (const job of jobs) {
    report.checked += 1;
    if (job.status === "done" && job.result_url) {
      // Provider success is already durable. Repair only missing local bookkeeping.
      const needsAsset = opts.ingest !== false && job.asset_id === null;
      const touched = await scopedQuery<{ id: string }>(app, scope, `UPDATE render_jobs SET updated_at=clock_timestamp()
        WHERE id=$1 AND workspace_id=$2 AND task_id=$3 AND result_url=$4 AND status='done' RETURNING id`,
        [job.id, scope.workspaceId, job.task_id, job.result_url]);
      if (!touched.length) {
        report.details.push({ jobId: job.id, status: "superseded" });
        continue;
      }
      const detail: PollReport["details"][number] = { jobId: job.id, status: "superseded" };
      if (job.cost_completed_at && job.cost_provider && job.actual_cny !== null) {
        try {
          await recordRenderCost(app, gateway, scope, {
            jobId: job.id, projectId: job.project_id, amountCny: Number(job.actual_cny),
            usd: job.actual_usd === null ? null : Number(job.actual_usd),
            provider: job.cost_provider, providerModel: job.provider_model ?? "",
            seconds: job.actual_seconds, by: "render-poller", occurredAt: new Date(job.cost_completed_at).toISOString(),
          });
          detail.status = "cost_settled";
        } catch (error) {
          detail.status = "cost_pending";
          detail.costError = mediaFailure(error);
        }
      }
      if (needsAsset) {
        try {
          const asset = await attachRenderedAsset(app, gateway, scope, job, job.result_url, job.actual_seconds, opts.fetchImpl);
          if (asset) {
            report.ingested += 1;
            detail.status = "ingested";
            detail.assetId = asset.assetId;
          }
        } catch (error) {
          detail.status = "ingest_pending";
          detail.ingestError = mediaFailure(error);
        }
      }
      report.details.push(detail);
      continue;
    }
    const provider = resolveProvider(realPool, job, mockPool);
    const mock = job.task_id.startsWith("mock-");
    let result: Awaited<ReturnType<GenProvider["poll"]>>;
    if (provider) {
      try {
        result = await provider.poll(job.task_id);
      } catch {
        result = { status: "submitted", error: "供应商查询未取得可核实的响应" };
      }
      if (result.status === "succeeded" && !verifiedResultUri(result.uri, provider.providerId, mock)) {
        result = { status: "submitted", error: "供应商报告成功，但尚无可核实的产物地址" };
      }
    } else {
      result = { status: "submitted", error: `当前无法使用原供应商 ${recordedProvider(job) ?? "（未记录）"} 核对该任务` };
    }

    if (provider && (result.status === "succeeded" || result.status === "failed")) {
      const done = result.status === "succeeded";

      // No verified price or units means unknown cost, not a zero-cost real render.
      const catalogModel = mock ? null : findModelByProviderModel(provider.providerId, job.provider_model ?? "", {});
      const actualUnits = typeof result.actualUnits === "number" && Number.isFinite(result.actualUnits)
        && result.actualUnits > 0 && result.actualUnits < 2_147_483_647 ? result.actualUnits : null;
      let actualUsd: number | null = null;
      let actualCny: number | null = null;
      let pricingMode: "catalog" | "unknown" = "unknown";
      if (done && catalogModel?.pricing?.usd != null && actualUnits !== null) {
        actualUsd = Math.round(catalogModel.pricing.usd * actualUnits * 10000) / 10000;
        actualCny = Math.round(actualUsd * usdCnyRate() * 100) / 100;
        pricingMode = "catalog";
      }

      const completedAt = new Date().toISOString();
      const gw = await gateway.connect();
      try {
        await gw.query("BEGIN");
        await gw.query("SELECT set_config('app.workspace_id', $1, true)", [scope.workspaceId]);
        await gw.query("SELECT set_config('app.tenant_id', $1, true)", [scope.tenantId]);
        const moved = await gw.query(
          `UPDATE render_jobs
              SET status=$3, result_url=$4, actual_seconds=$5, actual_usd=$6, actual_cny=$7, updated_at=now()
            WHERE id=$1 AND workspace_id=$2 AND task_id=$8 AND status IN ('submitted','rendering')`,
          [
            job.id, scope.workspaceId, done ? "done" : "failed", done ? result.uri : null,
            actualUnits === null ? null : Math.round(actualUnits), actualUsd, actualCny, job.task_id,
          ],
        );
        if (moved.rowCount !== 1) {
          await gw.query("ROLLBACK");
          report.details.push({ jobId: job.id, status: "superseded" });
          continue;
        }
        await gatewayAppendOnClient(gw, { ...scope, actor: { id: "render-poller", type: "system" } }, {
          who: { type: "system", id: "render-poller" },
          context: { tenant_id: scope.tenantId, workspace_id: scope.workspaceId, time: completedAt },
          object: { type: "render_job", id: job.id },
          decision: {
            action: done ? "render.complete" : "render.failed",
            after: {
              task_id: job.task_id, provider: provider.providerId,
              /** C-01 修复：mock 产物必须可辨识——此前只能靠 task_id 前缀推断，事件面与真实成片同形 */
              mock,
              result_url: done ? result.uri : null, error: result.error ?? null,
              actual_seconds: actualUnits,
              est_cny: job.est_cny === null ? null : Number(job.est_cny),
              actual_usd: actualUsd, actual_cny: actualCny, pricing: pricingMode,
              asset_id: null,
              local_path: null,
              // Local acceptance is a separate append-only render.ingest event.
              ingest: done ? { ok: false, status: mock ? "simulated" : "pending" } : null,
            },
            basis: [done ? "轮询回填：渲染成功（异步任务制第二步）" : `轮询回填：渲染失败（${result.error ?? "未知原因"}；不静默）`],
          },
          rule_impact: [],
          /**
           * 2026-09-20 真机测试修复：渲染完成必须带**外部回执**（无回执不算完成）。
           * 成功=Seedance 返回的成片 URL（synced:true，可回溯到供应商对象）；失败=无回执并标原因。
           * C-01 修复：mock 任务（task_id 前缀 mock-）的"成功"是本地模拟，不得携带 synced:true 假回执——
           * 此前 mock 完成事件写 synced:true+verified_at，账本层面与真实外部回执无法区分（假交付）。
           */
          ...(done && result.uri
            ? mock ? { receipt: { synced: false, mode: "simulated", snapshot_uri: result.uri } }
              : provider.providerId === "whiteboard-local" || provider.providerId === "remotion-local"
                ? { receipt: { synced: false, mode: "real", snapshot_uri: result.uri } }
                : { receipt: { synced: true, snapshot_uri: result.uri, verified_at: new Date().toISOString() } }
            : { receipt: { synced: false } }),
        });
        await gw.query("COMMIT");
      } catch (err) {
        await gw.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        gw.release();
      }

      // Only the terminal CAS winner attempts immediate ingestion; later polls can recover it.
      let ingested: Awaited<ReturnType<typeof attachRenderedAsset>> = null;
      let ingestError: string | null = null;
      if (done && result.uri && !mock && opts.ingest !== false) {
        try {
          ingested = await attachRenderedAsset(app, gateway, scope, job, result.uri, actualUnits, opts.fetchImpl);
        } catch (error) {
          ingestError = mediaFailure(error);
        }
      }

      /* 成本入账（幂等键 render:<jobId>；失败不推翻已完成事实，但必须留痕） */
      let costError: string | null = null;
      if (done && (mock || actualCny !== null)) {
        try {
          await recordRenderCost(app, gateway, scope, {
            jobId: job.id,
            projectId: job.project_id,
            amountCny: actualCny ?? 0,
            usd: actualUsd,
            provider: provider.providerId,
            providerModel: job.provider_model ?? "",
            seconds: actualUnits,
            mock,
            by: "render-poller",
            occurredAt: completedAt,
          });
        } catch (err) {
          costError = err instanceof Error ? err.message : String(err);
          console.error(`[render-poller] 成本入账失败 job=${job.id}：${costError}`);
        }
      }

      if (done) report.done += 1; else report.failed += 1;
      if (ingested) report.ingested += 1;

      /* 环节台账：每个 job 的终态迁移记一次 attempt（append-only） */
      const archiveWriter = archiveFor(job.project_id);
      if (archiveWriter) {
        try {
          const archiveReceipt = await logStageOutcome(archiveWriter.store, archiveWriter.ledger, {
            stageId: "renderPoll",
            status: done ? "done" : "failed",
            input: { jobId: job.id, taskId: job.task_id, provider: provider.providerId, scriptId: job.script_id },
            output: {
              jobId: job.id,
              taskId: job.task_id,
              assetId: ingested?.assetId ?? null,
              provider: provider.providerId,
              providerModel: job.provider_model ?? null,
              actualSeconds: actualUnits,
              actualCny: actualCny,
              pricing: pricingMode,
              resultUrl: result.uri ?? null,
              ingest: done ? (ingestError ? { ok: false, error: ingestError } : { ok: Boolean(ingested) }) : null,
            },
            errorClass: done ? null : classifyProviderError(result.error ?? "provider failed"),
            errorMsg: done ? null : (result.error ?? "供应商返回 failed（无原因文本）"),
            cost: { cashCny: actualCny },
            runId: null,
          });
          if (archiveReceipt.error) {
            console.error(`[render-poller] 档案回执待对账 job=${job.id}：${archiveReceipt.error}；产物=${archiveReceipt.outputRef ?? "未落盘"}；保留原任务，禁止重复提交`);
          }
        } catch (err) {
          console.error(`[render-poller] 档案记账失败（不影响回填）job=${job.id}：${(err as Error).message}`);
        }
      }

      report.details.push({
        jobId: job.id, status: done ? "done" : "failed", uri: result.uri,
        error: result.error, assetId: ingested?.assetId,
        ingestError: ingestError ?? undefined, costError: costError ?? undefined,
      });
    } else {
      // RLS 的 GUC 必须与更新同事务；更新时间也让老的未核实任务不饿死队尾。
      const moved = await scopedQuery<{ id: string }>(app, scope,
        `UPDATE render_jobs SET status=CASE WHEN $4 THEN 'rendering' ELSE status END, updated_at=clock_timestamp()
         WHERE id=$1 AND workspace_id=$2 AND task_id=$3 AND status IN ('submitted','rendering') RETURNING id`,
        [job.id, scope.workspaceId, job.task_id, result.status === "running"]);
      if (moved.length === 0) {
        report.details.push({ jobId: job.id, status: "superseded" });
        continue;
      }
      const overdue = renderJobTimedOut(job);
      const unverified = Boolean(result.error) || overdue;
      const error = [result.error, overdue ? `已超 ${RENDER_JOB_TIMEOUT_H}h，仍保留原任务等待供应商对账` : null]
        .filter(Boolean).join("；") || undefined;
      /**
       * 进度心跳（T-2026-0926-0002，规格书 §6.2 改动 B）：
       * "慢" 与 "死" 必须可区分——in-flight 只写档案事件（带 jobId/taskId），不开新 attempt，
       * 避免每拍轮询都污染台账（台账只记终态迁移）。
       */
      const heartbeatArchive = archiveFor(job.project_id);
      if (heartbeatArchive) {
        try {
          await heartbeatArchive.store.appendJsonl("events.jsonl", {
            kind: "stage.heartbeat",
            stageId: "renderPoll",
            jobId: job.id,
            taskId: job.task_id,
            provider: recordedProvider(job),
            status: unverified ? "poll_pending" : result.status,
            ...(error ? { error } : {}),
          });
        } catch (err) {
          console.error(`[render-poller] 档案心跳写入失败（不影响回填）job=${job.id}：${(err as Error).message}`);
        }
      }
      report.running += 1;
      report.details.push({ jobId: job.id, status: unverified ? "poll_pending" : "running", ...(error ? { error } : {}) });
    }
  }
  return report;
}
