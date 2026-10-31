#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET_ROOT = path.join(ROOT, "engines", "video-edit");
const SNAPSHOT_PATH = path.join(ROOT, "upstreams", "workloom-video-edit.snapshot.json");
const PIN_PATH = path.join(ROOT, "upstreams", "workloom-video-edit.pin.json");
const CONFIG_PATH = path.join(ROOT, "src", "video-runtime", "config.mjs");
const REPOSITORY = "https://github.com/geniusdapeng-collab/WorkLoom-video-edit";
const DEFAULT_TARGET_REASON =
  "PengManager host-owned runtime integration, capability, test, documentation, asset, or tool file retained across the full upstream rebind.";
const GENERATED_PREFIXES = [
  "packages/industry-contract/dist/",
  "vendor/supermickey/hyperreality-system/output/",
  "vendor/supermickey/output/",
];

function fail(message) {
  throw new Error(`VIDEO_SNAPSHOT_REFRESH_FAILED: ${message}`);
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
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

function regularFile(root, relative) {
  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) fail(`path escapes root: ${relative}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`not a regular file: ${relative}`);
  return { absolute, stat, bytes: fs.readFileSync(absolute) };
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function parseTree(sourceRoot, revision) {
  const raw = execFileSync("git", ["-C", sourceRoot, "ls-tree", "-rz", "--full-tree", revision]);
  const entries = [];
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const match = record.match(/^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.*)$/s);
    if (!match) fail(`cannot parse git tree entry: ${record.slice(0, 160)}`);
    const [, mode, type, blob, relative] = match;
    if (type !== "blob" || !["100644", "100755"].includes(mode) || !safeRelative(relative)) {
      fail(`unsupported source entry: ${mode} ${type} ${relative}`);
    }
    entries.push({ mode, blob, path: relative });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return entries;
}

function generated(relative) {
  return relative.split("/").includes("node_modules")
    || relative.split("/").includes(".git")
    || GENERATED_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function walkFiles(directory, relative = "", output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    if (generated(childRelative)) continue;
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(child, childRelative, output);
    else if (entry.isFile()) output.push(childRelative);
  }
  return output;
}

function modeOf(stat) {
  return stat.mode & 0o111 ? "100755" : "100644";
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o644, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const sourceRoot = path.resolve(
  arg("source")
    ?? process.env.WORKLOOM_VIDEO_EDIT_SOURCE
    ?? fail("pass --source <WorkLoom-video-edit worktree>"),
);
if (!fs.statSync(sourceRoot).isDirectory()) fail(`source is not a directory: ${sourceRoot}`);
const headCommit = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
const headTree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]).trim();
const commit = arg("commit") ?? headCommit;
const tree = arg("tree") ?? headTree;
if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(tree)) {
  fail("source commit or tree is invalid");
}
if (tree !== headTree) {
  fail(`source tree ${tree} does not match checked-out source tree ${headTree}`);
}

const previous = JSON.parse(fs.readFileSync(PIN_PATH, "utf8"));
let previousSnapshot;
try {
  previousSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
} catch {
  previousSnapshot = JSON.parse(
    execFileSync("git", ["-C", ROOT, "show", "HEAD:upstreams/workloom-video-edit.snapshot.json"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
}
const oldReasons = new Map(
  (previousSnapshot.targetOwnedFiles ?? []).map((item) => [item.path, item.reason]),
);
const sourceEntries = parseTree(sourceRoot, headTree);
const sourcePaths = new Set(sourceEntries.map((entry) => entry.path));
const files = [];
let sourceBytes = 0;
let modifiedSourceCount = 0;

for (const entry of sourceEntries) {
  const source = regularFile(sourceRoot, entry.path);
  const target = regularFile(TARGET_ROOT, entry.path);
  const sourceSha256 = sha256(source.bytes);
  const targetSha256 = sha256(target.bytes);
  sourceBytes += source.bytes.length;
  const changed = sourceSha256 !== targetSha256;
  if (changed) modifiedSourceCount += 1;
  files.push({
    path: entry.path,
    mode: modeOf(target.stat),
    sourceMode: entry.mode,
    gitBlob: entry.blob,
    bytes: source.bytes.length,
    targetBytes: target.bytes.length,
    sourceSha256,
    targetSha256,
    evidence: "B",
    ...(changed
      ? {
          adaptation:
            `PengManager host integration preserved during the 2026-10-31 upgrade to WorkLoom-video-edit ${commit}; exact target bytes are listed here for runtime verification.`,
        }
      : {}),
  });
}

const targetOnly = walkFiles(TARGET_ROOT)
  .filter((relative) => !sourcePaths.has(relative))
  .sort((left, right) => left.localeCompare(right, "en"));
const targetOwnedFiles = targetOnly.map((relative) => {
  const file = regularFile(TARGET_ROOT, relative);
  return {
    path: relative,
    mode: modeOf(file.stat),
    bytes: file.bytes.length,
    targetSha256: sha256(file.bytes),
    evidence: "B",
    reason: oldReasons.get(relative) ?? DEFAULT_TARGET_REASON,
  };
});

const snapshot = {
  schemaVersion: "pengmanager.edit-snapshot/v1",
  source: { repository: REPOSITORY, commit, tree },
  sourceFileCount: files.length,
  sourceBytes,
  files,
  targetOwnedFileCount: targetOwnedFiles.length,
  targetOwnedFiles,
};
const snapshotRaw = `${JSON.stringify(snapshot, null, 2)}\n`;
const snapshotSha256 = sha256(snapshotRaw);

const verifiedAt = arg("verified-at") ?? previous.verifiedAt;
if (!verifiedAt || Number.isNaN(Date.parse(verifiedAt))) fail("verifiedAt must be an ISO timestamp");
const pin = {
  ...previous,
  repository: REPOSITORY,
  commit,
  tree,
  verifiedAt,
  sourceFileCount: files.length,
  sourceBytes,
  snapshot: "upstreams/workloom-video-edit.snapshot.json",
  snapshotSha256,
  targetOwnedFileCount: targetOwnedFiles.length,
  sourceOverlayCount: modifiedSourceCount,
  validationStatus: "complete-byte-inventory-of-current-upstream-plus-reviewed-host-integration",
};

let runtimeConfig = fs.readFileSync(CONFIG_PATH, "utf8");
runtimeConfig = runtimeConfig
  .replace(/export const SOURCE_MAIN = '[^']+';/, `export const SOURCE_MAIN = '${commit}';`)
  .replace(/export const SOURCE_FILE_COUNT = \d+;/, `export const SOURCE_FILE_COUNT = ${files.length};`);
if (!runtimeConfig.includes(`SOURCE_MAIN = '${commit}'`)
  || !runtimeConfig.includes(`SOURCE_FILE_COUNT = ${files.length}`)) {
  fail("runtime config identity was not updated");
}

atomicWrite(SNAPSHOT_PATH, snapshotRaw);
atomicWrite(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
atomicWrite(CONFIG_PATH, runtimeConfig);

process.stdout.write(`${JSON.stringify({
  commit,
  tree,
  sourceFileCount: files.length,
  sourceBytes,
  targetOwnedFileCount: targetOwnedFiles.length,
  modifiedSourceCount,
  snapshotSha256,
}, null, 2)}\n`);
