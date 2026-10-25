import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { editorialEditionSnapshot, EDITORIAL_SCHEMA } from "../src/domain/editorial.mjs";
import { hashObject } from "../src/domain/hash.mjs";
import { editorialFixture, readyWebsite, createEditionVariant, scheduleVariant, approvedRelease, activateRelease,
  context, FIXED_TIME } from "./editorial-fixtures.mjs";

test("isolated article flow has separate language/content/public approvals, true activation state and a trusted-verifier receipt", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  const { edition, variant } = await createEditionVariant(f);
  assert.equal(edition.editorialRevision, 1); assert.equal(edition.snapshotHash, hashObject(editorialEditionSnapshot(edition)));
  assert.throws(() => f.service.publicDetail({ locale: "zh-CN", format: "article", slug: "isolated-editorial-case" }), { status: 404 });
  const release = await approvedRelease(f, variant);
  const preview = f.service.previewRelease(release.id);
  assert.equal(preview.preview, true); assert.equal(preview.body, variant.body); assert.equal(preview.releaseStatus, "approved");
  assert.equal(f.service.publicList().total, 0);
  const active = await activateRelease(f, release);
  assert.equal(active.status, "live_unverified"); assert.equal(active.receipt, null);
  assert.equal(f.service.getVariant(variant.id).status, "scheduled");
  const publicDoc = f.service.publicDetail({ locale: "zh-CN", format: "article", slug: release.slug });
  assert.equal(publicDoc.body, variant.body); assert.equal(publicDoc.canonicalPath, "/zh/articles/isolated-editorial-case");
  assert.equal(publicDoc.translationStatus, "original"); assert.equal(publicDoc.sources[0].id, "C003");
  assert.equal(publicDoc.accounts, undefined); assert.equal(publicDoc.events, undefined); assert.equal(publicDoc.claimBindings, undefined);
  const verified = await f.service.verifyRelease(active.id, { confirm: true }, context(active));
  assert.equal(verified.status, "published"); assert.equal(verified.receipt.verificationMethod, "server_readback");
  assert.equal(f.calls.readbacks, 1); assert.equal(f.service.getVariant(variant.id).status, "published");
  assert.equal(f.store.snapshot().publications.length, 0, "website revisions use their own ledger");
});

test("new writes enforce principal scope, exact ETags and durable idempotency before stale-retry checks", async t => {
  const f = await editorialFixture(t);
  const input = { workingTitle: "Idempotency case" }, ctx = context(null, "stable-create-key-123");
  const first = await f.service.createStory(input, ctx), before = f.store.snapshot();
  assert.deepEqual(await f.service.createStory(input, ctx), first);
  assert.deepEqual(f.store.snapshot(), before);
  await assert.rejects(f.service.createStory({ workingTitle: "changed" }, ctx), { code: "IDEMPOTENCY_CONFLICT" });
  await assert.rejects(f.service.createStory(input, { ...context(), method: "agent" }), { status: 403 });
  await assert.rejects(f.service.createStory(input, { actor: "test", method: "local" }), { code: "IDEMPOTENCY_KEY_REQUIRED" });
  await assert.rejects(f.service.updateStory(first.id, { workingTitle: "new" }, context()), { status: 428 });
  const update = { workingTitle: "revised title" }, updateCtx = context(first, "stable-update-key-123");
  const result = await f.service.updateStory(first.id, update, updateCtx), snapshot = f.store.snapshot();
  assert.deepEqual(await f.service.updateStory(first.id, update, updateCtx), result);
  assert.deepEqual(f.store.snapshot(), snapshot);
  await assert.rejects(f.service.updateStory(first.id, { workingTitle: "lost update" }, context(first)), { status: 412 });
});

