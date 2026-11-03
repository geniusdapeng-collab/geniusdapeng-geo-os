/** Bind formal local postproduction to the current service archive, issued jobs and registered originals. */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  assertProductionSource, ProductionClientError, type ProductionClient, type ProductionProjectResult, type ProductionSourceIdentity,
} from "./production-client.js";
import { fingerprintArtifact, type ArtifactFingerprint } from "./production-lineage.js";

const SHA = /^[a-f0-9]{64}$/;
const SHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface NativeAcceptedClip {
  shotId: string; seconds: number; promptSha256: string;
  jobId: string; taskId: string; assetId: string; scriptId: string; scriptVersion: number;
  qualificationId: string; requestHash: string; payloadHash: string;
  providerModel: string; actualCny: number | null;
  original: ArtifactFingerprint;
}

interface MediaReadback {
  id: string; projectId: string; kind: string; status: string; sourceType: string; hasLocalFile: boolean;
  licenseRisk: string; localPath: string; bytes: number | null; version: number;
  versions: Array<{ id: string; version: number; status: string; sha256: string }>;
  provenance: { source?: string; providerModel?: string; jobId?: string; scriptId?: string; localPath?: string };
}

export async function verifyNativeRenderSources(input: {
  client: ProductionClient; expectedSource: ProductionSourceIdentity; result: ProductionProjectResult;
  providerModel: string; workspaceId: string; mediaRoot: string; durationSeconds: number;
}): Promise<NativeAcceptedClip[]> {
  const { client, expectedSource, result } = input;
  const fail = (reason: string): never => { throw new ProductionClientError("NATIVE_RENDER_SOURCES_UNVERIFIED", reason); };
  const source = await client.shots(expectedSource.projectId);
  assertProductionSource(source, expectedSource);
  if (!input.providerModel.trim() || !/^[A-Za-z0-9_-]{1,100}$/.test(input.workspaceId)
    || !Number.isSafeInteger(input.durationSeconds) || input.durationSeconds <= 0
    || result.mode !== "service-production" || result.status !== "done" || result.projectId !== source.projectId
    || result.sourceStageRunId !== source.sourceStageRunId || result.sourceAttempt !== source.sourceAttempt
    || result.shots.length !== source.shots.length || result.shots.length === 0
    || source.shots.reduce((total, row) => total + row.durationSec, 0) !== input.durationSeconds) {
    fail("An all-shot native success receipt matching the current source and requested duration is required");
  }
  const jobIds = result.shots.flatMap(row => typeof row.jobId === "string" && row.jobId ? [row.jobId] : []);
  if (jobIds.length !== result.shots.length || jobIds.length > 100 || new Set(jobIds).size !== jobIds.length) {
    fail("Expected the complete set of unique native job IDs");
  }
  const jobs = await client.request<Array<Record<string, unknown>>>("video.gen.jobs",
    { projectId: source.projectId, jobIds, limit: jobIds.length }, "GET");
  if (!Array.isArray(jobs)) fail("Authenticated render jobs response is not a list");
  const mediaRoot = realpathSync(input.mediaRoot);
  if (mediaRoot !== path.resolve(input.mediaRoot) || !lstatSync(mediaRoot).isDirectory()) fail("Private media root is not a canonical ordinary directory");
  const seenJobs = new Set<string>(), seenTasks = new Set<string>();
  const accepted: NativeAcceptedClip[] = [];
  for (const [index, planned] of source.shots.entries()) {
    const row = result.shots[index]!;
    if (!SHOT_ID.test(planned.shotId) || planned.shotId.includes("..") || row.shotId !== planned.shotId || row.seconds !== planned.durationSec
      || row.promptSha256 !== planned.promptSha256 || row.sourceStageRunId !== source.sourceStageRunId || row.sourceAttempt !== source.sourceAttempt
      || row.status !== "done" || row.mock !== false || row.error || !row.scriptId || !row.qualificationId || !row.requestHash || !SHA.test(row.requestHash)
      || !row.payloadHash || !SHA.test(row.payloadHash) || !row.scriptVersion || !Number.isSafeInteger(row.scriptVersion) || row.scriptVersion < 1
      || !row.jobId || !row.taskId || !row.assetId || !row.localPath || seenJobs.has(row.jobId) || seenTasks.has(row.taskId)) {
      fail(`Invalid, duplicate or out-of-order native receipt for ${planned.shotId}`);
    }
    const match = jobs.filter(job => job?.id === row.jobId);
    const job = match[0];
    if (match.length !== 1 || job?.project_id !== source.projectId || job?.script_id !== row.scriptId || job?.script_version !== row.scriptVersion
      || job?.task_id !== row.taskId || job?.asset_id !== row.assetId || job?.local_path !== row.localPath
      || job?.provider_model !== input.providerModel || job?.status !== "done" || job?.mock !== false || job?.asset_kind !== "clip") {
      fail(`Current authenticated render job identity changed for ${planned.shotId}`);
    }
    const asset = await client.request<MediaReadback>("video.media.get", { id: row.assetId }, "GET");
    const version = Array.isArray(asset?.versions) ? asset.versions.filter(item => item?.id === row.assetId && item.version === asset.version) : [];
    const digest = version[0]?.sha256;
    if (!asset || asset.id !== row.assetId || asset.projectId !== source.projectId || asset.kind !== "clip" || asset.status !== "registered"
      || asset.sourceType !== "generated" || asset.hasLocalFile !== true || asset.licenseRisk !== "none" || asset.localPath !== row.localPath
      || asset.provenance?.source !== "generated" || asset.provenance.jobId !== row.jobId || asset.provenance.scriptId !== row.scriptId
      || asset.provenance.providerModel !== input.providerModel || asset.provenance.localPath !== row.localPath
      || version.length !== 1 || version[0]?.status !== "registered" || !digest || !SHA.test(digest)) {
      fail(`Current registered original is not bound to the native job for ${planned.shotId}`);
    }
    const rel = row.localPath!;
    const parts = rel.split("/");
    if (parts.length !== 3 || parts[0] !== "video" || parts[1] !== input.workspaceId
      || ![`${digest}.mp4`, `${digest}.webm`].includes(parts[2]!)) {
      fail(`Original is outside the current workspace content-addressed clip store for ${planned.shotId}`);
    }
    const file = path.join(mediaRoot, rel);
    if (realpathSync(file) !== file || !lstatSync(file).isFile()) fail(`Registered original is not a canonical ordinary file for ${planned.shotId}`);
    const original = fingerprintArtifact(file);
    if (original.path !== original.realpath || original.sha256 !== digest || (asset.bytes !== null && asset.bytes !== original.bytes)) {
      fail(`Registered bytes changed or use a symbolic link for ${planned.shotId}`);
    }
    seenJobs.add(row.jobId!); seenTasks.add(row.taskId!);
    accepted.push({ shotId: row.shotId, seconds: row.seconds, promptSha256: row.promptSha256, jobId: row.jobId!, taskId: row.taskId!,
      assetId: row.assetId!, scriptId: row.scriptId!, scriptVersion: row.scriptVersion!, qualificationId: row.qualificationId!,
      requestHash: row.requestHash!, payloadHash: row.payloadHash!, providerModel: input.providerModel,
      actualCny: typeof job?.actual_cny === "number" && Number.isFinite(job.actual_cny) && job.actual_cny >= 0 ? job.actual_cny : null,
      original });
  }
  assertProductionSource(await client.shots(expectedSource.projectId), expectedSource);
  return accepted;
}
