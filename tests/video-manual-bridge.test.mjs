import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { validate } from "../scripts/validate-video-manual-bridge.mjs";

const roots = [];
const digest = value => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pm-manual-bridge-"));
  roots.push(root);
  mkdirSync(path.join(root, "manual-bridges"));
  const write = (name, content) => {
    const file = path.join(root, name);
    writeFileSync(file, content);
    return { path: name, sha256: digest(content) };
  };
  const evidence = [1, 2, 3].map(attempt => {
    const receipt = write(`failure-${attempt}.json`, JSON.stringify({ attempt, status: "failed" }));
    return {
      attempt,
      subtaskKey: "G6.prompt-fusion",
      status: "failed",
      evidencePath: receipt.path,
      evidenceSha256: receipt.sha256,
    };
  });
  const input = write("input.json", JSON.stringify({ scene: "closed track", product: "820RR-RC" }));
  const schema = write("schema.json", JSON.stringify({ type: "object", required: ["prompt"] }));
  const output = write("output.json", JSON.stringify({ prompt: "完整提示词" }));
  const validatorEvidence = write("validation.json", JSON.stringify({ exitCode: 0, passed: true }));
  const bridgeId = `MB-${digest(`VID-TEST\0preproduction\0G6.prompt-fusion\0${output.sha256}`).slice(0, 16)}`;
  const handoff = write("handoff.json", JSON.stringify({ accepted: true, bridgeId, outputSha256: output.sha256 }));
  const manifest = {
    schemaVersion: "pengmanager.video-manual-bridge/v1",
    bridgeId,
    projectId: "VID-TEST",
    pipelineKind: "marketing",
    stageId: "preproduction",
    subtaskKey: "G6.prompt-fusion",
    trigger: { failedAttempts: 3, attempts: evidence },
    manualBridge: {
      actor: "Codex",
      reason: "同一提示词融合子环节连续三次因字段契约失败，按已冻结 schema 人工补齐。",
      inputArtifacts: [input],
      schema,
      output,
    },
    validation: {
      passed: true,
      validatorId: "g6-contract",
      command: "node scripts/validate-g6.mjs output.json",
      exitCode: 0,
      completedAt: "2026-10-30T09:20:00+08:00",
      evidence: validatorEvidence,
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
    downstream: { accepted: true, handoffReceipt: handoff },
    deliveryDisclosure: {
      requiredInFinalReport: true,
      stageLabel: "G6 提示词融合",
      statement: "G6 提示词融合连续失败三次后由 Codex 按当前 schema 人工搭桥，未编造事实。",
    },
    createdAt: "2026-10-30T09:20:00+08:00",
  };
  return { root, manifest };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("accepts a complete manual bridge with verified bytes, schema, fidelity and disclosure", () => {
  const { root, manifest } = fixture();
  const result = validate(manifest, root);
  assert.equal(result.failedAttempts, 3);
  assert.equal(result.output.sha256, manifest.manualBridge.output.sha256);
  assert.equal(result.fidelity.fabricatedFacts, false);
  assert.equal(result.deliveryDisclosure.requiredInFinalReport, true);
});

test("rejects use before three failures of the same subtask", () => {
  const { root, manifest } = fixture();
  manifest.trigger.failedAttempts = 2;
  manifest.trigger.attempts = manifest.trigger.attempts.slice(0, 2);
  assert.throws(() => validate(manifest, root), error => error.code === "MANUAL_BRIDGE_TRIGGER_INVALID");
  manifest.trigger.failedAttempts = 3;
  manifest.trigger.attempts = structuredClone(manifest.trigger.attempts);
  const third = structuredClone(manifest.trigger.attempts[0]);
  third.attempt = 3;
  third.subtaskKey = "another-subtask";
  manifest.trigger.attempts.push(third);
  assert.throws(() => validate(manifest, root), error => error.code === "MANUAL_BRIDGE_TRIGGER_INVALID");
});

test("rejects changed bytes, fabricated facts and missing final disclosure", () => {
  const { root, manifest } = fixture();
  writeFileSync(path.join(root, manifest.manualBridge.output.path), "{}");
  assert.throws(() => validate(manifest, root), error => error.code === "MANUAL_BRIDGE_HASH_MISMATCH");

  const next = fixture();
  next.manifest.fidelity.fabricatedFacts = true;
  assert.throws(() => validate(next.manifest, next.root), error => error.code === "MANUAL_BRIDGE_FIDELITY_FAILED");
  next.manifest.fidelity.fabricatedFacts = false;
  next.manifest.deliveryDisclosure.requiredInFinalReport = false;
  assert.throws(() => validate(next.manifest, next.root), error => error.code === "MANUAL_BRIDGE_INVALID");
});

test("rejects a claimed verified bridge with unresolved facts and any downstream rejection", () => {
  const { root, manifest } = fixture();
  manifest.fidelity.unresolvedFacts = ["未核实价格"];
  assert.throws(() => validate(manifest, root), error => error.code === "MANUAL_BRIDGE_FIDELITY_INVALID");
  manifest.fidelity.unresolvedFacts = [];
  manifest.downstream.accepted = false;
  assert.throws(() => validate(manifest, root), error => error.code === "MANUAL_BRIDGE_DOWNSTREAM_REJECTED");
});
