import { createHash, timingSafeEqual } from 'node:crypto';

// The official immutable hosting mirror contains the original CNB archive.
// Its identity is separate from the canonical dependency URL in pnpm-lock.yaml.
export const OFFICIAL_UI = Object.freeze({
  producer: 'geniusdapeng-collab/workloom-im', repositoryId: 1335665551,
  package: '@workloom/ui', version: '0.1.19', tag: 'ui-v0.1.19',
  sourceCommit: '2c5a02e8b4b3fb40b72549bc0a2c51539914c059',
  releaseId: 422438050, assetId: 670901023,
  assetName: 'workloom-ui-0.1.19.tgz', bytes: 90041,
  releaseUrl: 'https://api.github.com/repos/geniusdapeng-collab/workloom-im/releases/tags/ui-v0.1.19',
  releaseIdentityUrl: 'https://api.github.com/repos/geniusdapeng-collab/workloom-im/releases/422438050',
  releasePage: 'https://github.com/geniusdapeng-collab/workloom-im/releases/tag/ui-v0.1.19',
  assetUrl: 'https://api.github.com/repos/geniusdapeng-collab/workloom-im/releases/assets/670901023',
  browserUrl: 'https://github.com/geniusdapeng-collab/workloom-im/releases/download/ui-v0.1.19/workloom-ui-0.1.19.tgz',
  sha256: '42bf2e483cbd2665fda74f0e64cff7266184db7844801b27b5078f0082a3b262',
  sri: 'sha512-kplOLAtovega6BLpBwtFM1DfBS3q4ZjLp9yA942o+v9QlbREm/VsYNK/Jz7f/9ytDWSFXCvmh10C3ZHrPHkcSA==',
});

export class PublicUiReleaseError extends Error {
  constructor(code) { super(code); this.name = 'PublicUiReleaseError'; this.code = code; }
}
const requireFact = (condition, code) => { if (!condition) throw new PublicUiReleaseError(code); };
const active = signal => { if (signal?.aborted) throw new PublicUiReleaseError('UI_BOOTSTRAP_CANCELLED'); };
const sameDigest = (left, right) => {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

function requestScope(parent, timeoutMs) {
  active(parent);
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs); timer.unref?.();
  return {
    signal: controller.signal,
    close() { clearTimeout(timer); parent?.removeEventListener('abort', abort); },
  };
}
function requestError(signal, parent, code) {
  return new PublicUiReleaseError(parent?.aborted ? 'UI_BOOTSTRAP_CANCELLED' : signal.aborted ? code + '_TIMEOUT' : code);
}
// A supplied transport must not be able to hang cancellation by ignoring signal.
async function abortable(operation, signal, parent, code) {
  active(parent);
  if (signal.aborted) throw requestError(signal, parent, code);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(requestError(signal, parent, code)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw requestError(signal, parent, code);
      return operation();
    }).then(value => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(requestError(signal, parent, code)); else resolve(value);
    }, () => {
      signal.removeEventListener('abort', abort); reject(requestError(signal, parent, code));
    });
    if (signal.aborted) abort();
  });
}
async function boundedBody(response, maximum, signal, parent, code) {
  requireFact(response.body && typeof response.body.getReader === 'function', code);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal, parent, code);
      if (done) break;
      requireFact(value instanceof Uint8Array, code);
      size += value.byteLength; requireFact(size <= maximum, code);
      chunks.push(Buffer.from(value));
    }
    active(parent);
    return Buffer.concat(chunks, size);
  } catch (error) {
    // Cancellation must finish even if an injected stream's cleanup never settles.
    void reader.cancel().catch(() => { error.bodyCancellationFailed = true; });
    throw error;
  } finally { reader.releaseLock(); }
}
async function request(fetchImplementation, url, accept, parent, timeoutMs, code, consume) {
  const scope = requestScope(parent, timeoutMs);
  try {
    const response = await abortable(() => fetchImplementation(url, {
      method: 'GET', headers: { Accept: accept, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'PengManager-public-ui-install' },
      redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: scope.signal,
    }), scope.signal, parent, code);
    active(parent);
    return await consume(response, scope.signal);
  } finally { scope.close(); }
}

export function validateOfficialAssetRedirect(location) {
  let url;
  try { url = new URL(location); } catch { throw new PublicUiReleaseError('UI_PUBLIC_ASSET_REDIRECT_URL'); }
  requireFact(url.protocol === 'https:' && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
    && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash, 'UI_PUBLIC_ASSET_REDIRECT_ORIGIN');
  requireFact(url.pathname.startsWith('/github-production-release-asset/' + OFFICIAL_UI.repositoryId + '/'), 'UI_PUBLIC_ASSET_REDIRECT_PATH');
  return url;
}