test("two simultaneous parent edits have one winner; a failed mutation adds neither record nor retry receipt", async t => {
  const f = await editorialFixture(t), story = await f.service.createStory({ workingTitle: "Concurrent parent" }, context());
  const revision = f.store.snapshot().revision;
  const attempts = await Promise.allSettled([
    f.service.updateStory(story.id, { workingTitle: "winner A" }, context(story)),
    f.service.updateStory(story.id, { workingTitle: "winner B" }, context(story)),
  ]);
  assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(attempts.find(row => row.status === "rejected").reason.status, 412);
  assert.equal(f.store.snapshot().revision, revision + 1);
  assert.equal(f.store.snapshot().editorialRequests.length, 2);
});

test("immutable edition revisions preserve exact source text and English never inherits Chinese approval", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  const zh = await createEditionVariant(f, { body: "  完整中文原文 <AI>。\n\n第二段保留空白。\n" });
  const scheduledZh = await scheduleVariant(f, zh.variant);
  const en = await createEditionVariant(f, { story: zh.story, locale: "en-US", title: "Independent English edition",
    body: "This is an independently reviewed English account of the same idea.", sourceEditionId: zh.edition.id });
  assert.equal(en.variant.status, "draft"); assert.equal(en.variant.approval, null);
  assert.notEqual(en.variant.snapshotHash, scheduledZh.snapshotHash);
  await assert.rejects(f.service.transitionVariant(en.variant.id, { target: "approved", reviewed: true, snapshotHash: scheduledZh.snapshotHash }, context(en.variant)), { code: "EXACT_EDITORIAL_REVIEW_REQUIRED" });
  const zh2 = await createEditionVariant(f, { story: zh.story, supersedesEditionId: zh.edition.id, title: "第二修订", body: "独立的新正文。" });
  assert.equal(zh2.edition.editorialRevision, 2);
  assert.equal(f.service.getEdition(zh.edition.id).body, zh.edition.body);
  assert.equal(f.service.getEdition(en.edition.id).translationStatus, "needs_review");
  assert.equal(f.service.getEdition(zh.edition.id).snapshotHash, zh.edition.snapshotHash);
  const oldEdition = f.store.snapshot().editions.find(row => row.id === zh.edition.id);
  assert.equal(oldEdition.body, "  完整中文原文 <AI>。\n\n第二段保留空白。\n");
});

test("approvals bind full blocks/captions/assets and the legacy approval and manual-receipt routes cannot bypass v2", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  const { variant } = await createEditionVariant(f);
  await assert.rejects(f.geoService.transitionContent(variant.id, { target: "fact_check", actor: "test" }), { code: "EDITORIAL_TRANSITION_REQUIRED" });
  let row = await f.service.transitionVariant(variant.id, { target: "fact_check" }, context(variant));
  await assert.rejects(f.service.transitionVariant(row.id, { target: "approved", snapshotHash: row.snapshotHash }, context(row)), { code: "EXACT_EDITORIAL_REVIEW_REQUIRED" });
  row = await f.service.transitionVariant(row.id, { target: "approved", reviewed: true, snapshotHash: row.snapshotHash }, context(row));
  row = await f.service.transitionVariant(row.id, { target: "scheduled" }, context(row));
  await assert.rejects(f.geoService.recordPublication({ contentId: row.id, accountId: "github", actor: "test", receipt: {
    url: "https://github.com/geniusdapeng-collab/example/issues/777777", publishedAt: FIXED_TIME.toISOString(), capturedBy: "test", dataMode: "imported",
  } }), { code: "EDITORIAL_OPERATION_REQUIRED" });
  await f.store.mutate({ type: "unit.illicit-caption-change", actor: "test" }, state => {
    state.content.find(item => item.id === row.id).blocks[0].text = "This was never part of the approved blocks.";
  });
  await assert.rejects(f.service.createRelease({ contentId: row.id, slug: "changed-snapshot" }, context(f.service.getVariant(row.id))), { code: "EDITORIAL_SNAPSHOT_CHANGED" });
  assert.equal(f.service.ownsVariant(row.id), true);
});

