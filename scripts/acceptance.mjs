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
      timeout: 120_000,
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
  result: results.every((item) => item.status === "passed") ? "passed" : "failed",
  checks: results,
  liveReceipts: [
    "docs/evidence/personal-geo-live-2026-10-18.json",
    "docs/evidence/media-render-live-2026-10-18.json",
    "docs/evidence/full-system-live-2026-10-18.json",
    "docs/evidence/github-live-2026-10-18.json",
  ],
};
const reportPath = join(outputDir, "pengstack-acceptance.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.result !== "passed") process.exitCode = 1;