export function verifyOfficialArchiveBytes(input) {
  requireFact(Buffer.isBuffer(input) || input instanceof Uint8Array, 'UI_PUBLIC_ARCHIVE_BYTES');
  const bytes = Buffer.from(input);
  requireFact(bytes.length === OFFICIAL_UI.bytes, 'UI_PUBLIC_ARCHIVE_SIZE');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sri = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  requireFact(sameDigest(sha256, OFFICIAL_UI.sha256), 'UI_PUBLIC_ARCHIVE_SHA256');
  requireFact(sameDigest(sri, OFFICIAL_UI.sri), 'UI_PUBLIC_ARCHIVE_SRI');
  return { bytes: bytes.length, sha256, sri };
}

/** Public, pinned official transport. Credentials and signed URLs never enter its proof. */
export async function downloadOfficialUi({ signal, fetchImplementation = fetch } = {}) {
  active(signal);
  const release = await request(fetchImplementation, OFFICIAL_UI.releaseUrl, 'application/vnd.github+json', signal, 30000, 'UI_PUBLIC_RELEASE_REQUEST', async (response, requestSignal) => {
    requireFact(response.status === 200, 'UI_PUBLIC_RELEASE_HTTP_' + response.status);
    const bytes = await boundedBody(response, 512 * 1024, requestSignal, signal, 'UI_PUBLIC_RELEASE_BODY');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new PublicUiReleaseError('UI_PUBLIC_RELEASE_JSON'); }
  });
  requireFact(release && release.id === OFFICIAL_UI.releaseId && release.url === OFFICIAL_UI.releaseIdentityUrl
    && release.html_url === OFFICIAL_UI.releasePage && release.tag_name === OFFICIAL_UI.tag
    && release.target_commitish === OFFICIAL_UI.sourceCommit && release.draft === false
    && release.prerelease === false && release.immutable === true, 'UI_PUBLIC_RELEASE_IDENTITY');
  requireFact(Array.isArray(release.assets), 'UI_PUBLIC_RELEASE_ASSETS');
  const matching = release.assets.filter(asset => asset?.name === OFFICIAL_UI.assetName);
  requireFact(matching.length === 1, 'UI_PUBLIC_RELEASE_ASSET_CARDINALITY');
  const asset = matching[0];
  requireFact(asset.id === OFFICIAL_UI.assetId && asset.state === 'uploaded', 'UI_PUBLIC_RELEASE_ASSET_IDENTITY');
  requireFact(asset.size === OFFICIAL_UI.bytes && asset.digest === 'sha256:' + OFFICIAL_UI.sha256, 'UI_PUBLIC_RELEASE_ASSET_HASH');
  requireFact(asset.url === OFFICIAL_UI.assetUrl && asset.browser_download_url === OFFICIAL_UI.browserUrl, 'UI_PUBLIC_RELEASE_ASSET_URL');

  let assetOrigin = 'https://api.github.com';
  const result = await request(fetchImplementation, OFFICIAL_UI.assetUrl, 'application/octet-stream', signal, 60000, 'UI_PUBLIC_ASSET_REQUEST', async (response, requestSignal) => {
    // GitHub documents both direct binary and a single CDN redirect for this API.
    if (response.status === 200) return { bytes: await boundedBody(response, OFFICIAL_UI.bytes, requestSignal, signal, 'UI_PUBLIC_ASSET_BODY') };
    requireFact(response.status === 302, 'UI_PUBLIC_ASSET_HTTP_' + response.status);
    return { redirect: validateOfficialAssetRedirect(response.headers.get('location')) };
  });
  let bytes = result.bytes;
  if (result.redirect) {
    assetOrigin = result.redirect.origin;
    const scope = requestScope(signal, 60000);
    try {
      // No API headers, Authorization, cookies or referrer reach the signed URL.
      const response = await abortable(() => fetchImplementation(result.redirect, {
        method: 'GET', headers: { Accept: 'application/octet-stream' }, redirect: 'error',
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: scope.signal,
      }), scope.signal, signal, 'UI_PUBLIC_ASSET_DOWNLOAD');
      requireFact(response.status === 200, 'UI_PUBLIC_ASSET_DOWNLOAD_HTTP_' + response.status);
      bytes = await boundedBody(response, OFFICIAL_UI.bytes, scope.signal, signal, 'UI_PUBLIC_ASSET_DOWNLOAD_BODY');
    } finally { scope.close(); }
  }
  active(signal);
  const archive = verifyOfficialArchiveBytes(bytes);
  return { bytes, proof: {
    ...archive, transport: 'official-github', officialSourceVerified: true,
    producer: OFFICIAL_UI.producer, sourceCommit: OFFICIAL_UI.sourceCommit, tag: OFFICIAL_UI.tag,
    releaseId: String(OFFICIAL_UI.releaseId), assetId: String(OFFICIAL_UI.assetId),
    authenticatedApi: false, credentialsForwardedToCdn: false,
    apiOrigin: 'https://api.github.com', assetOrigin,
  } };
}