test("unknown editorial markers fail closed and do not fall through to legacy approval", async t => {
  const f = await editorialFixture(t);
  await f.store.mutate({ type: "unit.unknown-marker", actor: "test" }, state => { state.content[0].snapshotSchema = "unsupported/future/v999"; });
  const id = f.store.snapshot().content[0].id;
  assert.equal(f.service.ownsVariant(id), true);
  assert.throws(() => f.service.getVariant(id), { code: "EDITORIAL_SCHEMA_UNSUPPORTED" });
  await assert.rejects(f.geoService.transitionContent(id, { target: "fact_check", actor: "test" }), { code: "EDITORIAL_TRANSITION_REQUIRED" });
});

test("public projection rechecks Claim approval/source/expiry and never exports private markers", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  await f.store.mutate({ type: "unit.private-metadata", actor: "test" }, state => {
    state.entity.privateNote = "PRIVATE_ENTITY_CANARY";
    state.accounts[0].privateNote = "PRIVATE_ACCOUNT_CANARY";
    state.claims.find(row => row.id === "C003").source.internalNote = "PRIVATE_SOURCE_CANARY";
  });
  const { variant } = await createEditionVariant(f), release = await approvedRelease(f, variant);
  await activateRelease(f, release);
  const data = JSON.stringify(f.service.publicDetail({ locale: "zh-CN", format: "article", slug: release.slug }));
  assert.doesNotMatch(data, /PRIVATE_ENTITY_CANARY|PRIVATE_ACCOUNT_CANARY|PRIVATE_SOURCE_CANARY/);
  await f.store.mutate({ type: "unit.revoke-public-claim", actor: "test" }, state => { state.claims.find(row => row.id === "C003").publicLevel = "private"; });
  assert.equal(f.service.publicList().total, 0);
  assert.throws(() => f.service.publicDetail({ locale: "zh-CN", format: "article", slug: release.slug }), { status: 410 });
  const current = f.service.getRelease(release.id);
  assert.equal(current.publicSnapshot.body, variant.body, "private history is retained");
});

test("safe URL and text checks block sensitive input, raw HTML blocks, malformed UTF16 and unbound media before any write", async t => {
  const f = await editorialFixture(t), story = await f.service.createStory({ workingTitle: "Input boundaries" }, context());
  const base = { locale: "zh-CN", format: "article", title: "测试", body: "有效正文。", claimIds: ["C003"] };
  const before = f.store.snapshot();
  for (const patch of [
    { body: "" }, { body: "x".repeat(50_001) }, { body: "\uD800" },
    { body: "A synthetic private@example.com address is not approved public text." },
    { blocks: [{ type: "html", text: "<script>not allowed</script>" }] },
    { blocks: [{ type: "image", assetId: "asset-missing", alt: "missing" }] },
    { unexpected: "unrecognized input" },
  ]) await assert.rejects(f.service.createEdition(story.id, { ...base, ...patch }, context(story)), error => [400, 409].includes(error.status));
  assert.deepEqual(f.store.snapshot(), before);
  const maximum = await f.service.createEdition(story.id, { ...base, body: "x".repeat(50_000) }, context(story));
  assert.equal(maximum.body.length, 50_000);
});

async function reviewedTestAssets(f) {
  await f.store.mutate({ type: "unit.synthetic-reviewed-assets", actor: "test" }, state => {
    state.mediaAssets.push(...[
      { id: "MA-image", sha256: "a".repeat(64), mime: "image/png", kind: "image", size: 67, width: 1, height: 1 },
      { id: "MA-video", sha256: "b".repeat(64), mime: "video/mp4", kind: "video", size: 1024 },
    ].map(row => ({ ...row, status: "reviewed", privatePath: "PRIVATE_MEDIA_PATH_CANARY", review: { rightsConfirmed: true, privacyConfirmed: true } })));
  });
  return {
    image: { assetId: "MA-image", sha256: "a".repeat(64), role: "image", alt: "隔离测试图", caption: "只验证结构与权限的合成素材。" },
    video: { assetId: "MA-video", sha256: "b".repeat(64), role: "video", alt: "", caption: "隔离测试视频" },
  };
}

