import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { OFFICIAL_UI as PIN, PublicUiReleaseError, downloadOfficialUi, validateOfficialAssetRedirect, verifyOfficialArchiveBytes } from './ui-public-release.mjs';

// CI writes the genuine archive into its private temporary directory. The archive
// is deliberately not part of the source snapshot or this test's fixtures.
assert.ok(process.env.WORKLOOM_UI_TEST_ARCHIVE_PATH, 'WORKLOOM_UI_TEST_ARCHIVE_PATH must name the genuine temporary original archive');
const archive = await readFile(process.env.WORKLOOM_UI_TEST_ARCHIVE_PATH);
const code = expected => error => error instanceof PublicUiReleaseError && error.code === expected;
const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/' + PIN.repositoryId + '/fixture?signature=must-not-enter-proof';
function release() {
  return {
    id: PIN.releaseId, url: PIN.releaseIdentityUrl, html_url: PIN.releasePage,
    tag_name: PIN.tag, target_commitish: PIN.sourceCommit,
    draft: false, prerelease: false, immutable: true,
    assets: [{ id: PIN.assetId, name: PIN.assetName, size: PIN.bytes,
      state: 'uploaded', digest: 'sha256:' + PIN.sha256,
      url: PIN.assetUrl, browser_download_url: PIN.browserUrl }],
  };
}
function fixture({ releaseValue = release(), releaseStatus = 200, assetStatus = 302,
  redirect = cdn, finalStatus = 200, bytes = archive, failAt } = {}) {
  const calls = [];
  const fetchImplementation = async (url, options) => {
    calls.push({ url: String(url), options });
    if (calls.length === failAt) throw new Error('credential-never-leak ' + cdn);
    if (calls.length === 1) return new Response(JSON.stringify(releaseValue), { status: releaseStatus });
    if (calls.length === 2) return new Response(assetStatus === 200 ? bytes : null, { status: assetStatus, headers: { Location: redirect } });
    return new Response(bytes, { status: finalStatus });
  };
  return { calls, fetchImplementation };
}

