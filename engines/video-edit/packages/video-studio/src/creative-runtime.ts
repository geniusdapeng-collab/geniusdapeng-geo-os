import { AsyncLocalStorage } from "node:async_hooks";
import { DEEPSEEK_FLASH_CONTEXT_TOKENS, DEEPSEEK_FLASH_MODEL_ID, normalizeModelContent, planDeepSeekWindow, type BudgetMessage } from "@workloom/base/model-router";
import {
  assertCreativeContract, buildCreativeShots, compileCreativePrompt, creativeCacheKey,
  creativeCanonical, creativeHash, validateCreativeShots, validatePatchDelta,
  creativeTextHash,
  CreativeContractError, type CreativeContract, type CreativeFinding, type CreativeScope, type CreativeShot,
} from "./constraint-compiler.js";
import {
  ABSTRACT_PRODUCT_RENDER_RULE, REGISTERED_PRODUCT_REFERENCE_DETAIL_RULE, INSPECTED_RC_REFERENCE_DETAIL_RULE,
  VERIFIED_PRODUCT_VISUAL_MODE, assertProductVisualContent, registeredProductReferenceOmitsMirrors,
  type ProductVisualAuthority,
} from "./product-visual-authority.js";
import { creativeCandidateHash, rankCreativeCandidates, type CreativeCandidateAssessment } from "./creative-evaluation.js";

export const CREATIVE_EXECUTOR_VERSION = "workloom.creative-executor/v1";
const OPENING_TITLE_FIELDS = ["title_content", "subtitle_content", "title_animation", "title_font_design", "opening_audio_design"] as const;
type Recordish = Record<string, unknown>;
export interface CreativeModelRequest {
  requestHash: string; inputChars: number; maxOutputTokens: number; model: string; attempt: number;
  requestBytes: number;
  inputTokenEstimate: number;
  inputTokenUpperBound: number;
  inputTokenBasis: string;
  imageInputTokens?: number;
}
export interface CreativeModelOutcome {
  actualCny?: number | null; usageKnown: boolean; success: boolean;
  inputTokens?: number; outputTokens?: number;
  totalTokens?: number; reasoningTokens?: number; finishReason?: "stop" | "length";
  providerRequestId?: string; responseHash?: string;
}
export interface CreativeBudgetHooks {
  beforeModelCall(request: CreativeModelRequest): Promise<unknown>;
  afterModelCall(reservation: unknown, outcome: CreativeModelOutcome): Promise<void>;
  shouldAbort?: () => boolean;
  externalCall?: <T>(request: { kind: "search" | "media"; provider: string; requestHash: string },
    operation: (signal?: AbortSignal) => Promise<T>, isKnown: (value: T) => boolean) => Promise<T>;
}
interface ExecutionContext {
  hooks: CreativeBudgetHooks; controller: AbortController; closed: boolean;
  state: { calls: number; fatal?: Error; inFlight: Set<Promise<unknown>> }; runtime?: CreativeRuntime; phase?: string; shotId?: string;
}
const executions = new AsyncLocalStorage<ExecutionContext>();
const owners = new Set<string>();
const modelWindows = new Map<string, Promise<void>>();
function fail(code: string, message: string, findings: CreativeFinding[] = []): never {
  throw new CreativeContractError(code, message, findings);
}
function object(value: unknown, label: string): Recordish {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CREATIVE_NATIVE_INVALID", label);
  return value as Recordish;
}
function snapshot<T>(value: T): T {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) fail("CREATIVE_JSON_INVALID", "non-finite native value");
    if (typeof item === "function" || typeof item === "bigint" || typeof item === "symbol") fail("CREATIVE_JSON_INVALID", "non-JSON native value");
    return item;
  });
  if (serialized === undefined) fail("CREATIVE_JSON_INVALID", "missing native output");
  const result = JSON.parse(serialized) as T;
  creativeCanonical(result); return result;
}
function assertExecution(context: ExecutionContext): void {
  if (context.state.fatal) throw context.state.fatal;
  if (context.closed || context.controller.signal.aborted || context.hooks.shouldAbort?.()) {
    context.controller.abort(); fail("CREATIVE_CANCELLED", "execution cancelled or closed; no new provider calls");
  }
}

/** The budget scope also encloses G1 and independent reviews, before a final contract exists. */
export async function withCreativeBudget<T>(hooks: CreativeBudgetHooks, operation: () => Promise<T>): Promise<T> {
  if (executions.getStore()) fail("CREATIVE_SCOPE_CONFLICT", "nested execution budget");
  const context: ExecutionContext = { hooks, controller: new AbortController(), closed: false, state: { calls: 0, inFlight: new Set() } };
  const timer = setInterval(() => { if (hooks.shouldAbort?.()) context.controller.abort(); }, 50);
  timer.unref?.();
  return executions.run(context, async () => {
    try {
      assertExecution(context);
      const result = await operation();
      await Promise.allSettled(context.state.inFlight);
      assertExecution(context);
      return result;
    } catch (error) {
      context.controller.abort();
      // The router may report caller cancellation before its dispatched HTTP
      // promise settles. Finish the journal receipt before the worker releases
      // its lease, so a restart cannot observe a false clean finish.
      await Promise.allSettled(context.state.inFlight);
      throw context.state.fatal ?? error;
    }
    finally { clearInterval(timer); context.closed = true; context.controller.abort(); }
  });
}
export function creativeExecutionSignal(): AbortSignal | undefined { return executions.getStore()?.controller.signal; }
export function creativeBudgetActive(): boolean { return Boolean(executions.getStore()); }
export function assertCreativeBudgetCurrent(): void { const context = executions.getStore(); if (context) assertExecution(context); }
export async function guardedCreativeExternalCall<T>(
  request: { kind: "search" | "media"; provider: string; requestHash: string },
  operation: (signal?: AbortSignal) => Promise<T>, isKnown: (value: T) => boolean,
): Promise<T> {
  const context = executions.getStore();
  if (!context) return operation();
  assertExecution(context);
  try {
    if (!context.hooks.externalCall) fail(request.kind === "media" ? "CREATIVE_MEDIA_BUDGET_REQUIRED" : "CREATIVE_SEARCH_BUDGET_REQUIRED", "trusted external request journal is missing");
    const value = await context.hooks.externalCall(request, operation, isKnown);
    assertExecution(context); return value;
  } catch (error) {
    context.state.fatal ??= error instanceof Error ? error : new Error(String(error));
    throw context.state.fatal;
  }
}

