import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import { createRenderers, inspectPngBytes, prepareNativeManifest, previewNotebook, renderVtt, RENDERER_PINS, sourceClosureFiles } from "../src/content-ops-worker/renderers.mjs";
import { inspectProductionArtifact } from "../src/services/production-artifacts.mjs";

const hash = data => createHash("sha256").update(data).digest("hex");
const root = await mkdtemp(join(tmpdir(), "pm-renderer-test-"));
await chmod(root, 0o700);
after(async () => { await rm(root, { recursive: true, force: true }); });
const calls = [];
const renderer = createRenderers({ workRoot: root, runNativeCall: async (metadata, run) => {
  calls.push(metadata);
  const result = await run();
  assert.equal(result.executed, true); assert.equal(result.dryRun, false); assert.equal(result.nativeProcesses, 1);
  assert.ok(result.elapsedMs >= 0); return result;
} });
const readiness = await renderer.readiness({ probe: false });
const native = { skip: readiness.ready ? false : `Exact pinned native fixture unavailable: ${readiness.reason}` };

// Fixture PNGs are constructed from actual RGB samples. No downloaded or personal assets.
function crc(data) {
  let result = 0xffffffff;
  for (const value of data) {
    result ^= value;
    for (let bit = 0; bit < 8; bit++) result = result & 1 ? (result >>> 1) ^ 0xedb88320 : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4), kind = Buffer.from(type);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([kind, data])));
  return Buffer.concat([length, kind, data, checksum]);
}
function png(width = 96, height = 64, colorType = 2, rowFilter = 0) {
  const channels = colorType === 6 ? 4 : colorType === 0 ? 1 : 3;
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = colorType;
  const rows = Buffer.alloc((width * channels + 1) * height);
  for (let row = 0; row < height; row++) {
    rows[row * (width * channels + 1)] = rowFilter;
    for (let column = 0; column < width; column++) {
      const at = row * (width * channels + 1) + 1 + column * channels;
      rows[at] = column < width / 2 ? 245 : 20;
      if (channels >= 3) { rows[at + 1] = 30; rows[at + 2] = column < width / 2 ? 35 : 240; }
      if (channels === 4) rows[at + 3] = 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// Independent wire decoder used to compare the renderer's PNG with PDF XObject pixels.
function wirePixels(data) {
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20), channels = data[25] === 6 ? 4 : 3;
  const streams = [];
  for (let cursor = 8; cursor < data.length;) {
    const size = data.readUInt32BE(cursor), type = data.toString("ascii", cursor + 4, cursor + 8);
    if (type === "IDAT") streams.push(data.subarray(cursor + 8, cursor + 8 + size));
    cursor += size + 12;
  }
  const source = inflateSync(Buffer.concat(streams)), stride = width * channels, pixels = Buffer.alloc(width * height * channels);
  for (let row = 0; row < height; row++) {
    const filter = source[row * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const index = row * stride + x, a = x >= channels ? pixels[index - channels] : 0, b = row ? pixels[index - stride] : 0, c = row && x >= channels ? pixels[index - stride - channels] : 0;
      const prediction = a + b - c, distances = [Math.abs(prediction - a), Math.abs(prediction - b), Math.abs(prediction - c)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? a : distances[1] <= distances[2] ? b : c;
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : paeth;
      pixels[index] = (source[row * (stride + 1) + 1 + x] + predictor) % 256;
    }
  }
  return { width, height, channels, pixels };
}
const rejected = (operation, codes) => assert.rejects(operation, error => {
  assert.ok(codes.includes(error.code), `${error.code}: ${error.message}`); return true;
});
const notebookInput = object => { const data = Buffer.from(JSON.stringify(object)); return { bytes: data, sha256: hash(data) }; };
const notebook = cells => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells });
const codeCell = (source, outputs = []) => ({ cell_type: "code", metadata: {}, source, execution_count: null, outputs });

test("readiness defaults to immutable file inspection without a pre-claim process", () => {
  assert.equal(calls.length, 0);
  assert.equal(readiness.productionVerified, false);
  if (readiness.ready) {
    assert.equal(readiness.inspection, "pinned_files_only"); assert.equal(readiness.filtersProbed, false); assert.equal(readiness.temporaryBytes, 0);
    assert.equal(readiness.binarySha256, RENDERER_PINS.ffmpegSha256); assert.equal(readiness.fontSha256, RENDERER_PINS.fontSha256);
    assert.equal(readiness.sourceClosure.sources.length, sourceClosureFiles.length + 1);
    for (const source of readiness.sourceClosure.sources) assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(readiness).includes(root));
  }
});

