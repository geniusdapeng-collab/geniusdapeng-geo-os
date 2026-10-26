import { boundedResponseBytes, bytesHash, decodeJson, fail, identifier, integer, jsonValue,
  normalizedOrigin, record, requireCondition, sha256, text, ContentOpsWorkerError } from './protocol.mjs';

const SEGMENT = value => encodeURIComponent(identifier(value));

/** A single attempt per HTTP request. Recovery is controlled by the durable worker. */
export class WorkerHttpTransport {
  #credential;
  constructor({ origin, credential, workerId, grantId, scopeHash, fetchImpl = globalThis.fetch,
    timeoutMs = 30_000, allowLoopbackHttp = false } = {}) {
    this.origin = normalizedOrigin(origin, { allowLoopbackHttp });
    requireCondition(typeof credential === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(credential), 'WORKER_CREDENTIAL_INVALID', 'A valid independent worker credential must be supplied by the current process.');
    identifier(workerId, 'Worker ID'); identifier(grantId, 'Grant ID'); sha256(scopeHash);
    this.#credential = credential; this.workerId = workerId; this.grantId = grantId; this.scopeHash = scopeHash;
    this.fetchImpl = fetchImpl; this.timeoutMs = integer(timeoutMs, 'Cloud request timeout', 100, 120_000);
  }
  async #request(path, input, ctx = {}, { bytes, headers = {}, maxBytes = 2_000_000 } = {}) {
    requireCondition(path.startsWith('/api/content-ops/') && !path.includes('..') && !path.includes('?'),
      'WORKER_ROUTE_DENIED', 'The worker transport may call only its fixed content preparation routes.');
    const requestHeaders = { Authorization: `Bearer ${this.#credential}`, 'X-Worker-Id': this.workerId,
      'X-Worker-Grant-Id': this.grantId, 'X-Worker-Scope-Hash': this.scopeHash, Accept: 'application/json', ...headers };
    if (ctx.idempotencyKey) requestHeaders['Idempotency-Key'] = text(ctx.idempotencyKey, 'Idempotency key', { max: 128 });
    if (ctx.ifMatch) requestHeaders['If-Match'] = text(ctx.ifMatch, 'ETag', { max: 256 });
    let response, responseBytes;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    try {
      response = await this.fetchImpl(new URL(path, this.origin), { method: input === undefined && bytes === undefined ? 'GET' : 'POST',
        redirect: 'error', headers: { ...(bytes === undefined ? { 'Content-Type': 'application/json' } : {}), ...requestHeaders },
        ...(bytes !== undefined ? { body: bytes } : input !== undefined ? { body: JSON.stringify(jsonValue(input)) } : {}), signal });
      responseBytes = await boundedResponseBytes(response, maxBytes);
    } catch (cause) { throw new ContentOpsWorkerError('CLOUD_RESULT_UNKNOWN', 'The cloud request has no verified response; recover it by its original idempotency key.', { unknown: true, retryable: true, cause }); }
    if (response.status === 204) return null;
    if (!response.ok) {
      let code = 'CLOUD_REQUEST_REJECTED';
      try { const value = decodeJson(responseBytes); if (/^[A-Z][A-Z0-9_]{1,79}$/.test(value.error?.code)) code = value.error.code; }
      catch { /* A remote error body is deliberately withheld. */ }
      fail(code, 'The content preparation server rejected this exact worker request.', { retryable: response.status >= 500, unknown: response.status >= 500 });
    }
    if (headers.Accept === 'application/octet-stream') return { bytes: responseBytes,
      sha256: bytesHash(responseBytes), mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream' };
    try { return decodeJson(responseBytes, { maxBytes }); }
    catch (cause) { throw new ContentOpsWorkerError('CLOUD_RESPONSE_INVALID', 'The server returned an invalid content preparation response.', { unknown: true, cause }); }
  }
  claimTask(input, ctx) { return this.#request('/api/content-ops/worker/tasks/claim', input, ctx); }
  getWorkerTask(id, ctx) { return this.#request(`/api/content-ops/worker/tasks/${SEGMENT(id)}`, undefined, ctx); }
  heartbeatTask(id, input, ctx) { return this.#request(`/api/content-ops/worker/tasks/${SEGMENT(id)}/heartbeat`, input, ctx); }
  dispatchTask(id, input, ctx) { return this.#request(`/api/content-ops/worker/tasks/${SEGMENT(id)}/dispatch`, input, ctx); }
  settleCall(id, input, ctx) { return this.#request(`/api/content-ops/worker/reservations/${SEGMENT(id)}/settle`, input, ctx); }
  unknownCall(id, input, ctx) { return this.#request(`/api/content-ops/worker/reservations/${SEGMENT(id)}/unknown`, input, ctx); }
  completeTask(id, input, ctx) { return this.#request(`/api/content-ops/worker/tasks/${SEGMENT(id)}/complete`, input, ctx); }
  failTask(id, input, ctx) { return this.#request(`/api/content-ops/worker/tasks/${SEGMENT(id)}/fail`, input, ctx); }
  registerArtifact(id, input, bytes, ctx) {
    record(input, 'Artifact upload metadata');
    requireCondition(Buffer.isBuffer(bytes) && bytes.length === input.size && bytesHash(bytes) === input.sha256,
      'ARTIFACT_HASH_MISMATCH', 'The upload bytes do not match their frozen manifest.');
    return this.#request(`/api/content-ops/worker/tasks/${SEGMENT(id)}/artifacts`, undefined, ctx, { bytes, headers: {
      'Content-Type': input.mime, 'X-Attempt-Id': input.attemptId, 'X-Task-Epoch': String(input.epoch),
      'X-Task-Hash': input.taskHash, 'X-Resolved-Input-Hash': input.resolvedInputHash,
      'X-Output-Key': input.outputKey, 'X-Artifact-Role': input.role,
      'X-Content-Sha256': input.sha256, 'X-Content-Size': String(input.size),
      ...(input.artifactId ? { 'X-Artifact-Id': input.artifactId } : {}),
      ...(input.name ? { 'X-Artifact-Name': encodeURIComponent(input.name) } : {}),
    } });
  }
  async readSource(ref, ctx) {
    record(ref, 'Source reference'); const id = ref.artifactId ?? ref.assetId ?? ref.id; identifier(id); const expected = ref.sha256 ?? ref.hash; sha256(expected);
    const size = ref.bytes ?? ref.size;
    if (size !== undefined) integer(size, 'Source bytes', 1, 50 * 1024 * 1024);
    const collection = ref.assetId || /^MED-/.test(ref.id ?? '') || ref.kind === 'media' ? 'media' : 'artifacts';
    const result = await this.#request(`/api/content-ops/worker/${collection}/${SEGMENT(id)}/bytes`, undefined, ctx,
      { headers: { Accept: 'application/octet-stream' }, maxBytes: size ?? 50 * 1024 * 1024 });
    requireCondition((size === undefined || result?.bytes.length === size) && result.sha256 === expected,
      'ARTIFACT_HASH_MISMATCH', 'The cloud source bytes do not match their approved reference.');
    return { ...result, id, sourceProof: { id, sha256: expected, bytes: result.bytes.length, sourceUntouched: true } };
  }
}
