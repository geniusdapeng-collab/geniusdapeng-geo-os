import { randomUUID } from 'node:crypto';
import { bytesHash, dataHash, fail, identifier, integer, instant, isRecord, jsonValue, normalizedOrigin,
  record, requireCondition, safeError, sha256, throwIfAborted, WORKER_PROTOCOL } from './protocol.mjs';

const IDENTITY_KEYS = ['attemptId', 'epoch', 'taskHash', 'resolvedInputHash'];
const TERMINAL = new Set(['completed', 'failed_known', 'unknown', 'needs_reconcile', 'quarantined']);
const identity = lease => Object.fromEntries(IDENTITY_KEYS.map(key => [key, lease[key]]));
const taskId = lease => lease.task.taskId ?? lease.task.id;
const timestamp = clock => new Date(clock()).toISOString();
const omit = (value, keys) => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const editionSnapshot = edition => {
  const fields = ['id', 'familyId', 'storyId', 'locale', 'format', 'editorialRevision', 'sourceEditionId', 'supersedesEditionId',
    'title', 'summary', 'body', 'blocks', 'claimIds', 'claimBindings', 'assetRefs'];
  const snapshot = { schema: 'pengmanager.editorial-snapshot/v2', ...Object.fromEntries(fields.map(key => [key, edition[key]])) };
  if (edition.snapshotSchema === 'pengmanager.editorial-edition/v3') return { ...snapshot, schema: edition.snapshotSchema,
    formatLineage: edition.formatLineage, formatTransformKey: edition.formatTransformKey };
  requireCondition(edition.snapshotSchema === undefined || edition.snapshotSchema === snapshot.schema,
    'SOURCE_SCHEMA_UNSUPPORTED', 'The worker cannot verify this newer source edition schema.');
  return snapshot;
};
function validateResolvedData(lease, now) {
  const compile = lease.task.inputRefs;
  // The real compiler includes these complete input identities. Old explicit
  // fixture blueprints can omit them; no network API manufactures new values.
  if (!compile?.planHash) return;
  const data = record(lease.resolvedInputData, 'Resolved task data'), plan = record(data.plan, 'Frozen adaptation plan');
  requireCondition(dataHash(omit(plan, ['containsCommands', 'planHash'])) === (compile.planProjectionHash ?? compile.planHash),
    'TASK_INPUT_CHANGED', 'The resolved adaptation plan differs from the static compiled plan.');
  const target = plan.targets.find(row => row.targetKey === lease.task.targetKey);
  requireCondition(target && dataHash(target) === compile.targetHash
    && dataHash(omit(target, ['inputFiles'])) === dataHash(omit(data.target, ['inputFiles']))
    && dataHash(data.target.inputFiles) === dataHash(lease.resolvedInputRefs.fileRefs)
    && dataHash(data.effectivePolicy) === compile.effectivePolicyHash,
  'TASK_INPUT_CHANGED', 'The resolved target, exact source files or policy differs from the compiled authorization.');
  const authorRefs = lease.task.kind === 'format.transform' ? lease.task.neutralAuthorContributionRefs : target.authorContributionRefs;
  requireCondition(Array.isArray(authorRefs) && Array.isArray(data.authorContributions)
    && data.authorContributions.length === authorRefs.length
    && new Set(authorRefs.map(ref => ref.id)).size === authorRefs.length,
  'TASK_INPUT_CHANGED', 'The complete exact authorized author contribution set is unavailable.');
  if (lease.task.kind === 'format.transform') requireCondition(dataHash(data.transformSpec) === dataHash(lease.task.transformSpec)
    && dataHash(data.effectivePolicy) === dataHash(lease.task.neutralPolicy)
    && dataHash(lease.task.transformSpec.authority) === dataHash({ allowedAiActions: data.effectivePolicy.allowedAiActions,
      requiresAuthorContribution: data.effectivePolicy.requiresAuthorContribution, authorContributionRefs: authorRefs }),
  'TASK_INPUT_CHANGED', 'The shared neutral transform authority differs from its compiled snapshot.');
  for (const ref of authorRefs) {
    const source = data.authorContributions.find(row => row.id === ref.id);
    requireCondition(source && source.revision === ref.revision && source.hash === ref.sha256
      && dataHash(omit(source, ['hash', 'etag'])) === ref.sha256 && source.storyId === plan.storyRef.id
      && typeof source.body === 'string' && source.body.trim() && typeof source.authoredBy === 'string' && source.authoredBy.trim(),
    'TASK_INPUT_CHANGED', 'An actual author contribution differs from its exact authorized snapshot.');
  }
  requireCondition(Array.isArray(data.sourceEditions) && data.sourceEditions.length === plan.motherEditionRefs.length,
    'TASK_INPUT_CHANGED', 'The complete frozen source edition set is unavailable.');
  for (const ref of plan.motherEditionRefs) {
    const source = data.sourceEditions.find(row => row.id === ref.id);
    requireCondition(source && source.snapshotHash === ref.sha256 && (source.revision ?? source.editorialRevision ?? 1) === ref.revision
      && dataHash(editionSnapshot(source)) === ref.sha256, 'TASK_INPUT_CHANGED', 'An actual source edition differs from its approved complete snapshot.');
  }
  for (const ref of plan.claimBindings) {
    const source = data.claims?.find(row => row.id === ref.claimId);
    requireCondition(source && source.state === 'approved' && source.publicLevel === 'approved_public'
      && (!source.sensitivity || source.sensitivity === 'low') && (!source.expiresAt || Date.parse(source.expiresAt) > now)
      && dataHash({ id: source.id, type: source.type ?? null, text: source.text, source: source.source ?? null,
        evidenceLevel: source.evidenceLevel ?? null, sensitivity: source.sensitivity ?? null, expiresAt: source.expiresAt ?? null }) === ref.fingerprint,
    'CLAIM_CHANGED', 'The exact approved public claim is unavailable or no longer valid.');
  }
}

