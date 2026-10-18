import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const patterns = [
  { name: "github_pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: "fine_grained_github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "openai_key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/g },
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const findings = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, pattern } of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      findings.push({ file, kind: name });
    }
  }
}

if (findings.length > 0) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, filesScanned: files.length }, null, 2));
