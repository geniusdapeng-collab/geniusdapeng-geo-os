import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runtimeConfig, verifiedPortraitReuseManifest } from '../src/video-runtime/config.mjs';
import { nativeEnvironment } from '../src/video-runtime/environment.mjs';
import { loadPortraitReuseManifest } from '../engines/video-edit/apps/server/src/video/portrait-reuse-acceptance.ts';
import { PNG } from './fixtures/synthetic-media.mjs';

// Local file/contract tests only: no runtime start, models, provider requests,
// real owner approval, credential files or production character assets.
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-portrait-reuse-'));
  const base = fs.realpathSync(temporary), root = path.join(base, 'product'), data = path.join(base, 'private');
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'engines', 'video-edit'), { recursive: true });
  fs.mkdirSync(path.join(data, 'inputs'), { recursive: true, mode: 0o700 });
  fs.chmodSync(data, 0o700); fs.chmodSync(path.join(data, 'inputs'), 0o700);
  const file = path.join(data, 'inputs', 'portrait-reuse.json');
  const write = value => fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
  write({ schemaVersion: 'isolated-unvalidated-manifest/v1' });
  return { base, root, data, file, write,
    config: extra => runtimeConfig({ rootDir: root, dataDir: data, ...extra }) };
}
function environment(config, overrides = {}) {
  return nativeEnvironment(config, { instanceId: 'isolated-fixture', credentials: {
    jwt: 'isolated-jwt', pii: 'isolated-pii', media: 'isolated-media', render: 'isolated-render', audio: 'isolated-audio',
  } }, {}, 'isolated-desktop', overrides);
}
function studioManifest(f) {
  const directory = path.join(f.data, 'characters', 'young-rider-01'); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receipt = (name, bytes) => {
    const file = path.join(directory, name); fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { path: file, realPath: file, sha256: sha256(bytes), bytes: bytes.length };
  };
  const profile = receipt('profile.json', Buffer.from(JSON.stringify({ id: 'young-rider-01', kind: 'generated', authorization: { status: 'synthetic-no-real-person' } })));
  const files = Object.fromEntries(['front', 'threeQuarter', 'closeup', 'side'].map(angle => [angle, receipt(`${angle}.png`, PNG)]));
  return { schemaVersion: 'workloom.portrait-reuse-manifest/v1', approvedSelection: {
    schemaVersion: 'workloom.portrait-reuse-selection/v1', rawIntent: 'This isolated test selects the existing synthetic character for its test project.',
    selectedVersion: 2, expectedPortraits: 4, selectedAt: '2026-10-26T00:00:00.000Z',
  }, characters: [{ id: 'young-rider-01', name: '李英子', version: 2,
    authorization: { status: 'synthetic-no-real-person' }, profile, files }] };
}

test('portrait archive reuse is disabled by default and inherited environment or metadata cannot select it', t => {
  const f = fixture(t), config = f.config({ env: { HR_PORTRAIT_REUSE_MANIFEST: f.file, PENGMANAGER_PORTRAIT_REUSE_MANIFEST_PATH: f.file },
    metadata: { portraitReuseManifestPath: f.file } });
  assert.equal(config.portraitReuseManifest, null); assert.equal(environment(config).HR_PORTRAIT_REUSE_MANIFEST, '');
  assert.throws(() => environment(config, { HR_PORTRAIT_REUSE_MANIFEST: f.file }), { code: 'TOOL_ENV_INVALID' });
});

test('only the explicit owner runtime option freezes the actual private manifest bytes for the native backend', t => {
  const f = fixture(t), document = studioManifest(f); f.write(document);
  const config = f.config({ portraitReuseManifestPath: f.file });
  assert.deepEqual(config.portraitReuseManifest, { path: f.file, bytes: fs.statSync(f.file).size, sha256: sha256(fs.readFileSync(f.file)) });
  assert.equal(Object.isFrozen(config.portraitReuseManifest), true);
  assert.equal(verifiedPortraitReuseManifest(config), f.file); assert.equal(environment(config).HR_PORTRAIT_REUSE_MANIFEST, f.file);
  const verified = loadPortraitReuseManifest(environment(config).HR_PORTRAIT_REUSE_MANIFEST, config.portraitReuseManifest.sha256);
  assert.equal(verified.characters[0].id, 'young-rider-01'); assert.equal(verified.approvedSelection.selectedVersion, 2);
});

