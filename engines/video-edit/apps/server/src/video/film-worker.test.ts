import { describe, expect, it, vi } from "vitest";
import { filmWorkerEnvironment, handleFilmChannelRequest, validateFilmChannelScope } from "./film-worker.js";
import { FILM_CHANNEL_METHOD_COMPONENT, filmRequestHash, resolveEraProfile, type FilmChannelRequestFrame } from "@hyperreality/video-studio";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
describe("film worker child environment", () => {
  it("keeps public local tools while dropping every account, database, model and signing credential", () => {
    const env = filmWorkerEnvironment({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model", LLM_API_KEY: "test-secret", LLM_THINKING_TYPE: "enabled", DEEPSEEK_API_KEY: "test-secret", DEEPSEEK_BASE_URL: "https://api.deepseek.com", JWT_SECRET: "test-secret", CNB_TOKEN: "test-secret", DATABASE_URL: "test-secret", CUSTOMER_OAUTH_TOKEN: "test-secret", NODE_OPTIONS: "--import arbitrary" });
    expect(env).toEqual({ PATH: "/local/bin", WL_FFMPEG: "/local/ffmpeg", SEEDANCE_MODEL: "test-model" });
  });
});

describe("film worker transport boundary", () => {
  it("stops an oversized streamed result without writing a partial job artifact", async () => {
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "film-bounded-download-")));
    let pulls = 0, cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulls <= 10) controller.enqueue(new Uint8Array(32).fill(pulls));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    try {
      const url = "https://fixture.invalid/already-issued.mp4";
      const method = "media.fetch", stepKey = "videos:S1", shotId = "S1";
      const params = { url, targetRef: "clip.mp4" };
      const frame: FilmChannelRequestFrame = { kind: "film.request", id: "fixture", method, component: "media",
        stepKey, shotId, params, requestHash: filmRequestHash({ method, stepKey, shotId, params }), idempotencyKey: "film-fixture" };
      const ctx = {
        env: { FILM_MEDIA_FETCH_LIMIT_BYTES: "64" },
        job: { id: "job-fixture", project_id: "project-fixture", stages: ["videos"], options: {} },
        worker: { capabilities: ["media"] }, workDir, shots: new Map([[shotId, {}]]),
        issuedUrls: new Map([[url, { stepKey, shotId }]]),
        mediaFetchImpl: async () => new Response(body),
        signal: new AbortController().signal, deadlineAt: Date.now() + 30_000, ownerToken: "fixture",
        ledger: {
          reserveComponent: async () => ({ row: { id: "component-fixture" }, deduped: false }),
          claimComponent: async () => ({ id: "component-fixture" }),
          recordDispatch: async () => undefined,
          recordComponentAccepted: async () => undefined,
          recordComponentFailure: async () => undefined,
        },
      } as unknown as Parameters<typeof handleFilmChannelRequest>[0];
      await expect(handleFilmChannelRequest(ctx, frame)).rejects.toMatchObject({ code: "MEDIA_TOO_LARGE" });
      expect(cancelled).toBe(true);
      expect(pulls).toBeLessThan(10);
      expect(readdirSync(workDir)).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it.each(["dispatch-mark", "task-receipt"] as const)("honors cancellation at %s before another provider request", async checkpoint => {
    const workDir = realpathSync(mkdtempSync(join(tmpdir(), "film-dispatch-deadline-")));
    const abort = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "cgt-fixture-original" })));
    const seenReceipts: string[][] = [];
    vi.stubGlobal("fetch", fetchImpl);
    try {
      const method = "video.generate", stepKey = "videos:S1", shotId = "S1";
      const params = { prompt: "fixture prompt", seconds: 5, targetRef: "clip.mp4" };
      const frame: FilmChannelRequestFrame = { kind: "film.request", id: "fixture", method, component: "video",
        stepKey, shotId, params, requestHash: filmRequestHash({ method, stepKey, shotId, params }), idempotencyKey: "film-fixture" };
      const ctx = {
        env: { VOLCENGINE_ARK_API_KEY: "fixture", SEEDANCE_ENDPOINT: "https://fixture.invalid" },
        job: { id: "job-fixture", project_id: "project-fixture", stages: ["videos"], options: {} },
        worker: { capabilities: ["video"] }, workDir, shots: new Map([[shotId, {}]]),
        signal: abort.signal, deadlineAt: Date.now() + 30_000, ownerToken: "fixture",
        ledger: {
          reserveComponent: async () => ({ row: { id: "component-fixture" }, deduped: false }),
          claimComponent: async () => ({ id: "component-fixture" }),
          recordDispatch: async () => { if (checkpoint === "dispatch-mark") abort.abort(); },
          recordVideoTaskReceipt: async (...args: string[]) => {
            seenReceipts.push(args);
            abort.abort();
          },
          recordComponentFailure: async () => undefined,
        },
      } as unknown as Parameters<typeof handleFilmChannelRequest>[0];
      await expect(handleFilmChannelRequest(ctx, frame)).rejects.toMatchObject({ code: "JOB_DEADLINE_EXCEEDED" });
      await new Promise<void>(resolve => setImmediate(resolve));
      if (checkpoint === "dispatch-mark") {
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(seenReceipts).toEqual([]);
      } else {
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, request] = fetchImpl.mock.calls[0]!;
        expect(request?.method).toBe("POST");
        const body = JSON.parse(String(request?.body));
        expect(seenReceipts).toEqual([["component-fixture", "fixture", "cgt-fixture-original",
          createHash("sha256").update(JSON.stringify({ body, endpoint: url, method: "POST", provider: "seedance", providerModel: body.model })).digest("hex")]]);
      }
    } finally {
      vi.unstubAllGlobals();
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("film parent local post budget", () => {
  it.each(["shot", "compose", "color", "subtitle", "mux", "danmaku", "bgm", "sfx", "cover", "master"])("%s completes the actual parent channel with no model budget", async (stage) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "film-post-zero-budget-")));
    try {
      writeFileSync(join(dir, "actual-post-receipt.json"), JSON.stringify({ processing: "actual-local-post" }));
      const frozenStage = stage === "shot" ? "videos" : stage;
      const shotId = stage === "shot" ? "S1" : null;
      const stepKey = shotId ? `${frozenStage}:${shotId}` : frozenStage;
      const accepted: Array<Record<string, unknown>> = [];
      const reserved: number[] = [];
      const dispatched: string[] = [];
      const params = { stage, projectId: "project-a", context: shotId ? { shotId } : {},
        artifacts: [{ ref: "actual-post-receipt.json", kind: "json" }],
        deterministic: [{ id: "tool-exit", hard: true, pass: true, detail: "local command completed" }],
      };
      const requestHash = filmRequestHash({ method: "gate.review", stepKey, shotId, params });
      const frame: FilmChannelRequestFrame = { kind: "film.request", id: "actual-parent-request",
        method: "gate.review", component: FILM_CHANNEL_METHOD_COMPONENT["gate.review"]!,
        stepKey, shotId, params, requestHash, idempotencyKey: `post:${stage}` };
      const ctx = {
        scope: { workspaceId: "workspace-a", tenantId: "tenant-a" }, env: {},
        job: { id: "job-a", project_id: "project-a", stages: [frozenStage], options: { "review-policy": "blocking" }, attempt: 1 },
        worker: { capabilities: ["gate.review"] }, workDir: dir, archiveRoot: dir,
        shots: new Map([["S1", { shotId: "S1", scene: "black silent source" }]]), frozen: {},
        contractSource: { projectId: "project-a", shots: [{ shotId: "S1", scene: "black silent source" }], eraProfile: resolveEraProfile({ storyDate: "2026-10-07" }) },
        signal: new AbortController().signal, deadlineAt: Date.now() + 60_000,
        ownerToken: "parent-owner", issuedUrls: new Map(), log: () => undefined, send: () => undefined,
        ledger: {
          reserveComponent: async (input: { reservedCny: number }) => {
            reserved.push(input.reservedCny);
            if (input.reservedCny > 0) throw new Error("ZERO_MODEL_BUDGET: no funds for a model call");
            return { row: { id: "component-a" }, deduped: false };
          },
          claimComponent: async () => ({ id: "component-a" }),
          recordDispatch: async (_id: string, _owner: string, provider: string) => { dispatched.push(provider); },
          recordComponentAccepted: async (_id: string, _owner: string, receipt: Record<string, unknown>) => { accepted.push(receipt); },
          recordComponentFailure: async () => { throw new Error("unexpected local-post failure"); },
        },
      } as unknown as Parameters<typeof handleFilmChannelRequest>[0];
      const verdict = await handleFilmChannelRequest(ctx, frame) as { approved: boolean; score: number | null };
      expect(verdict).toMatchObject({ approved: true, score: null });
      expect(reserved).toEqual([0]);
      expect(dispatched).toEqual(["workloom.producer-gate"]);
      expect(accepted).toHaveLength(1);
      expect(accepted[0]).toMatchObject({ actualCny: 0, evidence: { score: null, approved: true } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("film parent frozen method and shot scope", () => {
  const scope = { stages: ["cine-kb", "plates", "videos", "material-gen", "voice", "cover", "spec", "continuity"], projectId: "project-a", shotIds: new Set(["S1", "S2"]) };
  const frame = (method: string, stepKey: string, shotId: string | null, params: unknown = {}): FilmChannelRequestFrame => ({
    kind: "film.request", id: "request-a", method, component: FILM_CHANNEL_METHOD_COMPONENT[method]!,
    stepKey, shotId, params, idempotencyKey: "idempotency-a", requestHash: "unused-by-scope-validation",
  });
  it.each([
    ["image.generate", "cine-kb:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["video.generate", "plates:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["image.generate", "plates:S1", "S2", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates", "S1", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates:S1:extra", "S1", "STEP_SHOT_MISMATCH"],
    ["image.generate", "plates", null, "SHOT_NOT_FOUND"],
    ["voice.dub", "videos:S1", "S1", "METHOD_STAGE_MISMATCH"],
    ["llm.chat", "spec", null, "METHOD_STAGE_MISMATCH"],
    ["media.fetch", "cover", null, "METHOD_STAGE_MISMATCH"],
    ["image.generate", "outside:S1", "S1", "STEP_OUT_OF_SCOPE"],
    ["image.generate", "plates:S3", "S3", "SHOT_NOT_FOUND"],
  ])("rejects %s at %s bound to %s", (method, stepKey, shotId, error) => {
    expect(() => validateFilmChannelScope(frame(String(method), String(stepKey), shotId as string | null), scope)).toThrow(String(error));
  });
  it("accepts registered component routes and bound step keys", () => {
    for (const [method, stage, shot] of [["image.generate", "plates", "S1"], ["video.generate", "videos", "S1"], ["video.generate", "material-gen", "S2"], ["voice.dub", "voice", "S1"], ["voice.verify", "voice", "S2"], ["llm.chat", "cover", null], ["media.fetch", "plates", null]] as const) {
      expect(() => validateFilmChannelScope(frame(method, shot === null ? stage : `${stage}:${shot}`, shot), scope)).not.toThrow();
    }
  });
  it("binds review aliases, project, shot and material source before reservation", () => {
    const review = (stage: string, key: string, shotId: string | null, context: object = {}) => frame("gate.review", key, shotId, { projectId: "project-a", stage, context });
    expect(() => validateFilmChannelScope(review("prompt", "spec", null), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("continuity", "continuity", null), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("shot", "material-gen:S1", "S1", { shotId: "S1", sourceStage: "material-gen" }), scope)).not.toThrow();
    expect(() => validateFilmChannelScope(review("prompt", "plates", null), scope)).toThrow("METHOD_STAGE_MISMATCH");
    expect(() => validateFilmChannelScope(frame("gate.review", "spec", null, { projectId: "other", stage: "prompt" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
    expect(() => validateFilmChannelScope(review("keyframe", "plates:S1", "S1", { shotId: "S2" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
    expect(() => validateFilmChannelScope(review("shot", "material-gen:S1", "S1", { shotId: "S1", sourceStage: "videos" }), scope)).toThrow("REVIEW_SCOPE_INVALID");
  });
  it("denies a frozen source shot outside an explicit only selection", () => {
    expect(() => validateFilmChannelScope(frame("image.generate", "plates:S2", "S2"), { ...scope, shotIds: new Set(["S1"]) })).toThrow("SHOT_NOT_FOUND");
  });
});
