import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SingleRequestModel, MODEL_TASK_KINDS } from './model.mjs';
import { createMediaProcessor, mediaSourceClosureFiles } from './media.mjs';
import { createRenderers, inspectPngBytes, sourceClosureFiles as rendererSourceFiles } from './renderers.mjs';
import { qualityTextKeys } from '../domain/content-ops-coverage.mjs';
import { bytesHash, dataHash, decodeJson, fail, identifier, isRecord, jsonValue, record,
  requireCondition, sha256, text, VALIDATOR_VERSION, WORKER_VERSION } from './protocol.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DETERMINISTIC_KINDS = ['image.compose', 'document.render', 'caption.align', 'native.prepare', 'media.inspect', 'quality.technical', 'video.assemble', 'video.reedit'];
const ALL_KINDS = Object.freeze([...MODEL_TASK_KINDS, ...DETERMINISTIC_KINDS, 'voice.speak']);
const CLOSURE = Object.freeze([...new Set(['src/content-ops-worker/adapters.mjs', 'src/content-ops-worker/model.mjs',
  'src/content-ops-worker/worker.mjs', 'src/content-ops-worker/local-store.mjs', 'src/content-ops-worker/transport.mjs',
  'src/content-ops-worker/protocol.mjs', 'scripts/content-ops-worker.mjs', 'src/domain/content-ops-coverage.mjs',
  'src/domain/hash.mjs', 'src/domain/strict-json.mjs', 'src/domain/errors.mjs',
  'src/model-routing/budget.mjs', 'src/model-routing/dispatcher.mjs', 'src/model-routing/errors.mjs',
  'src/model-routing/policy.mjs', 'src/model-routing/registry.mjs', 'src/model-routing/tokenizer.mjs',
  ...mediaSourceClosureFiles, ...rendererSourceFiles])].sort());

export async function contentOpsSourceClosure({ rootDir = ROOT } = {}) {
  const root = fs.realpathSync(rootDir), files = [];
  for (const relativePath of CLOSURE) {
    const file = path.join(root, relativePath), stat = fs.lstatSync(file);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(file).startsWith(root + path.sep),
      'ADAPTER_SOURCE_INVALID', 'A fixed adapter support file is missing or replaced by a link.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(fd); const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
      requireCondition(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs,
        'ADAPTER_SOURCE_CHANGED', 'The adapter source closure changed while it was being frozen.');
      files.push({ path: relativePath, bytes: bytes.length, sha256: bytesHash(bytes) });
    } finally { fs.closeSync(fd); }
  }
  return { schema: 'pengmanager.adapter-source-closure/v1', files, sha256: dataHash(files) };
}
export async function contentOpsAdapterBindings(options = {}) {
  const closure = await contentOpsSourceClosure(options);
  requireCondition(fs.realpathSync(options.rootDir ?? ROOT) === fs.realpathSync(ROOT)
    && closure.sha256 === LOADED_SOURCE_CLOSURE.sha256, 'ADAPTER_SOURCE_CHANGED',
  'The loaded worker code differs from the current source closure; restart from the exact approved checkout.');
  return ALL_KINDS.map(kind => ({ kind, adapterId: kind, version: WORKER_VERSION, entrypointSha: closure.sha256,
    validatorVersion: VALIDATOR_VERSION, fixedTransport: MODEL_TASK_KINDS.includes(kind) ? 'single_model_post'
      : ['image.compose', 'document.render', 'video.assemble', 'video.reedit', 'media.inspect'].includes(kind) ? 'fixed_native_local' : 'deterministic_local',
    nativeCapabilityId: null }));
}

