import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hashAdminPassword } from "../../src/security/admin-auth.mjs";

let domain;
let output;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--domain" && args[index + 1]) domain = args[++index].toLowerCase();
  else if (args[index] === "--output" && args[index + 1]) output = resolve(args[++index]);
  else throw new Error("Usage: secret-from-stdin | node deploy/aliyun/configure.mjs --domain admin.example.cn --output /secure/runtime.env");
}

try {
  if (!domain || domain.length > 253 || !domain.includes(".") ||
    domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("--domain must be one ASCII DNS hostname, without scheme, port or path.");
  }
  if (!output || process.stdin.isTTY) throw new Error("Provide an output file and the password only through standard input; never as a command argument.");
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  if (output.split("/").some((segment) => segment === ".git") ||
    (output.startsWith(`${repositoryRoot}/`) && !output.startsWith(`${repositoryRoot}/var/`))) {
    throw new Error("Runtime credentials must be stored outside tracked source (the ignored var/ directory is allowed).");
  }
  await lstat(output).then(() => { throw new Error("Output exists; choose a new protected path and review before replacing runtime configuration."); },
    (error) => { if (error.code !== "ENOENT") throw error; });
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1026) throw new Error("Password input exceeds the supported size.");
    chunks.push(chunk);
  }
  const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  const passwordHash = await hashAdminPassword(password);
  const body = ["# PengManager runtime configuration. Contains credential hashes; keep mode 0600.",
    "NODE_ENV=production", "HOST=127.0.0.1", "PORT=4318", `ALLOWED_HOSTS=${domain}`,
    `PUBLIC_ORIGIN=https://${domain}`, "PUBLIC_WEBSITE=1", "ENABLE_MEDIA_RENDER=false",
    "DATA_FILE=/var/lib/pengmanager-system/state.json",
    "GEO_ENGINE_DB=/var/lib/pengmanager-system/geo-engine/personal-geo.sqlite",
    `ADMIN_PASSWORD_HASH=${passwordHash}`, "ADMIN_AGENT_TOKEN_HASH=", "ADMIN_SESSION_TTL_SECONDS=28800",
    "GITHUB_TOKEN=", "DEEPSEEK_API_KEY=", ""].join("\n");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = `${output}.new-${process.pid}`;
  await writeFile(temporary, body, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  // link with exclusive creation prevents replacing a concurrently-created credential file.
  const { link, unlink } = await import("node:fs/promises");
  try { await link(temporary, output); }
  finally { await unlink(temporary); }
  console.log(JSON.stringify({ ok: true, domain, file: output, mode: "0600", passwordWritten: false }));
} catch (error) {
  console.error(`Configuration failed: ${error.message}`);
  process.exitCode = 1;
}
