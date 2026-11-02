import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveStore, type StageLedgerWriter } from "@hyperreality/video-studio";

vi.mock("@workloom/base/workdata", () => ({ gatewayAppendOnClient: vi.fn(async () => ({ eventId: "EV-1" })) }));
vi.mock("@workloom/base/model-router", async original => ({ ...await original<Record<string, unknown>>(), MockGenProvider: class {}, genPoolFromEnv: () => new Map() }));
vi.mock("@workloom/shared", () => ({ newId: () => "VA-1" }));
vi.mock("./gen/providers.js", () => ({ videoGenPool: () => new Map() }));
vi.mock("./gen/ingest.js", () => ({ downloadToMediaStore: vi.fn(), registerRenderedClip: vi.fn() }));
vi.mock("./gen/db.js", () => ({ scopedQuery: vi.fn() }));
vi.mock("./gen/catalog.js", () => ({ findModelByProviderModel: () => null }));
vi.mock("./gen/cost.js", () => ({ recordRenderCost: vi.fn(async () => undefined), usdCnyRate: () => 7 }));
vi.mock("./archive-host.js", () => ({ makeStageArchive: () => null }));

import { pollRenderJobs } from "./render-poller.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("render result and archive receipt separation", () => {
  it("keeps an already completed job successful and exposes its recovery path when archive claim fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "render-archive-receipt-"));
    directories.push(directory);
    const store = new ArchiveStore(directory, "ws-test", "VID-1");
    await store.ensure();
    const ledger: StageLedgerWriter = {
      claimRun: vi.fn(async () => { throw new Error("fixture archive connection unavailable"); }),
      finishRun: vi.fn(async () => undefined), nextAttempt: vi.fn(async () => 1),
    };
    const job = { id: "RJ-ACCEPTED", task_id: "provider-existing-task", project_id: "VID-1", script_id: "RS-1",
      provider_model: "fixture-model", est_cny: null, est_usd: null, created_at: new Date().toISOString(),
      submit_payload: { decision: { after: { provider: "fixture-provider" } } } };
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => { queries.push(sql); return { rows: sql.includes("SELECT j.id") ? [job] : [], rowCount: 1 }; },
      release: vi.fn(),
    };
    const pool = { connect: async () => client, query: client.query } as unknown as pg.Pool;
    const provider = { providerId: "fixture-provider", poll: vi.fn(async () => ({ status: "succeeded", uri: "https://media.example.com/existing.mp4" })),
      submit: vi.fn(async () => { throw new Error("must never resubmit an accepted task"); }) };
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const report = await pollRenderJobs(pool, pool, { tenantId: "t-test", workspaceId: "ws-test" }, {
      pool: new Map([[provider.providerId, provider]]) as never, ingest: false, archive: { store, ledger },
    });
    expect(report).toMatchObject({ done: 1, failed: 0, checked: 1, details: [{ jobId: "RJ-ACCEPTED", status: "done" }] });
    expect(provider.submit).not.toHaveBeenCalled();
    expect(provider.poll).toHaveBeenCalledExactlyOnceWith("provider-existing-task");
    expect(queries.some(sql => sql.includes("UPDATE render_jobs"))).toBe(true);
    expect(ledger.finishRun).not.toHaveBeenCalled();
    const warning = errors.mock.calls.map(call => String(call[0])).find(value => value.startsWith("[render-poller]") && value.includes("档案回执待对账"));
    expect(warning).toContain("job=RJ-ACCEPTED");
    expect(warning).toContain("禁止重复提交");
    const recoveryRef = warning?.match(/产物=(unclaimed-outcomes\/[^；]+\.json)/u)?.[1];
    expect(recoveryRef).toBeTruthy();
    expect(await store.readJson(recoveryRef!)).toMatchObject({
      intendedStatus: "done", output: { jobId: "RJ-ACCEPTED", taskId: "provider-existing-task" },
    });
    expect((await store.readManifest())?.ledger).toEqual({});
  });
});