test("PNG inspection fully decodes RGB/RGBA pixels and rejects corrupt/unsupported data", async () => {
  assert.equal(inspectPngBytes(png()).decodedPixels, 6144);
  assert.equal(inspectPngBytes(png(10, 10, 6)).channels, 4);
  const corrupt = png(); corrupt[50] ^= 1;
  for (const candidate of [Buffer.from("<svg></svg>"), corrupt, Buffer.concat([png(), Buffer.from("extra")]), png().subarray(0, -2), png(2, 2, 2, 5)]) await rejected(async () => inspectPngBytes(candidate), ["ARTIFACT_INVALID"]);
  await rejected(async () => inspectPngBytes(png(2, 2, 0)), ["NATIVE_ARTIFACT_TYPE_UNSUPPORTED"]);
  for (const wanted of ["IHDR", "IDAT", "IEND"]) {
    const highBit = png();
    for (let cursor = 8; cursor < highBit.length;) {
      const size = highBit.readUInt32BE(cursor);
      if (highBit.toString("latin1", cursor + 4, cursor + 8) === wanted) {
        highBit[cursor + 4] |= 128;
        highBit.writeUInt32BE(crc(highBit.subarray(cursor + 4, cursor + 8 + size)), cursor + 8 + size);
        break;
      }
      cursor += size + 12;
    }
    await rejected(async () => inspectPngBytes(highBit), ["ARTIFACT_INVALID"]);
  }
});

test("real CJK/Latin card produces readable nonuniform RGB pixels, exact coverage and one dispatch", native, async () => {
  const title = "真实交付与证据 English", body = "中文标点：事实、选择与限制。\nEvery final file keeps its real bytes.";
  const before = calls.length;
  const image = png(), input = { title, body, footer: "隔离测试 · 未发布", sourceImages: [{ bytes: image, sha256: hash(image), alt: "真实 fixture 红蓝对照图" }] };
  const result = await renderer.renderCard(input), decoded = wirePixels(result.bytes);
  assert.equal(result.mime, "image/png"); assert.equal(hash(result.bytes), result.sha256);
  assert.equal(inspectProductionArtifact(result.bytes, "image/png").kind, "image");
  assert.deepEqual([decoded.width, decoded.height, decoded.channels], [1080, 1440, 3]);
  assert.equal(result.metadata.textCoverage[0].text, title); assert.equal(result.metadata.textCoverage[1].text, body);
  for (const field of result.metadata.textCoverage) for (const line of field.lines) assert.equal(field.text.slice(line.start, line.end), line.text);
  const box = result.metadata.sourceImages[0].box;
  let red = 0, blue = 0, dark = 0;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) {
    const at = (y * decoded.width + x) * 3, [r, g, b] = decoded.pixels.subarray(at, at + 3);
    if (r > 210 && g < 60 && b < 70) red++;
    if (r < 60 && g < 60 && b > 210) blue++;
  }
  for (let y = 110; y < 400; y++) for (let x = 72; x < 1008; x++) {
    const at = (y * decoded.width + x) * 3;
    if (decoded.pixels[at] < 100 && decoded.pixels[at + 1] < 120 && decoded.pixels[at + 2] < 150) dark++;
  }
  assert.ok(red > 1000 && blue > 1000, "actual source image colors must survive contain composition");
  assert.ok(dark > 1000, "CJK/Latin text must create substantial visible ink");
  assert.equal(calls.length - before, 1); assert.equal(calls.at(-1).callKey, "image.compose.0");
  assert.match(calls.at(-1).requestHash, /^[a-f0-9]{64}$/); assert.equal(calls.at(-1).upperBound.nativeProcesses, 1);
  assert.deepEqual(await readdir(root), []);
});

test("same bytes/template are deterministic and text expansion syntax is literal", native, async () => {
  const input = { title: "%{localtime} stays literal", body: "<script>text</script> : ' $() ` ; [x] \\ remain data." };
  const first = await renderer.renderCard(input), second = await renderer.renderCard(input);
  assert.equal(first.sha256, second.sha256); assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.metadata.textCoverage[0].text, input.title);
  const recent = calls.slice(-2); assert.equal(recent[0].requestHash, recent[1].requestHash);
});

