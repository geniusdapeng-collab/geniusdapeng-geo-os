import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, chmod, cp, link, lstat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { crc32, deflateSync } from "node:zlib";
import { hashObject } from "../src/domain/hash.mjs";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { MediaAssets } from "../src/services/media-assets.mjs";
import { serveMediaAsset } from "../src/http/media-assets.mjs";

// Tiny real media generated once with ffmpeg from a synthetic blue 16×16 frame.
// Tests/runtime do not invoke a codec, process, network service or dependency.
const BASE64 = {"jpg": "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYwLjMuMTAwAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAFBxABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIABAAEAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AI4Av4t//9k=", "png": "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAFUlEQVR4nGNgYPhLIhrVMKph2GoAAISu/QH+5zsIAAAAAElFTkSuQmCC", "mp4": "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAANcbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAHgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAod0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAHgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAB4AAAEAAABAAAAAAH/bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAABgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABqm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAWpzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFExhdmM2MC4zLjEwMCBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAMAwAADAMAAAABhzdHRzAAAAAAAAAAEAAAADAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAKGN0dHMAAAAAAAAAAwAAAAEAAAQAAAAAAQAABgAAAAABAAACAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAwAAAAEAAAAgc3RzegAAAAAAAAAAAAAAAwAAAsoAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOMAAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MC4zLjEwMAAAAAhmcmVlAAAC6m1kYXQAAAKuBgX//6rcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMDc1IDY2YTViYzEgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIxIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MSByZWY9MyBkZWJsb2NrPTE6MDowIGFuYWx5c2U9MHgzOjB4MTEzIG1lPWhleCBzdWJtZT03IHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTEgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0xIDh4OGRjdD0xIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PS0yIHRocmVhZHM9MSBsb29rYWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTMgYl9weXJhbWlkPTIgYl9hZGFwdD0xIGJfYmlhcz0wIGRpcmVjdD0xIHdlaWdodGI9MSBvcGVuX2dvcD0wIHdlaWdodHA9MiBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAUZYiEADP//t8y+BTWhQ50QjNkdL8AAAAIQZoibEK//sAAAAAIAZ5BeQr/xIE=", "webp": "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoQABAAAgA0JaACdLoAA5gA/vmTb/+QH/+QH/+QH/8gP+IXeyAwAA=="};
const PNG = Buffer.from(BASE64.png, "base64");
const VTT = Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.500\nA real subtitle.\n");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const ctx = (key, etag) => ({ actor: "fixture-admin", method: "session", idempotencyKey: key, ...(etag ? { ifMatch: etag } : {}) });
const rejected = (promise, status, code) => assert.rejects(promise, error => error.status === status && (!code || error.code === code));
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-media-"));
  const store = new JsonStore({ filePath: join(directory, "state.json") });
  await store.open(async () => ({ accounts: [], claims: [], content: [] }));
  let published = false;
  const media = new MediaAssets({ store, ...options, publicAssetAuthorizer: () => published });
  await media.initialize();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, store, media, publish(value = true) { published = value; } };
}
function upload(media, bytes = PNG, key = "upload-key-0001", mime = "image/png", extra = {}) {
  return media.upload(Readable.from([bytes.subarray(0, 9), bytes.subarray(9)]), {
    contentType: mime, contentLength: bytes.length, name: `fixture.${mime.split("/")[1]}`, ...extra,
  }, ctx(key));
}
async function reviewed(media, key = "upload-key-0001") {
  const asset = await upload(media, PNG, key);
  return media.review(asset.id, { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Owner-created synthetic fixture; no personal information." }, ctx(`review-${key}`, asset.etag));
}
async function files(directory, sub = "objects") { return readdir(join(directory, "media-assets", sub)); }
function pngChunk(type, payload) {
  const output = Buffer.alloc(payload.length + 12); output.writeUInt32BE(payload.length);
  output.write(type, 4, 4, "ascii"); payload.copy(output, 8); output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4);
  return output;
}
function structuredPNG({ width = 1, height = 1, pixels = Buffer.from([0, 0, 0, 0]), compressed } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([PNG.subarray(0, 8), pngChunk("IHDR", header), pngChunk("IDAT", compressed ?? deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

test("binary streaming accepts actual allowlisted media, records exact bytes, and creates private immutable files", async t => {
  const { media, directory, store } = await fixture(t);
  for (const [ext, mime] of [["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"], ["mp4", "video/mp4"], ["vtt", "text/vtt"]]) {
    const bytes = ext === "vtt" ? VTT : Buffer.from(BASE64[ext], "base64");
    const asset = await upload(media, bytes, `upload-media-${ext}`, mime, { expectedSha256: sha(bytes) });
    assert.equal(asset.sha256, sha(bytes)); assert.equal(asset.size, bytes.length); assert.equal(asset.status, "staged");
    assert.equal(asset.mime, mime); assert.match(asset.etag, /^"[a-f0-9]{64}"$/);
    assert.equal(JSON.stringify(asset).includes(directory), false);
    if (asset.kind === "image") { assert.equal(asset.width, 16); assert.equal(asset.height, 16); }
    const path = join(directory, "media-assets", "objects", `${asset.id}.bin`);
    assert.deepEqual(await readFile(path), bytes); assert.equal((await lstat(path)).mode & 0o777, 0o400);
  }
  assert.equal(media.listAssets().items.length, 5);
  assert.equal((await lstat(join(directory, "media-assets"))).mode & 0o777, 0o700);
  assert.deepEqual(await files(directory, "staging"), []);
  assert.equal(verifyEventChain(store.snapshot().events).valid, true);
});

test("format validation rejects unsafe types, MIME mismatch, corrupt/truncated structures and appended polyglots", async t => {
  const { media, directory } = await fixture(t);
  const corruptPNG = Buffer.from(PNG); corruptPNG[60] ^= 1;
  const externalMP4 = Buffer.from(BASE64.mp4, "base64");
  const dref = externalMP4.indexOf(Buffer.from("url ")); externalMP4[dref + 7] = 0;
  const cases = [
    [Buffer.from("<svg onload='alert(1)'/>"), "image/svg+xml", "MEDIA_UNSUPPORTED_TYPE"],
    [PNG, "image/jpeg"], [corruptPNG, "image/png"], [Buffer.concat([PNG, Buffer.from("<script>1</script>")]), "image/png"],
    [Buffer.from(BASE64.jpg, "base64").subarray(0, -2), "image/jpeg"],
    [Buffer.concat([Buffer.from(BASE64.webp, "base64"), Buffer.from("html")]), "image/webp"],
    [Buffer.from("0000ftypfake"), "video/mp4"], [externalMP4, "video/mp4"],
    [Buffer.from("WEBVTT\n\n00:01.000 --> 00:00.100\nbad\n"), "text/vtt"],
    [Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\n<script>bad</script>\n"), "text/vtt"],
    [Buffer.from("WEBVTT\n\nSTYLE\n::cue { color: red }\n"), "text/vtt"],
    [Buffer.from([0xff, 0xfe, 0x57, 0x45]), "text/vtt"],
  ];
  for (const [index, [bytes, mime, code]] of cases.entries()) {
    await rejected(upload(media, bytes, `reject-format-${index}`, mime), 415, code ?? "MEDIA_INVALID_FORMAT");
  }
  assert.deepEqual(await files(directory), []); assert.deepEqual(await files(directory, "staging"), []);
});

test("PNG validation decodes bounded scanlines and rejects CRC-correct invalid compressed pixels and decompression bombs", async t => {
  const { media } = await fixture(t);
  const valid = structuredPNG(); assert.equal((await upload(media, valid, "valid-structured-png")).width, 1);
  for (const [index, bytes] of [
    structuredPNG({ compressed: Buffer.from("not a zlib stream") }),
    structuredPNG({ pixels: Buffer.from([5, 0, 0, 0]) }),
    structuredPNG({ pixels: Buffer.from([0, 0]) }),
    structuredPNG({ width: 16384, height: 16384 }),
    structuredPNG({ compressed: Buffer.concat([deflateSync(Buffer.from([0, 0, 0, 0])), Buffer.from("appended")]) }),
  ].entries()) await rejected(upload(media, bytes, `bad-png-pixels-${index}`), 415, "MEDIA_INVALID_FORMAT");
});

test("quotas include concurrent uploads, abandoned objects and unknown-length streams without partial leftovers", async t => {
  const { media, directory } = await fixture(t, { maxAssetBytes: PNG.length, maxTotalBytes: PNG.length * 2 });
  const settled = await Promise.allSettled([0, 1, 2].map(index => upload(media, PNG, `quota-key-${index}`)));
  assert.equal(settled.filter(row => row.status === "fulfilled").length, 2);
  assert.equal(settled.find(row => row.status === "rejected").reason.code, "MEDIA_QUOTA_EXCEEDED");
  assert.equal((await files(directory)).length, 2); assert.deepEqual(await files(directory, "staging"), []);
  const other = await fixture(t, { maxAssetBytes: PNG.length, maxTotalBytes: PNG.length * 2 });
  await rejected(other.media.upload(Readable.from([PNG, Buffer.from("x")]), { contentType: "image/png" }, ctx("unknown-length-upload")), 413, "MEDIA_TOO_LARGE");
  assert.deepEqual(await files(other.directory), []); assert.deepEqual(await files(other.directory, "staging"), []);
  await writeFile(join(other.directory, "media-assets", "staging", "crash.upload"), PNG, { mode: 0o600 });
  await upload(other.media, PNG, "first-after-crash");
  await rejected(upload(other.media, PNG, "second-after-crash"), 413, "MEDIA_QUOTA_EXCEEDED");
});

test("same-key upload replays original response at full quota without another object/event; changed payload conflicts", async t => {
  const { media, directory, store } = await fixture(t, { maxAssetBytes: PNG.length, maxTotalBytes: PNG.length });
  const first = await upload(media); const revision = store.snapshot().revision;
  assert.deepEqual(await upload(media), first); assert.equal(store.snapshot().revision, revision);
  assert.equal((await files(directory)).length, 1);
  await rejected(upload(media, PNG, "upload-key-0001", "image/png", { name: "different.png" }), 409, "IDEMPOTENCY_CONFLICT");
  const changed = Buffer.from(PNG); changed[40] ^= 1;
  await rejected(upload(media, changed), 409, "IDEMPOTENCY_CONFLICT");
  assert.equal(store.snapshot().revision, revision);
});

test("retry recovers an already durable blob from the crash-before-state-commit window without using quota twice", async t => {
  const { media, directory, store } = await fixture(t, { maxAssetBytes: PNG.length, maxTotalBytes: PNG.length });
  const request = ctx("crash-window-upload");
  const keyHash = hashObject(["media", request.actor, request.idempotencyKey]);
  const id = `MED-${hashObject(["media-upload", keyHash]).slice(0, 32)}`;
  const path = join(directory, "media-assets", "objects", `${id}.bin`);
  await writeFile(path, PNG, { mode: 0o400, flag: "wx" });
  const result = await upload(media, PNG, request.idempotencyKey);
  assert.equal(result.id, id); assert.equal(result.sha256, sha(PNG)); assert.equal((await files(directory)).length, 1);
  const revision = store.snapshot().revision;
  assert.deepEqual(await upload(media, PNG, request.idempotencyKey), result); assert.equal(store.snapshot().revision, revision);
  assert.equal(store.snapshot().mediaAssets.length, 1); assert.equal(store.snapshot().mediaAssetRequests.length, 1);
});

test("a changed crash-recovery blob fails closed and a failed state commit cleans only the new owned file", async t => {
  const f = await fixture(t); const request = ctx("corrupt-orphan-key");
  const id = `MED-${hashObject(["media-upload", hashObject(["media", request.actor, request.idempotencyKey])]).slice(0, 32)}`;
  const orphanPath = join(f.directory, "media-assets", "objects", `${id}.bin`);
  await writeFile(orphanPath, Buffer.alloc(PNG.length), { mode: 0o400 });
  await rejected(upload(f.media, PNG, request.idempotencyKey), 409, "MEDIA_RECOVERY_CONFLICT");
  assert.deepEqual(await readFile(orphanPath), Buffer.alloc(PNG.length));
  const originalMutate = f.store.mutate.bind(f.store);
  f.store.mutate = async () => { throw new Error("Injected protected-path persistence failure"); };
  await rejected(upload(f.media, PNG, "failed-persist-upload"), 503, "MEDIA_STORAGE_UNAVAILABLE");
  assert.deepEqual(await files(f.directory), [`${id}.bin`]); assert.deepEqual(await files(f.directory, "staging"), []);
  f.store.mutate = originalMutate;
  assert.equal((await upload(f.media, PNG, "failed-persist-upload")).status, "staged");
});

test("an action that uses the same key while upload is receiving cannot bypass the shared journal conflict", async t => {
  const { media, store, directory } = await fixture(t); const asset = await upload(media);
  let continueUpload, started;
  const gate = new Promise(resolve => { continueUpload = resolve; });
  const receiving = new Promise(resolve => { started = resolve; });
  const stream = Readable.from((async function* () { yield PNG.subarray(0, 10); started(); await gate; yield PNG.subarray(10); })());
  const pending = media.upload(stream, { contentType: "image/png", contentLength: PNG.length }, ctx("concurrent-shared-key"));
  await receiving;
  await media.review(asset.id, { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Owner-created.\nNo private data." }, ctx("concurrent-shared-key", asset.etag));
  continueUpload(); await rejected(pending, 409, "IDEMPOTENCY_CONFLICT");
  assert.equal(store.snapshot().mediaAssets.length, 1); assert.equal((await files(directory)).length, 1); assert.deepEqual(await files(directory, "staging"), []);
});

test("upload detects length/hash errors, rejects agent and path metadata, and cleans interrupted streams", async t => {
  const { media, directory } = await fixture(t);
  await rejected(upload(media, PNG, "bad-hash-upload", "image/png", { expectedSha256: "0".repeat(64) }), 400, "MEDIA_HASH_MISMATCH");
  await rejected(upload(media, PNG, "short-body-upload", "image/png", { contentLength: PNG.length + 1 }), 400, "MEDIA_LENGTH_MISMATCH");
  await rejected(upload(media, PNG, "bad-path-upload", "image/png", { name: "../private.png" }), 400, "MEDIA_INVALID_NAME");
  await rejected(media.upload(Readable.from([PNG]), { contentType: "image/png", destination: "/etc/passwd" }, ctx("bad-target-path")), 400);
  await rejected(media.upload(Readable.from([PNG]), { contentType: "image/png" }, { ...ctx("agent-forbidden"), method: "agent" }), 403);
  await rejected(media.upload(Readable.from([PNG]), { contentType: "image/png" }, ctx("short")), 400);
  const broken = Readable.from((async function* () { yield PNG.subarray(0, 8); throw Object.assign(new Error("private/path"), { code: "ECONNRESET" }); })());
  await rejected(media.upload(broken, { contentType: "image/png" }, ctx("interrupted-key")), 400, "MEDIA_UPLOAD_INTERRUPTED");
  assert.deepEqual(await files(directory), []); assert.deepEqual(await files(directory, "staging"), []);
});

test("review/revoke require hash, explicit rights/privacy, matching ETag and idempotency; prior results replay safely", async t => {
  const { media, store } = await fixture(t); const asset = await upload(media);
  const input = { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote: "Owned synthetic sample." };
  await rejected(media.review(asset.id, input, ctx("missing-etag-key")), 428);
  await rejected(media.review(asset.id, input, ctx("stale-etag-key", '"stale"')), 412);
  await rejected(media.review(asset.id, { ...input, rightsConfirmed: false }, ctx("unapproved-rights", asset.etag)), 400);
  await rejected(media.review(asset.id, { ...input, sha256: "0".repeat(64) }, ctx("wrong-hash-review", asset.etag)), 409);
  const approved = await media.review(asset.id, input, ctx("approve-one-key", asset.etag));
  const revision = store.snapshot().revision;
  assert.deepEqual(await media.review(asset.id, input, ctx("approve-one-key", asset.etag)), approved);
  assert.equal(store.snapshot().revision, revision);
  await rejected(media.review(asset.id, { ...input, rightsNote: "Different" }, ctx("approve-one-key", approved.etag)), 409);
  const revoked = await media.revoke(asset.id, { reason: "Privacy withdrawal." }, ctx("revoke-one-key", approved.etag));
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(await media.revoke(asset.id, { reason: "Privacy withdrawal." }, ctx("revoke-one-key", approved.etag)), revoked);
  await rejected(media.review(asset.id, input, ctx("review-after-revoke", revoked.etag)), 409, "MEDIA_REVOKED");
});

test("metadata cannot store recognizable credentials or personal contact data in names, rights notes and revocation reasons", async t => {
  const { media, store } = await fixture(t);
  await rejected(upload(media, PNG, "private-name-upload", "image/png", { name: "owner@example.org.png" }), 400, "MEDIA_SENSITIVE_METADATA");
  const asset = await upload(media);
  for (const [index, rightsNote] of ["password=synthetic-private-value", "Cookie: sessionid=synthetic-fixture", "Contact owner@example.org"].entries()) {
    await rejected(media.review(asset.id, { sha256: asset.sha256, rightsConfirmed: true, privacyConfirmed: true, rightsNote }, ctx(`private-note-${index}`, asset.etag)), 400, "MEDIA_SENSITIVE_METADATA");
  }
  await rejected(media.revoke(asset.id, { reason: "session_id=fixture-secret-value" }, ctx("private-reason-revoke", asset.etag)), 400, "MEDIA_SENSITIVE_METADATA");
  assert.equal(store.snapshot().mediaAssets[0].status, "staged"); assert.equal(store.snapshot().mediaAssetRequests.length, 1);
  assert.doesNotMatch(JSON.stringify(store.snapshot()), /synthetic-private-value|owner@example\.org|fixture-secret-value/);
});

test("reviewed assets remain private; release references and public bytes require current review plus exact hash and eligible route", async t => {
  const f = await fixture(t); const asset = await reviewed(f.media);
  await rejected(f.media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }), 404);
  const refs = [{ assetId: asset.id, sha256: asset.sha256, role: "image", alt: "Blue sample", caption: "" }];
  assert.equal((await f.media.verifyForRelease(refs))[0].id, asset.id);
  await rejected(f.media.verifyForRelease([{ ...refs[0], role: "video" }]), 409);
  await rejected(f.media.verifyForRelease([{ ...refs[0], sha256: "0".repeat(64) }]), 409);
  f.publish();
  const opened = await f.media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }); await opened.handle.close();
  await rejected(f.media.openVerifiedAsset(asset.id, { publicAccess: true }), 404);
  await rejected(f.media.openVerifiedAsset(asset.id, { sha256: "0".repeat(64), publicAccess: true }), 404);
  f.publish(false); await rejected(f.media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }), 404);
  f.publish(); await f.media.revoke(asset.id, { reason: "Owner withdrew rights." }, ctx("public-revoke-key", asset.etag));
  await rejected(f.media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }), 404);
  await rejected(f.media.verifyForRelease(refs), 409);
});