test("gallery/video publication uses exact reviewed media, invokes byte verification and revocation withdraws public eligibility", async t => {
  const f = await editorialFixture(t); await readyWebsite(f); const refs = await reviewedTestAssets(f);
  const { variant } = await createEditionVariant(f, { format: "image_text", assetRefs: [refs.image], blocks: [
    { type: "paragraph", text: "An isolated gallery description." }, { type: "image", assetId: refs.image.assetId, alt: refs.image.alt, caption: refs.image.caption },
  ] });
  const release = await approvedRelease(f, variant, "isolated-gallery");
  assert.equal(f.service.isAssetPublic(refs.image.assetId, refs.image.sha256), false);
  const preview = f.service.previewRelease(release.id); assert.equal(preview.assets[0].url, "/api/media/assets/MA-image/bytes");
  await activateRelease(f, release); assert.equal(f.calls.media.length, 1);
  const doc = f.service.publicDetail({ locale: "zh-CN", format: "image_text", slug: release.slug });
  assert.equal(doc.canonicalPath, "/zh/visuals/isolated-gallery"); assert.equal(doc.assets[0].url, `/public-media/MA-image/${refs.image.sha256}`);
  assert.doesNotMatch(JSON.stringify(doc), /PRIVATE_MEDIA_PATH_CANARY/);
  assert.equal(f.service.isAssetPublic(refs.image.assetId, refs.image.sha256), true);
  assert.equal(f.service.isAssetPublic(refs.image.assetId, "c".repeat(64)), false);
  await f.store.mutate({ type: "unit.revoke-media", actor: "test" }, state => { state.mediaAssets.find(row => row.id === refs.image.assetId).status = "revoked"; });
  assert.equal(f.service.isAssetPublic(refs.image.assetId, refs.image.sha256), false);
  assert.throws(() => f.service.publicDetail({ locale: "zh-CN", format: "image_text", slug: release.slug }), { status: 410 });
  const video = await createEditionVariant(f, { format: "video", assetRefs: [refs.video], body: "A complete independent test video transcript.",
    blocks: [{ type: "video", assetId: refs.video.assetId, caption: refs.video.caption }, { type: "paragraph", text: "A complete independent test video transcript." }] });
  const videoRelease = await approvedRelease(f, video.variant, "isolated-video"); await activateRelease(f, videoRelease);
  assert.equal(f.service.publicDetail({ locale: "zh-CN", format: "video", slug: "isolated-video" }).canonicalPath, "/zh/videos/isolated-video");
});

test("failed byte verification or pre-activation backup cannot change the active route", async t => {
  const f = await editorialFixture(t, { mediaAssets: { async verifyForRelease() { throw Object.assign(new Error("isolated disk fixture failure"), { code: "EIO" }); } } });
  await readyWebsite(f); const refs = await reviewedTestAssets(f);
  const { variant } = await createEditionVariant(f, { format: "image_text", assetRefs: [refs.image] });
  const release = await approvedRelease(f, variant), before = f.store.snapshot();
  await assert.rejects(activateRelease(f, release), { code: "EIO" });
  assert.deepEqual(f.store.snapshot(), before);
  f.service.mediaAssets = { async verifyForRelease() { return []; } };
  f.service.beforeActivation = async () => { throw Object.assign(new Error("isolated backup fixture failure"), { code: "ENOSPC" }); };
  await assert.rejects(activateRelease(f, release), { code: "ENOSPC" });
  assert.deepEqual(f.store.snapshot(), before);
  f.service.beforeActivation = async (_release, state) => ({ backupId: `EDB-${"f".repeat(32)}`, stage: "pre_activation", releaseId: _release.id, manifestSha256: "d".repeat(64), stateSha256: hashObject(state),
    assetCount: state.mediaAssets.length, totalBytes: 1091, createdAt: FIXED_TIME.toISOString(), path: "PRIVATE_BACKUP_PATH_CANARY" });
  const active = await activateRelease(f, release);
  assert.equal(active.activationBackup.stage, "pre_activation"); assert.equal(active.activationBackup.path, undefined);
});