test("document embeds every actual page RGB stream, correct page order and xref offsets", native, async () => {
  const before = calls.length;
  const result = await renderer.renderDocument({ title: "分页文档 · Evidence", pages: [
    { title: "第一页：问题", body: "真实原文完整进入页面。\nThe problem and its evidence.", footer: "01 / 02" },
    { title: "第二页：边界", body: "结果、限制与下一步。\nKeep all qualifications visible.", footer: "02 / 02" }
  ] });
  assert.equal(result.mime, "application/pdf"); assert.equal(result.metadata.pageCount, 2); assert.equal(result.pages.length, 2);
  assert.equal(result.metadata.textSearchable, false); assert.equal(calls.length - before, 2);
  assert.deepEqual(calls.slice(-2).map(call => call.callKey), ["document.page.0", "document.page.1"]);
  const pdf = result.bytes.toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.7\n")); assert.match(pdf, /\/Type \/Pages \/Count 2/);
  assert.equal((pdf.match(/\/Type \/Page\s/g) ?? []).length, 2);
  assert.equal((pdf.match(/\/Subtype \/Image/g) ?? []).length, 2);
  const starts = [...pdf.matchAll(/(\d+) 0 obj\n/g)];
  const xrefAt = Number(/startxref\n(\d+)\n%%EOF/.exec(pdf)[1]); assert.equal(pdf.slice(xrefAt, xrefAt + 4), "xref");
  const xrefRows = pdf.slice(xrefAt).split("\n").slice(3, 3 + starts.length);
  for (let index = 0; index < starts.length; index++) assert.equal(Number(xrefRows[index].slice(0, 10)), starts[index].index);
  const images = [...pdf.matchAll(/\/Subtype \/Image[\s\S]*?\/Length (\d+) >>\nstream\n/g)];
  for (let index = 0; index < images.length; index++) {
    const start = images[index].index + images[index][0].length;
    const encoded = result.bytes.subarray(start, start + Number(images[index][1])).toString("ascii");
    assert.match(encoded, /^[a-f0-9]+>$/);
    const rgb = inflateSync(Buffer.from(encoded.slice(0, -1), "hex"));
    const page = result.pages[index], wire = wirePixels(page.bytes);
    assert.deepEqual(rgb, wire.pixels, "PDF must contain the full actual page pixels, in order");
    assert.equal(result.metadata.pages[index].sha256, hash(page.bytes)); assert.equal(result.metadata.pages[index].bytes, page.bytes.length);
    assert.equal(result.metadata.pages[index].textCoverage[0].text, result.metadata.pages[index].title);
  }
  assert.equal(inspectProductionArtifact(result.bytes, "application/pdf").pages, 2);
  assert.deepEqual(await readdir(root), []);
});

test("input path/URL/argv, oversize/overflow, invalid hashes and unrenderable glyphs stop before spawn", native, async () => {
  const before = calls.length;
  const base = { title: "Title", body: "Body" };
  for (const extra of [{ path: "/etc/passwd" }, { url: "https://invalid.example" }, { argv: ["-i", "file"] }, { filter: "movie=https://invalid.example" }, { font: "untrusted" }, { layoutId: "arbitrary" }, { width: 999 }, { title: "x\u0000y" }, { body: "A".repeat(12_001) }]) await rejected(() => renderer.renderCard({ ...base, ...extra }), ["RENDER_INPUT_INVALID"]);
  await rejected(() => renderer.renderCard({ ...base, body: "完整内容\n".repeat(40) }), ["TEXT_OVERFLOW"]);
  await rejected(() => renderer.renderCard({ ...base, title: "Unsupported \u{1F9D1}" }), ["TEXT_GLYPH_UNSUPPORTED"]);
  const image = png();
  await rejected(() => renderer.renderCard({ ...base, sourceImages: [{ bytes: image, sha256: "0".repeat(64), alt: "image" }] }), ["ARTIFACT_HASH_MISMATCH"]);
  await rejected(() => renderer.renderCard({ ...base, sourceImages: [{ bytes: image, sha256: hash(image), alt: "image", source: "/etc/passwd" }] }), ["RENDER_INPUT_INVALID"]);
  assert.equal(calls.length, before);
});

