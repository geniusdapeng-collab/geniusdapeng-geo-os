import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let outDir = resolve(root, "var/deployment-packages");
let dryRun = false;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--out-dir" && args[index + 1]) outDir = resolve(args[++index]);
  else if (args[index] === "--dry-run") dryRun = true;
  else throw new Error("Usage: node scripts/package-deployment.mjs [--out-dir DIRECTORY] [--dry-run]");
}

const excludedSegments = new Set([".git", "var", ".env", "node_modules", "outputs", "work", "coverage", "__pycache__"]);
const excludedName = /^(?:\.env(?:\..*)?|\.npmrc|.*\.(?:pem|key|p12|pfx|pyc)|(?:cookies?|credentials?)\.(?:json|txt|env)|runtime\.env)$/i;
function allowed(path) {
  const segments = path.split("/");
  return !isAbsolute(path) && !segments.includes("..") &&
    !segments.some((segment) => excludedSegments.has(segment) || excludedName.test(segment));
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bLTAI[A-Za-z0-9]{16,}\b/,
];

let staging;
try {
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim());
  const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean);
  const files = [];
  for (const path of [...new Set(candidates)].filter(allowed).sort()) {
    if (!/^[\p{L}\p{N}_.\-/]+$/u.test(path)) throw new Error(`Deployment path needs explicit review: ${path}`);
    const absolute = resolve(root, path);
    if (!absolute.startsWith(`${root}${sep}`)) throw new Error("Source path escapes repository.");
    let stat;
    try { stat = await lstat(absolute); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile()) throw new Error(`Refusing non-regular deployment source: ${path}`);
    const data = await readFile(absolute);
    if (secretPatterns.some((pattern) => pattern.test(data.toString("utf8")))) {
      throw new Error(`Possible credential in deployment source: ${path}; value withheld.`);
    }
    files.push({ path, sha256: digest(data), size: data.length, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  }
  for (const required of ["package.json", "pnpm-lock.yaml", "src/server.mjs", "src/security/admin-auth.mjs",
    "deploy/aliyun/deploy.py", "deploy/aliyun/nginx_proxy.py", "deploy/aliyun/configure.mjs", "public/index.html"]) {
    if (!files.some((file) => file.path === required)) throw new Error(`Required file missing: ${required}`);
  }
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(packageJson.packageManager)) throw new Error("packageManager must pin an exact pnpm version.");
  const contentSha256 = digest(JSON.stringify(files));
  const manifest = { schema: "pengmanager-deployment/v1", gitSha, dirty, contentSha256,
    createdAt: new Date().toISOString(), packageManager: packageJson.packageManager, files };
  const name = `pengmanager-system-${gitSha.slice(0, 12)}-${contentSha256.slice(0, 12)}.tar.gz`;
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, gitSha, dirty, files: files.length,
      contentSha256, archive: join(outDir, name), excluded: candidates.length - files.length }, null, 2));
  } else {
    await mkdir(outDir, { recursive: true, mode: 0o700 });
    staging = await mkdtemp(join(tmpdir(), "pengmanager-package-"));
    const app = join(staging, "app");
    await mkdir(app);
    for (const file of files) {
      const target = join(app, file.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(root, file.path), target);
      await chmod(target, file.mode);
      // Re-read the copied file: a concurrent editor must never produce an invalid manifest.
      if (digest(await readFile(target)) !== file.sha256) throw new Error(`Source changed while packaging: ${file.path}; retry after edits finish.`);
    }
    await writeFile(join(app, "deployment-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    const archive = join(outDir, name);
    await writeFile(archive, "", { mode: 0o600, flag: "wx" });
    execFileSync("tar", ["-czf", archive, "-C", staging, "app"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    await chmod(archive, 0o600);
    const archiveSha256 = digest(await readFile(archive));
    await writeFile(`${archive}.sha256`, `${archiveSha256}  ${basename(archive)}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(`${archive}.manifest.json`, `${JSON.stringify({ ...manifest, archiveSha256, archive: basename(archive) }, null, 2)}\n`,
      { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ ok: true, gitSha, dirty, files: files.length, contentSha256, archive, archiveSha256,
      checksumFile: `${archive}.sha256`, manifestFile: `${archive}.manifest.json` }, null, 2));
  }
} catch (error) {
  console.error(`Deployment package failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
}
