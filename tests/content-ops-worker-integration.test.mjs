import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { randomBytes, randomUUID } from 'node:crypto';
import { contentOpsFixture, createOpsJob, opsContext, OPS_EXPIRY, uploadOpsSource, FIXTURE_PRICING } from './content-ops-fixtures.mjs';
import { ContentOpsWorker, localGrantHash } from '../src/content-ops-worker/worker.mjs';
import { WorkerLocalStore } from '../src/content-ops-worker/local-store.mjs';
import { createContentOpsAdapters } from '../src/content-ops-worker/adapters.mjs';
import { SingleRequestModel } from '../src/content-ops-worker/model.mjs';
import { bytesHash, dataHash } from '../src/content-ops-worker/protocol.mjs';
import { validateCandidateForReview } from '../src/domain/content-ops-quality.mjs';
import { qualityTextKeys } from '../src/domain/content-ops-coverage.mjs';
import { MediaAssets } from '../src/services/media-assets.mjs';
import { inspectPngBytes } from '../src/content-ops-worker/renderers.mjs';
import { PNG } from './fixtures/synthetic-media.mjs';

// Real seed, admin Claim.state approval, backups, migrations, pairing, leases,
// reservations, source files and final reports. Supplier text/usage below is an
// explicit in-process fixture, never a paid call or publication receipt.
function supplierOutput(input, prompt) {
  if (prompt.startsWith('Plan platform-specific')) return { decision: 'prepare', rationale: 'The complete isolated source can be prepared.',
    outline: input.workerPolicy.outlineFromAuthorOnly ? input.target.structure.map(row => row.purpose) : ['Exact source', 'Limitations'], requiredInputs: [], skipReason: null };
  if (/^Act as (?:an independent|the final independent) checker/.test(prompt)) return { checkedPackageHash: input.packageHash, findings: [],
    coverage: { deterministic: 'checked', semantic: 'checked', media: 'not_applicable', artistic: 'checked' }, assessment: 'The complete isolated package and attached text were read by a fixture checker, with no live supplier request.' };
  const source = input.sourceEditions[0];
  return { title: source.title, summary: source.summary, body: source.body, blocks: source.blocks, claimMappings: [],
    disclosure: { aiUse: input.workerPolicy.authorEditingOnly ? 'copyedit' : 'generated_text' },
    ...(input.transformSpec ? { locale: input.transformSpec.targetLocale, format: input.transformSpec.targetFormat, sourceRefs: input.plan.motherEditionRefs } : {}) };
}
async function actualWorker(t, f, job, { checker = false, onProvider, tamperLease = false } = {}) {
  const workerId = `actual-${checker ? 'checker' : 'writer'}-${randomBytes(4).toString('hex')}`;
  const pairing = await f.ops.createPairing({ workerId, origin: 'https://pengmanager.com', workspaceId: 'isolated-fixture',
    projectIds: ['isolated-fixture'], jobIds: [job.id], targetKeys: [], adapterIds: f.bindings.map(binding => binding.adapterId),
    expiresAt: OPS_EXPIRY, maxTempBytes: 200_000_000, maxRenderSeconds: 10_000, maxNativeProcesses: 2, checker }, opsContext());
  const grant = { schema: 'pengmanager.worker-local-grant/v1', workerId, origin: 'https://pengmanager.com', workspaceId: 'isolated-fixture',
    projectIds: ['isolated-fixture'], jobIds: [job.id], targetKeys: job.targets.map(row => row.targetKey), adapterBindings: f.bindings,
    scopeHash: pairing.scopeHash, budgetAuthorizationHash: f.budget.authorizationHash, expiresAt: OPS_EXPIRY, ownerConfirmed: true,
    roles: [checker ? 'checker' : 'worker'], limits: { maxTempBytes: 200_000_000, maxRenderSeconds: 10_000, maxNativeProcesses: 2, maxCalls: 100 } };
  grant.localGrantHash = localGrantHash(grant);
  const credential = randomBytes(32).toString('base64url');
  const confirmed = await f.ops.confirmPairing({ challengeId: pairing.challengeId, challenge: pairing.challenge, scopeHash: pairing.scopeHash,
    localGrantHash: grant.localGrantHash, credentialHash: bytesHash(Buffer.from(credential)) }, { method: 'pairing', actor: 'isolated actual local owner', idempotencyKey: randomUUID() });
  grant.grantId = confirmed.grantId;
  const ctx = input => ({ ...f.ops.authenticateWorker(credential), idempotencyKey: input.idempotencyKey, ifMatch: input.ifMatch });
  const transport = {
    async claimTask(input, context) { const lease = await f.ops.claimTask(input, ctx(context)); if (lease && tamperLease) lease.resolvedInputData.sourceEditions[0].body += '\nUnapproved tamper.'; return lease; },
    heartbeatTask: (id, input, context) => f.ops.heartbeatTask(id, input, ctx(context)),
    dispatchTask: (id, input, context) => f.ops.dispatchTask(id, input, ctx(context)),
    settleCall: (id, input, context) => f.ops.settleCall(id, input, ctx(context)),
    unknownCall: (id, input, context) => f.ops.unknownCall(id, input, ctx(context)),
    completeTask: (id, input, context) => f.ops.completeTask(id, input, ctx(context)),
    failTask: (id, input, context) => f.ops.failTask(id, input, ctx(context)),
    registerArtifact: (id, input, bytes, context) => f.ops.uploadArtifact(id, Readable.from([bytes]), input, ctx(context)),
    async readSource(ref, context) {
      const id = ref.artifactId ?? ref.id; await f.ops.authorizeWorkerArtifact(id, ctx(context));
      const opened = await f.artifacts.openVerifiedArtifact(id); try { const bytes = await opened.handle.readFile();
        return { id, bytes, sha256: bytesHash(bytes), mime: opened.artifact.mime, sourceProof: { id, sha256: bytesHash(bytes), bytes: bytes.length, sourceUntouched: true } };
      } finally { await opened.handle.close(); }
    },
  };
  const calls = [];
  const model = new SingleRequestModel({ endpoint: 'https://isolated-fixture.invalid/chat', apiKey: 'nonsecret-isolated-fixture-key',
    provider: FIXTURE_PRICING.provider, model: FIXTURE_PRICING.model, contextTokenLimit: 131_072,
    contextProof: { kind: 'provider_documented_context', sourceUrl: FIXTURE_PRICING.sourceUrl, sha256: dataHash({ fixtureOnly: true }), verifiedAt: f.clock().toISOString() },
    pricingSnapshotHash: f.budget.pricingSnapshotHash, currency: 'USD', maxOutputTokens: 200, allowUnregisteredModel: true,
    async fetchImpl(url, init) {
      const request = JSON.parse(init.body), input = JSON.parse(request.messages[1].content); calls.push(input);
      if (onProvider) await onProvider(input);
      return new Response(JSON.stringify({ id: `isolated-${workerId}-${calls.length}`, model: FIXTURE_PRICING.model,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(supplierOutput(input, request.messages[0].content)) } }],
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }));
    } });
  const store = new WorkerLocalStore({ dataDir: path.join(f.directory, workerId), rootDir: path.resolve(import.meta.dirname, '..'), clock: () => f.clock().getTime() }).acquire();
  t.after(() => { if (fs.existsSync(store.root)) store.close(); });
  const adapters = await createContentOpsAdapters({ model, clock: () => f.clock().getTime(), rendererOptions: { workRoot: store.root }, mediaOptions: { workRoot: store.root } });
  const worker = new ContentOpsWorker({ store, adapters, transport, localGrant: grant, origin: grant.origin, workerId, clock: () => f.clock().getTime() });
  return { worker, calls, store };
}