function latestText(input) {
  const result = [...(input.priorResults ?? [])].reverse().find(row => ['text.polish', 'text.revise', 'translation.localize', 'text.adapt', 'format.transform'].includes(row.kind) && row.data?.body);
  const value = result?.data ?? input.sourceEditions?.[0];
  requireCondition(value && typeof value.body === 'string' && value.body.trim(), 'AUTHOR_INPUT_REQUIRED', 'This task has no complete frozen source or prepared text.');
  return value;
}
function nativeOutputText(textResult, target, outputKey, kind) {
  const outputs = target.outputs.filter(row => row.kind === kind), index = outputs.findIndex(row => row.outputKey === outputKey);
  requireCondition(index >= 0, 'TASK_OUTPUT_INVALID', 'The output is outside the declared ordered native set.');
  const content = textResult.nativeContent?.find(row => row.outputKey === outputKey);
  requireCondition(content || outputs.length === 1, 'NATIVE_CONTENT_REQUIRED', 'Each native output needs its own exact prepared text; the adapter cannot repeat the entire body.');
  return { ...(content ?? { title: textResult.title, body: textResult.body, alt: '', caption: '' }), index };
}
const outputFor = (spec, result) => ({ outputKey: spec.outputKey, role: spec.role, mime: result.mime, bytes: result.bytes,
  name: `${spec.outputKey}.${result.mime === 'image/png' ? 'png' : result.mime === 'application/pdf' ? 'pdf'
    : result.mime === 'video/mp4' ? 'mp4' : result.mime === 'text/vtt' ? 'vtt' : result.mime === 'text/markdown' ? 'md'
      : result.mime === 'text/x-diff' ? 'diff' : result.mime === 'application/x-ipynb+json' ? 'ipynb' : 'json'}` });
const zeroUsage = currency => ({ inputTokens: 0, outputTokens: 0, costMicros: 0, currency });
const publicReceipt = (kind, result) => ({ kind, executed: true, dryRun: false, sha256: bytesHash(result.bytes),
  ...(result.evidence ? { evidence: result.evidence } : {}), ...(result.usageReceipt ? { usageReceipt: result.usageReceipt } : {}) });