// The cloud-assigned grant ID is a receipt, not an owner-controlled scope field.
export function localGrantHash(grant) { return dataHash(omit(grant, ['localGrantHash', 'grantId'])); }

export function validateLocalGrant(grant, { origin, workerId, clock = () => Date.now(), allowLoopbackHttp = false, pendingPairing = false } = {}) {
  record(grant, 'Local owner grant', ['schema', 'workerId', 'grantId', 'origin', 'workspaceId', 'projectIds', 'jobIds', 'targetKeys',
    'adapterBindings', 'scopeHash', 'budgetAuthorizationHash', 'expiresAt', 'limits', 'roles', 'ownerConfirmed', 'localGrantHash']);
  requireCondition(grant.schema === 'pengmanager.worker-local-grant/v1' && grant.ownerConfirmed === true,
    'LOCAL_APPROVAL_REQUIRED', 'This worker requires a locally confirmed owner grant.');
  identifier(grant.workerId); if (!pendingPairing) identifier(grant.grantId); identifier(grant.workspaceId);
  requireCondition(grant.workerId === workerId && normalizedOrigin(grant.origin, { allowLoopbackHttp }) === normalizedOrigin(origin, { allowLoopbackHttp }),
    'WORKER_SCOPE_DENIED', 'The local grant does not authorize this worker and cloud origin.');
  for (const key of ['projectIds', 'jobIds', 'targetKeys', 'roles']) {
    requireCondition(Array.isArray(grant[key]) && grant[key].length > 0 && grant[key].length <= 1000,
      'WORKER_SCOPE_DENIED', 'The local grant requires explicit bounded scopes.');
    grant[key].forEach(value => identifier(value, key));
  }
  requireCondition(grant.roles.every(role => ['worker', 'checker'].includes(role)), 'WORKER_SCOPE_DENIED', 'The worker role is invalid.');
  requireCondition(Array.isArray(grant.adapterBindings) && grant.adapterBindings.length > 0 && grant.adapterBindings.length <= 100,
    'WORKER_SCOPE_DENIED', 'The local grant requires fixed adapters.');
  for (const binding of grant.adapterBindings) {
    record(binding, 'Local adapter binding', ['kind', 'adapterId', 'version', 'entrypointSha', 'validatorVersion', 'fixedTransport', 'nativeCapabilityId']);
    requireCondition(typeof binding.adapterId === 'string' && /^[A-Za-z0-9_.:/-]{1,200}$/.test(binding.adapterId), 'WORKER_SCOPE_DENIED', 'The local adapter ID is invalid.');
    sha256(binding.entrypointSha);
  }
  sha256(grant.scopeHash); sha256(grant.budgetAuthorizationHash); sha256(grant.localGrantHash);
  requireCondition(localGrantHash(grant) === grant.localGrantHash, 'LOCAL_GRANT_CHANGED', 'The local approval snapshot changed.');
  requireCondition(instant(grant.expiresAt) > clock(), 'LOCAL_GRANT_EXPIRED', 'The local owner grant expired.');
  record(grant.limits, 'Local resource limits', ['maxTempBytes', 'maxRenderSeconds', 'maxNativeProcesses', 'maxCalls']);
  integer(grant.limits.maxTempBytes, 'Local temporary bytes', 1, 2_000_000_000);
  integer(grant.limits.maxRenderSeconds, 'Local render seconds', 0, 86_400);
  integer(grant.limits.maxNativeProcesses, 'Local native processes', 0, 100);
  integer(grant.limits.maxCalls, 'Local bottom request count', 1, 1000);
  return grant;
}

