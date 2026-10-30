import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArchiveStore } from "./store.js";
import {
  inspectManualBridgeEligibility, listManualBridges, ManualBridgeError, recordManualBridge,
  type ManualBridgeRequest,
} from "./manual-bridge.js";

const roots: string[] = [];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const work = mkdtempSync(path.join(tmpdir(), "workloom-manual-bridge-"));
  roots.push(work);
  const store = new ArchiveStore(work, "ws-test", "VID-1", "marketing");
  return { work, store };
}

async function failures(store: ArchiveStore, count: number, failureCode = "PHASE3_FUSION_UNVERIFIED") {
  await store.ensure({ kind: "marketing", title: "manual bridge fixture", createdAt: "2026-10-30T00:00:00Z" });
  for (let attempt = 1; attempt <= count; attempt += 1) {
    await store.appendJsonl("events.jsonl", {
      kind: "stage.failed",
      stageId: "preproduction",
      attempt,
      errorClass: "BUG",
      errorMsg: `${failureCode}: attempt ${attempt}`,
    });
  }
}

async function request(store: ArchiveStore): Promise<ManualBridgeRequest> {
  const files: Record<string, string> = {
    "upstream/shotlist.json": JSON.stringify({ shots: ["opening", "ending"] }),
    "manual-bridges/G6/schema.json": JSON.stringify({ type: "object", required: ["shots"] }),
    "manual-bridges/G6/prompts.json": JSON.stringify({ shots: ["complete prompt"] }),
    "manual-bridges/G6/validation.json": JSON.stringify({ passed: true, exitCode: 0 }),
  };
  for (const [relative, content] of Object.entries(files)) {
    await store.writeJsonAtomic(relative, JSON.parse(content));
  }
  const output = (await store.readText("manual-bridges/G6/prompts.json"))!;
  const outputSha256 = digest(output);
  const bridgeId = `MB-${digest(`VID-1\0preproduction\0G6.prompt-fusion\0${outputSha256}`).slice(0, 16)}`;
  const handoff = JSON.stringify({ accepted: true, bridgeId, outputSha256 });
  await store.writeJsonAtomic("manual-bridges/G6/handoff.json", JSON.parse(handoff));
  const receipt = async (relative: string) => {
    const content = await store.readText(relative);
    if (content === null) throw new Error(`missing fixture ${relative}`);
    return { path: relative, sha256: digest(content) };
  };
  return {
    schemaVersion: "pengmanager.video-manual-bridge/v1",
    projectId: "VID-1",
    stageId: "preproduction",
    subtaskKey: "G6.prompt-fusion",
    failureCode: "PHASE3_FUSION_UNVERIFIED",
    reason: "同一提示词融合细分环节连续三次失败，按冻结 schema 人工补齐完整镜头提示词。",
    inputArtifacts: [await receipt("upstream/shotlist.json")],
    schema: await receipt("manual-bridges/G6/schema.json"),
    output: await receipt("manual-bridges/G6/prompts.json"),
    validation: {
      passed: true,
      validatorId: "G6-contract",
      command: "node scripts/validate-g6.mjs manual-bridges/G6/prompts.json",
      exitCode: 0,
      completedAt: "2026-10-30T10:00:00+08:00",
      evidence: await receipt("manual-bridges/G6/validation.json"),
    },
    fidelity: {
      usesOnlyUpstreamFacts: true,
      fabricatedFacts: false,
      formatConforms: true,
      dataFidelityStatus: "verified",
      unresolvedFacts: [],
      deviations: [],
    },
    externalEffects: { providerCalls: 0, paidProviderCalls: 0, publications: 0, irreversibleActions: 0 },
    downstream: { handoffReceipt: await receipt("manual-bridges/G6/handoff.json") },
    deliveryDisclosure: {
      stageLabel: "G6 提示词融合",
      statement: "G6 提示词融合连续失败三次后由 Codex 按当前 schema 人工搭桥，未编造事实。",
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime manual bridge mechanism", () => {
  it("requires three independent failures of the same stage and failure code", async () => {
    const { store } = fixture();
    await failures(store, 2);
    const before = await inspectManualBridgeEligibility(store, { stageId: "preproduction", failureCode: "PHASE3_FUSION_UNVERIFIED" });
    expect(before).toMatchObject({ eligible: false, attempts: [{ attempt: 1 }, { attempt: 2 }] });
    await store.appendJsonl("events.jsonl", { kind: "stage.failed", stageId: "preproduction", attempt: 3,
      errorClass: "BUG", errorMsg: "PHASE3_FUSION_UNVERIFIED: attempt 3" });
    const after = await inspectManualBridgeEligibility(store, { stageId: "preproduction", failureCode: "PHASE3_FUSION_UNVERIFIED" });
    expect(after).toMatchObject({ eligible: true, attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] });
    await store.appendJsonl("events.jsonl", { kind: "stage.failed", stageId: "preproduction", attempt: 4,
      errorClass: "BUG", errorMsg: "other_failure" });
    expect(await inspectManualBridgeEligibility(store, { stageId: "preproduction", failureCode: "PHASE3_FUSION_UNVERIFIED" }))
      .toMatchObject({ eligible: false, reason: expect.stringContaining("不是当前最新失败") });
  });

  it("records a schema-validated, zero-side-effect bridge only after the downstream accepts its exact hash", async () => {
    const { store } = fixture();
    await failures(store, 3);
    const record = await recordManualBridge(store, await request(store));
    expect(record).toMatchObject({
      projectId: "VID-1",
      pipelineKind: "marketing",
      stageId: "preproduction",
      subtaskKey: "G6.prompt-fusion",
      trigger: { failedAttempts: 3 },
      externalEffects: { providerCalls: 0, paidProviderCalls: 0, publications: 0, irreversibleActions: 0 },
      deliveryDisclosure: { requiredInFinalReport: true },
    });
    expect(record.receiptPath).toMatch(/^manual-bridges\/preproduction\/G6\.prompt-fusion\/MB-[a-f0-9]{16}\.json$/);
    const listed = await listManualBridges(store);
    expect(listed.map(item => item.bridgeId)).toEqual([record.bridgeId]);
    expect(await store.readEvents(100)).toContainEqual(expect.objectContaining({
      kind: "manual-bridge.recorded",
      bridgeId: record.bridgeId,
      receiptPath: record.receiptPath,
    }));
  });

  it("rejects an unaccepted downstream receipt, fabricated facts and any external side effect", async () => {
    const { store } = fixture();
    await failures(store, 3);
    const payload = await request(store);
    payload.fidelity.fabricatedFacts = true as false;
    await expect(recordManualBridge(store, payload)).rejects.toMatchObject({ code: "MANUAL_BRIDGE_FIDELITY_FAILED" });

    const second = fixture();
    await failures(second.store, 3);
    const sideEffect = await request(second.store);
    sideEffect.externalEffects.providerCalls = 1 as 0;
    await expect(recordManualBridge(second.store, sideEffect)).rejects.toMatchObject({ code: "MANUAL_BRIDGE_SIDE_EFFECT_FORBIDDEN" });

    const third = fixture();
    await failures(third.store, 3);
    const rejected = await request(third.store);
    const raw = await third.store.readJson<Record<string, unknown>>("manual-bridges/G6/handoff.json");
    await third.store.writeJsonAtomic("manual-bridges/G6/handoff-rejected.json", { ...raw, accepted: false });
    const rejectedText = (await third.store.readText("manual-bridges/G6/handoff-rejected.json"))!;
    rejected.downstream.handoffReceipt = { path: "manual-bridges/G6/handoff-rejected.json", sha256: digest(rejectedText) };
    await expect(recordManualBridge(third.store, rejected)).rejects.toMatchObject({ code: "MANUAL_BRIDGE_HANDOFF_INVALID" });
  });

  it("rejects changed bytes and a second accepted fallback for the same subtask", async () => {
    const { store } = fixture();
    await failures(store, 3);
    const first = await request(store);
    await recordManualBridge(store, first);
    expect(await recordManualBridge(store, first)).toMatchObject({ bridgeId: expect.stringMatching(/^MB-/) });

    const changed = await request(store);
    changed.output.sha256 = "a".repeat(64);
    await expect(recordManualBridge(store, changed)).rejects.toBeInstanceOf(ManualBridgeError);
  });
});