test("storage refuses symlinks, group/world readable objects, hardlinks and bytes altered after review", async t => {
  const f = await fixture(t); const asset = await reviewed(f.media);
  const path = join(f.directory, "media-assets", "objects", `${asset.id}.bin`);
  await chmod(path, 0o644); await rejected(f.media.openVerifiedAsset(asset.id), 503); await chmod(path, 0o600);
  await writeFile(path, Buffer.alloc(PNG.length)); await rejected(f.media.verifyForRelease([{ assetId: asset.id, sha256: asset.sha256, role: "cover" }]), 503);
  await unlink(path); await symlink(f.store.filePath, path); await rejected(f.media.openVerifiedAsset(asset.id), 503);
  await rejected(upload(f.media, PNG, "unsafe-existing-storage"), 503);
  await unlink(path);
  const original = join(f.directory, "original-object"); await writeFile(original, PNG, { mode: 0o600 });
  await link(original, path); await rejected(f.media.openVerifiedAsset(asset.id), 503);
  const outside = await mkdtemp(join(await realpath(tmpdir()), "media-symlink-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const store = new JsonStore({ filePath: join(outside, "state.json") }); await store.open(async () => ({}));
  await symlink(join(f.directory, "media-assets"), join(outside, "media-assets"));
  await rejected(new MediaAssets({ store }).initialize(), 503, "MEDIA_UNSAFE_STORAGE");
  await store.close();
});

test("HTTP serves safe full/HEAD/single Range responses, ignores unknown units and gates even conditional responses after withdrawal", async t => {
  const f = await fixture(t); const asset = await reviewed(f.media); f.publish();
  const server = createServer(async (req, res) => {
    try { await serveMediaAsset(req, res, { mediaAssets: f.media, assetId: asset.id, sha256: asset.sha256, publicAccess: true }); }
    catch (error) { if (!res.headersSent) { res.writeHead(error.status ?? 500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ code: error.code })); } }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/public-media/${asset.id}/${asset.sha256}`;
  let response = await fetch(url); assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.match(response.headers.get("cache-control"), /no-store/);
  const etag = response.headers.get("etag");
  for (const [range, start, end] of [["bytes=0-1", 0, 1], ["bytes=90-", 90, PNG.length - 1], ["bytes=-8", PNG.length - 8, PNG.length - 1], ["bytes=90-999", 90, PNG.length - 1]]) {
    response = await fetch(url, { headers: { Range: range } }); assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), `bytes ${start}-${end}/${PNG.length}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG.subarray(start, end + 1));
  }
  for (const range of ["bytes=999-", "bytes=4-1", "bytes=-0", "bytes=0-1,3-4", "bytes=bad"]) {
    response = await fetch(url, { headers: { Range: range } }); assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${PNG.length}`); assert.equal(await response.text(), "");
  }
  response = await fetch(url, { method: "HEAD", headers: { Range: "bytes=0-1" } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), String(PNG.length)); assert.equal(await response.text(), "");
  response = await fetch(url, { headers: { Range: "items=0-1" } }); assert.equal(response.status, 200); await response.arrayBuffer();
  response = await fetch(url, { headers: { Range: "bytes=0-1", "If-Range": '"other"' } }); assert.equal(response.status, 200); await response.arrayBuffer();
  response = await fetch(url, { headers: { Range: "bytes=0-1", "If-Range": etag } }); assert.equal(response.status, 206); await response.arrayBuffer();
  response = await fetch(url, { headers: { "If-None-Match": etag } }); assert.equal(response.status, 304);
  response = await fetch(url, { headers: { "If-None-Match": `W/${etag}` } }); assert.equal(response.status, 304);
  f.publish(false);
  response = await fetch(url, { method: "HEAD", headers: { "If-None-Match": etag } }); assert.equal(response.status, 404);
  response = await fetch(url, { headers: { Range: "bytes=0-1" } }); assert.equal(response.status, 404); await response.text();
});

test("public access is rechecked after hashing and metadata lacking real review attestations fails closed", async t => {
  const f = await fixture(t); const asset = await reviewed(f.media);
  let calls = 0;
  const media = new MediaAssets({ store: f.store, publicAssetAuthorizer: () => ++calls === 1 }); await media.initialize();
  await rejected(media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }), 404);
  assert.equal(calls, 2);
  await f.store.mutate({ type: "fixture.corrupt-review", actor: "test" }, state => { delete state.mediaAssets[0].review.privacyConfirmed; });
  f.publish(); await rejected(f.media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }), 404);
  await rejected(f.media.verifyForRelease([{ assetId: asset.id, sha256: asset.sha256, role: "image" }]), 409);
});

test("a full isolated DATA restore retains metadata, immutable bytes and retry journal with normal 0600 restored file modes", async t => {
  const f = await fixture(t); const asset = await reviewed(f.media);
  const target = await mkdtemp(join(await realpath(tmpdir()), "pengmanager-media-restore-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await cp(f.directory, target, { recursive: true });
  const path = join(target, "media-assets", "objects", `${asset.id}.bin`); await chmod(path, 0o600);
  const store = new JsonStore({ filePath: join(target, "state.json") }); await store.open(async () => { throw new Error("No replacement seed"); });
  const media = new MediaAssets({ store }); await media.initialize();
  assert.deepEqual(media.getAsset(asset.id), asset);
  const opened = await media.openVerifiedAsset(asset.id); await opened.handle.close();
  assert.deepEqual(await readFile(path), PNG); assert.equal(sha(await readFile(path)), asset.sha256);
  assert.equal((await media.verifyForRelease([{ assetId: asset.id, sha256: asset.sha256, role: "image" }]))[0].id, asset.id);
  const revision = store.snapshot().revision; const original = f.store.snapshot().mediaAssetRequests[0].result;
  assert.deepEqual(await upload(media), original); assert.equal(store.snapshot().revision, revision);
  await rejected(media.openVerifiedAsset(asset.id, { sha256: asset.sha256, publicAccess: true }), 404);
  assert.equal(verifyEventChain(store.snapshot().events).valid, true); await store.close();
});