function budgetCurrency(input, configured) {
  const currency = input.budget?.currency ?? configured;
  requireCondition(typeof currency === 'string' && /^[A-Z]{3}$/.test(currency), 'BUDGET_CONFIG_REQUIRED', 'The exact authorized currency is required for local execution settlement.');
  return currency;
}
function frozenFileInputs(input, inputs) {
  const byHash = new Map(inputs.map(row => [row.sha256 ?? bytesHash(row.bytes), row]));
  return (input.target?.inputFiles ?? []).map(ref => {
    const source = byHash.get(ref.sha256);
    requireCondition(source && bytesHash(source.bytes) === ref.sha256, 'LOCAL_SOURCE_MISSING', 'A required exact file input is unavailable.');
    return { ...source, ...ref, bytes: source.bytes, mime: source.mime };
  });
}
function timedCaptionSource(file, target) {
  requireCondition(['text/vtt', 'application/x-subrip'].includes(file.mime), 'CAPTION_FORMAT_UNSUPPORTED',
    'This fixed caption adapter accepts plain WebVTT or SRT; styled ASS requires a separately verified adapter.');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  let blocks = source.trim().split(/\n\s*\n/u);
  if (file.mime === 'text/vtt') { requireCondition(/^WEBVTT(?:\s[^\n]*)?$/.test(blocks[0]), 'CAPTION_FORMAT_UNSUPPORTED', 'The VTT header is invalid.'); blocks = blocks.slice(1); }
  requireCondition(blocks.length > 0 && blocks.length <= 2000, 'CAPTION_TIMING_REQUIRED', 'The source caption cue count exceeds its limit.');
  const time = value => {
    const match = /^(?:(\d{2,3}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
    requireCondition(match, 'CAPTION_TIMING_REQUIRED', 'A caption timestamp is invalid.');
    return ((Number(match[1] ?? 0) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000 + Number(match[4]);
  };
  const cues = blocks.map(block => {
    const lines = block.split('\n'); if (!lines[0].includes('-->')) {
      requireCondition(/^[A-Za-z0-9_-]{1,100}$/.test(lines.shift()), 'CAPTION_FORMAT_UNSUPPORTED', 'Caption identifiers must be plain bounded text.');
    }
    const timing = /^(\S+) --> (\S+)$/.exec(lines.shift());
    requireCondition(timing && lines.length > 0 && lines.every(line => line.trim())
      && lines.every(line => !/<[^>]*>|-->/.test(line)), 'CAPTION_FORMAT_UNSUPPORTED', 'Styled, active or malformed caption content is not supported.');
    const content = lines.join('\n').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    return { startMs: time(timing[1]), endMs: time(timing[2]), text: content };
  });
  // A target-language label does not turn untranslated original cues into a translation.
  requireCondition(!['translated', 'bilingual'].includes(target.languagePlan?.subtitleMode), 'CAPTION_TRANSLATION_REQUIRED',
    'Translated or bilingual captions need an explicitly translated timed source; this source is original only.');
  return { cues, durationMs: target.settings.durationMs, locale: target.languagePlan?.sourceLocale ?? target.locale };
}
function checkerInput(input, lease) {
  const result = structuredClone(input);
  if (lease.task.kind === 'quality.final') {
    const exact = lease.resolvedInputRefs.packageRef; requireCondition(exact && isRecord(input.package),
      'QUALITY_RECHECK_REQUIRED', 'The final checker requires a complete frozen publication package.');
    sha256(exact.packageHash); sha256(exact.checkContextHash);
    requireCondition(input.package.packageHash === exact.packageHash && dataHash(Object.fromEntries(Object.entries(input.package).filter(([key]) => key !== 'packageHash'))) === exact.packageHash,
      'QUALITY_REPORT_STALE', 'The final publication package no longer matches its exact frozen hash.');
    result.packageHash = exact.packageHash; result.checkContextHash = exact.checkContextHash;
  } else result.packageHash = input.packageHash ?? dataHash(latestText(input));
  return result;
}
function modelPolicyInput(kind, input) {
  const profile = input.profile?.policy, rule = input.rules?.policy, budget = input.budget;
  const explicit = input.effectivePolicy;
  requireCondition(explicit || profile && rule, 'PLATFORM_POLICY_BLOCKED', 'The task needs the current explicit platform and destination policy intersection.');
  const actions = explicit?.allowedAiActions ?? profile.allowedAiActions.filter(action => rule.allowedAiActions.includes(action)
    && (!budget?.allowedAiActions || budget.allowedAiActions.includes(action)));
  const requested = input.target?.requestedCreationMode;
  requireCondition(!['human_only', 'ineligible'].includes(requested) && actions.length > 0,
    'PLATFORM_POLICY_BLOCKED', 'This target does not permit an AI preparation step.');
  const translationOnly = kind === 'translation.localize' || kind === 'format.transform'
    && typeof input.transformSpec?.targetFormat === 'string' && Array.isArray(input.sourceEditions) && input.sourceEditions.length > 0
    && input.sourceEditions.every(source => source.format === input.transformSpec.targetFormat)
    && input.sourceEditions.some(source => source.locale !== input.transformSpec.targetLocale);
  const authorEditingOnly = Boolean(!actions.includes('draft') && !translationOnly || ['author_led_editor_assist', 'human_original_copyedit'].includes(requested)
    || explicit?.requiresAuthorContribution === true || profile?.requiresAuthorContribution || rule?.requiresAuthorContribution);
  if (translationOnly) requireCondition(actions.includes('translate'), 'PLATFORM_POLICY_BLOCKED', 'Translation is outside the explicit policy intersection.');
  if (['text.adapt', 'text.polish', 'text.revise', 'format.transform'].includes(kind) && !translationOnly) requireCondition(actions.includes('copyedit') || !authorEditingOnly && actions.includes('draft'),
    'PLATFORM_POLICY_BLOCKED', 'The text action is outside the explicit platform policy.');
  return { ...input, workerPolicy: { allowedAiActions: actions, authorEditingOnly, translationOnly,
    outlineFromAuthorOnly: !actions.includes('outline'), ...(typeof explicit?.ruleBindingHash === 'string' ? { ruleBindingHash: explicit.ruleBindingHash } : {}) } };
}
function finalReport(modelResult, input, lease, inputs) {
  const pkg = input.package, raw = modelResult.value;
  const hashes = new Set(inputs.map(row => bytesHash(row.bytes)));
  requireCondition((pkg.artifactRefs ?? []).every(row => hashes.has(row.sha256)), 'ARTIFACT_MISSING', 'Final checking requires the actual bytes of every declared attachment.');
  const textKeys = qualityTextKeys(pkg);
  const artifactHashes = [...new Set((pkg.artifactRefs ?? []).map(row => row.sha256))];
  const media = inputs.filter(row => /^(?:image\/|video\/|audio\/)|^application\/(?:pdf|zip|x-safetensors)$/.test(row.mime));
  const major = raw.findings.some(finding => ['blocker', 'major'].includes(finding.severity));
  const passed = coverage => coverage === 'checked' || coverage === 'not_applicable';
  return { checkedPackageHash: input.packageHash, checkerVersion: 'pengmanager.independent-checker/v1',
    checkContextHash: input.checkContextHash, deterministicReceipts: [{ kind: 'package_hash_and_attachment_bytes',
      packageHash: input.packageHash, artifactHashes, executed: true }],
    semanticFindings: raw.findings.map(row => ({ ...row, resolved: false })), mediaEvidence: media.map(row => ({ sha256: bytesHash(row.bytes),
      mime: row.mime, byteHashVerified: true, semanticInspection: 'unverified', artisticInspection: 'unverified' })),
    coverage: { textKeys, artifactHashes },
    dimensions: { deterministic: 'passed', semantic: !major && passed(raw.coverage.semantic) ? 'passed' : 'unverified',
      media: media.length ? 'unverified' : 'passed', artistic: !major && !media.length && passed(raw.coverage.artistic) ? 'passed' : 'unverified' },
    modelReceiptIds: [modelResult.providerRequestId].filter(Boolean), assessment: raw.assessment };
}

/** Fixed typed projection. Task/plan JSON never controls executable names or native arguments. */
export async function createContentOpsAdapters({ rootDir = ROOT, model, modelConfig, rendererOptions = {}, mediaOptions = {},
  clock = () => Date.now(), currency, maxOutputTokens } = {}) {
  const bindings = await contentOpsAdapterBindings({ rootDir });
  const assertCurrentSources = async () => {
    const current = await contentOpsSourceClosure({ rootDir });
    requireCondition(current.sha256 === LOADED_SOURCE_CLOSURE.sha256, 'ADAPTER_SOURCE_CHANGED',
      'A loaded worker support file changed; no further task dispatch is permitted until a fresh process is approved.');
  };
  const modelAdapter = model ?? new SingleRequestModel({ ...modelConfig, ...(maxOutputTokens ? { maxOutputTokens } : {}) });
  const byKind = new Map();
  for (const binding of bindings) {
    const kind = binding.kind;
    const readiness = async () => {
      if (MODEL_TASK_KINDS.includes(kind)) return modelAdapter.readiness();
      if (kind === 'voice.speak') return { ready: false, productionVerified: false, reason: 'EXPLICIT_VOICE_CHUNK_ADAPTER_REQUIRED' };
      if (['image.compose', 'document.render'].includes(kind)) return await createRenderers({ ...rendererOptions,
        runNativeCall: async () => fail('TASK_LEASE_REQUIRED', 'A native render probe needs a live task and budget permit.') }).readiness();
      if (['video.assemble', 'video.reedit', 'media.inspect'].includes(kind)) return createMediaProcessor({ ...mediaOptions,
        runNativeCall: async () => fail('TASK_LEASE_REQUIRED', 'A native media probe needs a live task and budget permit.') }).readiness();
      return { ready: true, productionVerified: false, inspection: 'fixed_pure_data' };
    };
    byKind.set(kind, { binding, readiness, async execute({ lease, input, inputs = [], signal, runCall }) {
      record(input, 'Resolved task input'); jsonValue(input); requireCondition(lease.task.kind === kind, 'ADAPTER_KIND_DENIED', 'The adapter kind differs from the frozen task.');
      if (MODEL_TASK_KINDS.includes(kind)) {
        if (kind === 'quality.final') {
          const actualHashes = new Set(inputs.map(row => bytesHash(row.bytes)));
          requireCondition((input.package?.artifactRefs ?? []).every(ref => actualHashes.has(ref.sha256)),
            'ARTIFACT_MISSING', 'Every actual final attachment must be available before reserving a checker request.');
        }
        let source = modelPolicyInput(kind, ['quality.check', 'quality.final'].includes(kind) ? checkerInput(input, lease) : input);
        // Drafting and checking both receive the exact authorized textual works,
        // never merely their names or a statement that the files exist.
        source = { ...source, attachmentTexts: inputs.filter(row => /^(?:text\/|application\/(?:json|x-ipynb\+json))/.test(row.mime))
          .map(row => ({ id: row.id, sha256: bytesHash(row.bytes), mime: row.mime, text: new TextDecoder('utf-8', { fatal: true }).decode(row.bytes) })) };
        const result = await runCall('model.1', await modelAdapter.prepare(kind, source));
        const data = kind === 'quality.final' ? finalReport(result, source, lease, inputs) : result.value;
        // A backend-declared text output always contains the actual complete text.
        const outputs = (lease.task.outputSpec ?? []).map(spec => {
          const allowed = spec.allowedMimes ?? spec.mimes ?? [spec.mime];
          const mime = allowed.includes('application/json') ? 'application/json' : allowed.includes('text/markdown') ? 'text/markdown' : null;
          requireCondition(mime, 'TASK_OUTPUT_INVALID', 'The model task output MIME has no fixed typed projection.');
          const selected = result.value.nativeContent?.find(row => row.outputKey === spec.outputKey) ?? result.value;
          return outputFor(spec, { mime, bytes: mime === 'application/json' ? result.bytes : Buffer.from(`${selected.title}\n\n${selected.body}\n`) });
        });
        return { data, outputs, executionReceipts: [publicReceipt(kind, result)] };
      }
      requireCondition(kind !== 'voice.speak', 'ADAPTER_NOT_READY', 'Explicit voice synthesis needs separately authorized chunk metering and is not enabled.');
      const actualCurrency = budgetCurrency(input, currency);
      const nativeReceipts = [];
      const runNativeCall = async (call, run) => {
        const result = await runCall(call.callKey, { ...call, provider: null, model: null, pricingSnapshotHash: null,
          execute: async ({ signal: executionSignal }) => {
            // Native processors also receive the worker signal in their fixed config.
            requireCondition(!executionSignal.aborted, 'WORKER_CANCELLED', 'The native permit was cancelled before execution.');
            const native = await run({ signal: executionSignal });
            const receipt = { kind: 'local_execution_receipt', providerRequestId: null,
              sha256: dataHash({ callKey: call.callKey, requestHash: call.requestHash, stdoutSha256: bytesHash(native.stdout),
                exitCode: native.exitCode, elapsedMs: native.elapsedMs, executed: native.executed, dryRun: native.dryRun }) };
            return { ...native, usage: zeroUsage(actualCurrency), usageReceipt: receipt, usageUnknown: false,
              evidence: { kind: 'fixed_native_process', callKey: call.callKey, requestHash: call.requestHash, elapsedMs: native.elapsedMs, exitCode: native.exitCode } };
          } });
        nativeReceipts.push({ kind: 'fixed_native_process', executed: true, dryRun: false, ...result.evidence, usageReceipt: result.usageReceipt }); return result;
      };
      const renderers = createRenderers({ ...rendererOptions, signal, runNativeCall });
      const media = createMediaProcessor({ ...mediaOptions, signal, runNativeCall });
      const textResult = latestText(input), files = frozenFileInputs(input, inputs), outputs = [], metadata = [];
      const specs = lease.task.outputSpec ?? [];
      const targetOutputKey = lease.task.inputRefs?.inputRefs?.find(row => row.targetOutputKey)?.targetOutputKey;
      const pure = async (callKey, source, execute) => await runCall(callKey, { provider: null, model: null, pricingSnapshotHash: null,
        requestHash: dataHash(source), upperBound: { inputTokens: 0, outputTokens: 0, renderSeconds: 0,
          tempBytes: Math.max(1, specs.reduce((sum, spec) => sum + (spec.maxBytes ?? 1_000_000), 0)), nativeProcesses: 0 },
        execute: async () => { const result = await execute(); return { ...result, executed: true, dryRun: false,
          usage: zeroUsage(actualCurrency), usageUnknown: false, usageReceipt: { kind: 'local_execution_receipt', providerRequestId: null,
            sha256: bytesHash(result.bytes) }, evidence: { kind: 'fixed_deterministic_bytes', sourceHash: dataHash(source), resultHash: bytesHash(result.bytes) } }; } });
      for (const spec of specs) {
        let result;
        if (kind === 'image.compose') {
          const sources = files.filter(file => file.role === 'source_image').map(file => ({ bytes: file.bytes, sha256: file.sha256,
            alt: input.target?.readerNeed || 'Authorized source image' }));
          requireCondition(sources.length > 0, 'LOCAL_SOURCE_MISSING', 'Image composition requires actual authorized source screenshots.');
          const selected = nativeOutputText(textResult, input.target, spec.outputKey, 'image');
          result = await renderers.renderCard({ layoutId: spec.role === 'cover' ? 'editorial-cover-v1' : 'editorial-card-v1',
            title: selected.title, body: selected.body, footer: input.target?.settings?.disclosure?.requiredLabels?.join(' · ') ?? '', sourceImages: sources });
          result.metadata = { ...result.metadata, cardIndex: selected.index, title: selected.title, body: selected.body, alt: selected.alt, caption: selected.caption,
            completeSourceTextHash: bytesHash(Buffer.from(textResult.body)) };
        } else if (kind === 'document.render') {
          const selected = nativeOutputText(textResult, input.target, spec.outputKey, 'document');
          const paragraphs = selected.body.split(/\n\s*\n/u).filter(Boolean); const pages = []; let body = '';
          for (const paragraph of paragraphs) { if (body && body.length + paragraph.length > 1000) { pages.push({ title: pages.length ? `${selected.title} · ${pages.length + 1}` : selected.title, body }); body = ''; } body += (body ? '\n\n' : '') + paragraph; }
          if (body) pages.push({ title: pages.length ? `${selected.title} · ${pages.length + 1}` : selected.title, body });
          requireCondition(pages.length > 0 && pages.length <= 12, 'DOCUMENT_PAGE_LIMIT', 'The complete document does not fit the fixed twelve-page template.');
          result = await renderers.renderDocument({ title: selected.title, pages });
        } else if (kind === 'caption.align') {
          const source = files.find(file => file.role === 'timed_captions');
          requireCondition(source, 'CAPTION_TIMING_REQUIRED', 'Caption preparation requires a real authorized timed transcript.');
          const timing = timedCaptionSource(source, input.target);
          result = await pure(`caption.${spec.outputKey}`, { sha256: source.sha256, locale: spec.locale ?? input.target.locale },
            () => renderers.renderVtt({ durationMs: input.target.settings.durationMs ?? timing.durationMs,
              locale: timing.locale, cues: timing.cues }));
        } else if (['video.assemble', 'video.reedit'].includes(kind)) {
          const sources = files.filter(file => file.role === 'source_video');
          requireCondition(sources.length > 0, 'LOCAL_SOURCE_MISSING', 'Video preparation requires actual authorized source video.');
          const settings = input.target.settings, aspect = settings.aspect;
          const [width, height] = aspect === '9:16' ? [1080, 1920] : aspect === '1:1' ? [1080, 1080] : [1920, 1080];
          requireCondition(sources.length === 1, 'VIDEO_TIMELINE_REQUIRED', 'Multi-source assembly needs an explicit reviewed source timeline; this plan has none.');
          result = await media.renderVideo({ segments: [{ bytes: sources[0].bytes, sha256: sources[0].sha256,
            startMs: 0, endMs: settings.durationMs }], width, height, fps: 30, audioPolicy: input.target.languagePlan.voiceMode });
        } else if (kind === 'native.prepare') {
          const nativeForm = input.target.nativeForm;
          if (spec.kind === 'notebook') {
            const notebook = files.find(file => file.role === 'notebook'); requireCondition(notebook, 'ARTIFACT_MISSING', 'The notebook source is missing.');
            result = await pure(`native.${spec.outputKey}`, { sha256: notebook.sha256 }, async () => {
              const preview = await renderers.previewNotebook({ bytes: notebook.bytes, sha256: notebook.sha256 });
              return { bytes: notebook.bytes, mime: 'application/x-ipynb+json', metadata: { staticPreviewHash: preview.sha256, executeCode: false, sourceUntouched: true } };
            });
          } else if (spec.kind === 'repository_diff' && input.target.settings.operation === 'prepare_release_notes') {
            requireCondition(files.some(file => file.role === 'code' || file.role === 'run_log'), 'ARTIFACT_MISSING', 'Release notes require actual supplied code or result evidence.');
            result = await pure(`native.${spec.outputKey}`, { body: textResult.body, baseCommit: input.target.settings.baseCommit,
              sourceHashes: files.map(file => file.sha256) }, async () => ({ bytes: Buffer.from(`# ${textResult.title}\n\n${textResult.body}\n`), mime: 'text/markdown',
                metadata: { baseCommit: input.target.settings.baseCommit, operation: 'prepare_release_notes', sourceHashes: files.map(file => file.sha256), executedCode: false, pushed: false } }));
          } else if (spec.kind === 'repository_diff') {
            const diff = files.find(file => file.mime === 'text/x-diff' || file.mime === 'text/x-patch');
            requireCondition(diff, 'REPOSITORY_DIFF_REQUIRED', 'A repository change requires actual source diff bytes; prose is not a patch.');
            result = await pure(`native.${spec.outputKey}`, { sha256: diff.sha256, baseCommit: input.target.settings.baseCommit }, async () => {
              const manifest = await renderers.prepareNativeManifest({ kind: 'repository_change', title: textResult.title, baseCommit: input.target.settings.baseCommit,
                tag: input.target.settings.tag, files: [{ key: 'diff', role: 'diff', mime: 'text/x-diff', bytes: diff.bytes, sha256: diff.sha256 },
                  { key: 'readme', role: 'readme', mime: 'text/markdown', bytes: Buffer.from(textResult.body), sha256: bytesHash(Buffer.from(textResult.body)) }], executeCode: false, deploy: false });
              return { bytes: diff.bytes, mime: 'text/x-diff', metadata: { manifestHash: manifest.sha256, baseCommit: input.target.settings.baseCommit, sourceUntouched: true } };
            });
          } else if (['model_card', 'dataset_card'].includes(spec.kind)) {
            requireCondition(files.some(file => spec.kind === 'model_card' ? file.role === 'model_weights' : file.role === 'dataset'),
              'ARTIFACT_MISSING', 'This technical card requires the actual authorized model or dataset source.');
            requireCondition(files.some(file => file.role === 'rights_evidence'), 'LICENSE_EVIDENCE_REQUIRED', 'This technical card needs real license evidence.');
            result = await pure(`native.${spec.outputKey}`, { body: textResult.body, sourceHashes: files.map(file => file.sha256) },
              async () => ({ bytes: Buffer.from(`# ${textResult.title}\n\n${textResult.body}\n`), mime: 'text/markdown', metadata: { nativeForm, sourceHashes: files.map(file => file.sha256), suppliedResultsStatus: 'unverified' } }));
          } else if (spec.kind === 'demo_manifest') {
            const code = files.filter(file => file.role === 'code'); requireCondition(code.length, 'ARTIFACT_MISSING', 'A demo package requires actual code files.');
            const manifest = { schema: 'pengmanager.static-demo-manifest/v1', title: textResult.title, body: textResult.body,
              files: code.map(file => ({ artifactId: file.artifactId ?? file.id, sha256: file.sha256, bytes: file.bytes.length, mime: file.mime })), deploy: false, executeCode: false, executionStatus: 'not_executed' };
            result = await pure(`native.${spec.outputKey}`, manifest, async () => ({ bytes: Buffer.from(JSON.stringify(manifest) + '\n'), mime: 'application/json', metadata: manifest }));
          } else fail('NATIVE_ARTIFACT_TYPE_UNSUPPORTED', 'This exact native output has no safe fixed preparation projection.');
        } else if (kind === 'media.inspect' || kind === 'quality.technical') {
          const inspected = [];
          for (const file of files) {
            if (file.mime === 'image/png') inspected.push({ sha256: file.sha256, mime: file.mime, ...inspectPngBytes(file.bytes) });
            else if (file.mime === 'video/mp4') inspected.push({ sha256: file.sha256, mime: file.mime, ...(await media.inspect({ bytes: file.bytes, sha256: file.sha256 })).metadata });
            else if (/^text\/|^application\/(?:json|x-ipynb\+json)$/.test(file.mime)) {
              new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); inspected.push({ sha256: file.sha256, mime: file.mime, bytesVerified: true });
            } else fail('NATIVE_ARTIFACT_TYPE_UNSUPPORTED', 'The technical check cannot claim inspection of this unsupported file type.');
          }
          result = await pure(`inspect.${spec.outputKey}`, inspected, async () => ({ bytes: Buffer.from(JSON.stringify({ inspected, semantic: 'unverified', artistic: 'unverified' }) + '\n'), mime: 'application/json', metadata: { inspected } }));
        } else fail('ADAPTER_KIND_DENIED', 'This task is outside the fixed adapter projections.');
        outputs.push(outputFor(spec, result)); metadata.push({ outputKey: spec.outputKey, sha256: bytesHash(result.bytes), mime: result.mime, ...result.metadata });
      }
      requireCondition(specs.length > 0, 'TASK_OUTPUT_INVALID', 'A deterministic artifact task needs declared actual outputs.');
      const receipts = nativeReceipts.length ? nativeReceipts : metadata.map(row => ({ kind, executed: true, dryRun: false, sha256: row.sha256 }));
      return { outputs, data: { outputKey: targetOutputKey ?? specs[0].outputKey, outputs: metadata, sourceUntouchedProof: files.map(file => file.sourceProof) }, executionReceipts: receipts };
    } });
  }
  return { get: kind => byKind.get(kind) ?? null, bindings, assertCurrentSources, async readiness() {
    await assertCurrentSources();
    const checkedAt = new Date(clock()).toISOString(), expiresAt = new Date(Number(clock()) + 5 * 60_000).toISOString();
    const results = [];
    for (const adapter of byKind.values()) {
      let result; try { result = await adapter.readiness(); } catch (error) { result = { ready: false, reason: error.code ?? 'ADAPTER_NOT_READY' }; }
      results.push({ ...adapter.binding, ready: result.ready === true, checkedAt, expiresAt,
        proofHash: dataHash({ binding: adapter.binding, checkedAt, expiresAt, inspection: result.inspection ?? null,
          ready: result.ready === true, reason: result.reason ?? null }), reason: result.reason ?? null, productionVerified: false });
    }
    return results;
  } };
}

export const CONTENT_OPS_ADAPTER_KINDS = ALL_KINDS;
// Capture the closure at module load. Rehashing changed disk files must never
// advertise a newer fingerprint for an older cached ESM implementation.
const LOADED_SOURCE_CLOSURE = await contentOpsSourceClosure({ rootDir: ROOT });