test('official immutable mirror verifies original archive with SHA-256 and SHA-512', () => {
  assert.deepEqual(verifyOfficialArchiveBytes(archive), { bytes: PIN.bytes, sha256: PIN.sha256, sri: PIN.sri });
  assert.throws(() => verifyOfficialArchiveBytes('not bytes'), code('UI_PUBLIC_ARCHIVE_BYTES'));
  assert.throws(() => verifyOfficialArchiveBytes(archive.subarray(1)), code('UI_PUBLIC_ARCHIVE_SIZE'));
  const corrupt = Buffer.from(archive); corrupt[100] ^= 1;
  assert.throws(() => verifyOfficialArchiveBytes(corrupt), code('UI_PUBLIC_ARCHIVE_SHA256'));
});
test('public transport binds immutable release/source/asset and sends no credentials on any hop', async () => {
  const mock = fixture(); const result = await downloadOfficialUi(mock);
  assert.deepEqual(mock.calls.map(call => call.url), [PIN.releaseUrl, PIN.assetUrl, cdn]);
  for (const call of mock.calls) {
    assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.referrerPolicy, 'no-referrer');
    assert.equal(Object.keys(call.options.headers).some(key => /authorization|cookie/i.test(key)), false);
  }
  assert.equal(mock.calls[0].options.redirect, 'manual'); assert.equal(mock.calls[1].options.redirect, 'manual');
  assert.equal(mock.calls[2].options.redirect, 'error');
  assert.deepEqual(mock.calls[2].options.headers, { Accept: 'application/octet-stream' });
  assert.deepEqual(result.bytes, archive);
  assert.deepEqual(result.proof, {
    bytes: PIN.bytes, sha256: PIN.sha256, sri: PIN.sri,
    transport: 'official-github', officialSourceVerified: true,
    producer: PIN.producer, sourceCommit: PIN.sourceCommit, tag: PIN.tag,
    releaseId: String(PIN.releaseId), assetId: String(PIN.assetId),
    authenticatedApi: false, credentialsForwardedToCdn: false,
    apiOrigin: 'https://api.github.com', assetOrigin: 'https://release-assets.githubusercontent.com',
  });
  assert.equal(JSON.stringify(result.proof).includes('signature'), false);
});
test('documented direct binary response needs no redirect or third request', async () => {
  const mock = fixture({ assetStatus: 200 }); const result = await downloadOfficialUi(mock);
  assert.equal(mock.calls.length, 2); assert.equal(result.proof.assetOrigin, 'https://api.github.com');
  assert.equal(result.proof.sha256, PIN.sha256);
});
for (const [label, mutate, expected] of [
  ['release ID', x => { x.id++; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['release API URL', x => { x.url = 'https://api.github.com/repos/another/project/releases/' + PIN.releaseId; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['release page', x => { x.html_url = 'https://github.com/another/project/releases/tag/' + PIN.tag; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['tag', x => { x.tag_name = 'ui-v0.1.20'; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['source commit', x => { x.target_commitish = 'main'; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['draft', x => { x.draft = true; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['prerelease', x => { x.prerelease = true; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['mutable release', x => { x.immutable = false; }, 'UI_PUBLIC_RELEASE_IDENTITY'],
  ['missing assets', x => { x.assets = null; }, 'UI_PUBLIC_RELEASE_ASSETS'],
  ['missing asset', x => { x.assets = []; }, 'UI_PUBLIC_RELEASE_ASSET_CARDINALITY'],
  ['duplicate asset', x => { x.assets.push({ ...x.assets[0] }); }, 'UI_PUBLIC_RELEASE_ASSET_CARDINALITY'],
  ['asset ID', x => { x.assets[0].id++; }, 'UI_PUBLIC_RELEASE_ASSET_IDENTITY'],
  ['unpublished asset', x => { x.assets[0].state = 'new'; }, 'UI_PUBLIC_RELEASE_ASSET_IDENTITY'],
  ['asset size', x => { x.assets[0].size++; }, 'UI_PUBLIC_RELEASE_ASSET_HASH'],
  ['asset digest', x => { x.assets[0].digest = 'sha256:' + '0'.repeat(64); }, 'UI_PUBLIC_RELEASE_ASSET_HASH'],
  ['asset API URL', x => { x.assets[0].url += '?token=unsafe'; }, 'UI_PUBLIC_RELEASE_ASSET_URL'],
  ['asset browser URL', x => { x.assets[0].browser_download_url = 'https://example.com/other.tgz'; }, 'UI_PUBLIC_RELEASE_ASSET_URL'],
]) test('release verification rejects changed ' + label + ' before downloading', async () => {
  const value = release(); mutate(value); const mock = fixture({ releaseValue: value });
  await assert.rejects(downloadOfficialUi(mock), code(expected)); assert.equal(mock.calls.length, 1);
});
for (const [url, expected] of [
  ['not a URL', 'UI_PUBLIC_ASSET_REDIRECT_URL'],
  ['http://release-assets.githubusercontent.com/github-production-release-asset/' + PIN.repositoryId + '/x', 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN'],
  ['https://release-assets.githubusercontent.com.evil.example/x', 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN'],
  ['https://evil.example/x', 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN'],
  [cdn.replace('.com/', '.com:444/'), 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN'],
  [cdn.replace('https://', 'https://user:secret@'), 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN'],
  [cdn + '#fragment', 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN'],
  [cdn.replace(String(PIN.repositoryId), '123'), 'UI_PUBLIC_ASSET_REDIRECT_PATH'],
  ['https://release-assets.githubusercontent.com/other/x', 'UI_PUBLIC_ASSET_REDIRECT_PATH'],
]) test('CDN redirect rejects unsafe destination ' + expected + ' ' + url.split('?')[0], async () => {
  assert.throws(() => validateOfficialAssetRedirect(url), code(expected));
  const mock = fixture({ redirect: url });
  await assert.rejects(downloadOfficialUi(mock), code(expected)); assert.equal(mock.calls.length, 2);
});
test('both exact allowed GitHub asset CDN hostnames keep the repository boundary', () => {
  assert.equal(validateOfficialAssetRedirect(cdn).hostname, 'release-assets.githubusercontent.com');
  assert.equal(validateOfficialAssetRedirect(cdn.replace('release-assets.', 'objects.')).hostname, 'objects.githubusercontent.com');
});
for (const [options, expected] of [
  [{ releaseStatus: 403 }, 'UI_PUBLIC_RELEASE_HTTP_403'],
  [{ assetStatus: 404 }, 'UI_PUBLIC_ASSET_HTTP_404'],
  [{ assetStatus: 307 }, 'UI_PUBLIC_ASSET_HTTP_307'],
  [{ finalStatus: 302 }, 'UI_PUBLIC_ASSET_DOWNLOAD_HTTP_302'],
  [{ finalStatus: 403 }, 'UI_PUBLIC_ASSET_DOWNLOAD_HTTP_403'],
  [{ bytes: archive.subarray(1) }, 'UI_PUBLIC_ARCHIVE_SIZE'],
  [{ bytes: Buffer.concat([archive, Buffer.alloc(1)]) }, 'UI_PUBLIC_ASSET_DOWNLOAD_BODY'],
  [{ assetStatus: 200, bytes: Buffer.concat([archive, Buffer.alloc(1)]) }, 'UI_PUBLIC_ASSET_BODY'],
]) test('HTTP and archive failures remain explicit: ' + expected, async () => {
  await assert.rejects(downloadOfficialUi(fixture(options)), code(expected));
});
test('invalid JSON, oversized metadata and failing streams produce safe codes', async () => {
  for (const [body, expected] of [
    ['not-json', 'UI_PUBLIC_RELEASE_JSON'],
    ['x'.repeat(512 * 1024 + 1), 'UI_PUBLIC_RELEASE_BODY'],
    [new ReadableStream({ start(controller) { controller.error(new Error('credential-never-leak ' + cdn)); } }), 'UI_PUBLIC_RELEASE_BODY'],
  ]) {
    await assert.rejects(downloadOfficialUi({ fetchImplementation: async () => new Response(body) }), error => code(expected)(error) && !error.message.includes('credential') && !error.message.includes('signature'));
  }
});
test('transport exceptions expose neither credentials nor signed CDN URLs', async () => {
  for (const [failAt, expected] of [[1, 'UI_PUBLIC_RELEASE_REQUEST'], [2, 'UI_PUBLIC_ASSET_REQUEST'], [3, 'UI_PUBLIC_ASSET_DOWNLOAD']]) {
    await assert.rejects(downloadOfficialUi(fixture({ failAt })), error => code(expected)(error) && !error.message.includes('credential') && !error.message.includes('signature'));
  }
});
test('already cancelled public download never calls a transport', async () => {
  const controller = new AbortController(); controller.abort(); const mock = fixture();
  await assert.rejects(downloadOfficialUi({ ...mock, signal: controller.signal }), code('UI_BOOTSTRAP_CANCELLED'));
  assert.equal(mock.calls.length, 0);
});
test('cancellation completes even when an injected transport ignores its signal', async () => {
  const controller = new AbortController(); let started;
  const connected = new Promise(resolve => { started = resolve; });
  const pending = downloadOfficialUi({ signal: controller.signal, fetchImplementation: async () => { started(); return new Promise(() => {}); } });
  const outcome = assert.rejects(pending, code('UI_BOOTSTRAP_CANCELLED'));
  await connected; controller.abort(); await outcome;
});
for (const phase of ['request', 'body']) test('public download cancellation interrupts real loopback ' + phase, async t => {
  let notify; const connected = new Promise(resolve => { notify = resolve; });
  const server = http.createServer((_request, response) => {
    if (phase === 'body') { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"id":'); }
    notify();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const controller = new AbortController();
  // This local fixture proves lifecycle cancellation, never release provenance.
  const pending = downloadOfficialUi({ signal: controller.signal, fetchImplementation: (_url, options) => fetch('http://127.0.0.1:' + server.address().port + '/', options) });
  const outcome = assert.rejects(pending, code('UI_BOOTSTRAP_CANCELLED'));
  await connected; controller.abort(); await outcome;
});