test('actual worker and backend process a real source-backed text DAG with independent identities and reserved unknown costs', async t => {
  const f = await contentOpsFixture(t), sourceBytes = Buffer.from('# Actual isolated source\n\nThis complete source is included in the final independent checker input.\n');
  const source = await uploadOpsSource(f, { role: 'transcript', mime: 'text/markdown', bytes: sourceBytes });
  const { job } = await createOpsJob(f, { sourceArtifactIds: [source.id] }), initial = f.ops.getJob(job.id, opsContext());
  const beforeContent = structuredClone(f.store.snapshot().content), writer = await actualWorker(t, f, job), checker = await actualWorker(t, f, job, { checker: true });
  const runs = [];
  for (let index = 0; index < 12; index++) {
    const first = await writer.worker.runOnce(), second = await checker.worker.runOnce(); runs.push(first, second);
    if (first.status === 'idle' && second.status === 'idle') break;
  }
  assert.ok(runs.every(row => ['completed', 'idle'].includes(row.status)), JSON.stringify(runs));
  const finished = f.ops.getJob(job.id, opsContext());
  assert.equal(finished.status, 'ready_for_review'); assert.equal(finished.candidates.length, 1);
  assert.equal(writer.calls.length, 3); assert.equal(checker.calls.length, 2);
  assert.match(checker.calls.at(-1).attachmentTexts[0].text, /complete source is included/);
  const reviewed = validateCandidateForReview(f.store.snapshot(), finished.candidates[0].id, { now: f.clock() });
  assert.equal(reviewed.reports[0].status, 'passed'); assert.notEqual(reviewed.reports[0].execution.subject, `worker:${writer.worker.workerId}`);
  assert.equal(finished.reservations.length, 5); assert.ok(finished.reservations.every(row => row.status === 'partially_settled' && row.actual.costMicros === null));
  assert.equal(finished.budgetTotals.unknown.count, 5); assert.deepEqual(f.store.snapshot().content, beforeContent);
  assert.equal(finished.blueprintHash, initial.blueprintHash);
  assert.deepEqual(finished.tasks.map(row => [row.taskId, row.taskHash]), initial.tasks.map(row => [row.taskId, row.taskHash]));
  const currentSource = await f.artifacts.openVerifiedArtifact(source.id);
  try { assert.equal(bytesHash(await currentSource.handle.readFile()), source.sha256); }
  finally { await currentSource.handle.close(); }
});

