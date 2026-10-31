#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_ROOT = path.join(ROOT, "engines", "video-edit");
const GENERATED_PREFIXES = [
  "outputs/",
  "packages/industry-contract/dist/",
  "vendor/supermickey/hyperreality-system/output/",
  "vendor/supermickey/output/",
];

function fail(message) {
  throw new Error(`VIDEO_ENGINE_SOURCE_SYNC_FAILED: ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(sourceRoot, args, options = {}) {
  return execFileSync("git", [
    "-C", sourceRoot,
    "-c", "http.proxy=",
    "-c", "https.proxy=",
    "-c", "http.version=HTTP/1.1",
    ...args,
  ], {
    encoding: options.encoding,
    env: {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      ...options.env,
    },
    input: options.input,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 1024,
  });
}

function gitBlob(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

function safeRelative(value) {
  return typeof value === "string"
    && value
    && !value.includes("\\")
    && !value.includes("\0")
    && !path.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== ".."
    && !value.startsWith("../");
}

function generated(relative) {
  return relative.split("/").includes("node_modules")
    || relative.split("/").includes(".git")
    || GENERATED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function tree(sourceRoot, commit) {
  const raw = git(sourceRoot, ["ls-tree", "-rz", "--full-tree", commit], { encoding: undefined });
  const result = new Map();
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = record.match(/^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.*)$/s);
    if (!match) fail(`cannot parse tree entry: ${record.slice(0, 160)}`);
    const [, mode, type, blob, relative] = match;
    if (type !== "blob" || !["100644", "100755"].includes(mode) || !safeRelative(relative)) {
      fail(`unsupported source entry: ${mode} ${type} ${relative}`);
    }
    if (!generated(relative)) result.set(relative, { mode, blob });
  }
  return result;
}

function committedTargetTree(commit) {
  const prefix = "engines/video-edit/";
  const raw = git(ROOT, ["ls-tree", "-rz", "--full-tree", commit, "--", prefix], { encoding: undefined });
  const result = new Map();
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = record.match(/^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.*)$/s);
    if (!match) fail(`cannot parse target tree entry: ${record.slice(0, 160)}`);
    const [, mode, type, blob, committedPath] = match;
    if (type !== "blob" || !["100644", "100755"].includes(mode) || !committedPath.startsWith(prefix)) {
      fail(`unsupported target entry: ${mode} ${type} ${committedPath}`);
    }
    const relative = committedPath.slice(prefix.length);
    if (!safeRelative(relative)) fail(`unsafe target path: ${relative}`);
    if (!generated(relative)) result.set(relative, { mode, blob });
  }
  return result;
}

function committedTargetBytes(commit, relative) {
  try {
    return git(ROOT, ["cat-file", "blob", `${commit}:engines/video-edit/${relative}`], {
      encoding: undefined,
    });
  } catch (error) {
    const detail = Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8").trim() : "";
    fail(`cannot read target blob ${relative}${detail ? `: ${detail}` : ""}`);
  }
}

function readBlob(sourceRoot, oid) {
  return git(sourceRoot, ["cat-file", "blob", oid], { encoding: undefined });
}

function localBytes(root, relative) {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) fail(`local path escapes root: ${relative}`);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) fail(`local path is not a regular file: ${relative}`);
  return fs.readFileSync(absolute);
}

function targetFile(relative) {
  const absolute = path.resolve(TARGET_ROOT, relative);
  if (absolute !== TARGET_ROOT && !absolute.startsWith(`${TARGET_ROOT}${path.sep}`)) fail(`target path escapes root: ${relative}`);
  if (!fs.existsSync(absolute)) return null;
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) fail(`target path is not a regular file: ${relative}`);
  return { absolute, bytes: fs.readFileSync(absolute) };
}

function writeTarget(relative, bytes) {
  const absolute = path.resolve(TARGET_ROOT, relative);
  if (absolute !== TARGET_ROOT && !absolute.startsWith(`${TARGET_ROOT}${path.sep}`)) fail(`target path escapes root: ${relative}`);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.sync-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    fs.renameSync(temporary, absolute);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function deleteTarget(relative) {
  const absolute = path.resolve(TARGET_ROOT, relative);
  if (!fs.existsSync(absolute)) return;
  fs.unlinkSync(absolute);
}

function binary(bytes) {
  return bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0);
}

function mergeText(ours, base, theirs) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "video-engine-sync-"));
  const oursPath = path.join(temporary, "ours");
  const basePath = path.join(temporary, "base");
  const theirsPath = path.join(temporary, "theirs");
  try {
    fs.writeFileSync(oursPath, ours);
    fs.writeFileSync(basePath, base ?? Buffer.alloc(0));
    fs.writeFileSync(theirsPath, theirs);
    try {
      return {
        bytes: execFileSync("git", ["merge-file", "-p", "--diff3", oursPath, basePath, theirsPath], {
          maxBuffer: 256 * 1024 * 1024,
        }),
        conflicted: false,
      };
    } catch (error) {
      if (typeof error.status !== "number" || error.status <= 0 || error.status >= 128 || !Buffer.isBuffer(error.stdout)) {
        throw error;
      }
      return { bytes: error.stdout, conflicted: true };
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const sourceRoot = path.resolve(arg("source") ?? fail("pass --source <clean WorkLoom-video-edit worktree>"));
const baseRoot = arg("base-root") ? path.resolve(arg("base-root")) : null;
const baseCommit = arg("base") ?? fail("pass --base <previous reviewed commit>");
const sourceCommit = arg("commit") ?? "HEAD";
const targetCommit = arg("target-commit");
const conflictStrategy = arg("conflict-strategy") ?? "markers";
if (!["markers", "canonical", "target"].includes(conflictStrategy)) {
  fail(`unsupported conflict strategy: ${conflictStrategy}`);
}
const dryRun = process.argv.includes("--dry-run");
const base = tree(sourceRoot, baseCommit);
const next = tree(sourceRoot, sourceCommit);
const committedTarget = targetCommit ? committedTargetTree(targetCommit) : null;
const changed = [...new Set([...base.keys(), ...next.keys()])]
  .filter((relative) => base.get(relative)?.blob !== next.get(relative)?.blob)
  .sort();
if (baseRoot && committedTarget) {
  const missingBaseInputs = changed.filter((relative) => {
    const baseEntry = base.get(relative);
    const nextEntry = next.get(relative);
    const targetEntry = committedTarget.get(relative);
    return Boolean(
      baseEntry
      && nextEntry
      && targetEntry
      && targetEntry.blob !== baseEntry.blob
      && targetEntry.blob !== nextEntry.blob
      && nextEntry.blob !== baseEntry.blob
      && localBytes(baseRoot, relative) === null,
    );
  });
  if (missingBaseInputs.length > 0) {
    fail(`missing base inputs: ${missingBaseInputs.join(", ")}`);
  }
}
const sourceRev = git(sourceRoot, ["rev-parse", sourceCommit], { encoding: "utf8" }).trim();
const headRev = git(sourceRoot, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const targetRev = targetCommit ? git(ROOT, ["rev-parse", targetCommit], { encoding: "utf8" }).trim() : null;
const sourceIsHead = sourceRev === headRev;
const report = {
  sourceCommit: sourceRev,
  baseCommit: git(sourceRoot, ["rev-parse", baseCommit], { encoding: "utf8" }).trim(),
  targetCommit: targetRev,
  changed: changed.length,
  updated: [],
  deleted: [],
  keptTarget: [],
  cleanMerges: [],
  conflicts: [],
  resolvedToCanonical: [],
  resolvedToTarget: [],
  keptDeletedByTarget: [],
  dryRun,
};

for (const relative of changed) {
  const baseEntry = base.get(relative);
  const nextEntry = next.get(relative);
  const targetEntry = committedTarget?.get(relative);
  const target = committedTarget
    ? (targetEntry
      ? { absolute: null, bytes: committedTargetBytes(targetRev, relative) }
      : null)
    : targetFile(relative);
  const targetBlob = target ? gitBlob(target.bytes) : null;

  if (!nextEntry) {
    if (!target) continue;
    if (targetBlob === baseEntry?.blob) {
      if (!dryRun) deleteTarget(relative);
      report.deleted.push(relative);
    } else {
      report.conflicts.push(relative);
      report.keptDeletedByTarget.push(relative);
    }
    continue;
  }

  const nextBytes = sourceIsHead ? localBytes(sourceRoot, relative) : readBlob(sourceRoot, nextEntry.blob);
  if (!nextBytes) fail(`missing source blob: ${relative}`);
  if (!target) {
    if (!baseEntry) {
      if (!dryRun) writeTarget(relative, nextBytes);
      report.updated.push(relative);
    } else {
      report.conflicts.push(relative);
      report.keptDeletedByTarget.push(relative);
    }
    continue;
  }

  if (targetBlob === nextEntry.blob) {
    report.keptTarget.push(relative);
    continue;
  }
  if (!baseEntry || targetBlob === baseEntry.blob) {
    if (!dryRun) writeTarget(relative, nextBytes);
    report.updated.push(relative);
    continue;
  }
  if (nextEntry.blob === baseEntry.blob) {
    report.keptTarget.push(relative);
    continue;
  }
  const baseBytes = baseRoot ? localBytes(baseRoot, relative) : readBlob(sourceRoot, baseEntry.blob);
  if (!baseBytes || !nextBytes) fail(`missing merge input: ${relative}`);
  if (binary(target.bytes) || binary(baseBytes) || binary(nextBytes)) {
    report.conflicts.push(relative);
    continue;
  }
  const merged = mergeText(target.bytes, baseBytes, nextBytes);
  if (merged.conflicted) {
    report.conflicts.push(relative);
    if (conflictStrategy === "canonical") {
      if (!dryRun) writeTarget(relative, nextBytes);
      report.resolvedToCanonical.push(relative);
    } else if (conflictStrategy === "target") {
      if (!dryRun) writeTarget(relative, target.bytes);
      report.resolvedToTarget.push(relative);
    } else if (!dryRun) {
      writeTarget(relative, merged.bytes);
    }
  } else {
    if (!dryRun) writeTarget(relative, merged.bytes);
    report.cleanMerges.push(relative);
  }
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.conflicts.length > 0) process.exitCode = 2;
