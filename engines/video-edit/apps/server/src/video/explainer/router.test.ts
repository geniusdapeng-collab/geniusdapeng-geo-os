/** Actual tRPC caller with explicit engine, database and provider boundaries. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrpcContext } from "../../trpc/context.js";
const f = vi.hoisted(() => ({ project: vi.fn(), latest: vi.fn(), query: vi.fn(), job: vi.fn(), prepare: vi.fn(),
  engine: vi.fn(), annotate: vi.fn(), submit: vi.fn(), loadRules: vi.fn(), judge: vi.fn(), budget: vi.fn(),
  lease: vi.fn(), release: vi.fn(), update: vi.fn() }));
vi.mock("../../service/access-authority.js", async original => ({ ...await original<Record<string, unknown>>(),
  currentMemberAuthority: async (identity: unknown) => ({ identity, permissions: {} }),
  memberAccessGrants: () => ({ actionPermissions: ["workspace.write"] }),
}));
vi.mock("./db.js", async original => ({ ...await original<Record<string, unknown>>(),
  projectOf: f.project, latestShotbook: f.latest, scopedQuery: f.query, renderJobOf: f.job, updateShotbook: f.update,
}));
vi.mock("./pipeline.js", () => ({ runExplainerPipeline: f.prepare }));
vi.mock("./engine.js", async original => ({ ...await original<Record<string, unknown>>(), engineStatus: f.engine }));
vi.mock("./semantics.js", async original => ({ ...await original<Record<string, unknown>>(), annotateSemantics: f.annotate }));
vi.mock("../gen/submit.js", () => ({ submitGenJob: f.submit }));
vi.mock("../router.js", () => ({ loadActiveRules: f.loadRules }));
vi.mock("../archive-host.js", async original => ({ ...await original<Record<string, unknown>>(), acquireProjectLease: f.lease }));
vi.mock("@workloom/base/fence-engine", async original => ({ ...await original<Record<string, unknown>>(), judgeViews: f.judge }));
vi.mock("@workloom/base/model-router", async original => ({ ...await original<Record<string, unknown>>(), checkRenderBudget: f.budget }));
vi.mock("@workloom/db", async original => ({ ...await original<Record<string, unknown>>(), getAppPool: () => ({}), getGatewayPool: () => ({}) }));
import { explainerRouter } from "./router.js";

const scope = { tenantId: "tenant-explainer", workspaceId: "ws-explainer" };
const identity = { ...scope, memberNo: "MEM-T", plan: "pro", role: "owner" } as NonNullable<TrpcContext["identity"]>;
const context: TrpcContext = { identity, session: identity, partnerIdentity: null, headers: new Headers() };
const caller = () => explainerRouter.createCaller(context);
const projectId = "VID-FIXTURE";
const row = { id: "SB-1", project_id: projectId, version: 2, script_text: "解释一个案例。", shotbook: { shots: [{ card: "text", start: 0, end: 5 }] } };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TALKCRAFT_ENABLED", "1");
  vi.stubEnv("WORKLOOM_VOICE_BRIDGE_TENANT", scope.workspaceId);
  vi.stubEnv("WORKLOOM_VOICE_PROFILE", "scope-authorized");
  f.project.mockResolvedValue({ id: projectId, kind: "explainer" });
  f.latest.mockResolvedValue(row); f.query.mockResolvedValue([]); f.job.mockResolvedValue(null);
  f.engine.mockReturnValue({ installed: true, ready: true });
  f.annotate.mockRejectedValue(new Error("unexpected semantics dispatch"));
  f.prepare.mockRejectedValue(new Error("unexpected preparation dispatch"));
  f.lease.mockResolvedValue({ release: f.release });
  f.loadRules.mockResolvedValue({ rules: [], defaultLevel: "review" });
  f.judge.mockReturnValue({ level: "auto", impacts: [], triggeredBy: [] });
  f.budget.mockReturnValue({ allowed: true });
});
afterEach(() => vi.unstubAllEnvs());

describe("explainer preflight through the tRPC entry", () => {
  it.each([null, { id: projectId, kind: "marketing" }])("checks project kind before shotbook engine work (%j)", async project => {
    f.project.mockResolvedValue(project);
    await expect(caller().shotbook({ projectId, scriptText: "解释一个案例。" })).rejects.toMatchObject({
      code: project ? "PRECONDITION_FAILED" : "NOT_FOUND",
    });
    expect(f.project).toHaveBeenCalledWith(scope, projectId);
    expect(f.engine).not.toHaveBeenCalled();
    expect(f.annotate).not.toHaveBeenCalled();
  });
  it.each([
    { voiceSource: "upload", uploadConfirmed: true, uploadPath: "/private/fixture/recording.wav" },
    { hostAssets: { default: "/private/fixture/host.mp4" } },
    { assets: [{ from: "/private/fixture/source", to: "../../src/index.ts" }] },
  ])("rejects caller filesystem paths before preparation (%j)", async patch => {
    await expect(caller().submit({ projectId, ...patch } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("blocks preparation before paid work when current G8 blocks", async () => {
    f.judge.mockReturnValue({ level: "block", impacts: [], triggeredBy: ["fixture-block"] });
    await expect(caller().submit({ projectId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });
  it("rejects concurrent submit before duplicate preparation", async () => {
    f.lease.mockResolvedValueOnce(null);
    await expect(caller().submit({ projectId })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(["wrong station scope", "untrusted profile", "disabled engine"])("stops before paid work for %s", async kind => {
    if (kind === "wrong station scope") vi.stubEnv("WORKLOOM_VOICE_BRIDGE_TENANT", "other-workspace");
    if (kind === "disabled engine") vi.stubEnv("TALKCRAFT_ENABLED", "0");
    await expect(caller().submit({ projectId, ...(kind === "untrusted profile" ? { voiceProfile: "other-voice" } : {}) }))
      .rejects.toMatchObject({ code: kind === "disabled engine" ? "PRECONDITION_FAILED" : "FORBIDDEN" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.submit).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(["same workspace", "cross workspace", "symlink", "changed bytes"])("resolves real scoped audio bytes (%s)", async kind => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "explainer-scoped-media-")));
    vi.stubEnv("WORKLOOM_MEDIA_DIR", root);
    try {
      const bytes = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfixture");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const prefix = kind === "cross workspace" ? "other-workspace" : scope.workspaceId;
      const rel = `upload/${prefix}/${sha256}.wav`;
      const file = join(root, rel), privateFile = join(root, "private.wav");
      mkdirSync(join(root, "upload", prefix), { recursive: true });
      writeFileSync(privateFile, bytes);
      if (kind === "symlink") symlinkSync(privateFile, file);
      else writeFileSync(file, kind === "changed bytes" ? Buffer.from("changed") : bytes);
      f.query.mockImplementation(async (sql, params) => {
        if (!String(sql).includes("FROM video_assets")) return [];
        expect(params).toEqual([scope.tenantId, scope.workspaceId, "VA-fixture", ["upload_audio"]]);
        return [{ path: rel, sha256 }];
      });
      await expect(caller().submit({ projectId, voiceSource: "upload", uploadAssetId: "VA-fixture" }))
        .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      if (kind === "same workspace") {
        expect(f.prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          voice: expect.objectContaining({ source: "upload", uploadPath: file, uploadSha256: sha256, confirmed: false }),
        }));
      } else expect(f.prepare).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