test("missing/mismatched/symlink binaries and missing dispatch hooks never become native ready", async () => {
  const missing = createRenderers({ ffmpegPath: join(root, "missing"), runNativeCall: async (_meta, run) => run() });
  const absent = await missing.readiness(); assert.equal(absent.ready, false); assert.equal(absent.productionVerified, false);
  await rejected(() => missing.renderCard({ title: "title", body: "body" }), ["ADAPTER_NOT_READY"]);
  const badPath = join(root, "bad-executable"); await writeFile(badPath, Buffer.from("not the pinned executable"));
  const bad = createRenderers({ ffmpegPath: badPath, runNativeCall: async (_meta, run) => run() });
  assert.equal((await bad.readiness()).ready, false);
  const linkPath = join(root, "linked-executable"); await symlink(badPath, linkPath);
  assert.equal((await createRenderers({ ffmpegPath: linkPath }).readiness()).ready, false);
  if (readiness.ready) assert.equal((await createRenderers().readiness()).reason, "local_dispatch_hook_required");
  await rm(linkPath); await rm(badPath);
});

test("cancellation, native quota and dry-run callbacks cannot produce a successful card", native, async () => {
  const controller = new AbortController(); controller.abort();
  await rejected(() => createRenderers({ workRoot: root, signal: controller.signal, runNativeCall: async (_meta, run) => run() }).renderCard({ title: "title", body: "body" }), ["RENDER_CANCELLED"]);
  const tiny = createRenderers({ workRoot: root, maxTempBytes: 10, runNativeCall: async () => { throw new Error("must not dispatch"); } });
  await rejected(() => tiny.renderCard({ title: "title", body: "body" }), ["WORKSPACE_QUOTA_EXCEEDED"]);
  const fake = createRenderers({ workRoot: root, runNativeCall: async () => ({ stdout: "", executed: true, dryRun: false, nativeProcesses: 1, exitCode: 0 }) });
  await rejected(() => fake.renderCard({ title: "title", body: "body" }), ["NATIVE_EXECUTION_UNVERIFIED"]);
  assert.deepEqual(await readdir(root), []);
});

