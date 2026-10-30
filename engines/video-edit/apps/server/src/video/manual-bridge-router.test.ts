import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Identity } from "@workloom/base/tenancy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authority = vi.hoisted(() => vi.fn());
vi.mock("../service/access-authority.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../service/access-authority.js")>(),
  currentMemberAuthority: authority,
}));
vi.mock("@workloom/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@workloom/db")>(),
  getAppPool: () => ({}),
  getGatewayPool: () => ({}),
}));

import { ArchiveStore, type ManualBridgeRequest } from "@hyperreality/video-studio";
import { videoRouter } from "./router.js";

const owner: Identity = {
  kind: "member", memberId: "owner", memberNo: "MEM-OWNER", name: "Owner", role: "owner",
  plan: "pro", tenantId: "tenant-router", workspaceId: "ws-router",
};
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let root = "";
let previous = "";

function caller() {
  return videoRouter.createCaller({ identity: owner, session: owner, partnerIdentity: null, headers: new Headers() }).studio;
}

async function fixture(store: ArchiveStore): Promise<ManualBridgeRequest & { idempotencyKey: string }> {
  await store.ensure({ kind: "marketing", title: "manual bridge router fixture", createdAt: "2026-10-30T00:00:00Z" });
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await store.appendJsonl("events.jsonl", {
      kind: "stage.failed", stageId: "preproduction", attempt,
      errorClass: "BUG", errorMsg: `REQUIREMENT_DISCOVERY_UNVERIFIED: attempt ${attempt}`,
    });
  }
  const files = {
    "upstream/input.json": { input: "complete upstream" },
    "manual-bridges/G3/schema.json": { type: "object", required: ["value"] },
    "manual-bridges/G3/output.json": { value: "complete bridge output" },
    "manual-bridges/G3/validation.json": { passed: true, exitCode: 0 },
  };
  for (const [relative, value] of Object.entries(files)) await store.writeJsonAtomic(relative, value);
  const receipt = async (relative: string) => ({ path: relative, sha256: digest((await store.readText(relative))!) });
  const output = await receipt("manual-bridges/G3/output.json");
  const bridgeId = `MB-${digest(`VID-ROUTER\0preproduction\0G3.insight\0${output.sha256}`).slice(0, 16)}`;
  await store.writeJsonAtomic("manual-bridges/G3/handoff.json", { accepted: true, bridgeId, outputSha256: output.sha256 });
  return {
    schemaVersion: "pengmanager.video-manual-bridge/v1",
    idempotencyKey: "manual-bridge-router-attempt-0001",
    projectId: "VID-ROUTER",
    stageId: "preproduction",
    subtaskKey: "G3.insight",
    failureCode: "REQUIREMENT_DISCOVERY_UNVERIFIED",
    reason: "同一需求洞察细分环节连续三次失败后，按当前完整 schema 和上游事实人工补齐。",
    inputArtifacts: [await receipt("upstream/input.json")],
    schema: await receipt("manual-bridges/G3/schema.json"),
    output,
    validation: {
      passed: true, validatorId: "G3-contract", command: "node validate-g3.mjs",
      exitCode: 0, completedAt: "2026-10-30T10:00:00+08:00",
      evidence: await receipt("manual-bridges/G3/validation.json"),
    },
    fidelity: {
      usesOnlyUpstreamFacts: true, fabricatedFacts: false, formatConforms: true,
      dataFidelityStatus: "verified", unresolvedFacts: [], deviations: [],
    },
    externalEffects: { providerCalls: 0, paidProviderCalls: 0, publications: 0, irreversibleActions: 0 },
    downstream: { handoffReceipt: await receipt("manual-bridges/G3/handoff.json") },
    deliveryDisclosure: {
      stageLabel: "G3 需求洞察",
      statement: "G3 连续失败三次后按现有 schema 人工搭桥，未编造商品或人物事实。",
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "manual-bridge-router-"));
  previous = process.env.HR_WORK_DIR ?? "";
  process.env.HR_WORK_DIR = root;
  authority.mockReset().mockResolvedValue({ identity: owner, permissions: {} });
});
afterEach(() => {
  if (previous) process.env.HR_WORK_DIR = previous; else delete process.env.HR_WORK_DIR;
  rmSync(root, { recursive: true, force: true });
});

describe("video.studio manual bridge routes", () => {
  it("exposes eligibility, records the accepted receipt and lists it for final delivery disclosure", async () => {
    const store = new ArchiveStore(root, owner.workspaceId, "VID-ROUTER", "marketing");
    const input = await fixture(store);
    expect(await caller().manualBridgeEligibility({
      projectId: input.projectId, stageId: input.stageId, failureCode: input.failureCode,
    })).toMatchObject({ eligible: true, attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] });
    const recorded = await caller().recordManualBridge(input);
    expect(recorded).toMatchObject({
      result: { projectId: input.projectId, trigger: { failedAttempts: 3 }, deliveryDisclosure: { requiredInFinalReport: true } },
      receipt: { synced: true, sourceVerified: true, receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(await caller().manualBridges({ projectId: input.projectId })).toHaveLength(1);
  });

  it("fails closed before three same-code failures", async () => {
    const store = new ArchiveStore(root, owner.workspaceId, "VID-ROUTER", "marketing");
    await store.ensure({ kind: "marketing", title: "short fixture", createdAt: "2026-10-30T00:00:00Z" });
    await store.appendJsonl("events.jsonl", { kind: "stage.failed", stageId: "preproduction", attempt: 1,
      errorClass: "BUG", errorMsg: "REQUIREMENT_DISCOVERY_UNVERIFIED" });
    expect(await caller().manualBridgeEligibility({
      projectId: "VID-ROUTER", stageId: "preproduction", failureCode: "REQUIREMENT_DISCOVERY_UNVERIFIED",
    })).toMatchObject({ eligible: false, attempts: [{ attempt: 1 }] });
  });
});
