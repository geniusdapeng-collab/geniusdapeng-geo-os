import { execFile } from "node:child_process";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = resolve(import.meta.dirname, "..");
const outputDir = join(rootDir, "outputs", "acceptance");
await mkdir(outputDir, { recursive: true });

async function testFiles(directory) {
  return (await readdir(directory))
    .filter((file) => file.endsWith(".test.mjs"))
    .map((file) => join(directory, file));
}

const postBridgeDir = join(
  rootDir,
  "engines",
  "video-edit",
  "bundles",
  "ai-video",
  "connectors",
  "post-bridge",
);
const vendorVitestFiles = [
  join(
    rootDir,
    "engines",
    "video-edit",
    "bundles",
    "ai-video",
    "connectors",
    "cover-kb-bridge",
    "core.test.ts",
  ),
  join(postBridgeDir, "delivery-integration.test.ts"),
  join(postBridgeDir, "post-cli-media.test.ts"),
  join(postBridgeDir, "revision-concurrency.test.ts"),
];

const commands = [
  {
    id: "unit-integration",
    command: process.execPath,
    args: ["--test", ...(await testFiles(join(rootDir, "tests")))],
  },
  {
    id: "geo-engine-regression",
    command: process.execPath,
    args: [
      "--test",
      ...(await testFiles(join(rootDir, "engines", "geo-evidence", "test"))),
    ],
  },
  {
    id: "embedded-video-node-tests",
    command: process.execPath,
    args: ["--test", ...(await testFiles(postBridgeDir))],
    timeoutMs: 180_000,
  },
  {
    id: "embedded-video-integration-tests",
    command: join(rootDir, "node_modules", ".bin", "vitest"),
    args: ["run", ...vendorVitestFiles],
    timeoutMs: 300_000,
  },
  {
    id: "smoke",
    command: process.execPath,
    args: [join(rootDir, "scripts", "smoke.mjs")],
  },
  {
    id: "security",
    command: process.execPath,
    args: [join(rootDir, "scripts", "security-scan.mjs")],
  },
];

const results = [];
for (const item of commands) {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(item.command, item.args, {
      cwd: rootDir,
      timeout: item.timeoutMs ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    results.push({
      id: item.id,
      status: "passed",
      ms: Date.now() - startedAt,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    });
  } catch (error) {
    results.push({
      id: item.id,
      status: "failed",
      ms: Date.now() - startedAt,
      error: String(error.stderr || error.stdout || error.message).slice(0, 8_000),
    });
  }
}

const report = {
  schemaVersion: "pengstack.acceptance/v1",
  generatedAt: new Date().toISOString(),
  sourceHead: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootDir })).stdout.trim(),
  sourceDirty:
    (await execFileAsync("git", ["status", "--porcelain"], { cwd: rootDir })).stdout.trim().length > 0,
  result: results.every((item) => item.status === "passed") ? "passed" : "failed",
  checks: results,
  liveReceipts: (await readdir(join(rootDir, "docs", "evidence")))
    .filter((file) => /(?:^|-)(?:live|render)-.*\.json$/i.test(file) || /-live-\d{4}-\d{2}-\d{2}\.json$/i.test(file))
    .sort()
    .map((file) => `docs/evidence/${file}`),
};
const reportPath = join(outputDir, "pengstack-acceptance.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.result !== "passed") process.exitCode = 1;