/** Wrap the existing provider transport so each actual HTTP attempt has its own reservation. */
export function creativeBudgetedFetch(transport: typeof fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    if (!executions.getStore()) return transport(input, init);
    if (typeof init.body !== "string") fail("CREATIVE_REQUEST_UNVERIFIED", "serialized provider body is required before dispatch");
    let body: Recordish;
    try { body = object(JSON.parse(init.body), "provider body"); }
    catch { fail("CREATIVE_REQUEST_UNVERIFIED", "provider body is not complete JSON"); }
    if (body.model !== DEEPSEEK_FLASH_MODEL_ID || !Number.isSafeInteger(body.max_tokens) || Number(body.max_tokens) <= 0
      || !Array.isArray(body.messages)) fail("CREATIVE_REQUEST_UNVERIFIED", "model, messages or output window unavailable");
    const window = await planDeepSeekWindow({ messages: body.messages as BudgetMessage[], tools: body.tools,
      responseFormat: body.response_format, thinking: body.thinking, reasoningEffort: body.reasoning_effort });
    const maxOutputTokens = Number(body.max_tokens);
    if (maxOutputTokens !== window.outputCeiling) fail("CREATIVE_REQUEST_UNVERIFIED", "actual max_tokens does not equal the complete legal output window");
    const requestBytes = Buffer.byteLength(init.body);
    let usage: CreativeModelOutcome = { usageKnown: false, success: false, actualCny: null };
    return guardedCreativeModelCall({ requestHash: creativeTextHash(init.body), inputChars: requestBytes, requestBytes,
      inputTokenEstimate: window.inputTokens, inputTokenUpperBound: window.inputTokenUpperBound, inputTokenBasis: window.inputTokenBasis,
      maxOutputTokens, model: body.model,
      ...(window.imageTokens ? { imageInputTokens: window.imageTokens } : {}) }, async () => {
      const response = await transport(input, { ...init, redirect: "error" });
      // Clone only for billing evidence; the unchanged provider still owns validation and parsing.
      let envelope: Recordish;
      let rawResponse: string;
      try {
        rawResponse = await response.clone().text();
        envelope = object(JSON.parse(rawResponse), "provider usage response");
      }
      catch { return response; }
      const rawUsage = envelope.usage && typeof envelope.usage === "object" ? envelope.usage as Recordish : {};
      const inputTokens = rawUsage.prompt_tokens, outputTokens = rawUsage.completion_tokens, totalTokens = rawUsage.total_tokens;
      if (response.ok && envelope.model === body.model && typeof envelope.id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(envelope.id)
        && Number.isSafeInteger(inputTokens) && Number(inputTokens) >= 0
        && Number.isSafeInteger(outputTokens) && Number(outputTokens) >= 0 && Number(outputTokens) <= maxOutputTokens
        && totalTokens === Number(inputTokens) + Number(outputTokens) && Number(totalTokens) <= DEEPSEEK_FLASH_CONTEXT_TOKENS) {
        const choice = Array.isArray(envelope.choices) && envelope.choices.length === 1 && envelope.choices[0] && typeof envelope.choices[0] === "object"
          ? envelope.choices[0] as Recordish : {};
        const message = choice.message && typeof choice.message === "object" ? choice.message as Recordish : {};
        const content = normalizeModelContent(message.content).trim();
        const reasoning = rawUsage.completion_tokens_details && typeof rawUsage.completion_tokens_details === "object"
          ? (rawUsage.completion_tokens_details as Recordish).reasoning_tokens : undefined;
        const thinking = body.thinking && typeof body.thinking === "object" ? (body.thinking as Recordish).type : undefined;
        const reasoningValid = Number.isSafeInteger(reasoning) && Number(reasoning) >= 0 && Number(reasoning) <= Number(outputTokens);
        let contentValid = Boolean(content) && (reasoning === undefined || reasoningValid)
          && (thinking !== "disabled" || (!String(message.reasoning_content ?? "").trim() && (reasoning ?? 0) === 0));
        if (contentValid && body.response_format && typeof body.response_format === "object" && (body.response_format as Recordish).type === "json_object") {
          try { const value: unknown = JSON.parse(content); contentValid = Boolean(value && typeof value === "object" && !Array.isArray(value)); }
          catch { contentValid = false; }
        }
        usage = { usageKnown: true, success: choice.finish_reason === "stop" && contentValid,
          inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), totalTokens: Number(totalTokens),
          providerRequestId: envelope.id, responseHash: creativeTextHash(rawResponse),
          ...(reasoningValid ? { reasoningTokens: Number(reasoning) } : {}),
          ...(choice.finish_reason === "stop" || choice.finish_reason === "length" ? { finishReason: choice.finish_reason } : {}) };
      }
      return response;
    }, () => usage);
  }) as typeof fetch;
}