test('actual job cancellation during a provider request retains actual usage and fences every downstream action', async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f); let cancelled = false;
  const writer = await actualWorker(t, f, job, { async onProvider() {
    if (cancelled) return; cancelled = true; const current = f.ops.getJob(job.id, opsContext());
    await f.ops.cancelJob(job.id, { reason: 'Cancel this isolated in-flight preparation without repeating its supplier request.' }, opsContext(current));
  } });
  const result = await writer.worker.runOnce(); assert.notEqual(result.status, 'completed');
  const current = f.ops.getJob(job.id, opsContext()); assert.equal(current.status, 'cancelled'); assert.equal(current.candidates.length, 0);
  assert.equal(writer.calls.length, 1); assert.equal(current.reservations.length, 1); assert.equal(current.reservations[0].actual.costMicros, null);
  assert.ok(writer.store.listAttempts()[0].calls[0].actualResult);
  assert.equal((await writer.worker.runOnce()).status, 'idle'); assert.equal(writer.calls.length, 1);
});

test('a forged complete source body with an unchanged reference hash is rejected before a real budget reservation', async t => {
  const f = await contentOpsFixture(t), { job } = await createOpsJob(f), writer = await actualWorker(t, f, job, { tamperLease: true });
  await assert.rejects(writer.worker.runOnce(), { code: 'TASK_INPUT_CHANGED' });
  assert.equal(writer.calls.length, 0); assert.equal(f.ops.getJob(job.id, opsContext()).reservations.length, 0);
});