test("native runner uses execution signals for heartbeat revocation and prevents duplicate dispatch", native, async () => {
  const controller = new AbortController(); let dispatches = 0;
  const cancelled = createRenderers({ workRoot: root, runNativeCall: async (_call, run) => {
    dispatches++;
    const execution = run({ signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    return execution;
  } });
  await assert.rejects(() => cancelled.renderCard({ title: "心跳撤销", body: "Only this owned child may be stopped." }), error => {
    assert.equal(error.code, "RENDER_CANCELLED"); assert.equal(error.details.executed, true); assert.equal(error.details.nativeProcesses, 1); assert.equal(error.details.dryRun, false); return true;
  });
  assert.equal(dispatches, 1); assert.deepEqual(await readdir(root), []);
  let duplicatesRejected = 0;
  const duplicate = createRenderers({ workRoot: root, runNativeCall: async (_call, run) => {
    const result = await run();
    await assert.rejects(run, error => { assert.equal(error.code, "NATIVE_DUPLICATE_DISPATCH"); duplicatesRejected++; return true; });
    return result;
  } });
  const checked = await duplicate.readiness({ probe: true });
  assert.equal(checked.ready, true); assert.equal(checked.filtersProbed, true); assert.equal(duplicatesRejected, 1);
  assert.deepEqual(await readdir(root), []);
});

test("VTT preserves literal CJK/Latin text, real millisecond timing and escaped markup", async () => {
  const result = await renderVtt({ locale: "zh-CN", durationMs: 90_000, cues: [{ startMs: 0, endMs: 1234, text: "中文 & <tag>\nEnglish" }, { startMs: 60_001, endMs: 89_999, text: "条件与边界" }] });
  assert.equal(result.mime, "text/vtt"); assert.match(result.bytes.toString(), /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:01\.234\n中文 &amp; &lt;tag&gt;\nEnglish/);
  assert.match(result.bytes.toString(), /00:01:00\.001 --> 00:01:29\.999/);
  assert.equal(result.metadata.alignmentPerformed, false); assert.equal(result.metadata.timingSource, "caller_supplied_timeline");
  assert.equal(result.sha256, hash(result.bytes));
});

test("VTT refuses invented/overlapping/out-of-range timing, blank cue blocks and unsupported fields", async () => {
  for (const cues of [[], [{ startMs: 1, endMs: 1, text: "same" }], [{ startMs: 0, endMs: 1001, text: "too long" }], [{ startMs: 0, endMs: 800, text: "first" }, { startMs: 700, endMs: 900, text: "overlap" }], ...["\nHello", "Hello\n", "Hello\n\nWorld", "a --> b", "NUL\u0000"].map(text => [{ startMs: 0, endMs: 900, text }])]) await rejected(() => renderVtt({ durationMs: 1000, cues }), ["RENDER_INPUT_INVALID", "CAPTION_TIMING_REQUIRED"]);
  await rejected(() => renderVtt({ durationMs: 1000, cues: [{ startMs: 0, endMs: 900, text: "text", path: "/file" }] }), ["RENDER_INPUT_INVALID"]);
  await rejected(() => renderVtt({ durationMs: 1000, cues: new Array(1) }), ["RENDER_INPUT_INVALID"]);
  const extra = [{ startMs: 0, endMs: 900, text: "text" }]; extra.path = "/not-an-input-field";
  await rejected(() => renderVtt({ durationMs: 1000, cues: extra }), ["RENDER_INPUT_INVALID"]);
});

test("notebook preview displays all supplied cells and allowed text outputs as inert text", async () => {
  const source = notebookInput(notebook([
    { cell_type: "markdown", metadata: {}, source: ["# 中文\n", "<script>globalThis.ran=true</script>"] },
    codeCell("if True:\n\tprint('must never execute')\nfetch('https://invalid.example')", [
      { output_type: "stream", name: "stdout", text: ["supplied output\n", "中文"] },
      { output_type: "display_data", metadata: {}, data: { "text/plain": "literal <img src=x onerror=alert(1)> output" } }
    ])
  ]));
  const result = await previewNotebook(source), html = result.bytes.toString();
  assert.equal(result.metadata.executeCode, false); assert.equal(result.metadata.executionStatus, "not_executed"); assert.equal(result.metadata.cellCount, 2); assert.equal(result.metadata.suppliedOutputCount, 2); assert.equal(result.metadata.omittedOutputs, 0);
  assert.ok(html.includes("&lt;script&gt;globalThis.ran=true&lt;/script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;")); assert.ok(!html.includes("<img"));
  assert.ok(html.includes("default-src 'none'")); assert.ok(!/<iframe|<object|<a\s|<script/i.test(html));
  assert.equal(result.metadata.coverage[1].displayedOutputRepresentations, 2); assert.equal(source.sha256, hash(source.bytes));
  assert.ok(html.includes("\tprint(&#39;must never execute&#39;)"), "static code indentation must remain exact");
  assert.equal(inspectProductionArtifact(source.bytes, "application/x-ipynb+json").cells, 2);
});

test("notebook bad UTF8/duplicate JSON/unsafe keys/type/hash/active MIME and unsupported attachments are rejected", async () => {
  const rawInputs = [Buffer.from('{"nbformat":4,"nbformat":4}'), Buffer.from('{"__proto__":{}}'), Buffer.from([255, 254])];
  for (const data of rawInputs) await rejected(() => previewNotebook({ bytes: data, sha256: hash(data) }), ["INVALID_JSON", "DUPLICATE_JSON_KEY", "UNSAFE_JSON_KEY"]);
  await rejected(() => previewNotebook({ bytes: Buffer.from("{}"), sha256: "0".repeat(64) }), ["ARTIFACT_HASH_MISMATCH"]);
  for (const cells of [[], [codeCell("x", [null])], [codeCell("x", [{ output_type: "display_data", metadata: {}, data: { "application/javascript": "alert(1)" } }])], [{ cell_type: "markdown", metadata: {}, source: "x", attachments: { x: {} } }]]) await rejected(() => previewNotebook(notebookInput(notebook(cells))), ["RENDER_INPUT_INVALID", "NATIVE_ARTIFACT_TYPE_UNSUPPORTED", "NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED"]);
  for (const mime of ["text/html", "image/png", "application/json", "application/javascript"]) {
    const rich = notebookInput(notebook([codeCell("x", [{ output_type: "display_data", metadata: {}, data: { [mime]: "untrusted" } }])]));
    await rejected(() => previewNotebook(rich), ["NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED"]);
    assert.throws(() => inspectProductionArtifact(rich.bytes, "application/x-ipynb+json"), error => error.code === "NOTEBOOK_ACTIVE_OUTPUT_UNSUPPORTED");
  }
  assert.equal(globalThis.ran, undefined);
});

function nativeFile(key, role, mime, content) { const data = Buffer.from(content); return { key, role, mime, bytes: data, sha256: hash(data) }; }
test("native manifest binds actual ordered files, preserves inputs and never claims execution/deployment", async () => {
  const files = [nativeFile("readme", "readme", "text/markdown", "# Real fixture software\nKnown limits."), nativeFile("change", "diff", "text/x-diff", "diff --git a/demo.txt b/demo.txt\n--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n")];
  const original = Buffer.from(files[1].bytes);
  const result = await prepareNativeManifest({ kind: "repository_change", title: "真实变更说明", baseCommit: "a".repeat(40), tag: "v-fixture", files });
  const manifest = JSON.parse(result.bytes);
  assert.equal(manifest.files.length, 2); assert.equal(manifest.files[1].sha256, hash(original)); assert.equal(manifest.baseCommit, "a".repeat(40));
  assert.equal(manifest.executeCode, false); assert.equal(manifest.deploy, false); assert.equal(manifest.executionStatus, "not_executed"); assert.equal(manifest.suppliedResultsStatus, "unverified");
  assert.deepEqual(result.files[1].bytes, original); assert.deepEqual(files[1].bytes, original);
  result.files[1].bytes[0] ^= 1; assert.deepEqual(files[1].bytes, original, "returned snapshots must not alias caller memory");
});

test("native prerequisites and strict MIME-role/kind/path contracts cannot be satisfied by descriptions", async () => {
  const readme = nativeFile("readme", "readme", "text/markdown", "description");
  await rejected(() => prepareNativeManifest({ kind: "model_card", title: "model", files: [readme] }), ["ARTIFACT_MISSING"]);
  await rejected(() => prepareNativeManifest({ kind: ["repository_change"], title: "bad", files: [readme] }), ["RENDER_INPUT_INVALID"]);
  const base = { kind: "repository_change", title: "actual", baseCommit: "a".repeat(40) };
  for (const baseCommit of [["a".repeat(40)], {}, 42, null]) await rejected(() => prepareNativeManifest({ ...base, baseCommit, files: [readme] }), ["RENDER_INPUT_INVALID"]);
  for (const file of [nativeFile("diff", "diff", "application/octet-stream", "pretend"), nativeFile("diff", "diff", "text/x-diff", "--- header only"), nativeFile("../path", "diff", "text/x-diff", "x"), nativeFile("readme2", "readme", "application/octet-stream", "not text")]) await rejected(() => prepareNativeManifest({ ...base, files: [readme, file] }), ["RENDER_INPUT_INVALID", "NATIVE_ARTIFACT_TYPE_UNSUPPORTED"]);
  await rejected(() => prepareNativeManifest({ kind: "demo_bundle", title: "x", executeCode: true, files: [readme] }), ["RENDER_INPUT_INVALID"]);
});

test("model manifests require actual nonempty passive tensor bytes and retain unverified training status", async () => {
  const header = Buffer.from(JSON.stringify({ fixture: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(header.length));
  const tensor = Buffer.alloc(4); tensor.writeFloatLE(1);
  const model = Buffer.concat([size, header, tensor]);
  const input = { kind: "model_card", title: "Isolated tensor fixture only", files: [
    nativeFile("readme", "readme", "text/markdown", "# Fixture, not a trained production model"),
    nativeFile("license", "license", "text/plain", "Synthetic fixture for isolated tests only."),
    nativeFile("weights", "model", "application/x-safetensors", model)
  ] };
  const result = await prepareNativeManifest(input), manifest = JSON.parse(result.bytes);
  assert.equal(inspectProductionArtifact(model, "application/x-safetensors").tensorCount, 1);
  assert.equal(manifest.files[2].inspection.tensorCount, 1); assert.equal(manifest.files[2].inspection.loaded, false);
  assert.equal(manifest.files[2].inspection.trainingVerified, false); assert.equal(manifest.files[2].inspection.inferenceVerified, false);
  assert.equal(inspectProductionArtifact(result.bytes, "application/json").kind, "text");
  const emptyHeader = Buffer.from("{}"), emptySize = Buffer.alloc(8); emptySize.writeBigUInt64LE(2n);
  for (const bad of [Buffer.from("describing a model does not create weights"), Buffer.concat([emptySize, emptyHeader]), Buffer.concat([model, Buffer.from([0])])]) await rejected(() => prepareNativeManifest({ ...input, files: [...input.files.slice(0, 2), nativeFile("weights", "model", "application/x-safetensors", bad)] }), ["ARTIFACT_INVALID", "ARTIFACT_MISSING"]);
});