/** No scheduler side effect runs inside a cloud storage transaction. */
export class ContentOpsWorker {
  constructor({ transport, store, adapters, localGrant, origin, workerId, sourceRegistry,
    clock = () => Date.now(), allowLoopbackHttp = false, signal, heartbeatIntervalMs = 15_000 } = {}) {
    this.transport = transport; this.store = store; this.adapters = adapters;
    this.localGrant = structuredClone(localGrant); this.origin = origin; this.workerId = workerId;
    this.sourceRegistry = sourceRegistry; this.clock = clock; this.signal = signal; this.allowLoopbackHttp = allowLoopbackHttp;
    this.heartbeatIntervalMs = integer(heartbeatIntervalMs, 'Worker heartbeat interval', 1000, 30_000);
    this.busy = false; this.liveLeases = new Map(); this.heartbeatQueues = new Map();
    validateLocalGrant(this.localGrant, this);
    this.store.maxTempBytes = Math.min(this.store.maxTempBytes, this.localGrant.limits.maxTempBytes);
  }
  #ctx(key, checker = false, extra = {}) {
    return { method: checker ? 'checker' : 'worker', actor: this.workerId, workerId: this.workerId,
      grantId: this.localGrant.grantId, scopeHash: this.localGrant.scopeHash,
      idempotencyKey: `wk_${dataHash({ workerId: this.workerId, key }).slice(0, 60)}`, signal: this.signal, ...extra };
  }
  #assertLease(lease, binding) {
    lease = this.liveLeases.get(lease.attemptId) ?? lease;
    throwIfAborted(this.signal); validateLocalGrant(this.localGrant, this);
    record(lease, 'Task lease'); identifier(lease.attemptId); integer(lease.epoch, 'Lease epoch', 1);
    sha256(lease.taskHash); sha256(lease.blueprintHash); sha256(lease.resolvedInputHash); sha256(lease.scopeHash);
    requireCondition(instant(lease.leaseExpiresAt) > this.clock(), 'LEASE_EXPIRED', 'The task lease expired before the next operation.');
    const task = record(lease.task, 'Task blueprint'); identifier(taskId(lease)); identifier(task.jobId); identifier(task.targetKey);
    requireCondition(lease.scopeHash === this.localGrant.scopeHash && lease.localGrantHash === this.localGrant.localGrantHash
      && lease.budgetAuthorizationHash === this.localGrant.budgetAuthorizationHash
      && task.budgetAuthorizationHash === lease.budgetAuthorizationHash,
    'WORKER_SCOPE_DENIED', 'The cloud and local execution authorizations do not match.');
    const targetKeys = task.neutralTargetKeys ?? [task.targetKey];
    requireCondition(Array.isArray(targetKeys) && targetKeys.length > 0 && targetKeys.includes(task.targetKey)
      && new Set(targetKeys).size === targetKeys.length && (task.kind !== 'format.transform' || Array.isArray(task.neutralTargetKeys))
      && this.localGrant.jobIds.includes(task.jobId) && targetKeys.every(key => this.localGrant.targetKeys.includes(key))
      && (!task.projectId || this.localGrant.projectIds.includes(task.projectId)),
    'WORKER_SCOPE_DENIED', 'The task is outside the local job, project or target scope.');
    requireCondition(isRecord(task.adapterBinding) && this.localGrant.adapterBindings.some(item => dataHash(item) === dataHash(task.adapterBinding)),
      'ADAPTER_BINDING_CHANGED', 'The task adapter is not the exact locally approved source binding.');
    if (binding) requireCondition(dataHash(binding) === dataHash(task.adapterBinding), 'ADAPTER_BINDING_CHANGED', 'The current fixed adapter differs from the frozen task binding.');
    const blueprint = omit(task, ['taskHash', 'etag', 'status', 'attemptId', 'epoch', 'resolvedInputRefs', 'resolvedInputHash', 'resolvedInputData', 'createdAt']);
    requireCondition(dataHash(blueprint) === lease.taskHash, 'TASK_HASH_MISMATCH', 'The task blueprint bytes changed after compilation.');
    requireCondition(isRecord(lease.resolvedInputRefs) && dataHash({ taskHash: lease.taskHash, resolvedInputRefs: lease.resolvedInputRefs }) === lease.resolvedInputHash,
      'TASK_INPUT_CHANGED', 'The resolved input references differ from their frozen attempt hash.');
    const checker = ['quality.check', 'quality.final'].includes(task.kind);
    validateResolvedData(lease, this.clock());
    requireCondition(this.localGrant.roles.includes(checker ? 'checker' : 'worker'), 'WORKER_SCOPE_DENIED', 'This local worker has no authority for this task role.');
    return checker;
  }
  async #heartbeat(lease, binding) {
    const previous = this.heartbeatQueues.get(lease.attemptId) ?? Promise.resolve();
    const request = previous.catch(() => {}).then(async () => {
      const current = this.liveLeases.get(lease.attemptId) ?? lease;
      const checker = this.#assertLease(current, binding);
      const refreshed = await this.transport.heartbeatTask(taskId(current), identity(current), this.#ctx(`heartbeat:${current.attemptId}:${randomUUID()}`, checker));
      for (const key of IDENTITY_KEYS) requireCondition(refreshed[key] === current[key], 'STALE_LEASE', 'The cloud returned a different task attempt identity.');
      const next = { ...current, ...refreshed, task: current.task };
      // Never install an unvalidated replacement lease into the live cache.
      const old = this.liveLeases.get(current.attemptId); this.liveLeases.delete(current.attemptId);
      try { this.#assertLease(next, binding); this.liveLeases.set(current.attemptId, next); }
      catch (error) { if (old) this.liveLeases.set(current.attemptId, old); throw error; }
      return next;
    });
    this.heartbeatQueues.set(lease.attemptId, request);
    try { return await request; }
    finally { if (this.heartbeatQueues.get(lease.attemptId) === request) this.heartbeatQueues.delete(lease.attemptId); }
  }
  async #readInputs(lease) {
    const sources = [];
    const refs = [...(lease.resolvedInputRefs.fileRefs ?? []), ...(lease.resolvedInputRefs.dependencyRefs ?? []).flatMap(row => row.artifactRefs ?? []),
      ...(lease.resolvedInputData?.package?.artifactRefs ?? [])];
    const seen = new Set();
    for (const ref of refs) {
      record(ref, 'Resolved source'); sha256(ref.sha256 ?? ref.hash);
      const key = `${ref.id ?? ref.artifactId ?? ref.assetId ?? ref.localSourceId}:${ref.sha256 ?? ref.hash}`;
      if (seen.has(key)) continue; seen.add(key);
      if (ref.localSourceId || ref.kind === 'local') {
        requireCondition(this.sourceRegistry, 'LOCAL_SOURCE_MISSING', 'This worker has no owner-approved local source registry.');
        sources.push(this.sourceRegistry.read({ id: ref.localSourceId ?? ref.id, sha256: ref.sha256 ?? ref.hash, bytes: ref.bytes ?? ref.size }));
      } else if (ref.artifactId || ref.assetId || /^ART-/.test(ref.id ?? '') || /^MED-/.test(ref.id ?? '') || ref.kind === 'artifact' || ref.kind === 'media') {
        requireCondition(typeof this.transport.readSource === 'function', 'CLOUD_SOURCE_UNAVAILABLE', 'The exact source byte endpoint is unavailable.');
        const source = await this.transport.readSource(ref, this.#ctx(`source:${lease.attemptId}:${dataHash(ref)}`));
        requireCondition(bytesHash(source.bytes) === (ref.sha256 ?? ref.hash), 'ARTIFACT_HASH_MISMATCH', 'The current source bytes differ from the frozen reference.');
        sources.push({ ...source, role: ref.role ?? source.role, ...(ref.outputKey ? { outputKey: ref.outputKey } : {}) });
      }
    }
    return sources;
  }
  async #runCall(lease, binding, callKey, operation) {
    lease = this.liveLeases.get(lease.attemptId) ?? lease;
    if (this.adapters.assertCurrentSources) await this.adapters.assertCurrentSources();
    identifier(callKey, 'Bottom request key');
    let journal = this.store.getAttempt(lease.attemptId);
    requireCondition(!(journal.calls ?? []).some(call => call.callKey === callKey), 'DISPATCH_REPLAY_BLOCKED', 'This bottom request already has a durable dispatch record.');
    requireCondition((journal.calls?.length ?? 0) < this.localGrant.limits.maxCalls, 'WORKER_RESOURCE_LIMIT', 'The local request-count limit has been reached.');
    record(operation.upperBound, 'Bottom request limits', ['inputTokens', 'outputTokens', 'renderSeconds', 'tempBytes', 'nativeProcesses']);
    for (const dimension of ['inputTokens', 'outputTokens', 'renderSeconds', 'tempBytes', 'nativeProcesses']) integer(operation.upperBound[dimension], dimension);
    requireCondition(operation.upperBound.tempBytes <= this.localGrant.limits.maxTempBytes
      && operation.upperBound.renderSeconds <= this.localGrant.limits.maxRenderSeconds
      && operation.upperBound.nativeProcesses <= this.localGrant.limits.maxNativeProcesses,
    'WORKER_RESOURCE_LIMIT', 'The request exceeds the locally approved resource limits.');
    requireCondition(this.store.temporaryBytes() <= this.localGrant.limits.maxTempBytes,
      'WORKSPACE_QUOTA_EXCEEDED', 'Existing private worker data already exceeds the local temporary-space authorization.');
    sha256(operation.requestHash); const requestHash = dataHash({ taskHash: lease.taskHash, resolvedInputHash: lease.resolvedInputHash,
      adapterBinding: binding, callKey, requestHash: operation.requestHash, upperBound: operation.upperBound });
    lease = await this.#heartbeat(lease, binding);
    const dispatch = { ...identity(lease), callKey, requestHash, provider: operation.provider, model: operation.model,
      pricingSnapshotHash: operation.pricingSnapshotHash, upperBound: operation.upperBound };
    const call = { callKey, requestHash, state: 'dispatch_requested', upperBound: operation.upperBound, requestedAt: timestamp(this.clock) };
    this.store.updateAttempt(lease.attemptId, { status: 'dispatch_requested', calls: [...(journal.calls ?? []), call] });
    const checker = ['quality.check', 'quality.final'].includes(lease.task.kind);
    let permit;
    try { permit = await this.transport.dispatchTask(taskId(lease), dispatch, this.#ctx(`dispatch:${lease.attemptId}:${callKey}`, checker)); }
    catch (error) { error.unknown = true; throw error; }
    requireCondition(permit?.dispatchRecorded === true && permit.attemptId === lease.attemptId && permit.epoch === lease.epoch
      && permit.requestHash === requestHash && permit.scopeHash === lease.scopeHash,
    'DISPATCH_PERMIT_INVALID', 'The budget dispatch permit does not match this exact bottom request.');
    requireCondition(permit.execute === true, 'DISPATCH_REPLAY_BLOCKED', 'The server returned a prior dispatch; the provider must not be called again.');
    identifier(permit.reservationId); identifier(permit.dispatchPermitId);
    requireCondition(instant(permit.expiresAt) > this.clock(), 'DISPATCH_PERMIT_EXPIRED', 'The dispatch permit expired before execution.');
    const updateCall = update => {
      const current = this.store.getAttempt(lease.attemptId);
      this.store.updateAttempt(lease.attemptId, { calls: current.calls.map(row => row.callKey === callKey ? { ...row, ...update } : row) });
    };
    updateCall({ state: 'permit_received', reservationId: permit.reservationId, dispatchPermitId: permit.dispatchPermitId });
    if (this.adapters.assertCurrentSources) await this.adapters.assertCurrentSources();
    this.#assertLease(lease, binding);
    updateCall({ state: 'provider_inflight', dispatchedAt: timestamp(this.clock) });
    let result, heartbeatError = null, heartbeatPending = null;
    const controller = new AbortController();
    const executionSignal = this.signal ? AbortSignal.any([this.signal, controller.signal]) : controller.signal;
    const renewal = setInterval(() => {
      if (heartbeatPending || heartbeatError) return;
      heartbeatPending = this.#heartbeat(lease, binding).catch(error => { heartbeatError = error; controller.abort(error); })
        .finally(() => { heartbeatPending = null; });
    }, this.heartbeatIntervalMs); renewal.unref();
    try { result = await operation.execute({ signal: executionSignal, permit }); }
    catch (error) {
      clearInterval(renewal); if (heartbeatPending) await heartbeatPending;
      const known = error.metering && error.usageReceipt;
      try {
        if (known) await this.transport.settleCall(permit.reservationId, { attemptId: lease.attemptId,
          providerRequestId: error.providerRequestId ?? null, usage: error.metering, usageReceipt: error.usageReceipt }, this.#ctx(`settle:${lease.attemptId}:${callKey}`, checker));
        else await this.transport.unknownCall(permit.reservationId, { attemptId: lease.attemptId,
          reason: 'execution_result_unverified', providerRequestId: error.providerRequestId ?? null }, this.#ctx(`unknown:${lease.attemptId}:${callKey}`, checker));
      } catch (settleError) { updateCall({ state: 'usage_sync_pending', error: safeError(settleError) }); error.unknown = true; throw error; }
      updateCall({ state: known ? 'failed_known' : 'unknown', error: safeError(error) });
      if (!known) error.unknown = true;
      throw error;
    }
    clearInterval(renewal); if (heartbeatPending) await heartbeatPending;
    requireCondition(result?.executed === true && result.dryRun === false, 'EXECUTION_NOT_VERIFIED', 'The adapter did not execute a real non-dry-run operation.');
    const actualBytes = result.bytes ?? result.stdout;
    const localResult = actualBytes?.length ? this.store.writeArtifact(lease.attemptId, `call-${callKey}`, actualBytes,
      result.mime ?? 'application/octet-stream') : null;
    updateCall({ state: 'provider_received', evidence: result.evidence ?? {}, providerRequestId: result.providerRequestId ?? null,
      ...(localResult ? { actualResult: localResult } : {}) });
    try {
      if (result.usage && result.usageUnknown !== true) await this.transport.settleCall(permit.reservationId,
        { attemptId: lease.attemptId, providerRequestId: result.providerRequestId ?? null, usage: result.usage,
          usageReceipt: result.usageReceipt }, this.#ctx(`settle:${lease.attemptId}:${callKey}`, checker));
      else await this.transport.unknownCall(permit.reservationId, { attemptId: lease.attemptId,
        reason: 'provider_usage_unverified', providerRequestId: result.providerRequestId ?? null }, this.#ctx(`unknown:${lease.attemptId}:${callKey}`, checker));
    } catch (error) { updateCall({ state: 'usage_sync_pending', error: safeError(error) }); error.unknown = true; throw error; }
    updateCall({ state: result.usageUnknown === true ? 'unknown_usage' : 'settled', usageReceipt: result.usageReceipt ?? null });
    // Costs can remain unknown while genuine output is retained; cancellation still fences activation.
    if (result.usageUnknown === true) fail('USAGE_RECONCILIATION_REQUIRED',
      'The actual output is retained privately, but unverified provider usage blocks further task execution.', { unknown: true });
    if (heartbeatError) throw heartbeatError;
    await this.#heartbeat(lease, binding);
    return result;
  }
  async #uploadAndComplete(lease, binding) {
    let journal = this.store.getAttempt(lease.attemptId);
    const complete = async (manifest, receipts) => {
      const completed = await this.transport.completeTask(taskId(lease), { ...identity(lease), resultManifest: manifest,
        executionReceipts: receipts }, this.#ctx(`complete:${lease.attemptId}`, ['quality.check', 'quality.final'].includes(lease.task.kind)));
      requireCondition(['succeeded', 'completed'].includes(completed?.status)
        && (completed.attemptId === undefined || completed.attemptId === lease.attemptId)
        && (completed.taskId === undefined || completed.taskId === taskId(lease)),
      'TASK_RESULT_QUARANTINED', 'The server did not activate the actual result for this live task attempt.');
      this.store.updateAttempt(lease.attemptId, { status: 'completed', completedAt: timestamp(this.clock), result: completed, syncPending: false });
      return { status: 'completed', taskId: taskId(lease), attemptId: lease.attemptId, artifacts: manifest.artifacts, result: completed };
    };
    // A lost completion response is recovered using the exact original body/key,
    // even after the successful server write made the old lease terminal.
    if (journal.status === 'complete_requested') return await complete(journal.resultManifest, journal.executionReceipts);
    lease = await this.#heartbeat(lease, binding);
    const uploaded = [...(journal.uploaded ?? [])];
    for (const artifact of journal.artifacts) {
      if (uploaded.some(row => row.outputKey === artifact.outputKey && row.sha256 === artifact.sha256)) continue;
      this.#assertLease(lease, binding); const bytes = this.store.readArtifact(artifact);
      const result = await this.transport.registerArtifact(taskId(lease), { ...identity(lease), outputKey: artifact.outputKey,
        role: artifact.role, mime: artifact.mime, size: bytes.length, sha256: artifact.sha256, name: artifact.name ?? `${artifact.outputKey}` },
      bytes, this.#ctx(`upload:${lease.attemptId}:${artifact.outputKey}:${artifact.sha256}`));
      requireCondition(result?.sha256 === artifact.sha256 && (result.outputKey === undefined || result.outputKey === artifact.outputKey)
        && result.status !== 'quarantined' && result.commitStatus !== 'quarantined' && result.committed !== false,
      'ARTIFACT_COMMIT_REJECTED', 'The output is not a committed artifact of this live task attempt.');
      const artifactId = result.artifactId ?? result.id; identifier(artifactId);
      uploaded.push({ artifactId, sha256: artifact.sha256, outputKey: artifact.outputKey });
      this.store.updateAttempt(lease.attemptId, { status: 'uploading', uploaded });
    }
    lease = await this.#heartbeat(lease, binding); journal = this.store.getAttempt(lease.attemptId);
    const resultManifest = { schema: 'pengmanager.task-result/v1', executed: true, dryRun: false,
      data: journal.resultData, artifacts: uploaded, outputHash: dataHash({ data: journal.resultData, artifacts: uploaded }) };
    this.store.updateAttempt(lease.attemptId, { status: 'complete_requested', resultManifest });
    return await complete(resultManifest, journal.executionReceipts);
  }
  async #recordFailure(lease, error) {
    const safe = safeError(error); const current = this.store.getAttempt(lease.attemptId);
    if (['outputs_ready', 'uploading', 'complete_requested'].includes(current.status)
      && safe.unknown && safe.retryable) {
      // Retrying immutable byte transport/receipt readback cannot repeat a model
      // or a render. Keep the original keys/manifests for the next invocation.
      this.store.updateAttempt(lease.attemptId, { syncPending: true, syncError: safe });
      return { status: 'needs_sync', taskId: taskId(lease), attemptId: lease.attemptId, error: safe };
    }
    const status = safe.unknown || (current.calls ?? []).some(call => ['dispatch_requested', 'permit_received', 'provider_inflight', 'usage_sync_pending'].includes(call.state))
      ? 'needs_reconcile' : 'failed_known';
    this.store.updateAttempt(lease.attemptId, { status, error: safe });
    try { await this.transport.failTask(taskId(lease), { ...identity(lease), code: safe.code, reason: safe.message,
      unknown: status === 'needs_reconcile' }, this.#ctx(`fail:${lease.attemptId}:${safe.code}`)); }
    catch (cloudError) { this.store.updateAttempt(lease.attemptId, { failureSyncPending: true, syncError: safeError(cloudError) }); }
    return { status, taskId: taskId(lease), attemptId: lease.attemptId, error: safe };
  }
  async runOnce() {
    requireCondition(!this.busy, 'WORKER_BUSY', 'This worker is already processing one task.'); this.busy = true;
    try {
      validateLocalGrant(this.localGrant, this); throwIfAborted(this.signal);
      const pending = this.store.listAttempts().find(row => !TERMINAL.has(row.status));
      if (pending) {
        const lease = pending.lease;
        try {
          const adapter = this.adapters.get(lease.task.kind);
          if (pending.status !== 'complete_requested') this.#assertLease(lease, adapter?.binding);
          if (['outputs_ready', 'uploading', 'complete_requested'].includes(pending.status)) return await this.#uploadAndComplete(lease, adapter.binding);
          fail('WORKER_RECOVERY_REQUIRES_RECONCILE', 'A previous attempt was interrupted after claiming or dispatch; it will not be executed again.', { unknown: true });
        } catch (error) { return await this.#recordFailure(lease, error); }
      }
      const readiness = await this.adapters.readiness();
      const allowed = readiness.filter(row => row.ready && this.localGrant.adapterBindings.some(binding => binding.adapterId === row.adapterId
        && binding.version === row.version && binding.entrypointSha === row.entrypointSha));
      if (!allowed.length) return { status: 'not_ready', adapters: readiness.map(({ adapterId, ready, reason }) => ({ adapterId, ready, reason })) };
      const lease = await this.transport.claimTask({ workerId: this.workerId, adapterReadinessRefs: allowed, maxTasks: 1 }, this.#ctx(`claim:${randomUUID()}`));
      if (!lease) return { status: 'idle' };
      const adapter = this.adapters.get(lease.task.kind);
      this.#assertLease(lease, adapter?.binding);
      requireCondition(adapter && (await adapter.readiness()).ready, 'ADAPTER_NOT_READY', 'The fixed task adapter is not currently ready.');
      requireCondition(!this.store.getAttempt(lease.attemptId), 'ATTEMPT_REPLAY_BLOCKED', 'The server returned an attempt already known to this worker.');
      this.store.updateAttempt(lease.attemptId, { taskId: taskId(lease), epoch: lease.epoch, taskHash: lease.taskHash,
        resolvedInputHash: lease.resolvedInputHash, status: 'claimed', lease, calls: [], artifacts: [], uploaded: [] });
      try {
        const inputs = await this.#readInputs(lease);
        const result = await adapter.execute({ lease, input: structuredClone(lease.resolvedInputData), inputs,
          signal: this.signal, runCall: (callKey, operation) => this.#runCall(lease, adapter.binding, callKey, operation) });
        requireCondition(Array.isArray(result.outputs) && result.outputs.length <= 100,
          'ARTIFACT_OUTPUT_MISSING', 'The adapter returned no complete bounded output set.');
        const specs = lease.task.outputSpec;
        requireCondition(Array.isArray(specs), 'TASK_OUTPUT_INVALID', 'The compiled task output specification is missing.');
        const seen = new Set(); const artifacts = result.outputs.map(output => {
          identifier(output.outputKey); requireCondition(!seen.has(output.outputKey), 'ARTIFACT_OUTPUT_INVALID', 'The adapter repeated an output key.'); seen.add(output.outputKey);
          const spec = specs.find(item => item.outputKey === output.outputKey);
          requireCondition(spec && (spec.mime === output.mime || spec.mimes?.includes(output.mime) || spec.allowedMimes?.includes(output.mime)) && spec.role === output.role
            && output.bytes.length <= (spec.maxBytes ?? spec.sizeLimit ?? this.localGrant.limits.maxTempBytes),
          'ARTIFACT_OUTPUT_SCOPE_DENIED', 'The output bytes, role or MIME exceed the exact compiled specification.');
          return { ...this.store.writeArtifact(lease.attemptId, output.outputKey, output.bytes, output.mime), role: output.role,
            ...(output.name ? { name: output.name } : {}) };
        });
        requireCondition(specs.every(spec => spec.required === false || seen.has(spec.outputKey)),
          'ARTIFACT_OUTPUT_MISSING', 'A required native output is missing; the task cannot complete.');
        jsonValue(result.data); jsonValue(result.executionReceipts ?? []);
        this.store.updateAttempt(lease.attemptId, { status: 'outputs_ready', artifacts, resultData: result.data,
          executionReceipts: result.executionReceipts ?? [] });
        return await this.#uploadAndComplete(lease, adapter.binding);
      } catch (error) { return await this.#recordFailure(lease, error); }
    } finally { this.busy = false; }
  }
  status() { return { schema: WORKER_PROTOCOL, workerId: this.workerId,
    attempts: this.store.listAttempts().map(({ attemptId, taskId: id, status, error }) => ({ attemptId, taskId: id, status, ...(error ? { error } : {}) })) }; }
}