test("readback is a trusted callback, not caller-provided hashes, and mismatches never mark a release published", async t => {
  const f = await editorialFixture(t, { verifier: false }); await readyWebsite(f);
  const { variant } = await createEditionVariant(f), release = await approvedRelease(f, variant), active = await activateRelease(f, release);
  const before = f.store.snapshot();
  await assert.rejects(f.service.verifyRelease(active.id, { confirm: true, snapshotHash: active.snapshotHash }, context(active)), { code: "UNKNOWN_FIELD" });
  await assert.rejects(f.service.verifyRelease(active.id, { confirm: true }, context(active)), { code: "WEBSITE_READBACK_UNAVAILABLE" });
  f.service.verifyReadback = async expected => ({ releaseId: expected.releaseId, snapshotHash: "e".repeat(64), canonicalUrl: expected.canonicalUrl,
    verifiedAt: FIXED_TIME.toISOString(), method: "server_readback", assetHashes: [] });
  await assert.rejects(f.service.verifyRelease(active.id, { confirm: true }, context(active)), { code: "WEBSITE_READBACK_MISMATCH" });
  assert.deepEqual(f.store.snapshot(), before);
});

test("stable canonical routes retain old snapshots; atomic activation has one winner and withdrawal retains receipts", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  const first = await createEditionVariant(f), release1 = await approvedRelease(f, first.variant), active1 = await activateRelease(f, release1);
  const published1 = await f.service.verifyRelease(active1.id, { confirm: true }, context(active1));
  const oldReceipt = structuredClone(published1.receipt);
  const second = await createEditionVariant(f, { story: first.story, supersedesEditionId: first.edition.id, body: "Second complete isolated revision." });
  const variant2 = await scheduleVariant(f, second.variant);
  await assert.rejects(f.service.createRelease({ contentId: variant2.id, slug: "must-not-silently-change" }, context(variant2)), { code: "CANONICAL_ROUTE_MISMATCH" });
  const release2 = await approvedRelease(f, variant2);
  const anotherVariant = await f.service.createVariant(second.edition.id, { destinationId: "official-site", body: "Alternative independently approved text." }, context(f.service.getEdition(second.edition.id)));
  const release3 = await approvedRelease(f, anotherVariant);
  const attempts = await Promise.allSettled([activateRelease(f, release2, release1.id), activateRelease(f, release3, release1.id)]);
  assert.equal(attempts.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(attempts.find(row => row.status === "rejected").reason.code, "RELEASE_ROUTE_CONFLICT");
  assert.deepEqual(f.service.getRelease(release1.id).receipt, oldReceipt);
  const current = attempts.find(row => row.status === "fulfilled").value;
  const doc = f.service.publicDetail({ locale: "zh-CN", format: "article", slug: release1.slug });
  assert.equal(doc.releaseId, current.id); assert.equal(doc.canonicalPath, published1.canonicalPath);
  const beforeWithdraw = f.store.snapshot().websiteReleases.length;
  const withdrawn = await f.service.withdrawRelease(current.id, { reason: "Isolated withdrawal fixture." }, context(current));
  assert.equal(withdrawn.status, "withdrawn"); assert.equal(f.store.snapshot().websiteReleases.length, beforeWithdraw);
  assert.throws(() => f.service.publicDetail({ locale: "zh-CN", format: "article", slug: release1.slug }), { status: 410 });
});