test('actual image worker output needs separate artifact/media reviews and genuine final coverage before draft materialization', async t => {
  const f = await contentOpsFixture(t), mediaAssets = new MediaAssets({ store: f.store }); await mediaAssets.initialize();
  f.service.mediaAssets = mediaAssets; f.service.productionArtifacts = f.artifacts;
  const source = await uploadOpsSource(f, { role: 'source_image', mime: 'image/png', bytes: PNG });
  const { job } = await createOpsJob(f, { sourceArtifactIds: [source.id], targets: [{ destinationId: 'official-site', locale: 'zh-CN', nativeForm: 'image_text' }] });
  const writer = await actualWorker(t, f, job), checker = await actualWorker(t, f, job, { checker: true });
  // Other CI hosts explicitly lack the verified native pin; this test cannot
  // relabel a fixture PNG or an unexecuted renderer as a real image generation.
  const imageReady = (await createContentOpsAdapters({ rendererOptions: { workRoot: writer.store.root } })).get('image.compose');
  if (!(await imageReady.readiness()).ready) { t.skip('This host does not have the verified local image-rendering runtime.'); return; }
  let generated = null;
  for (let round = 0; round < 20; round++) {
    const first = await writer.worker.runOnce(), second = await checker.worker.runOnce();
    assert.ok(['completed', 'idle'].includes(first.status), JSON.stringify(first)); assert.ok(['completed', 'idle'].includes(second.status), JSON.stringify(second));
    generated = f.store.snapshot().productionArtifacts.find(row => row.jobId === job.id && row.origin === 'worker_upload' && row.mime === 'image/png');
    if (generated) break;
  }
  assert.ok(generated, 'a genuine image.compose artifact must have been uploaded');
  assert.equal(generated.status, 'committed'); assert.equal(f.ops.getJob(job.id, opsContext()).candidates.length, 0);
  const original = await f.artifacts.openVerifiedArtifact(source.id), image = await f.artifacts.openVerifiedArtifact(generated.id);
  let imageBytes;
  try { assert.deepEqual(await original.handle.readFile(), PNG); imageBytes = await image.handle.readFile(); }
  finally { await original.handle.close(); await image.handle.close(); }
  assert.equal(bytesHash(imageBytes), generated.sha256); const inspected = inspectPngBytes(imageBytes);
  assert.equal(inspected.width, 1080); assert.equal(inspected.height, 1440); assert.notEqual(generated.sha256, source.sha256);
  let artifact = await f.artifacts.review(generated.id, { sha256: generated.sha256, rightsConfirmed: true, privacyConfirmed: true, licenseConfirmed: true,
    note: 'Actual isolated local render over the authorized synthetic screenshot; administrator review is a test fixture.' }, opsContext(f.artifacts.getArtifact(generated.id)));
  assert.equal((await checker.worker.runOnce()).status, 'idle'); assert.equal(f.ops.getJob(job.id, opsContext()).candidates.length, 0);
  const imported = await f.artifacts.importMedia(artifact.id, { sha256: artifact.sha256 }, opsContext(artifact), mediaAssets);
  assert.equal(imported.status, 'staged'); assert.equal((await checker.worker.runOnce()).status, 'idle');
  assert.equal(f.ops.getJob(job.id, opsContext()).candidates.length, 0);
  await mediaAssets.review(imported.id, { sha256: artifact.sha256, rightsConfirmed: true, privacyConfirmed: true,
    rightsNote: 'Independent isolated media-domain review of the same actual local rendered bytes.' }, opsContext(mediaAssets.getAsset(imported.id)));
  const final = await checker.worker.runOnce(); assert.equal(final.status, 'completed', JSON.stringify(final));
  let current = f.ops.getJob(job.id, opsContext()); assert.equal(current.candidates.length, 1); let candidate = f.ops.getCandidate(current.candidates[0].id, opsContext());
  assert.equal(candidate.status, 'needs_input'); assert.equal(candidate.reports.at(-1).dimensions.media, 'unverified');
  assert.equal(candidate.package.orderedMediaRefs.filter(ref => ref.role === 'cover').length, 1);
  assert.equal(candidate.package.orderedMediaRefs.filter(ref => ref.role === 'image').length, 1);
  assert.ok(candidate.package.orderedMediaRefs.every(ref => ref.assetId === imported.id && ref.sha256 === artifact.sha256));
  await assert.rejects(f.service.materializeCandidate(candidate.id, { packageHash: candidate.packageHash,
    qualityReportHashes: candidate.qualityReportHashes ?? [], reviewSnapshotHash: candidate.reviewSnapshotHash }, opsContext(candidate)));
  const evidence = [];
  for (const ref of candidate.package.artifactRefs) {
    const opened = await f.artifacts.openVerifiedArtifact(ref.id); try { const bytes = await opened.handle.readFile();
      assert.equal(bytesHash(bytes), ref.sha256); if (ref.mime === 'image/png') inspectPngBytes(bytes);
    } finally { await opened.handle.close(); }
    evidence.push({ artifactId: ref.id, sha256: ref.sha256, method: 'deterministic_static_inspection', coverage: 'full',
      note: 'Complete real PNG bytes decoded. Semantic and artistic signoff here is an isolated administrator-attestation fixture, not a production human review.' });
  }
  await f.ops.submitQualityReport(candidate.id, { checkedPackageHash: candidate.packageHash, checkContextHash: candidate.checkContextHash, reviewed: true,
    coverage: { textKeys: qualityTextKeys(candidate.package), artifactHashes: candidate.package.artifactRefs.map(ref => ref.sha256), semantic: 'checked', artistic: 'checked' },
    mediaEvidence: evidence, assessment: 'Independent final-review fixture after all actual isolated text and native files were available; no platform publication or real customer approval is asserted.' },
  opsContext(candidate, 'independent final-review fixture'));
  candidate = f.ops.getCandidate(candidate.id, opsContext()); assert.equal(candidate.status, 'ready_for_review');
  const variant = await f.service.materializeCandidate(candidate.id, { packageHash: candidate.packageHash,
    qualityReportHashes: candidate.qualityReportHashes, reviewSnapshotHash: candidate.reviewSnapshotHash }, opsContext(candidate));
  assert.equal(variant.status, 'draft'); assert.equal(variant.format, 'image_text'); assert.equal(variant.assetRefs.length, 2);
  assert.equal(f.store.snapshot().publications.length, 0); assert.equal(f.store.snapshot().websiteRoutes.length, 0);
});
