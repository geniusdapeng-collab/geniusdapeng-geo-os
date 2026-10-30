#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest("hex");

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new BridgeError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("MANUAL_BRIDGE_INVALID", `${label} must be an object.`);
  return value;
}

function text(value, label, minimum = 1) {
  if (typeof value !== "string" || value.trim().length < minimum) {
    fail("MANUAL_BRIDGE_INVALID", `${label} must be text with at least ${minimum} characters.`);
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("MANUAL_BRIDGE_INVALID", `${label} must be an integer >= ${minimum}.`);
  return value;
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("MANUAL_BRIDGE_INVALID", `${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function assertion(value, label) {
  if (value !== true) fail("MANUAL_BRIDGE_INVALID", `${label} must be true.`);
}

function parseArgs(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--json") {
      if (values.json) fail("MANUAL_BRIDGE_USAGE", "--json was repeated.");
      values.json = true;
      continue;
    }
    if (!["--root", "--manifest"].includes(name) || values[name] || !args[index + 1] || args[index + 1].startsWith("--")) {
      fail("MANUAL_BRIDGE_USAGE", "Usage: node scripts/validate-video-manual-bridge.mjs --root <dir> --manifest <file> [--json]");
    }
    values[name] = path.resolve(args[++index]);
  }
  if (!values["--root"] || !values["--manifest"]) fail("MANUAL_BRIDGE_USAGE", "--root and --manifest are required.");
  return values;
}

function ordinaryFile(root, file, label) {
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("MANUAL_BRIDGE_PATH_INVALID", `${label} must stay inside --root.`);
  }
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    fail("MANUAL_BRIDGE_FILE_INVALID", `${label} must be a non-empty ordinary file no larger than 8 MiB.`);
  }
  return resolved;
}

function verifyReceipt(root, value, label) {
  const receipt = object(value, label);
  const file = ordinaryFile(root, text(receipt.path, `${label}.path`), label);
  const expected = sha(receipt.sha256, `${label}.sha256`);
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected) fail("MANUAL_BRIDGE_HASH_MISMATCH", `${label} changed after the receipt was written.`);
  return { path: path.relative(root, file), sha256: actual };
}

function validate(manifest, root) {
  if (manifest.schemaVersion !== "pengmanager.video-manual-bridge/v1") {
    fail("MANUAL_BRIDGE_SCHEMA_INVALID", "Unsupported schemaVersion.");
  }
  const projectId = text(manifest.projectId, "projectId");
  if (!["narrative", "marketing"].includes(manifest.pipelineKind)) fail("MANUAL_BRIDGE_INVALID", "pipelineKind is not supported.");
  const stageId = text(manifest.stageId, "stageId");
  const subtaskKey = text(manifest.subtaskKey, "subtaskKey");

  const trigger = object(manifest.trigger, "trigger");
  const failedAttempts = integer(trigger.failedAttempts, "trigger.failedAttempts");
  if (failedAttempts < 3) fail("MANUAL_BRIDGE_TRIGGER_INVALID", "At least three failed attempts of the same subtask are required.");
  if (!Array.isArray(trigger.attempts) || trigger.attempts.length < 3 || trigger.attempts.length !== failedAttempts) {
    fail("MANUAL_BRIDGE_TRIGGER_INVALID", "trigger.attempts must contain exactly the recorded failed attempts and at least three.");
  }
  const seenAttempts = new Set();
  const attempts = trigger.attempts.map((value, index) => {
    const item = object(value, `trigger.attempts[${index}]`);
    const attempt = integer(item.attempt, `trigger.attempts[${index}].attempt`, 1);
    if (item.subtaskKey !== subtaskKey || item.status !== "failed") {
      fail("MANUAL_BRIDGE_TRIGGER_INVALID", "Every trigger attempt must be a failure of the same subtaskKey.");
    }
    if (seenAttempts.has(attempt)) fail("MANUAL_BRIDGE_TRIGGER_INVALID", "trigger.attempts contains a duplicate attempt.");
    seenAttempts.add(attempt);
    return {
      attempt,
      ...verifyReceipt(root, { path: item.evidencePath, sha256: item.evidenceSha256 }, `trigger.attempts[${index}].evidence`),
    };
  });

  const bridge = object(manifest.manualBridge, "manualBridge");
  if (bridge.actor !== "Codex") fail("MANUAL_BRIDGE_ACTOR_INVALID", "manualBridge.actor must be Codex.");
  const reason = text(bridge.reason, "manualBridge.reason", 20);
  if (!Array.isArray(bridge.inputArtifacts) || bridge.inputArtifacts.length === 0) {
    fail("MANUAL_BRIDGE_INPUT_REQUIRED", "manualBridge.inputArtifacts must contain the complete current upstream input.");
  }
  const inputArtifacts = bridge.inputArtifacts.map((value, index) => verifyReceipt(root, value, `manualBridge.inputArtifacts[${index}]`));
  const schema = verifyReceipt(root, bridge.schema, "manualBridge.schema");
  const output = verifyReceipt(root, bridge.output, "manualBridge.output");

  const validation = object(manifest.validation, "validation");
  assertion(validation.passed, "validation.passed");
  text(validation.validatorId, "validation.validatorId");
  text(validation.command, "validation.command");
  if (validation.exitCode !== 0) fail("MANUAL_BRIDGE_VALIDATION_FAILED", "validation.exitCode must be 0.");
  text(validation.completedAt, "validation.completedAt");
  const validationEvidence = verifyReceipt(root, validation.evidence, "validation.evidence");

  const fidelity = object(manifest.fidelity, "fidelity");
  for (const key of ["usesOnlyUpstreamFacts", "formatConforms"]) assertion(fidelity[key], `fidelity.${key}`);
  if (fidelity.fabricatedFacts !== false) fail("MANUAL_BRIDGE_FIDELITY_FAILED", "fidelity.fabricatedFacts must be false.");
  if (!["verified", "partially_verified", "unverified"].includes(fidelity.dataFidelityStatus)) {
    fail("MANUAL_BRIDGE_FIDELITY_INVALID", "fidelity.dataFidelityStatus is not supported.");
  }
  if (!Array.isArray(fidelity.unresolvedFacts) || !Array.isArray(fidelity.deviations)) {
    fail("MANUAL_BRIDGE_FIDELITY_INVALID", "fidelity unresolved facts and deviations must be arrays.");
  }
  if (fidelity.dataFidelityStatus === "verified" && fidelity.unresolvedFacts.length > 0) {
    fail("MANUAL_BRIDGE_FIDELITY_INVALID", "A verified bridge cannot retain unresolved facts.");
  }

  const effects = object(manifest.externalEffects, "externalEffects");
  const effectCounts = Object.fromEntries(["providerCalls", "paidProviderCalls", "publications", "irreversibleActions"]
    .map(key => [key, integer(effects[key], `externalEffects.${key}`)]));
  for (const [key, count] of Object.entries(effectCounts)) {
    if (count !== 0) fail("MANUAL_BRIDGE_SIDE_EFFECT_FORBIDDEN", `A manual bridge cannot claim externalEffects.${key}=${count}.`);
  }

  const downstream = object(manifest.downstream, "downstream");
  if (downstream.accepted !== true) fail("MANUAL_BRIDGE_DOWNSTREAM_REJECTED", "downstream.accepted must be true.");
  const handoffReceipt = verifyReceipt(root, downstream.handoffReceipt, "downstream.handoffReceipt");
  const bridgeId = `MB-${digest(`${projectId}\0${stageId}\0${subtaskKey}\0${output.sha256}`).slice(0, 16)}`;
  if (manifest.bridgeId !== undefined && manifest.bridgeId !== bridgeId) {
    fail("MANUAL_BRIDGE_ID_INVALID", "The recorded bridgeId does not match project, stage, subtask and output bytes.");
  }
  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(ordinaryFile(root, handoffReceipt.path, "downstream.handoffReceipt"), "utf8"));
  } catch {
    fail("MANUAL_BRIDGE_HANDOFF_INVALID", "The downstream handoff receipt is not valid JSON.");
  }
  if (handoff?.accepted !== true || handoff?.bridgeId !== bridgeId || handoff?.outputSha256 !== output.sha256) {
    fail("MANUAL_BRIDGE_HANDOFF_INVALID", "The downstream receipt is not bound to this bridgeId and current output SHA-256.");
  }

  const disclosure = object(manifest.deliveryDisclosure, "deliveryDisclosure");
  assertion(disclosure.requiredInFinalReport, "deliveryDisclosure.requiredInFinalReport");
  const stageLabel = text(disclosure.stageLabel, "deliveryDisclosure.stageLabel");
  const statement = text(disclosure.statement, "deliveryDisclosure.statement", 20);
  text(manifest.createdAt, "createdAt");

  return {
    schemaVersion: manifest.schemaVersion,
    projectId,
    bridgeId,
    pipelineKind: manifest.pipelineKind,
    stageId,
    subtaskKey,
    failedAttempts,
    attempts,
    inputArtifacts,
    schema,
    output,
    reason,
    validation: { ...validation, evidence: validationEvidence },
    fidelity,
    externalEffects: effectCounts,
    downstream: { accepted: true, handoffReceipt },
    deliveryDisclosure: { requiredInFinalReport: true, stageLabel, statement },
  };
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = path.resolve(args["--root"]);
    const manifestFile = ordinaryFile(root, args["--manifest"], "manifest");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const result = validate(object(manifest, "manifest"), root);
    process.stdout.write(`${JSON.stringify({ ok: true, manifest: path.relative(root, manifestFile), ...result }, null, args.json ? 2 : 0)}\n`);
  } catch (error) {
    const result = {
      ok: false,
      error: { code: error?.code ?? "MANUAL_BRIDGE_FAILED", message: error instanceof Error ? error.message : String(error) },
    };
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) main();

export { validate };
