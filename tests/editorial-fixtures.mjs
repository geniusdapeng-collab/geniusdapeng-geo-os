import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JsonStore } from "../src/storage/json-store.mjs";
import { loadSeedState, migrateEditorialState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { EditorialService } from "../src/services/editorial-service.mjs";
import { AccountOperationsService } from "../src/services/account-operations.mjs";

export const ROOT = resolve(import.meta.dirname, "..");
export const FIXED_TIME = new Date("2026-10-25T10:00:00.000Z");
export const clock = () => new Date(FIXED_TIME);
export function context(row, key = randomUUID()) {
  return { actor: "isolated unit reviewer", method: "local", idempotencyKey: key, ...(row ? { ifMatch: row.etag } : {}) };
}

// All callbacks and state in these fixtures are isolated test doubles. They do
// not contact a social platform or prove any real website publication.
export async function editorialFixture(t, { verifier = true, mediaAssets, beforeActivation, seedTransform } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-editorial-test-"));
  const store = new JsonStore({ filePath: join(directory, "state.json"), clock });
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const seed = await loadSeedState(join(ROOT, "data/seed"));
  if (seedTransform) seedTransform(seed);
  await store.open(async () => seed);
  await migrateEditorialState(store, { publicOrigin: "https://pengmanager.com", clock });
  const geoService = new GeoOsService({ store, clock });
  const operations = new AccountOperationsService({ service: geoService, clock });
  const calls = { readbacks: 0, media: [] };
  const service = new EditorialService({ store, geoService, clock, publicOrigin: "https://pengmanager.com",
    beforeActivation: beforeActivation === undefined ? async (release, state) => ({ backupId: `EDB-${"f".repeat(32)}`, stage: "pre_activation", releaseId: release.id,
      manifestSha256: "d".repeat(64), stateSha256: "e".repeat(64), assetCount: state.mediaAssets.length, totalBytes: 0, createdAt: FIXED_TIME.toISOString() }) : beforeActivation,
    mediaAssets: mediaAssets ?? { async verifyForRelease(refs) { calls.media.push(structuredClone(refs)); return []; } },
    verifyReadback: verifier === true ? async expected => {
      calls.readbacks += 1;
      return { releaseId: expected.releaseId, snapshotHash: expected.snapshotHash, canonicalUrl: expected.canonicalUrl,
        verifiedAt: FIXED_TIME.toISOString(), method: "server_readback",
        assetHashes: [...new Map(expected.assets.map(ref => [`${ref.assetId}:${ref.sha256}`, { assetId: ref.assetId, sha256: ref.sha256 }])).values()] };
    } : verifier || null });
  return { service, geoService, operations, store, directory, calls };
}

export async function readyWebsite(fixture) {
  await fixture.geoService.approveClaim("C003", { approvedBy: "isolated unit reviewer", publicLevel: "approved_public" });
  const destination = fixture.service.getDestination("official-site");
  await fixture.service.updateDestination("official-site", { visibility: "public", status: "active", identityConfirmed: true,
    policyStatus: "reviewed", policyCheckedAt: FIXED_TIME.toISOString(), reviewNote: "Isolated test of explicit origin and publication review." }, context(destination));
}

export async function createEditionVariant(fixture, { story, locale = "zh-CN", format = "article", title = "隔离测试中的正式文章",
  body = "这是一篇只存在于临时测试目录的完整正文。\n\n它用于核对独立语言修订、审批快照和公开投影，不是一次真实外部发布。",
  summary = "隔离测试资料", assetRefs = [], blocks, sourceEditionId, supersedesEditionId,
  destinationId = "official-site", supersedesContentId } = {}) {
  story ??= await fixture.service.createStory({ workingTitle: "Isolated editorial scenario", claimIds: ["C003"] }, context());
  const currentStory = fixture.service.getStory(story.id);
  const input = { locale, format, title, body, summary, claimIds: ["C003"], assetRefs,
    ...(blocks ? { blocks } : {}), ...(sourceEditionId ? { sourceEditionId } : {}), ...(supersedesEditionId ? { supersedesEditionId } : {}) };
  const edition = await fixture.service.createEdition(story.id, input, context(currentStory));
  const variant = await fixture.service.createVariant(edition.id, { destinationId,
    ...(supersedesContentId ? { supersedesContentId } : {}) }, context(edition));
  return { story, edition, variant };
}

export async function scheduleVariant(fixture, variant) {
  let current = await fixture.service.transitionVariant(variant.id, { target: "fact_check" }, context(variant));
  current = await fixture.service.transitionVariant(variant.id, { target: "approved", reviewed: true, snapshotHash: current.snapshotHash }, context(current));
  return fixture.service.transitionVariant(variant.id, { target: "scheduled" }, context(current));
}

export async function approvedRelease(fixture, variant, slug = "isolated-editorial-case") {
  const scheduled = variant.status === "scheduled" ? variant : await scheduleVariant(fixture, variant);
  let release = await fixture.service.createRelease({ contentId: scheduled.id, slug }, context(scheduled));
  release = await fixture.service.approveRelease(release.id, { reviewed: true, snapshotHash: release.snapshotHash,
    authorizationNote: "Isolated unit approval of this exact public snapshot." }, context(release));
  return release;
}

export async function activateRelease(fixture, release, expectedPreviousReleaseId = null) {
  return fixture.service.publishRelease(release.id, { confirm: true, expectedPreviousReleaseId }, context(release));
}