/** Called at each actual provider request, not once per agent or phase. */
export async function guardedCreativeModelCall<T>(
  request: Omit<CreativeModelRequest, "attempt">, operation: () => Promise<T>, outcome: (value: T) => CreativeModelOutcome,
  errorOutcome?: (error: unknown) => CreativeModelOutcome | undefined,
): Promise<T> {
  const context = executions.getStore();
  if (!context) return operation();
  const previous = modelWindows.get(request.model) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => held); modelWindows.set(request.model, tail);
  await previous;
  const receipt = reservedCreativeModelCall(request, operation, outcome, errorOutcome);
  context.state.inFlight.add(receipt);
  try { return await receipt; }
  finally {
    context.state.inFlight.delete(receipt);
    release(); if (modelWindows.get(request.model) === tail) modelWindows.delete(request.model);
  }
}
async function reservedCreativeModelCall<T>(
  request: Omit<CreativeModelRequest, "attempt">, operation: () => Promise<T>, outcome: (value: T) => CreativeModelOutcome,
  errorOutcome?: (error: unknown) => CreativeModelOutcome | undefined,
): Promise<T> {
  const context = executions.getStore();
  if (!context) return operation();
  assertExecution(context);
  const reservation = await context.hooks.beforeModelCall({ ...request, attempt: ++context.state.calls });
  let settled = false;
  let providerCompleted = false;
  try {
    assertExecution(context);
    const result = await operation(); providerCompleted = true;
    const receipt = outcome(result);
    await context.hooks.afterModelCall(reservation, receipt); settled = true;
    if (!receipt.usageKnown) {
      context.state.fatal = new CreativeContractError("CREATIVE_USAGE_UNKNOWN", "unknown usage retains its reservation and freezes execution");
      throw context.state.fatal;
    }
    assertExecution(context); return result;
  } catch (error) {
    if (!settled) {
      const knownFailure = !providerCompleted ? errorOutcome?.(error) : undefined;
      if (knownFailure?.usageKnown) {
        try { await context.hooks.afterModelCall(reservation, { ...knownFailure, success: false }); }
        catch (journalError) {
          context.state.fatal = new CreativeContractError("CREATIVE_RECEIPT_UNKNOWN", `budget receipt could not be persisted: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
        }
        throw context.state.fatal ?? error;
      }
      context.state.fatal ??= new CreativeContractError("CREATIVE_USAGE_UNKNOWN", "provider/receipt outcome unknown; preserve reservation and reconcile");
      try { await context.hooks.afterModelCall(reservation, { actualCny: null, usageKnown: false, success: false }); }
      catch (journalError) {
        context.state.fatal = new CreativeContractError("CREATIVE_RECEIPT_UNKNOWN", `budget receipt could not be persisted: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
      }
    }
    throw context.state.fatal ?? error;
  }
}

export interface CreativeCache {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown): Promise<void>;
}
export interface CreativeRuntimeOptions {
  contract: CreativeContract; model: string; nativeSchemaHash: string;
  fields: { keys: string[]; labels: Record<string, string>; requiredKeys?: string[] };
  cache: CreativeCache;
  assertCurrent?: () => void | Promise<void>;
  onEvent?: (event: { kind: string; payload: Recordish }) => void | Promise<void>;
  beginStage?: (stage: string) => Promise<void>;
  completeStage?: (stage: string, output: unknown) => Promise<void>;
  preparationStage?: string;
  selectedCandidate?: CreativeCandidateAssessment;
  visualAuthority?: ProductVisualAuthority;
  generate: (prompt: string, schema: unknown) => Promise<unknown>;
}
export function currentCreativeRuntime(): CreativeRuntime | undefined { return executions.getStore()?.runtime; }
export function currentCreativeModelSlice(): string | undefined {
  const context = executions.getStore();
  return context?.runtime && context.shotId ? context.runtime.modelSlice(context.shotId) : undefined;
}
export function currentCreativeSelectionContext(): string | undefined { return currentCreativeRuntime()?.selectionContext(); }

/** One real adapter owns a project. The server's PG lease supplies cross-process fencing. */
export async function withCreativeRuntime<T>(runtime: CreativeRuntime, operation: () => Promise<T>): Promise<T> {
  const context = executions.getStore();
  if (!context) fail("CREATIVE_BUDGET_REQUIRED", "enforced creative execution requires a trusted request journal");
  assertExecution(context);
  const key = creativeCanonical(runtime.contract.scope);
  if (owners.has(key) || context.runtime) fail("CREATIVE_EXECUTOR_BUSY", "project already has an active creative executor");
  owners.add(key);
  return executions.run({ ...context, runtime }, async () => {
    try { await runtime.assertCurrent(); const result = await operation(); await runtime.assertCurrent(); return result; }
    finally { owners.delete(key); }
  });
}

export class CreativeRuntime {
  readonly contract: CreativeContract;
  private readonly options: CreativeRuntimeOptions;
  private readonly sources = new Map<string, Recordish>();
  private readonly planned = new Map<string, CreativeShot>();
  private readonly accepted = new Map<string, CreativeShot>();
  private readonly selectedCandidate?: CreativeCandidateAssessment;
  private titleShotId: string | undefined;
  private productionStarted = false;
  private compiledVerified = false;
  constructor(options: CreativeRuntimeOptions) {
    assertCreativeContract(options.contract);
    if (options.contract.feasibility.status !== "feasible") fail("CREATIVE_CONTRACT_NOT_READY", "facts or feasibility are not ready");
    if (!options.model || !/^[a-f0-9]{64}$/.test(options.nativeSchemaHash) || !options.fields.keys.length
      || new Set(options.fields.keys).size !== options.fields.keys.length
      || options.fields.keys.some(key => !options.fields.labels[key])
      || options.fields.requiredKeys?.some(key => !options.fields.keys.includes(key))) fail("CREATIVE_SCHEMA_UNVERIFIED", "actual native field registry is required");
    if (options.selectedCandidate) {
      const selected = snapshot(options.selectedCandidate);
      const ranked = rankCreativeCandidates({ contract: options.contract, generationModel: options.model, candidates: [selected] });
      if (ranked.eligible.length !== 1) fail("CREATIVE_SELECTION_UNVERIFIED", "selected candidate lacks separate current hard-valid review");
      const references = selected.trustedProductReferences;
      if (references !== undefined) {
        const sha256 = /^[a-f0-9]{64}$/;
        if (options.visualAuthority?.mode !== VERIFIED_PRODUCT_VISUAL_MODE || options.contract.route !== "marketing"
          || !Array.isArray(references) || references.length < 1 || references.length > 4
          || references.some(reference => !reference || Object.keys(reference).length !== 11
            || reference.productName !== options.visualAuthority!.product || !reference.productId || !reference.assetId
            || reference.authorizationBasis !== "owner-confirmed-reference-use" || !sha256.test(reference.sha256)
            || reference.ref !== `product:sha256:${reference.sha256}` || !sha256.test(reference.ownerManifestSha256)
            || reference.g1ContentSha256 !== options.contract.facts?.hash
            || !Number.isSafeInteger(reference.g1ImageIndex) || !options.visualAuthority!.images[reference.g1ImageIndex]
            || !Number.isSafeInteger(reference.bytes) || reference.bytes < 1024 || reference.bytes > 8_000_000
            || !["image/png", "image/jpeg", "image/webp"].includes(reference.mimeType))
          || new Set(references.map(reference => reference.ref)).size !== references.length
          || selected.shots.some(shot => creativeHash(shot.assetRefs) !== creativeHash(references.map(reference => reference.ref)))) {
          fail("CREATIVE_PRODUCT_REFERENCE_UNVERIFIED", "selected candidate product receipt differs from current G1 or shot references");
        }
      }
      this.selectedCandidate = selected;
    }
    this.options = options; this.contract = options.contract;
    if (this.usesGeneratedTitle && OPENING_TITLE_FIELDS.some(key => !options.fields.labels[key])) {
      fail("CREATIVE_SCHEMA_UNVERIFIED", "native opening title field registry is missing");
    }
  }
  async assertCurrent(): Promise<void> {
    const context = executions.getStore();
    if (!context) fail("CREATIVE_BUDGET_REQUIRED", "missing execution scope");
    assertExecution(context); assertCreativeContract(this.contract); await this.options.assertCurrent?.(); assertExecution(context);
  }
  async startProduction(authority: unknown): Promise<void> {
    await this.assertCurrent();
    if (this.productionStarted) fail("CREATIVE_STAGE_CONFLICT", "production may only start once per execution");
    await this.options.completeStage?.(this.options.preparationStage ?? "preparation", { contractHash: this.contract.hash,
      selectedCandidateHash: this.selectedCandidate ? creativeCandidateHash(this.contract.hash, this.selectedCandidate.shots) : null,
      approvedProductionSource: snapshot(authority) });
    this.productionStarted = true;
  }
  private async event(kind: string, payload: Recordish): Promise<void> {
    await this.options.onEvent?.({ kind, payload: { contractHash: this.contract.hash, ...payload } });
  }
  private cacheKey(stage: string, input: unknown): string {
    return creativeCacheKey({ scope: this.contract.scope, contractHash: this.contract.hash,
      upstreamHashes: [creativeHash(snapshot(input))], schemaVersion: this.options.nativeSchemaHash,
      model: this.options.model, promptVersion: CREATIVE_EXECUTOR_VERSION,
      policyVersion: CREATIVE_EXECUTOR_VERSION, config: { stage, fields: this.options.fields,
        selectedCandidateHash: this.selectedCandidate ? creativeCandidateHash(this.contract.hash, this.selectedCandidate.shots) : null } });
  }
  get omitUnverifiedMirrors(): boolean {
    return registeredProductReferenceOmitsMirrors(this.selectedCandidate?.trustedProductReferences);
  }
  private productReferenceContext(): string {
    const references = this.selectedCandidate?.trustedProductReferences;
    if (!references) return "";
    return `\n\n## 本次已登记商品原图参考用途回执\n`
      + `宿主已核对当前项目、意图、登记字节和本次 G1 的同源图。本回执仅授权使用以下已登记字节作为本项目外观参考；`
      + `G1 公开资料卡的 license_risk 和 licensed_for_delivery 原样适用其公开素材，无从本回执获得新的传播权。不得将两种来源混用。\n`
      + REGISTERED_PRODUCT_REFERENCE_DETAIL_RULE + (this.omitUnverifiedMirrors ? INSPECTED_RC_REFERENCE_DETAIL_RULE : "") + "\n"
      + creativeCanonical({ schemaVersion: "workloom.registered-product-reference/v1", scope: this.contract.scope,
        rawIntentSha256: this.contract.rawIntentHash, references }) + "\n";
  }
  selectionContext(): string | undefined {
    if (!this.selectedCandidate) return undefined;
    const { trustedProductReferences: _references, ...assessment } = this.selectedCandidate;
    return this.productReferenceContext() + `\n\n## 本次已独立评审的创意候选（仍须经过当前正式确认门）\n`
      + `这是同一合同下选定的创作来源，不是客户新指令或商品事实授权。后续主题、洞察与PRD应消费完整候选，允许按正式审核改进；不得把此候选直接标作G2/G3/G4批准。\n`
      + creativeCanonical({ contractHash: this.contract.hash,
        candidateHash: creativeCandidateHash(this.contract.hash, assessment.shots), assessment }) + "\n";
  }
  private async cached<T>(stage: string, input: unknown, validate: (value: T, fromCache: boolean) => void, operation: () => Promise<T>): Promise<T> {
    await this.assertCurrent(); const key = this.cacheKey(stage, input), found = await this.options.cache.read(key);
    if (found !== null) {
      const entry = object(found, "cache receipt");
      if (entry.key !== key || entry.contractHash !== this.contract.hash || entry.outputHash !== creativeHash(entry.output)) fail("CREATIVE_CACHE_CHANGED", "cached bytes or dependency identity changed");
      const output = snapshot(entry.output) as T; validate(output, true); await this.assertCurrent();
      await this.event("creative.cache.reused", { stage, key, outputHash: entry.outputHash }); return output;
    }
    await this.event("creative.stage.started", { stage, key });
    const output = snapshot(await operation()); validate(output, false); await this.assertCurrent();
    const outputHash = creativeHash(output);
    await this.options.cache.write(key, { schemaVersion: CREATIVE_EXECUTOR_VERSION, key,
      contractHash: this.contract.hash, outputHash, output });
    await this.event("creative.stage.completed", { stage, key, outputHash }); return output;
  }
  modelSlice(shotId: string): string {
    const source = this.sources.get(shotId);
    if (!source) fail("CREATIVE_SHOT_UNKNOWN", shotId);
    const ids = [...this.sources.keys()], index = ids.indexOf(shotId);
    const relevant = this.contract.constraints.filter(c => c.subject === "film" || c.subject === "shot"
      || this.contract.coverage.some(cov => cov.constraintId === c.id && this.planned.get(shotId)?.claimIds.includes(cov.claimId)));
    return `\n\n## 当前单镜创作合同切片（只处理 ${shotId}）\n${creativeCanonical({
      contractHash: this.contract.hash, rawIntent: this.contract.rawIntent, constraints: relevant,
      current: source, previous: index > 0 ? this.sources.get(ids[index - 1]!) ?? null : null,
      next: index + 1 < ids.length ? this.sources.get(ids[index + 1]!) ?? null : null,
      visualAuthority: this.options.visualAuthority ?? null,
    })}\n以下为本次已接受事实的完整原件，不是摘要；仅在批准用途内引用：\n${this.contract.facts?.content ?? "通用叙事不消费营销G1事实"}\n` + this.productReferenceContext();
  }
  private validateFields(shot: CreativeShot): CreativeFinding[] {
    const required = this.options.fields.requiredKeys ?? this.options.fields.keys;
    const keys = shot.id === this.titleShotId ? [...required, ...OPENING_TITLE_FIELDS] : required;
    return keys.flatMap(key => {
      const label = this.options.fields.labels[key]!, value = shot.fields[label];
      const source = this.sources.get(shot.id);
      if (key === "dialogue" && source?.dialogueFree === true) return [];
      const title = OPENING_TITLE_FIELDS.some(field => field === key);
      if (typeof value === "string" ? Boolean(value.trim()) && (!title || !/待片头优化器生成|需单独配置/u.test(value)) : !title && value !== null && value !== undefined
        && (typeof value !== "object" || Object.keys(value).length > 0)) return [];
      return [{ code: "CREATIVE_NATIVE_FIELD_MISSING", targetId: shot.id, fieldPath: `fields.${label}`,
        expected: "non-empty actual native field", actual: value ?? null, evidence: [this.options.nativeSchemaHash],
        ownerStage: "creative", allowedChanges: [`fields.${label}`], blocking: true }];
    });
  }
  private orderedFields(fields: Recordish): string[] {
    const registered = this.nativeFieldKeys().map(key => this.options.fields.labels[key]!).filter(label => Object.hasOwn(fields, label));
    return [...registered, ...Object.keys(fields).filter(label => !registered.includes(label)).sort()];
  }
  private nativeFieldKeys(): readonly string[] {
    return this.usesGeneratedTitle ? [...this.options.fields.keys, ...OPENING_TITLE_FIELDS] : this.options.fields.keys;
  }
  private project(native: Recordish): CreativeShot {
    if (native._workloomCreativeShot !== undefined || native._workloomCreativeCompiler !== undefined) fail("CREATIVE_FORGED_IR", "model/native input cannot issue host acceptance evidence");
    const shot = buildCreativeShots(this.contract, [snapshot(native)])[0]!;
    const allocation = this.planned.get(shot.id);
    if (allocation) {
      shot.claimIds = [...allocation.claimIds]; shot.informationTask = [...allocation.informationTask];
      shot.constraintIds = [...allocation.constraintIds];
    }
    const fields = object(native.fields, "native creative fields");
    shot.fields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [this.options.fields.labels[key] ?? key, snapshot(value)]));
    shot.fieldOrder = this.orderedFields(shot.fields);
    const source = this.sources.get(shot.id);
    if (!source) fail("CREATIVE_SHOT_UNKNOWN", shot.id);
    shot.sourceHash = creativeHash(source);
    return shot;
  }
  private assertNativeBinding(native: Recordish, ir: CreativeShot): void {
    const id = String(native.shotId ?? native.shot_id ?? ""), source = this.sources.get(id);
    if (!source || ir.id !== id || ir.contractHash !== this.contract.hash || ir.sourceHash !== creativeHash(source)
      || native.duration !== ir.duration || source.duration !== ir.duration) fail("CREATIVE_SHOT_STALE", "native shot identity, duration or source binding differs");
    const fields = object(native.fields, "accepted native fields");
    const normalized = Object.fromEntries(Object.entries(fields).map(([key, value]) => [this.options.fields.labels[key] ?? key, value]));
    if (creativeHash(normalized) !== creativeHash(ir.fields) || native.prompt !== this.render(ir)) fail("CREATIVE_COMPILED_CHANGED", "native fields/prompt differ from the accepted IR bytes");
    if (this.validateFields(ir).length) fail("CREATIVE_CACHE_INVALID", "accepted native fields no longer meet current schema");
  }
  private render(shot: CreativeShot): string {
    if (this.options.visualAuthority) assertProductVisualContent(this.options.visualAuthority, { fields: shot.fields, prompt: shot.prompt }, "creative-ir", this.omitUnverifiedMirrors);
    let prompt = compileCreativePrompt(this.contract, shot);
    if (this.contract.profile.visualMode === "abstract_without_product_appearance" && !prompt.includes(ABSTRACT_PRODUCT_RENDER_RULE)) prompt += `\n${ABSTRACT_PRODUCT_RENDER_RULE}`;
    if (this.options.visualAuthority) assertProductVisualContent(this.options.visualAuthority, prompt, "creative-compiled-prompt", this.omitUnverifiedMirrors);
    return prompt;
  }
  private async deriveTechnicalFields(native: Recordish): Promise<Recordish> {
    const output = snapshot(native), fields = object(output.fields, "native fields"), profile = this.contract.profile;
    const changes: Array<{ path: string; before: unknown; after: unknown; source: string }> = [];
    const normalize = (value: string) => value
      // Only explicit technical labels authorize a rewrite. Story clocks, ratios,
      // prices and artwork numbers must retain the model's exact bytes.
      .replace(/(?:画幅|宽高比|aspect\s*ratio)\s*[:：=]?\s*\d+\s*:\s*\d+/giu, `画幅${profile.aspectRatio}`)
      .replace(/\d+\s*:\s*\d+\s*(?:画幅|宽高比)/gu, `${profile.aspectRatio}画幅`)
      .replace(/(?:分辨率|resolution)\s*[:：=]?\s*(?:\d{3,5}\s*[x×]\s*\d{3,5}|\d{3,5}[pP]|\d+(?:\.\d+)?[kK])/giu, `分辨率${profile.resolution}`)
      .replace(/(?:\d{3,5}\s*[x×]\s*\d{3,5}|\d{3,5}[pP]|\d+(?:\.\d+)?[kK])\s*分辨率/gu, `${profile.resolution}分辨率`)
      .replace(/(?:帧率|frame\s*rate)\s*[:：=]?\s*\d+(?:\.\d+)?\s*(?:fps)?/giu, `帧率${profile.frameRate}fps`)
      .replace(/\d+(?:\.\d+)?\s*(?:fps|帧\s*\/\s*秒)/giu, `${profile.frameRate}fps`);
    if (this.options.fields.keys.includes("constraint")) {
      const before = fields.constraint ?? null;
      const original = typeof before === "string" ? normalize(before) : "";
      const technical = `${profile.aspectRatio}画幅，${profile.resolution}分辨率，${profile.frameRate}fps，MP4格式`;
      fields.constraint = original ? `${technical}；${original}` : technical;
      if (before !== fields.constraint) changes.push({ path: "fields.constraint", before, after: fields.constraint, source: this.contract.hash });
    }
    if (typeof fields.baseline === "string") {
      const before = fields.baseline, after = normalize(before);
      if (before !== after) { fields.baseline = after; changes.push({ path: "fields.baseline", before, after, source: this.contract.hash }); }
    }
    if (changes.length) await this.event("creative.technical.derived", { shotId: output.shotId ?? output.shot_id, changes,
      originalModelOutputHash: creativeHash(native) });
    return output;
  }
  private findings(shot: CreativeShot): CreativeFinding[] {
    // Film duration/count/coverage are checked against the complete set after all shots exist.
    return [...this.validateFields(shot), ...validateCreativeShots(this.contract, [shot])
      .filter(f => f.targetId === shot.id && f.code !== "CREATIVE_CLAIM_NOT_EXPRESSED")];
  }
  private async repair(initial: CreativeShot): Promise<CreativeShot> {
    let shot = initial, previousSignature: string | undefined;
    for (let attempt = 0; ; attempt++) {
      const findings = this.findings(shot);
      if (!findings.length) return shot;
      const signature = creativeHash(findings.map(f => ({ code: f.code, fieldPath: f.fieldPath, actual: f.actual })));
      await this.event("creative.shot.rejected", { shot: snapshot(shot), findings: snapshot(findings),
        visualAuthority: this.options.visualAuthority ?? null, attempt });
      if (attempt >= 2) fail("CREATIVE_REPAIR_LIMIT", "at most two local model patches per shot", findings);
      if (signature === previousSignature) fail("REPAIR_NO_PROGRESS", "same finding signature after a patch", findings);
      const allowed = [...new Set(findings.flatMap(f => f.allowedChanges))];
      if (!allowed.length) fail("CREATIVE_REPAIR_FORBIDDEN", "finding has no authorized local changes", findings);
      previousSignature = signature; await this.assertCurrent();
      await this.event("creative.repair.started", { shotId: shot.id, sourceHash: shot.sourceHash,
        attempt: attempt + 1, signature, allowedChanges: allowed });
      const raw = await this.options.generate(`只返回完整候选JSON。只允许修复以下镜头的这些字段，不得改变来源、镜号、约束、其他镜头或事实。\n`
        + `保留当前 fieldOrder，增加字段后的排序由宿主派生。\n`
        + `${this.modelSlice(shot.id)}\n问题：${creativeCanonical(findings)}\n允许路径：${creativeCanonical(allowed)}\n当前候选：${creativeCanonical(shot)}`, shot);
      const candidate = snapshot(object(raw, "local patch candidate")) as unknown as CreativeShot;
      const actualDiff = validatePatchDelta(shot, candidate, allowed);
      const previousOrder = candidate.fieldOrder;
      candidate.fieldOrder = this.orderedFields(candidate.fields);
      const beforeHash = creativeHash(shot); this.render(candidate); await this.assertCurrent();
      candidate.revision = shot.revision + 1; candidate.parentHash = beforeHash;
      await this.event("creative.repair.applied", { shotId: shot.id, attempt: attempt + 1, beforeHash,
        afterHash: creativeHash(candidate), actualDiff,
        ...(creativeHash(previousOrder) !== creativeHash(candidate.fieldOrder) ? { derivedFieldOrder: candidate.fieldOrder } : {}),
        remainingFindings: this.findings(candidate).map(f => f.code) });
      shot = candidate;
    }
  }
  async executePhase3(stateValue: unknown, agentValue: unknown): Promise<Recordish> {
    await this.options.beginStage?.("phase3");
    const state = object(stateValue, "phase3 state"), agent = object(agentValue, "native fusion agent");
    if (!Array.isArray(state.shots) || !state.shots.length || typeof agent._fuseSingleShot !== "function") fail("CREATIVE_NATIVE_UNAVAILABLE", "real single-shot fusion seam missing");
    const blueprint = object(state.adaptedBlueprint, "adapted blueprint");
    const sources = (state.shots as unknown[]).map(value => snapshot(object(value, "source shot")));
    this.sources.clear(); this.accepted.clear(); this.planned.clear(); this.compiledVerified = false;
    for (const source of sources) {
      const id = String(source.shotId ?? source.shot_id ?? "");
      if (!id || this.sources.has(id)) fail("CREATIVE_SHOT_ID_INVALID", "missing or duplicate native id");
      this.sources.set(id, source);
    }
    this.titleShotId = this.usesGeneratedTitle ? [...this.sources.entries()].find(([id, shot]) =>
      shot.sceneType === "opening" || /^(S?C?00($|-|_)|OP|opening|intro)/i.test(id))?.[0] ?? this.sources.keys().next().value : undefined;
    const plan = buildCreativeShots(this.contract, sources);
    const timing = validateCreativeShots(this.contract, plan).filter(f => ["CREATIVE_SHOT_COUNT_INVALID", "CREATIVE_SHOT_DURATION", "CREATIVE_DURATION_SUM"].includes(f.code));
    if (timing.length) fail("CREATIVE_NATIVE_PLAN_INFEASIBLE", "actual source timing or count violates the contract", timing);
    for (const shot of plan) this.planned.set(shot.id, shot);
    const outputs: Recordish[] = [];
    for (const [id, source] of this.sources) {
      const context = executions.getStore()!;
      const output = await executions.run({ ...context, phase: "phase3", shotId: id }, () => this.cached<Recordish>(`shot:${id}`, { source, blueprint }, (candidate, fromCache) => {
        if (candidate.shotId !== id || candidate.degraded === true || !candidate.fields || !candidate.prompt) fail("CREATIVE_CACHE_INVALID", "not a complete accepted shot");
        const ir = snapshot(object(candidate._workloomCreativeShot, "trusted cache IR")) as unknown as CreativeShot;
        if (!fromCache && creativeHash(ir) !== creativeHash(this.accepted.get(id))) fail("CREATIVE_FORGED_IR", "output was not issued by this invocation");
        this.assertNativeBinding(candidate, ir); this.accepted.set(id, ir);
      }, async () => {
        const view = Object.create(agent) as Recordish;
        view.llmMaxRetries = 0; view._callBudget = new Map();
        view._callLLM = async (prompt: unknown, schema: unknown) => {
          let modelPrompt = String(prompt), modelSchema = schema;
          if (id === this.titleShotId) {
            const titleSchema = snapshot(object(schema, "opening title schema"));
            const template = Array.isArray(titleSchema.shots) ? object(titleSchema.shots[0], "opening shot template") : fail("CREATIVE_SCHEMA_UNVERIFIED", "opening shot template is missing");
            const fields = object(template.fields, "opening shot fields");
            for (const key of OPENING_TITLE_FIELDS) fields[key] = "string";
            modelSchema = titleSchema;
            modelPrompt += "\n客户要求片头标题。仅当前片头镜头生成正式主标题、副标题、标题动画、字体设计和开场音效。把五项写入当前 fields，保留客户原文和制作合同，不使用占位。";
          }
          const result = object(await this.options.generate(modelPrompt, modelSchema), "single-shot model envelope");
          if (!Array.isArray(result.shots) || result.shots.length !== 1) fail("CREATIVE_MODEL_SCOPE_CHANGED", "model must return exactly the current shot");
          const entry = object(result.shots[0], "single-shot model output"), fields = object(entry.fields, "single-shot model fields");
          if (entry.shotId !== id) fail("CREATIVE_MODEL_SCOPE_CHANGED", "model changed the current shot identity");
          if ([result, entry, fields].some(value => Object.keys(value).some(key => /^_workloomCreative/i.test(key)))) {
            fail("CREATIVE_FORGED_IR", "model may not issue host acceptance evidence");
          }
          if (id !== this.titleShotId && OPENING_TITLE_FIELDS.some(key => Object.hasOwn(fields, key) || Object.hasOwn(fields, this.options.fields.labels[key] ?? key))) {
            fail("CREATIVE_MODEL_SCOPE_CHANGED", "opening title fields are outside this shot's declared scope");
          }
          return { result, degraded: false };
        };
        // Missing fields are handled by one bounded, diff-checked local repair policy.
        view._ensureFieldCompleteness = async (_source: unknown, fields: unknown) => ({ fields, usedRuleFallback: false });
        view._finalizeShotResult = async (_source: unknown, output: unknown) => output;
        view._assembleStandardPrompt = (_source: unknown, fieldsValue: unknown) => Object.entries(object(fieldsValue, "native model fields"))
          .map(([key, value]) => `【${this.options.fields.labels[key] ?? key}】${typeof value === "string" ? value : creativeCanonical(value)}`).join("\n");
        if (agent.consistencyChecker && typeof agent.consistencyChecker === "object") {
          const checker = Object.create(agent.consistencyChecker) as Recordish;
          checker.autoFix = (value: unknown) => value; view.consistencyChecker = checker;
        }
        const config = object(blueprint.config ?? {}, "blueprint config"), cast = object(blueprint.character_system ?? {}, "blueprint cast");
        // The native deadline wrapper owns a hidden retry loop. Call its actual
        // one-request implementation once; transport deadlines and the trusted
        // journal own timeout, cancellation and any subsequent local repair.
        const raw = object(await Reflect.apply(agent._fuseSingleShot as (...args: unknown[]) => unknown, view,
          [snapshot(source), config.aspectRatio ?? this.contract.profile.aspectRatio, cast.characters ?? [], blueprint, 300_000]), "native fused shot");
        if (raw.degraded === true || raw.degradeReason || raw.degradedReason || raw.error) fail("CREATIVE_MODEL_UNVERIFIED", "native fusion returned fallback or unverified output");
        const derived = await this.deriveTechnicalFields(raw);
        const ir = await this.repair(this.project(derived));
        const prompt = this.render(ir);
        const fields = Object.fromEntries(Object.entries(ir.fields).map(([label, value]) => [this.nativeFieldKeys().find(key => this.options.fields.labels[key] === label) ?? label, value]));
        this.accepted.set(id, ir);
        return { ...raw, ...fields, fields, prompt, promptCharCount: prompt.length, degraded: false,
          ...(id === this.titleShotId ? { title: fields.title_content, subtitle: fields.subtitle_content } : {}),
          _workloomCreativeShot: snapshot(ir), _workloomCreativeCompiler: { version: CREATIVE_EXECUTOR_VERSION, contractHash: this.contract.hash, promptHash: creativeHash(prompt) } };
      }));
      await this.event("creative.shot.accepted", { shotId: id, shotHash: creativeHash(this.accepted.get(id)), sourceHash: creativeHash(source) });
      outputs.push(output);
    }
    const irs = [...this.accepted.values()];
    const allFindings = validateCreativeShots(this.contract, irs);
    if (allFindings.some(f => f.blocking)) fail("CREATIVE_FILM_UNVERIFIED", "complete film contract did not pass", allFindings);
    const result = object(state.result, "phase3 result");
    const stages = object(result.stages ?? {}, "phase3 stages");
    stages.phase3Fusion = { status: "passed", executor: CREATIVE_EXECUTOR_VERSION, contractHash: this.contract.hash,
      shotHashes: irs.map(shot => ({ id: shot.id, sourceHash: shot.sourceHash, outputHash: creativeHash(shot) })) };
    result.stages = stages;
    const output = { success: true, shots: outputs, result, timing: 0 };
    await this.options.completeStage?.("phase3", snapshot(output)); return output;
  }
  async nativePhase(stage: string, stateValue: unknown, operation: () => Promise<unknown>): Promise<unknown> {
    const state = object(stateValue, `${stage} state`);
    const ownedStages = stage === "phase1" ? ["opening"] : stage === "phase2" ? ["continuity", "boundaryReport"] : [];
    if (!ownedStages.length) fail("CREATIVE_STAGE_UNSUPPORTED", stage);
    const blueprintFields = stage === "phase1" ? ["genre", "mood", "theme", "targetAudience", "description", "filmDirector", "filmDirectorSource"] : [];
    await this.options.beginStage?.(stage);
    const output = await this.cached<Recordish>(stage, { shots: state.shots, adaptedBlueprint: state.adaptedBlueprint }, value => {
      if (value.success !== true || !Array.isArray(value.shots) || value.degraded === true) fail("CREATIVE_STAGE_UNVERIFIED", stage);
      const semantic = object(value.semantic, "phase semantic delta"), stageValues = object(semantic.stages, "phase owned stages");
      if (Object.keys(stageValues).some(key => !ownedStages.includes(key))
        || Object.keys(semantic).some(key => !["stages", ...(stage === "phase1" ? ["opening"] : [])].includes(key))
        || Object.keys(object(value.blueprintDelta, "blueprint delta")).some(key => !blueprintFields.includes(key))) fail("CREATIVE_CACHE_INVALID", "phase cache attempts to restore non-owned state");
    }, async () => {
      const native = object(await operation(), `${stage} output`);
      if (native.success !== true || !Array.isArray(native.shots) || native.degraded === true) fail("CREATIVE_STAGE_UNVERIFIED", stage);
      const result = object(native.result, "native phase result"), stages = object(result.stages, "native phase stages");
      const blueprint = object(state.adaptedBlueprint, "phase blueprint");
      return { success: true, shots: native.shots, semantic: {
        stages: Object.fromEntries(ownedStages.filter(key => Object.hasOwn(stages, key)).map(key => [key, stages[key]])),
        ...(stage === "phase1" && Object.hasOwn(result, "opening") ? { opening: result.opening } : {}),
      }, blueprintDelta: Object.fromEntries(blueprintFields.filter(key => Object.hasOwn(blueprint, key)).map(key => [key, blueprint[key]])) };
    });
    const target = object(state.result, "phase result"), semantic = object(output.semantic, "phase semantic delta");
    Object.assign(object(target.stages, "current phase stages"), semantic.stages);
    if (stage === "phase1" && Object.hasOwn(semantic, "opening")) target.opening = semantic.opening;
    Object.assign(object(state.adaptedBlueprint, "current blueprint"), output.blueprintDelta);
    const response = { success: true, shots: output.shots, result: target, timing: 0 };
    await this.options.completeStage?.(stage, snapshot(response)); return response;
  }
  private assertCompiledShots(shots: unknown): void {
    if (!Array.isArray(shots) || shots.length !== this.accepted.size) fail("CREATIVE_STAGE_UNVERIFIED", "compiled shot set changed");
    const seen = new Set<string>();
    const expectedOrder = [...this.accepted.keys()];
    for (const [index, value] of shots.entries()) {
      const shot = object(value, "compiled shot"), id = String(shot.shotId ?? shot.shot_id ?? ""), ir = this.accepted.get(id);
      if (!ir || seen.has(id)) fail("CREATIVE_SHOT_UNVERIFIED", "missing or duplicate private acceptance for this shot");
      if (id !== expectedOrder[index]) fail("CREATIVE_SHOT_ORDER_CHANGED", "accepted shot order changed");
      seen.add(id);
      this.assertNativeBinding(shot, ir);
    }
    if (seen.size !== this.accepted.size || [...this.accepted.keys()].some(id => !seen.has(id))) fail("CREATIVE_SHOT_UNVERIFIED", "accepted shot set is incomplete");
    const findings = validateCreativeShots(this.contract, [...this.accepted.values()]);
    if (findings.some(f => f.blocking)) fail("CREATIVE_FILM_UNVERIFIED", "current complete film contract failed", findings);
  }
  /** Reassembly may retain accepted bytes; it may not apply a legacy template. */
  compiledPromptFor(shotValue: unknown, fields: unknown): string {
    if (!this.compiledVerified) fail("CREATIVE_STAGE_UNVERIFIED", "compiled verification did not complete");
    const shot = object(shotValue, "prompt reassembly input"), ir = this.accepted.get(String(shot.shotId ?? shot.shot_id ?? ""));
    if (!ir || creativeHash(fields) !== creativeHash(shot.fields)) fail("CREATIVE_COMPILED_CHANGED", "reassembly input is not the accepted field set");
    this.assertNativeBinding(shot, ir);
    return this.render(ir);
  }
  /** DirectorSkills owns advice metadata. The reviewed IR owns supplier text. */
  keepDirectorAdvice(shotsValue: unknown, promptsValue: unknown): void {
    if (!this.compiledVerified || !Array.isArray(shotsValue) || !Array.isArray(promptsValue)) {
      fail("CREATIVE_STAGE_UNVERIFIED", "director advice requires a compiled shot set");
    }
    this.assertCompiledShots(promptsValue);
    const projections = shotsValue.map((value, index) => {
      const shot = object(value, "director advice shot"), prompt = object(promptsValue[index], "current compiled prompt");
      const projected = { ...shot, prompt: prompt.prompt, promptCharCount: String(prompt.prompt).length };
      return { shot, prompt, projected };
    });
    // Only restore text after every proposed shot still binds to its accepted fields,
    // duration and position. Other legacy stages cannot borrow this named seam.
    this.assertCompiledShots(projections.map(({ projected }) => projected));
    for (const { shot, prompt, projected } of projections) {
      shot.prompt = projected.prompt;
      shot.promptCharCount = projected.promptCharCount;
      if (Object.hasOwn(prompt, "_generatedPrompt")) shot._generatedPrompt = prompt._generatedPrompt;
      else delete shot._generatedPrompt;
    }
  }
  get usesGeneratedTitle(): boolean {
    const brief = this.contract.sourceMetadata.brief;
    const production = brief && typeof brief === "object" && !Array.isArray(brief) ? (brief as Recordish).productionRequirements : undefined;
    const titleCard = production && typeof production === "object" ? (production as Recordish).titleCard : undefined;
    if (typeof titleCard === "boolean") return titleCard;
    const raw = this.contract.rawIntent;
    return [...raw.matchAll(/(?:片头|开场)\s*(?:加上?|加入|显示|展示|保留|需要)\s*(?:一个)?\s*(?:主|副)?标题(?:卡)?/gu)]
      .some(match => !/(?:不|禁止|不要|无需|取消)[^，。；\n]{0,8}$/u.test(raw.slice(Math.max(0, match.index - 12), match.index)));
  }
  /** Retain the native check while preventing its legacy formatting from rewriting the IR. */
  reviewLegacyPromptAdvice(prompts: unknown, resultValue: unknown): Recordish {
    this.assertCompiledShots(prompts);
    const result = object(resultValue, "legacy prompt review");
    if (!Array.isArray(result.fixes) || result.safe !== true || result.fixes.some(fix => object(fix, "legacy prompt finding").type === "sensitive_word")) {
      const error = new CreativeContractError("CREATIVE_PROMPT_GUARD_REJECTED", "native prompt guard found unsafe content");
      const context = executions.getStore();
      if (context) context.state.fatal ??= error;
      throw error;
    }
    return { ...result, prompts, fixes: [], advisoryFixes: result.fixes };
  }
  async verifyHandoff(shots: unknown): Promise<void> {
    await this.assertCurrent();
    if (!this.compiledVerified) fail("CREATIVE_STAGE_UNVERIFIED", "compiled verification did not complete");
    this.assertCompiledShots(shots);
  }
  async verifyCompiledPhase(stateValue: unknown): Promise<Recordish> {
    await this.options.beginStage?.("phase3.5"); await this.assertCurrent();
    const state = object(stateValue, "compiled field verification"), shots = state.shots;
    this.assertCompiledShots(shots);
    const result = object(state.result, "compiled result");
    object(result.stages, "compiled stages").creativeFieldVerification = { status: "passed", executor: CREATIVE_EXECUTOR_VERSION,
      contractHash: this.contract.hash, semanticReview: "pending-existing-G6-G7" };
    const output = { success: true, shots, result, timing: 0 };
    await this.options.completeStage?.("phase3.5", snapshot(output));
    await this.options.beginStage?.("final");
    this.compiledVerified = true;
    return output;
  }
}

/** The archive remains a byte store; the execution journal records every accepted reuse. */
export function creativeArchiveCache(store: {
  readJson(ref: string): Promise<unknown | null>;
  writeJsonAtomic(ref: string, value: unknown): Promise<unknown>;
}): CreativeCache {
  const ref = (key: string) => { if (!/^[a-f0-9]{64}$/.test(key)) fail("CREATIVE_CACHE_KEY_INVALID", key); return `creative-cache/${key}.json`; };
  return { read: key => store.readJson(ref(key)), write: async (key, value) => { await store.writeJsonAtomic(ref(key), value); } };
}
