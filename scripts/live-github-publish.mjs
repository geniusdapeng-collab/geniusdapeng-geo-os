import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";
import { GitHubAdapter } from "../src/adapters/github.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const stateFile = join(rootDir, "var", "live-github-state.json");
const store = new JsonStore({ filePath: stateFile });
await store.open(() => loadSeedState(dataDir));
const service = new GeoOsService({ store });
const unused = {
  async health() {
    return { configured: false };
  },
};
const deepSeek = new DeepSeekAdapter();
const github = new GitHubAdapter();
const live = new LivePipelineService({
  service,
  deepSeek,
  github,
  geoEvidence: unused,
  videoEdit: unused,
});

for (const claimId of ["C003", "C005"]) {
  const claim = store.snapshot().claims.find((item) => item.id === claimId);
  if (claim?.state !== "approved") {
    await service.approveClaim(claimId, {
      approvedBy: "Dapeng Li",
      publicLevel: "private",
    });
  }
}

await store.mutate({ type: "github.account_verified", actor: "live-smoke" }, (state) => {
  const account = state.accounts.find((item) => item.id === "github");
  account.status = "active";
  account.policyStatus = "reviewed";
  account.policyCheckedAt = new Date().toISOString().slice(0, 10);
  account.policyNote = "Official GitHub REST issue write verified by the live adapter.";
  return account;
});

const generated = await live.generateContent({
  brief:
    "写一条发布，解释为什么个人 GEO 需要证据控制面，以及为什么私有仓不是公开 GEO 信源。",
  claimIds: ["C003", "C005"],
  platform: "GitHub",
  contentType: "social_post",
});
const contentId = generated.content.id;
for (const target of ["fact_check", "approved", "scheduled"]) {
  await service.transitionContent(contentId, {
    target,
    actor: "Dapeng Li",
    approvedBy: "Dapeng Li",
    note: "Live model-driven GitHub adapter verification",
  });
}
const published = await live.publishContentToGitHub({
  contentId,
  label: "geo-live-smoke",
});

const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const receipt = {
  schemaVersion: "pengstack.live-receipt/v1",
  kind: "model-driven-github-publication",
  completedAt: new Date().toISOString(),
  repository: github.repository,
  contentId,
  contentTitle: generated.content.title,
  model: generated.model,
  issue: published.issue,
  publication: published.publication,
  stateFile: "var/live-github-state.json",
};
const receiptDir = join(rootDir, "docs", "evidence");
await mkdir(receiptDir, { recursive: true });
await writeFile(
  join(receiptDir, `github-live-${date}.json`),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(receipt, null, 2));
