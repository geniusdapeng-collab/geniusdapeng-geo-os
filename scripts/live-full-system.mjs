import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { LivePipelineService } from "../src/services/live-pipeline.mjs";
import { DeepSeekAdapter } from "../src/adapters/deepseek.mjs";
import { GitHubAdapter } from "../src/adapters/github.mjs";
import { VideoEditAdapter } from "../src/adapters/video-edit.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import { VideoMediaEngine } from "../src/engines/video-media.mjs";

const rootDir = resolve(import.meta.dirname, "..");
const dataDir = join(rootDir, "data", "seed");
const stateFile = join(rootDir, "var", "live-full-system-state.json");
const store = new JsonStore({ filePath: stateFile });
await store.open(() => loadSeedState(dataDir));
const service = new GeoOsService({ store });
const controlQueries = store.snapshot().queries;
const geoEngine = new PersonalGeoEngine({
  rootDir,
  controlQueries,
});
const mediaEngine = new VideoMediaEngine({ rootDir });
const live = new LivePipelineService({
  service,
  deepSeek: new DeepSeekAdapter(),
  github: new GitHubAdapter(),
  geoEngine,
  videoEdit: new VideoEditAdapter({
    upstreamRoot: join(rootDir, "engines", "video-edit"),
  }),
  mediaEngine,
});

try {
  for (const claimId of ["C003", "C005"]) {
    const claim = store.snapshot().claims.find((item) => item.id === claimId);
    if (claim?.state !== "approved") {
      await service.approveClaim(claimId, {
        approvedBy: "Dapeng Li",
        publicLevel: "private",
      });
    }
  }

  const generated = await live.generateContent({
    brief:
      "生成一条 30 秒以内的专业短视频文案：解释个人 GEO 为什么需要 Claim、证据、审批、发布回执和复测。",
    claimIds: ["C003", "C005"],
    platform: "微信视频号",
    contentType: "video",
  });
  for (const target of ["fact_check", "approved", "scheduled"]) {
    await service.transitionContent(generated.content.id, {
      target,
      actor: "Dapeng Li",
      approvedBy: "Dapeng Li",
      note: "Integrated full-system live run",
    });
  }
  const approvedContent = service.store
    .snapshot()
    .content.find((item) => item.id === generated.content.id);

  const sources = [
    join(rootDir, "var", "media", "fixtures", "pengstack-live-source-1.mp4"),
    join(rootDir, "var", "media", "fixtures", "pengstack-live-source-2.mp4"),
  ];
  const media = await live.renderMedia({
    sources,
    title: generated.content.title,
    coverTitle: "4 层证据链",
    hook: generated.content.generation?.hook || "Claim → 回执 → 复测",
    platform: "微信视频号",
    subtitleText: generated.content.body.slice(0, 90),
  });

  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const receipt = {
    schemaVersion: "pengstack.live-receipt/v1",
    kind: "integrated-model-content-media-pipeline",
    completedAt: new Date().toISOString(),
    content: {
      id: generated.content.id,
      title: generated.content.title,
      status: approvedContent.status,
      version: approvedContent.version,
      claimIds: generated.content.claimIds,
      generation: generated.content.generation,
    },
    model: generated.model,
    geo: {
      caseId: geoEngine.summary().case.id,
      metrics: geoEngine.summary().metrics,
    },
    media: {
      jobId: media.jobId,
      variants: media.variants,
      outputs: media.outputs.map((output) => ({
        file: relative(rootDir, output.path),
        bytes: output.bytes,
        sha256: output.sha256,
      })),
      postQuality: media.manifest.postQuality,
      manifestHash: media.manifestHash,
    },
    state: {
      contentStatus: service.store
        .snapshot()
        .content.find((item) => item.id === generated.content.id)?.status,
      mediaJobs: service.store.snapshot().mediaJobs?.length ?? 0,
      revision: service.store.snapshot().revision,
    },
  };
  const receiptDir = join(rootDir, "docs", "evidence");
  await mkdir(receiptDir, { recursive: true });
  const receiptPath = join(receiptDir, `full-system-live-${date}.json`);
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  geoEngine.close();
}