test('relative, noncanonical, missing, outside and prefix-sibling manifests are rejected without creating private state', t => {
  const f = fixture(t), outside = path.join(f.base, 'outside.json'), sibling = path.join(f.base, 'private-extra.json');
  fs.writeFileSync(outside, '{}', { mode: 0o600 }); fs.writeFileSync(sibling, '{}', { mode: 0o600 });
  for (const file of ['', null, false, 'inputs/portrait-reuse.json', `${f.data}/inputs/./portrait-reuse.json`,
    path.join(f.data, 'missing.json'), f.data, outside, sibling]) {
    assert.throws(() => f.config({ portraitReuseManifestPath: file }), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
  }
  assert.equal(fs.existsSync(path.join(f.data, 'private-state.json')), false);
});

test('a linked manifest or linked parent directory cannot redirect the owner-selected input', t => {
  const f = fixture(t), outside = path.join(f.base, 'outside'); fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(path.join(outside, 'manifest.json'), '{}', { mode: 0o600 });
  const fileLink = path.join(f.data, 'inputs', 'linked.json'); fs.symlinkSync(f.file, fileLink);
  const directoryLink = path.join(f.data, 'redirect'); fs.symlinkSync(outside, directoryLink);
  for (const file of [fileLink, path.join(directoryLink, 'manifest.json')]) {
    assert.throws(() => f.config({ portraitReuseManifestPath: file }), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
  }
});

test('the private data root, every input parent and the manifest itself must remain owner-only', t => {
  if (process.platform === 'win32') { t.skip('POSIX owner permission bits are not available.'); return; }
  const f = fixture(t);
  for (const location of [f.data, path.dirname(f.file), f.file]) {
    const original = fs.statSync(location).mode & 0o777; fs.chmodSync(location, 0o755);
    assert.throws(() => f.config({ portraitReuseManifestPath: f.file }), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
    fs.chmodSync(location, original);
  }
});

test('empty and oversized manifests fail before reading while the exact byte bound can be frozen', t => {
  const f = fixture(t); f.write('');
  assert.throws(() => f.config({ portraitReuseManifestPath: f.file }), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
  f.write(Buffer.alloc(8_000_001, 32));
  assert.throws(() => f.config({ portraitReuseManifestPath: f.file }), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
  f.write(Buffer.alloc(8_000_000, 32)); assert.equal(f.config({ portraitReuseManifestPath: f.file }).portraitReuseManifest.bytes, 8_000_000);
});

test('same-size content changes are rejected on every native environment build instead of silently switching the selected input', t => {
  const f = fixture(t); f.write('{"version":1}'); const config = f.config({ portraitReuseManifestPath: f.file });
  assert.equal(environment(config).HR_PORTRAIT_REUSE_MANIFEST, f.file);
  f.write('{"version":2}');
  assert.throws(() => environment(config), { code: 'PORTRAIT_REUSE_MANIFEST_CHANGED' });
  assert.throws(() => verifiedPortraitReuseManifest(config), { code: 'PORTRAIT_REUSE_MANIFEST_CHANGED' });
});

test('deletion, permission changes and redirected replacement after configuration stay fail-closed', t => {
  const f = fixture(t), config = f.config({ portraitReuseManifestPath: f.file });
  fs.unlinkSync(f.file); assert.throws(() => environment(config), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
  f.write('{}'); const second = f.config({ portraitReuseManifestPath: f.file });
  if (process.platform !== 'win32') {
    fs.chmodSync(f.file, 0o644); assert.throws(() => environment(second), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' }); fs.chmodSync(f.file, 0o600);
  }
  const original = path.join(f.data, 'inputs', 'preserved.json'); fs.renameSync(f.file, original); fs.symlinkSync(original, f.file);
  assert.throws(() => environment(second), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' });
});

test('a file replacement during the bounded descriptor read cannot become the frozen manifest', t => {
  const f = fixture(t), read = fs.readSync; let replaced = false;
  t.mock.method(fs, 'readSync', function (...args) {
    if (!replaced) { replaced = true; const replacement = `${f.file}.replacement`; fs.writeFileSync(replacement, '{}', { mode: 0o600 }); fs.renameSync(replacement, f.file); }
    return read.apply(this, args);
  });
  assert.throws(() => f.config({ portraitReuseManifestPath: f.file }), { code: 'PORTRAIT_REUSE_MANIFEST_INVALID' }); assert.equal(replaced, true);
});

test('PM path/hash selection never substitutes for the Studio content identity and current source-byte verifier', t => {
  const f = fixture(t), document = studioManifest(f); f.write(document);
  const config = f.config({ portraitReuseManifestPath: f.file });
  assert.equal(environment(config).HR_PORTRAIT_REUSE_MANIFEST, f.file);
  fs.writeFileSync(document.characters[0].files.front.path, 'changed source image', { mode: 0o600 });
  assert.equal(environment(config).HR_PORTRAIT_REUSE_MANIFEST, f.file); // The JSON bytes did not change.
  assert.throws(() => loadPortraitReuseManifest(f.file), /PORTRAIT_REUSE_UNVERIFIED/);
  f.write({ schemaVersion: 'wrong-schema', characters: [] });
  const invalidContent = f.config({ portraitReuseManifestPath: f.file });
  assert.equal(environment(invalidContent).HR_PORTRAIT_REUSE_MANIFEST, f.file);
  assert.throws(() => loadPortraitReuseManifest(f.file), /PORTRAIT_REUSE_UNVERIFIED/);
});
