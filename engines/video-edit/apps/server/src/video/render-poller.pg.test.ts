import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockGenProvider, type GenProvider } from "@workloom/base/model-router";
import { ArkVideoProvider } from "./gen/providers.js";
import { getModel } from "./gen/catalog.js";
import { pollRenderJobs } from "./render-poller.js";

const isolated = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL
  && process.env.DATABASE_APP_URL && process.env.DATABASE_GATEWAY_URL);

describe.runIf(isolated)("provider result authority (real PostgreSQL and actual poll protocol)", () => {
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const app = new pg.Pool({ connectionString: process.env.DATABASE_APP_URL });
  const gateway = new pg.Pool({ connectionString: process.env.DATABASE_GATEWAY_URL });
  const tenantId = `poll-tenant-${randomUUID()}`;
  const otherTenantId = `poll-tenant-${randomUUID()}`;
  beforeAll(async () => {
    await owner.query("INSERT INTO tenants(id,name) VALUES($1,$1),($2,$2)", [tenantId, otherTenantId]);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app.end(), gateway.end()]);
  });

  async function fixture(workspaceId = `poll-ws-${randomUUID()}`, taskId = `accepted-${randomUUID()}`, hours = 0) {
    const projectId = `poll-project-${randomUUID()}`, scriptId = `poll-script-${randomUUID()}`, jobId = `poll-job-${randomUUID()}`;
    await owner.query("INSERT INTO workspaces(id,tenant_id,name,slug) VALUES($1,$2,$1,$1) ON CONFLICT(id) DO NOTHING",
      [workspaceId, tenantId]);
    await owner.query("INSERT INTO video_projects(id,workspace_id,title,kind,created_by) VALUES($1,$2,$1,'marketing','fixture')", [projectId, workspaceId]);
    await owner.query(`INSERT INTO render_scripts(id,workspace_id,project_id,shot_id,script_key,version,md,created_by)
      VALUES($1,$2,$3,'shot-1',$1,1,'fixture prompt','fixture')`, [scriptId, workspaceId, projectId]);
    await owner.query(`INSERT INTO render_jobs(id,workspace_id,project_id,script_id,script_version,task_id,provider,created_at,updated_at)
      VALUES($1,$2,$3,$4,1,$5,'seedance',now()-$6*interval '1 hour',now()-$6*interval '1 hour')`,
    [jobId, workspaceId, projectId, scriptId, taskId, hours]);
    const row = async () => (await owner.query("SELECT status,task_id,result_url,asset_id FROM render_jobs WHERE id=$1", [jobId])).rows[0];
    const terminal = async () => (await owner.query(`SELECT payload->'decision'->>'action' AS action, payload->'receipt' AS receipt
      FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2
      AND payload->'decision'->>'action' IN ('render.complete','render.failed') ORDER BY seq`, [workspaceId, jobId])).rows;
    const poll = (provider?: GenProvider, options: Parameters<typeof pollRenderJobs>[3] = {}, scopeTenant = tenantId) =>
      pollRenderJobs(app, gateway, { tenantId: scopeTenant, workspaceId }, {
        pool: new Map(provider ? [[provider.providerId, provider]] : []),
        ingest: false, archive: null, ...options,
      });
    return { workspaceId, jobId, taskId, row, terminal, poll };
  }

  function provider(poll: GenProvider["poll"]): GenProvider {
    return { providerId: "seedance", kind: "video", healthy: async () => true, poll,
      submit: vi.fn(async () => { throw new Error("polling must never submit a new paid job"); }) };
  }

  it("keeps an existing real job unverified when only a mock is configured; a true fixture stays marked simulated", async () => {
    const real = await fixture(undefined, undefined, 72);
    const mock = new MockGenProvider("seedance");
    const mockPoll = vi.spyOn(mock, "poll");
    await expect(real.poll(mock)).resolves.toMatchObject({ done: 0, failed: 0, details: [{ status: "poll_pending" }] });
    expect(await real.row()).toMatchObject({ status: "submitted", task_id: real.taskId, result_url: null });
    expect(await real.terminal()).toEqual([]);
    expect(mockPoll).not.toHaveBeenCalled();
    await owner.query("UPDATE render_jobs SET provider=NULL WHERE id=$1", [real.jobId]);
    const guessed = vi.fn<GenProvider["poll"]>();
    await expect(real.poll(provider(guessed))).resolves.toMatchObject({ done: 0, failed: 0, details: [{ status: "poll_pending" }] });
    expect(guessed).not.toHaveBeenCalled();

    const simulation = await fixture(undefined, "mock-seedance-fixture");
    await expect(simulation.poll()).resolves.toMatchObject({ done: 1, ingested: 0 });
    expect(await simulation.terminal()).toMatchObject([{ action: "render.complete", receipt: { synced: false, mode: "simulated" } }]);
  });

  it("polls the same old task through limit, outage, queue, wrong task identity and incomplete success", async () => {
    const job = await fixture(undefined, undefined, 72);
    const url = "https://media.example.com/clip.mp4";
    const responses = [[429, { error: { message: "limited" } }], [503, { error: { message: "outage" } }],
      [200, { id: job.taskId, status: "queued" }],
      [200, { status: "succeeded", content: { video_url: url } }],
      [200, { id: "other-provider-task", status: "succeeded", content: { video_url: url } }],
      [200, { id: job.taskId, status: "succeeded" }],
      [200, { id: job.taskId, status: "succeeded", content: { video_url: url } }]] as const;
    const paths: string[] = [];
    const server = createServer((request, response) => {
      const [status, body] = responses[paths.length]!;
      paths.push(`${request.method} ${request.url}`);
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture server has no port");
      const ark = new ArkVideoProvider({ apiKey: "fixture", baseUrl: `http://127.0.0.1:${address.port}` });
      for (let i = 0; i < responses.length - 1; i += 1) {
        await expect(job.poll(ark)).resolves.toMatchObject({ done: 0, failed: 0 });
        expect(await job.row()).toMatchObject({ task_id: job.taskId, result_url: null });
        expect(await job.terminal()).toEqual([]);
      }
      await expect(job.poll(ark)).resolves.toMatchObject({ done: 1, failed: 0, details: [{ uri: url }] });
      expect(await job.terminal()).toMatchObject([{ action: "render.complete", receipt: { synced: true, snapshot_uri: url } }]);
      expect(paths).toEqual(Array(responses.length).fill(`GET /contents/generations/tasks/${job.taskId}`));
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("commits one terminal event when two workers read the same accepted task", async () => {
    const job = await fixture();
    let calls = 0;
    let both!: () => void;
    const bothStarted = new Promise<void>(resolve => { both = resolve; });
    const native = provider(async () => {
      if (++calls === 2) both();
      await bothStarted;
      return { status: "succeeded", uri: "https://media.example.com/clip.mp4", actualUnits: 5 };
    });
    const reports = await Promise.all([job.poll(native), job.poll(native)]);
    expect(calls).toBe(2);
    expect(reports.reduce((sum, report) => sum + report.done, 0)).toBe(1);
    expect(await job.terminal()).toHaveLength(1);
    expect(native.submit).not.toHaveBeenCalled();
    expect(gateway.idleCount).toBe(gateway.totalCount);
  });

  it("blocks mismatched scope and a remote provider's local path; only an actual terminal error fails", async () => {
    const job = await fixture();
    const poll = vi.fn<GenProvider["poll"]>()
      .mockResolvedValueOnce({ status: "succeeded", uri: "file:///private/remote-provider-claim.mp4" })
      .mockResolvedValueOnce({ status: "succeeded", uri: "http://169.254.169.254/claim.mp4" })
      .mockResolvedValueOnce({ status: "failed", error: "provider returned terminal expired" });
    const native = provider(poll);
    await expect(job.poll(native, {}, otherTenantId)).resolves.toMatchObject({ checked: 0 });
    expect(poll).not.toHaveBeenCalled();
    await expect(job.poll(native)).resolves.toMatchObject({ done: 0, failed: 0, details: [{ status: "poll_pending" }] });
    await expect(job.poll(native)).resolves.toMatchObject({ done: 0, failed: 0, details: [{ status: "poll_pending" }] });
    expect(await job.terminal()).toEqual([]);
    await expect(job.poll(native)).resolves.toMatchObject({ failed: 1, done: 0 });
    expect(await job.terminal()).toMatchObject([{ action: "render.failed", receipt: { synced: false } }]);
  });

  it("rotates an old unverified job behind the next eligible job rather than starving the queue", async () => {
    const old = await fixture(undefined, undefined, 72);
    const fresh = await fixture(old.workspaceId);
    const seen: string[] = [];
    const native = provider(async taskId => {
      seen.push(taskId);
      return { status: "submitted", error: "fixture provider query temporarily unavailable" };
    });
    for (let i = 0; i < 2; i += 1) {
      await expect(old.poll(native, { limit: 1 })).resolves.toMatchObject({ checked: 1, failed: 0 });
    }
    expect(seen).toEqual([old.taskId, fresh.taskId]);
  });

  it("recovers actual local media after download failure and rejects an HTTP success containing HTML", async () => {
    const job = await fixture();
    const directory = mkdtempSync(join(tmpdir(), "render-poll-recovery-"));
    vi.stubEnv("WORKLOOM_MEDIA_DIR", join(directory, "media"));
    try {
      const source = join(directory, "fixture.mp4");
      execFileSync(process.env.WL_FFMPEG || "ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=black:s=64x64:r=10",
        "-t", "0.2", "-c:v", "mpeg4", source], { timeout: 10_000 });
      const bytes = readFileSync(source);
      const url = "https://media.example.com/existing-result.mp4";
      const nativePoll = vi.fn<GenProvider["poll"]>().mockResolvedValue({ status: "succeeded", uri: url, actualUnits: 5 });
      const native = provider(nativePoll);
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response("<html>expired edge response</html>", { headers: { "content-type": "video/mp4" } }))
        .mockResolvedValueOnce(new Response(new Uint8Array(bytes), { headers: { "content-type": "video/mp4" } }));
      await expect(job.poll(native, { ingest: true, fetchImpl })).resolves.toMatchObject({ done: 1, ingested: 0, details: [{ ingestError: expect.stringContaining("503") }] });
      expect(await job.row()).toMatchObject({ status: "done", asset_id: null, result_url: url });
      await expect(job.poll(native, { ingest: true, fetchImpl })).resolves.toMatchObject({ done: 0, ingested: 0, details: [{ status: "ingest_pending" }] });
      expect(await job.row()).toMatchObject({ status: "done", asset_id: null });
      await expect(job.poll(native, { ingest: true, fetchImpl })).resolves.toMatchObject({ done: 0, ingested: 1, details: [{ status: "ingested" }] });
      const row = await job.row();
      expect(row).toMatchObject({ status: "done", asset_id: expect.any(String), result_url: url });
      const stored = (await owner.query("SELECT meta->>'localPath' AS path, duration_seconds, meta->>'providerReportedSeconds' AS reported FROM video_assets WHERE id=$1", [row.asset_id])).rows[0];
      expect(readFileSync(join(directory, "media", stored.path))).toEqual(bytes);
      expect(Number(stored.duration_seconds)).toBeCloseTo(0.2, 2);
      expect(stored.reported).toBe("5");
      const events = await owner.query(`SELECT payload->'decision'->>'action' AS action
        FROM biz_events WHERE workspace_id=$1 AND payload->'object'->>'id'=$2 ORDER BY seq`, [job.workspaceId, job.jobId]);
      expect(events.rows).toEqual([{ action: "render.complete" }, { action: "render.ingest" }]);
      expect(nativePoll).toHaveBeenCalledExactlyOnceWith(job.taskId);
      expect(native.submit).not.toHaveBeenCalled();
      expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([url, url, url]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("books the durable known amount after an interrupted cost write without contacting the provider", async () => {
    const job = await fixture();
    const model = getModel("hf-seedance-2-0-t2v");
    if (!model?.pricing?.usd) throw new Error("fixture needs a priced video model");
    await owner.query("UPDATE render_jobs SET provider=$2, provider_model=$3 WHERE id=$1", [job.jobId, model.provider, model.providerModel]);
    const resultUri = "https://media.example.com/already-accepted.mp4";
    const wire = vi.fn<GenProvider["poll"]>().mockResolvedValue({ status: "succeeded", uri: resultUri, actualUnits: 5 });
    const native = { ...provider(wire), providerId: model.provider };
    let failure = 0;
    const faultyApp = {
      async connect() {
        const client = await app.connect();
        return {
          query(sql: string, params?: unknown[]) {
            if (/INSERT INTO budget_ledger/.test(sql) && failure++ === 0) throw new Error("fixture settlement outage");
            return client.query(sql, params);
          },
          release() { client.release(); },
        };
      },
    } as unknown as pg.Pool;
    await expect(pollRenderJobs(faultyApp, gateway, { tenantId, workspaceId: job.workspaceId }, {
      pool: new Map([[native.providerId, native]]), ingest: false, archive: null,
    })).resolves.toMatchObject({ done: 1, details: [{ costError: "fixture settlement outage" }] });
    await expect(job.poll(native)).resolves.toMatchObject({ checked: 1, done: 0, ingested: 0, details: [{ status: "cost_settled" }] });
    await expect(job.poll(native)).resolves.toMatchObject({ checked: 0 });
    expect(wire).toHaveBeenCalledExactlyOnceWith(job.taskId);
    expect(native.submit).not.toHaveBeenCalled();
    expect(await job.terminal()).toHaveLength(1);
    const rows = await owner.query(`SELECT b.amount=j.actual_cny AS exact_amount, b.occurred_at=e.created_at AS original_time,
             b.ref_event_id FROM render_jobs j
       JOIN budget_ledger b ON b.workspace_id=j.workspace_id AND b.idempotency_key='render:' || j.id
       JOIN biz_events e ON e.workspace_id=j.workspace_id AND e.payload->'object'->>'id'=j.id
        AND e.payload->'decision'->>'action'='render.complete' WHERE j.id=$1`, [job.jobId]);
    expect(rows.rows).toEqual([{ exact_amount: true, original_time: true, ref_event_id: expect.any(String) }]);
  });
});