test("public list validates locale/filter/cursor and private untranslated revisions do not leak a stale-translation warning", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  const zh = await createEditionVariant(f), zhRelease = await approvedRelease(f, zh.variant), zhActive = await activateRelease(f, zhRelease);
  const en = await createEditionVariant(f, { story: zh.story, locale: "en-US", title: "English public fixture", body: "Independent English body.", sourceEditionId: zh.edition.id });
  const enRelease = await approvedRelease(f, en.variant, "english-fixture"); await activateRelease(f, enRelease);
  let enDoc = f.service.publicDetail({ locale: "en-US", format: "article", slug: enRelease.slug });
  assert.equal(enDoc.translationStatus, "source_revision_linked"); assert.equal(enDoc.alternates["zh-CN"], `https://pengmanager.com${zhActive.canonicalPath}`);
  const newer = await createEditionVariant(f, { story: zh.story, supersedesEditionId: zh.edition.id, body: "A private new Chinese draft is not public yet." });
  assert.equal(f.service.getEdition(en.edition.id).translationStatus, "needs_review");
  enDoc = f.service.publicDetail({ locale: "en-US", format: "article", slug: enRelease.slug }); assert.equal(enDoc.translationStatus, "source_revision_linked");
  const newerRelease = await approvedRelease(f, newer.variant); await activateRelease(f, newerRelease, zhRelease.id);
  enDoc = f.service.publicDetail({ locale: "en-US", format: "article", slug: enRelease.slug }); assert.equal(enDoc.translationStatus, "needs_review");
  assert.equal(f.service.publicList({ locale: "en-US", q: "independent", limit: 1 }).total, 1);
  assert.throws(() => f.service.publicList({ locale: "de-DE" }), { code: "INVALID_LOCALE" });
  assert.throws(() => f.service.publicList({ limit: 0 }), { code: "INVALID_LIMIT" });
  assert.throws(() => f.service.publicList({ cursor: "not-a-cursor" }), { code: "INVALID_CURSOR" });
  const two = await createEditionVariant(f, { title: "Second story" }), twoRelease = await approvedRelease(f, two.variant, "second-story"); await activateRelease(f, twoRelease);
  const page = f.service.publicList({ limit: 1 }); assert.equal(page.items.length, 1); assert.equal(typeof page.nextCursor, "string");
  const next = f.service.publicList({ limit: 1, cursor: page.nextCursor }); assert.notEqual(next.items[0].releaseId, page.items[0].releaseId);
  assert.throws(() => f.service.publicList({ locale: "en-US", cursor: page.nextCursor }), { code: "INVALID_CURSOR" });
});

test("account setup is explicit, history is retained, and unresolved external results block identity changes or archival", async t => {
  const f = await editorialFixture(t);
  let account = await f.service.createAccount({ platformId: "tiktok", handle: "isolated-owner", profileUrl: "https://www.tiktok.com/@isolated-owner", language: "en-US" }, context());
  assert.equal(account.status, "draft"); assert.equal(account.identityReview.status, "unverified");
  await assert.rejects(f.service.updateAccount(account.id, { status: "active" }, context(account)), { code: "ACCOUNT_NOT_READY" });
  account = await f.service.updateAccount(account.id, { identityConfirmed: true, policyStatus: "reviewed", policyCheckedAt: FIXED_TIME.toISOString(),
    reviewNote: "Isolated explicit identity and rules check.", status: "active" }, context(account));
  assert.equal(account.identityReview.status, "verified"); assert.equal(f.service.accountHistory(account.id).items.length, 2);
  await f.store.mutate({ type: "unit.pending-result", actor: "test" }, state => { state.accountOperations = [{ id: "OP-9999", accountId: account.id, status: "in_progress" }]; });
  await assert.rejects(f.service.updateAccount(account.id, { status: "archived", reason: "Stop this channel" }, context(account)), { code: "ACCOUNT_RECONCILIATION_REQUIRED" });
  await assert.rejects(f.service.updateAccount(account.id, { handle: "different-owner" }, context(account)), { code: "ACCOUNT_RECONCILIATION_REQUIRED" });
  await f.store.mutate({ type: "unit.resolve-fixture", actor: "test" }, state => { state.accountOperations[0].status = "completed"; });
  const archived = await f.service.updateAccount(account.id, { status: "archived", reason: "Stop this channel" }, context(account));
  assert.equal(archived.status, "archived"); assert.equal(f.service.getAccount(account.id).handle, "isolated-owner");
  assert.ok(f.service.accountHistory(account.id).items.some(row => row.reason === "Stop this channel"));
  assert.equal(f.store.snapshot().accountOperations[0].id, "OP-9999");
});
