import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { editorialInput, normalizeEditorialAssetRefs, normalizeEditorialBlocks, assertEditorialAssets, assertEditorialStateIntegrity } from "../src/domain/editorial.mjs";
import { JsonStore } from "../src/storage/json-store.mjs";
import { editorialFixture, readyWebsite, createEditionVariant, approvedRelease, activateRelease, context, FIXED_TIME } from "./editorial-fixtures.mjs";

test("sensitive scan exempts validated machine digest and community IDs while keeping human text and malformed fields visible", () => {
  const digest = `a13800138000a${"b".repeat(51)}`;
  assert.equal(digest.length, 64);
  assert.doesNotThrow(() => editorialInput({ sha256: digest, serverId: "123456789012345678", channelId: "13800138000" }, ["sha256", "serverId", "channelId"]));
  assert.throws(() => editorialInput({ body: digest }, ["body"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  assert.throws(() => editorialInput({ sha256: digest.slice(0, -1) }, ["sha256"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  assert.throws(() => editorialInput({ serverId: "x13800138000" }, ["serverId"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
});

test("canonical media asset IDs with phone-like digits survive reference and block normalization without changing input", () => {
  const assetId = `MED-a13800138000a${"b".repeat(19)}`;
  assert.equal(assetId.length, 36);
  const input = { assetRefs: [{ assetId, sha256: "a".repeat(64), role: "image", alt: "Synthetic image", caption: "" }] };
  const before = structuredClone(input);
  assert.equal(editorialInput(input, ["assetRefs"]), input);
  assert.deepEqual(input, before);
  const refs = normalizeEditorialAssetRefs(input.assetRefs, "zh-CN");
  assert.equal(refs[0].assetId, assetId);
  assert.equal(normalizeEditorialBlocks([{ type: "image", assetId, alt: "Synthetic image" }], "body", refs)[0].assetId, assetId);
});

test("canonical media poster IDs require the video block's bound poster or cover reference", () => {
  const posterAssetId = `MED-a13800138000a${"b".repeat(19)}`, assetId = `MED-${"c".repeat(32)}`;
  for (const role of ["poster", "cover"]) {
    const refs = normalizeEditorialAssetRefs([
      { assetId, sha256: "a".repeat(64), role: "video", alt: "" },
      { assetId: posterAssetId, sha256: "b".repeat(64), role, alt: "Synthetic poster" },
    ], "zh-CN");
    const block = { type: "video", assetId, posterAssetId, caption: "Synthetic video" };
    assert.deepEqual(normalizeEditorialBlocks([block], "body", refs), [block]);
    assert.throws(() => normalizeEditorialBlocks([block], "body", refs.filter(ref => ref.role === "video")), { code: "UNBOUND_DOCUMENT_ASSET" });
  }
});

test("only exact media-reference fields exempt canonical IDs; malformed IDs, prose and credential URLs stay blocked", () => {
  const assetId = `MED-a13800138000a${"b".repeat(19)}`;
  for (const field of ["assetId", "posterAssetId"]) {
    for (const value of [assetId.slice(0, -1), `${assetId}b`, assetId.toUpperCase(), assetId.replace("MED-", "med-"),
      `${assetId.slice(0, -1)}g`, `prefix-${assetId}`, `${assetId} suffix`, `${assetId}\n`, [assetId], { value: assetId }]) {
      assert.throws(() => editorialInput({ [field]: value }, [field]), { code: "EDITORIAL_SENSITIVE_INPUT" });
    }
  }
  for (const field of ["id", "body", "caption", "alt"]) {
    assert.throws(() => editorialInput({ [field]: assetId }, [field]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  }
  assert.throws(() => editorialInput({ assetId, body: "Call 13800138000" }, ["assetId", "body"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  assert.throws(() => editorialInput({ assetId, body: "https://docs.github.com/page?token=x" }, ["assetId", "body"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
});

test("a canonical media ID never substitutes for an existing matching reviewed asset", () => {
  const assetId = `MED-a13800138000a${"b".repeat(19)}`;
  const refs = normalizeEditorialAssetRefs([{ assetId, sha256: "a".repeat(64), role: "image", alt: "Synthetic image" }], "zh-CN");
  const asset = { id: assetId, sha256: "a".repeat(64), kind: "image", status: "reviewed",
    review: { rightsConfirmed: true, privacyConfirmed: true } };
  assert.doesNotThrow(() => assertEditorialAssets({ mediaAssets: [asset] }, refs, { reviewed: true }));
  assert.throws(() => assertEditorialAssets({ mediaAssets: [] }, refs, { reviewed: true }), { code: "EDITORIAL_ASSET_MISMATCH" });
  for (const patch of [{ sha256: "b".repeat(64) }, { kind: "video" }]) {
    assert.throws(() => assertEditorialAssets({ mediaAssets: [{ ...asset, ...patch }] }, refs, { reviewed: true }), { code: "EDITORIAL_ASSET_MISMATCH" });
  }
  for (const patch of [{ status: "staged" }, { status: "revoked" }, { review: { rightsConfirmed: false, privacyConfirmed: true } },
    { review: { rightsConfirmed: true, privacyConfirmed: false } }]) {
    assert.throws(() => assertEditorialAssets({ mediaAssets: [{ ...asset, ...patch }] }, refs, { reviewed: true }), { code: "EDITORIAL_ASSET_NOT_REVIEWED" });
  }
});

test("short and encoded credential URLs are blocked in body text but ordinary localhost tutorial links remain text", () => {
  for (const body of ["https://docs.github.com/page?token=x", "https://docs.github.com/page?%74%6fken=x",
    "https://docs.github.com/page#access%255Ftoken%253Dx", "https://u:p@docs.github.com/page", "https%3A%2F%2Fdocs.github.com%2Fp%3Fsession%3Dx",
    "https://docs.github.com/redirect?next=https%3A%2F%2Fdocs.github.com%2Fp%3Ftoken%3Dx"]) {
    assert.throws(() => editorialInput({ body }, ["body"]), { code: "EDITORIAL_SENSITIVE_INPUT" });
  }
  assert.doesNotThrow(() => editorialInput({ body: "For this local tutorial open http://localhost:4318/healthz or https://docs.github.com/page#ordinary-anchor." }, ["body"]));
});

test("one image can have distinct cover/image/poster roles independent of order, and subtitle language remains explicit", () => {
  const image = { assetId: "MA-image", sha256: "a".repeat(64), alt: "Image", caption: "" };
  for (const roles of [["poster", "image"], ["image", "poster"]]) {
    const refs = normalizeEditorialAssetRefs(roles.map(role => ({ ...image, role })), "zh-CN");
    assert.equal(normalizeEditorialBlocks([{ type: "image", assetId: image.assetId, alt: "Image" }], "body", refs)[0].assetId, image.assetId);
  }
  const subtitles = normalizeEditorialAssetRefs([{ assetId: "MA-vtt-en", sha256: "b".repeat(64), role: "subtitle", alt: "", caption: "English subtitles", locale: "en-US" }], "zh-CN");
  assert.equal(subtitles[0].locale, "en-US");
  assert.throws(() => normalizeEditorialAssetRefs([{ ...image, role: "image", locale: "en-US" }], "zh-CN"), { code: "ASSET_LOCALE_MISMATCH" });
});

test("public and private preview DTOs carry the exact approved subtitle language", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  await f.store.mutate({ type: "unit.synthetic-bilingual-video", actor: "test" }, state => state.mediaAssets.push(...[
    { id: "MA-video", kind: "video", mime: "video/mp4", sha256: "a".repeat(64) },
    { id: "MA-vtt-en", kind: "caption", mime: "text/vtt", sha256: "b".repeat(64) },
    { id: "MA-vtt-zh", kind: "caption", mime: "text/vtt", sha256: "c".repeat(64) },
  ].map(row => ({ ...row, size: 123, status: "reviewed", review: { rightsConfirmed: true, privacyConfirmed: true } }))));
  const assetRefs = [
    { assetId: "MA-video", sha256: "a".repeat(64), role: "video", alt: "", caption: "Unit video" },
    { assetId: "MA-vtt-en", sha256: "b".repeat(64), role: "subtitle", alt: "", caption: "English subtitles", locale: "en-US" },
    { assetId: "MA-vtt-zh", sha256: "c".repeat(64), role: "subtitle", alt: "", caption: "中文字幕", locale: "zh-CN" },
  ];
  const { variant } = await createEditionVariant(f, { format: "video", assetRefs });
  const release = await approvedRelease(f, variant, "bilingual-video-unit");
  assert.deepEqual(f.service.previewRelease(release.id).assets.map(row => row.locale), ["zh-CN", "en-US", "zh-CN"]);
  await activateRelease(f, release);
  assert.deepEqual(f.service.publicDetail({ locale: "zh-CN", format: "video", slug: release.slug }).assets.map(row => row.locale), ["zh-CN", "en-US", "zh-CN"]);
});

test("pre-activation full backup is mandatory and wrong stage, release or digest never activates a route", async t => {
  const f = await editorialFixture(t, { beforeActivation: null }); await readyWebsite(f);
  const { variant } = await createEditionVariant(f), release = await approvedRelease(f, variant), before = f.store.snapshot();
  await assert.rejects(activateRelease(f, release), { code: "EDITORIAL_BACKUP_UNAVAILABLE" });
  const valid = { backupId: `EDB-${"d".repeat(32)}`, stage: "pre_activation", releaseId: release.id, manifestSha256: "e".repeat(64),
    stateSha256: "f".repeat(64), assetCount: 0, totalBytes: 0, createdAt: FIXED_TIME.toISOString() };
  for (const patch of [{ stage: "current" }, { releaseId: "REL-other" }, { backupId: "EDB-arbitrary-attestation" }, { manifestSha256: "invalid" }, { totalBytes: -1 }]) {
    f.service.beforeActivation = async () => ({ ...valid, ...patch });
    await assert.rejects(activateRelease(f, release), { code: "EDITORIAL_BACKUP_INVALID_RECEIPT" });
    assert.deepEqual(f.store.snapshot(), before);
  }
});

test("new final-state routes invoke the existing backup writer and report failures without undoing the approved state", async t => {
  const f = await editorialFixture(t); await readyWebsite(f); const saved = [];
  f.geoService.finalContentBackup = { async save(row) { saved.push({ id: row.id, body: row.body, status: row.status }); throw new Error("Synthetic isolated backup failure"); } };
  const { variant } = await createEditionVariant(f);
  let row = await f.service.transitionVariant(variant.id, { target: "fact_check" }, context(variant));
  assert.equal(saved.length, 0);
  row = await f.service.transitionVariant(row.id, { target: "approved", reviewed: true, snapshotHash: row.snapshotHash }, context(row));
  assert.equal(row.status, "approved"); assert.equal(row.finalBackup.code, "FINAL_BACKUP_IO_ERROR");
  row = await f.service.transitionVariant(row.id, { target: "scheduled" }, context(row));
  assert.equal(row.status, "scheduled"); assert.equal(saved.length, 2);
  const release = await approvedRelease(f, row), active = await activateRelease(f, release);
  const published = await f.service.verifyRelease(active.id, { confirm: true }, context(active));
  assert.equal(published.status, "published"); assert.equal(published.finalBackup.status, "error");
  assert.deepEqual(saved.map(item => item.status), ["approved", "scheduled", "published"]);
  assert.ok(saved.every(item => item.body === variant.body));
});

test("reopened v2 writer rejects duplicate or dangling indexes and changed immutable snapshots without rewriting source", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  const { variant } = await createEditionVariant(f), release = await approvedRelease(f, variant); await activateRelease(f, release);
  const good = f.store.snapshot(); assert.doesNotThrow(() => assertEditorialStateIntegrity(good));
  const scenarios = [
    state => state.accounts.push(structuredClone(state.accounts[0])),
    state => state.editions.push({ ...structuredClone(state.editions[0]), id: "ED-unique-but-same-revision" }),
    state => { state.content.find(row => row.id === variant.id).editionId = "missing-parent"; },
    state => { state.editions[0].body = "Changed immutable edition"; },
    state => { state.content.find(row => row.id === variant.id).assetRefs = [{ assetId: "missing-asset" }]; },
    state => { state.websiteReleases[0].publicSnapshot.body = "Changed immutable public body"; },
    state => state.websiteRoutes.push({ ...structuredClone(state.websiteRoutes[0]), id: "RTE-other" }),
    state => { state.websiteRoutes[0].activeReleaseId = "REL-missing"; },
    state => { state.content[0].snapshotSchema = "unsupported/v99"; },
  ];
  for (const [index, corrupt] of scenarios.entries()) {
    const state = structuredClone(good); corrupt(state);
    const path = join(f.directory, `corrupt-${index}.json`), bytes = JSON.stringify(state); await writeFile(path, bytes);
    const store = new JsonStore({ filePath: path, writerLock: true });
    await assert.rejects(store.open(async () => { throw new Error("must not reseed"); }), { code: "STATE_EDITORIAL_INVALID" });
    assert.equal(await readFile(path, "utf8"), bytes); await assert.rejects(readFile(`${path}.writer.lock`), { code: "ENOENT" });
  }
});

test("a long real backup uses completion time for activation and rechecks Claims that expire during capture", async t => {
  for (const expiresDuringBackup of [false, true]) await t.test(String(expiresDuringBackup), async child => {
    const f = await editorialFixture(child); await readyWebsite(f);
    if (expiresDuringBackup) await f.store.mutate({ type: "unit.short-claim-validity", actor: "test" }, state => {
      state.claims.find(row => row.id === "C003").expiresAt = new Date(FIXED_TIME.getTime() + 30_000).toISOString();
    });
    const { variant } = await createEditionVariant(f), release = await approvedRelease(f, variant), before = f.store.snapshot();
    let now = new Date(FIXED_TIME); f.service.clock = () => new Date(now);
    f.service.beforeActivation = async row => {
      now = new Date(FIXED_TIME.getTime() + 61_000);
      return { backupId: `EDB-${"d".repeat(32)}`, stage: "pre_activation", releaseId: row.id, manifestSha256: "e".repeat(64),
        stateSha256: "f".repeat(64), assetCount: 0, totalBytes: 0, createdAt: now.toISOString() };
    };
    if (expiresDuringBackup) {
      await assert.rejects(activateRelease(f, release), { code: "CONTENT_APPROVAL_BLOCKED" });
      assert.deepEqual(f.store.snapshot(), before);
    } else {
      const active = await activateRelease(f, release);
      assert.equal(active.activationAt, now.toISOString()); assert.equal(active.activationBackup.createdAt, now.toISOString());
    }
  });
});

test("readback rechecks Claim eligibility at completion rather than using a stale request start time", async t => {
  const f = await editorialFixture(t); await readyWebsite(f);
  await f.store.mutate({ type: "unit.claim-expiring-during-readback", actor: "test" }, state => {
    state.claims.find(row => row.id === "C003").expiresAt = new Date(FIXED_TIME.getTime() + 30_000).toISOString();
  });
  const { variant } = await createEditionVariant(f), release = await approvedRelease(f, variant), active = await activateRelease(f, release), before = f.store.snapshot();
  let now = new Date(FIXED_TIME); f.service.clock = () => new Date(now);
  f.service.verifyReadback = async expected => {
    now = new Date(FIXED_TIME.getTime() + 61_000);
    return { releaseId: expected.releaseId, snapshotHash: expected.snapshotHash, canonicalUrl: expected.canonicalUrl,
      verifiedAt: now.toISOString(), method: "server_readback", assetHashes: [] };
  };
  await assert.rejects(f.service.verifyRelease(active.id, { confirm: true }, context(active)), { code: "CONTENT_APPROVAL_BLOCKED" });
  assert.deepEqual(f.store.snapshot(), before); assert.equal(f.service.getRelease(active.id).receipt, null);
});
