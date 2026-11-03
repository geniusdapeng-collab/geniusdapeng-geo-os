import { createHash } from "node:crypto";

export const CREATIVE_CONTRACT_VERSION = "workloom.creative-contract/v1" as const;
export const CREATIVE_COMPILER_VERSION = "1";
export interface CreativeScope { tenantId: string; workspaceId: string; projectId: string }
export interface CreativeConstraint {
  id: string; version: 1; source: "customer" | "fact" | "system" | "provider";
  sourceRef: string; subject: "film" | "coverage" | "shot"; predicate: string;
  severity: "hard" | "soft" | "post_render"; applicability: "applicable" | "not_applicable";
  basis: string; ownerStage: string; repairScope: string[]; verificationMethod: string;
  value: unknown;
}
export interface CreativeFinding {
  code: string; targetId: string; fieldPath: string; expected: unknown; actual: unknown;
  evidence: string[]; ownerStage: string; allowedChanges: string[]; blocking: boolean;
}
export interface CreativeProfile {
  finalDuration: number; contentDuration: number; coverIntroSeconds: number;
  aspectRatio: string; frameRate: number; resolution: string; subtitleMode: string;
  visualMode: "abstract_without_product_appearance" | "verified_product_appearance" | "no_named_product";
  minShotSeconds: number; maxShotSeconds: number; minShots: number; maxShots: number;
}
export interface CreativeFactInput {
  /** Complete accepted-current source bytes, supplied by the private authority closure. */
  content: string; hash: string; claims: Array<{ id: string; text: string; sourceRef: string }>;
  validUntil?: string;
}
export interface CreativeContract {
  schemaVersion: typeof CREATIVE_CONTRACT_VERSION; compilerVersion: string;
  scope: CreativeScope; revision: number; hash: string; rawIntent: string; rawIntentHash: string;
  sourceMetadata: Record<string, unknown>; sourceMetadataHash: string;
  requiredFields: string[]; requestedClaimIds: string[];
  route: "marketing" | "narrative"; profile: CreativeProfile; constraints: CreativeConstraint[];
  facts: CreativeFactInput | null;
  feasibility: { status: "feasible" | "blocked" | "needs_input"; findings: CreativeFinding[] };
  coverage: Array<{ constraintId: string; claimId: string; text: string; sourceRef: string }>;
}
export interface CompileCreativeInput {
  scope: CreativeScope; rawIntent: string; metadata?: Record<string, unknown>; isMarketing?: boolean;
  revision?: number; facts?: CreativeFactInput; requiredClaimIds?: string[]; requiredFields?: string[];
  bounds?: Partial<Pick<CreativeProfile, "minShotSeconds" | "maxShotSeconds" | "minShots" | "maxShots">>;
  /** A resolved native profile can be supplied only by the current authority bridge. */
  profile?: Record<string, unknown>;
}
export interface CreativeShot {
  schemaVersion: "workloom.creative-shot/v1"; id: string; sceneId: string; revision: number;
  contractHash: string; sourceHash: string; parentHash: string | null; duration: number;
  purpose: string; informationTask: string[]; claimIds: string[]; subject: string; action: string;
  visual: string; sound: string; textLayers: string[]; assetRefs: string[];
  constraintIds: string[]; fields: Record<string, unknown>; fieldOrder: string[]; prompt: string;
}
export class CreativeContractError extends Error {
  readonly retryable = false;
  constructor(readonly code: string, message: string, readonly findings: CreativeFinding[] = []) {
    super(`${code}: ${message}`); this.name = "CreativeContractError";
  }
}
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const fail = (code: string, message: string): never => { throw new CreativeContractError(code, message); };

/** Canonical JSON rejects values that cannot survive a durable receipt round trip. */
export function creativeCanonical(value: unknown): string {
  const active = new Set<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) fail("CREATIVE_JSON_INVALID", "invalid Unicode");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) fail("CREATIVE_JSON_INVALID", "non-finite number"); return v; }
    if (!v || typeof v !== "object" || active.has(v)) fail("CREATIVE_JSON_INVALID", "non-JSON or cyclic value");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) fail("CREATIVE_JSON_INVALID", "non-plain object");
    const object = v as object;
    active.add(object);
    const result = Array.isArray(v) ? v.map(walk) : Object.fromEntries(Object.keys(object).sort().map(k => {
      if (["__proto__", "constructor", "prototype"].includes(k)) fail("CREATIVE_JSON_INVALID", "unsafe key");
      return [k, walk((v as Record<string, unknown>)[k])];
    }));
    active.delete(object); return result;
  };
  return JSON.stringify(walk(value));
}
export const creativeHash = (value: unknown): string => createHash("sha256").update(creativeCanonical(value)).digest("hex");
export const creativeTextHash = (value: string): string => createHash("sha256").update(value).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function finding(code: string, fieldPath: string, expected: unknown, actual: unknown, allowedChanges: string[] = [], targetId = "film"): CreativeFinding {
  return { code, targetId, fieldPath, expected, actual, evidence: [], ownerStage: "creative", allowedChanges, blocking: true };
}
function finite(v: unknown, fallback: number): number { return v === undefined ? fallback : typeof v === "number" && Number.isFinite(v) ? v : 0; }
function explicitDurations(raw: string): number[] {
  const value = String.raw`(-?\d+(?:\.\d+)?|[一两二三四五六七八九]?十[一二三四五六七八九]?|[一两二三四五六七八九半]|one|two|three|half)\s*[- ]?\s*(秒(?:钟)?|分钟?|sec(?:onds?)?|min(?:utes?)?)`;
  const scopedToPart = (m: RegExpMatchArray) => /(?:封面|片头|片尾|单镜|每(?:镜|段|个镜头)|cover|intro|outro|per shot)[^，。；;\n]{0,10}$/iu
    .test(raw.slice(Math.max(0, (m.index ?? 0) - 24), m.index));
  const anchored = [...raw.matchAll(new RegExp(String.raw`(?:成片(?:总?时长)?|最终时长|总时长|片长|全长|总长|时长|(?:final\s+|total\s+)?duration)\s*[:：为]?\s*` + value, "giu"))]
    .filter(m => !scopedToPart(m) || /^(?:成片|最终|总|全长|(?:final|total)\s)/iu.test(m[0]));
  const matches = anchored.length ? anchored : [...raw.matchAll(new RegExp(String.raw`(?<![\d一两二三四五六七八九十A-Za-z])` + value + String.raw`(?:的|长|短片|视频|故事|[- ](?:long|film|video|story))`, "giu"))]
    .filter(m => !scopedToPart(m));
  const numerals: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 半: 0.5, one: 1, two: 2, three: 3, half: 0.5 };
  return [...new Set(matches.map(m => {
    const rawValue = m[1]!.toLowerCase();
    const [tens, ones] = rawValue.split("十");
    const amount = rawValue.includes("十") ? (numerals[tens!] ?? 1) * 10 + (numerals[ones!] ?? 0)
      : numerals[rawValue] ?? Number(rawValue);
    return finite(amount * (/分|min/iu.test(m[2]!) ? 60 : 1), 0);
  }))];
}

/** Only a declared exhaustive uniform shot plan establishes content duration. */
function explicitShotPlans(raw: string): Array<{ count: number; durationSeconds: number }> {
  const plan = /(?:恰好|仅有|仅含|总共|exactly)\s*(\d{1,2})\s*(?:个|段|[×x*])\s*(\d{1,3}(?:\.\d+)?)\s*(?:秒(?:钟)?|sec(?:onds?)?)\s*(?:镜头段|镜头|段|shots?)/giu;
  const unique = new Map<string, { count: number; durationSeconds: number }>();
  for (const match of raw.matchAll(plan)) {
    const count = Number(match[1]), durationSeconds = Number(match[2]);
    unique.set(`${count}:${durationSeconds}`, { count, durationSeconds });
  }
  return [...unique.values()];
}

/** Read the schedule from the immutable customer intent already in the contract. */
export function explicitCreativeShotPlan(contract: CreativeContract) {
  const plans = explicitShotPlans(contract.rawIntent);
  if (plans.length > 1) fail("CONSTRAINT_CONFLICT", "conflicting exhaustive shot schedules");
  return plans[0];
}

function sourceContainsClaims(content: string, claims: CreativeFactInput["claims"]): boolean {
  const missing = claims.filter(claim => !content.includes(claim.text));
  if (!missing.length) return true;
  // Native G1 is JSON. The retained bytes still define authority; verify escaped
  // source text against its decoded values without reserializing those bytes.
  let decoded: unknown;
  try { decoded = JSON.parse(content); } catch { return false; }
  const stack = [decoded];
  while (stack.length && missing.length) {
    const value = stack.pop();
    if (typeof value === "string") {
      for (let i = missing.length - 1; i >= 0; i--) if (value.includes(missing[i]!.text)) missing.splice(i, 1);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) stack.push(child);
    }
  }
  return missing.length === 0;
}

/** This compiler never grants fact, identity, render or spending authorization. */
export function compileCreativeContract(input: CompileCreativeInput): CreativeContract {
  for (const [key, value] of Object.entries(input.scope)) if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) fail("CREATIVE_SCOPE_INVALID", key);
  if (Object.keys(input.scope).sort().join() !== "projectId,tenantId,workspaceId") fail("CREATIVE_SCOPE_INVALID", "scope fields");
  if (!input.rawIntent?.trim() || input.rawIntent.length > 200_000) fail("CREATIVE_INTENT_INVALID", "完整原文缺失或超限");
  const revision = input.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) fail("CREATIVE_REVISION_INVALID", "revision");
  const metadata = input.metadata ?? {}, brief = record(metadata.brief), production = record(brief.productionRequirements);
  const sourceMetadata = structuredClone(metadata), sourceMetadataHash = creativeHash(sourceMetadata);
  const resolved = input.profile ?? {};
  const rawDurations = explicitDurations(input.rawIntent), rawDuration = rawDurations.length === 1 ? rawDurations[0] : undefined;
  const declaredDurations = Object.entries({ "brief.duration": brief.duration,
    "metadata.durationSec": metadata.durationSec, "metadata.durationSeconds": metadata.durationSeconds })
    .filter(([, value]) => value !== undefined).map(([field, value]) => ({
      field, seconds: typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? finite(Number(value), 0) : finite(value, 0),
    }));
  const declared = declaredDurations[0];
  const coverIntroSeconds = (resolved.openWithCover ?? production.openWithCover) === true
    ? finite(resolved.coverIntroSeconds ?? production.coverIntroSeconds, 0) : 0;
  const shotPlans = explicitShotPlans(input.rawIntent), shotPlan = shotPlans.length === 1 ? shotPlans[0] : undefined;
  const contentDuration = shotPlan && Number((shotPlan.count * shotPlan.durationSeconds).toFixed(6));
  const expectedDuration = declared?.seconds ?? rawDuration
    ?? (contentDuration === undefined ? undefined : contentDuration + coverIntroSeconds);
  const finalDuration = finite(resolved.targetDuration, expectedDuration ?? 30);
  const visual = resolved.visualMode ?? production.visualMode;
  const namedProduct = Boolean(brief.product || (Array.isArray(brief.products) && brief.products.length));
  const rawRatios = [...new Set([...input.rawIntent.matchAll(/(?<!\d)(16\s*[:：]\s*9|9\s*[:：]\s*16|1\s*[:：]\s*1|4\s*[:：]\s*3|3\s*[:：]\s*4)(?!\d)/gu)].map(m => m[1]!.replace(/\s/g, "").replace("：", ":")))];
  const aspect = brief.aspectRatio ?? brief.aspect_ratio ?? production.aspectRatio;
  const profile: CreativeProfile = {
    finalDuration, contentDuration: finalDuration - coverIntroSeconds, coverIntroSeconds,
    aspectRatio: text(resolved.aspectRatio ?? aspect) || (rawRatios.length === 1 ? rawRatios[0]! : "9:16"),
    frameRate: finite(resolved.frameRate ?? production.frameRate ?? brief.frameRate, 30),
    resolution: text(resolved.resolution ?? production.resolution ?? brief.resolution) || "1080p",
    subtitleMode: text(resolved.subtitleMode ?? production.subtitleMode ?? brief.subtitleMode) || "none",
    visualMode: visual === "abstract_without_product_appearance" ? visual : namedProduct ? "verified_product_appearance" : "no_named_product",
    minShotSeconds: input.bounds?.minShotSeconds ?? 3, maxShotSeconds: input.bounds?.maxShotSeconds ?? 15,
    minShots: input.bounds?.minShots ?? 1, maxShots: input.bounds?.maxShots ?? 60,
  };
  const findings: CreativeFinding[] = [], constraints: CreativeConstraint[] = [];
  // A native projection is a derived value, never a new customer authority.
  // Detect disagreements before a model request instead of silently adopting it.
  const preserve = (path: string, expected: unknown, actual: unknown): void => {
    if (expected !== undefined && creativeCanonical(expected) !== creativeCanonical(actual)) findings.push(finding("CONSTRAINT_CONFLICT", path, expected, actual));
  };
  preserve("profile.finalDuration", expectedDuration, finalDuration);
  for (const alias of declaredDurations.slice(1)) preserve(alias.field, declared?.seconds, alias.seconds);
  if (contentDuration !== undefined) preserve("intent.contentDuration", contentDuration, Number(profile.contentDuration.toFixed(6)));
  if (shotPlans.length > 1) findings.push(finding("CONSTRAINT_CONFLICT", "intent.shotPlan", "one exhaustive shot schedule", shotPlans));
  for (const value of [brief.aspectRatio, brief.aspect_ratio, production.aspectRatio]) preserve("profile.aspectRatio", value, profile.aspectRatio);
  for (const key of ["frameRate", "resolution", "subtitleMode"] as const) {
    preserve(`profile.${key}`, production[key], profile[key]);
    preserve(`profile.${key}`, brief[key], profile[key]);
  }
  preserve("profile.openWithCover", production.openWithCover, (resolved.openWithCover ?? production.openWithCover) === true);
  if (production.openWithCover === true) preserve("profile.coverIntroSeconds", production.coverIntroSeconds, coverIntroSeconds);
  preserve("profile.visualMode", production.visualMode, profile.visualMode);
  if (rawRatios.length === 1) preserve("profile.aspectRatio", rawRatios[0], profile.aspectRatio);
  if (rawRatios.length > 1) findings.push(finding("CONSTRAINT_CONFLICT", "profile.aspectRatio", "one whole-film aspect ratio", rawRatios));
  if (rawDurations.length > 1) findings.push(finding("CONSTRAINT_CONFLICT", "intent.finalDuration", "one whole-film duration", rawDurations));
  const requestedCover = resolved.coverIntroSeconds ?? production.coverIntroSeconds;
  if (requestedCover !== undefined && (typeof requestedCover !== "number" || !Number.isFinite(requestedCover))) {
    findings.push(finding("CONSTRAINT_DURATION_INVALID", "profile.coverIntroSeconds", "finite number of seconds", typeof requestedCover === "number" ? null : requestedCover));
  }
  const rawIntentHash = creativeTextHash(input.rawIntent);
  const add = (id: string, value: unknown, source: CreativeConstraint["source"], subject: CreativeConstraint["subject"] = "film", severity: CreativeConstraint["severity"] = "hard") => {
    constraints.push({ id, version: 1, source, sourceRef: source === "customer" ? `intent:${rawIntentHash};metadata:${sourceMetadataHash}` : `${source}:creative/v1`, subject,
      predicate: id, severity, applicability: "applicable", basis: source === "customer" ? "Explicit customer input retained verbatim" : "Versioned host contract", ownerStage: "creative",
      repairScope: source === "customer" || source === "fact" ? [] : ["duration", "fields", "prompt"], verificationMethod: severity === "post_render" ? "media-measurement" : "deterministic-and-source-review", value });
  };
  add("duration.final", finalDuration, expectedDuration !== undefined ? "customer" : "system");
  add("duration.content", profile.contentDuration, "system");
  for (const key of ["aspectRatio", "frameRate", "resolution", "subtitleMode"] as const) {
    const explicit = key === "aspectRatio" ? aspect !== undefined || rawRatios.length === 1 : Object.hasOwn(production, key) || Object.hasOwn(brief, key);
    add(`delivery.${key}`, profile[key], explicit ? "customer" : "system");
  }
  add("visual.mode", profile.visualMode, visual !== undefined ? "customer" : "system");
  if (profile.visualMode === "abstract_without_product_appearance") add("visual.no-product-appearance", true, "customer");
  for (const [key, value] of Object.entries(brief)) if (["style", "visualStyle", "colorPalette", "music", "voice", "references", "goal", "audience"].includes(key)) add(`customer.${key}`, value, "customer");
  add("creative.art-rubric", ["information-readability", "hook-payoff", "emotional-progression", "visual-variety", "brand-fit", "novelty"], "system", "film", "soft");
  add("media.actual-quality", "unverified-before-render", "system", "film", "post_render");
  if (!Number.isFinite(finalDuration) || finalDuration < 5 || finalDuration > 180 || !Number.isFinite(coverIntroSeconds) || coverIntroSeconds < 0 || coverIntroSeconds > 5 || profile.contentDuration <= 0) findings.push(finding("CONSTRAINT_DURATION_INVALID", "profile.contentDuration", "final 5..180; cover 0..5 and content >0", profile.contentDuration));
  if (declared && rawDuration !== undefined && declared.seconds !== rawDuration) {
    findings.push(finding("CONSTRAINT_CONFLICT", declared.field, rawDuration, declared.seconds));
  }
  if (!["16:9", "9:16", "1:1", "4:3", "3:4"].includes(profile.aspectRatio) || ![24, 25, 30, 60].includes(profile.frameRate) || !["1080p", "4K"].includes(profile.resolution) || !["none", "both", "burned", "sidecar"].includes(profile.subtitleMode)) findings.push(finding("CONSTRAINT_DELIVERY_INVALID", "profile", "supported delivery profile", profile));
  if (visual !== undefined && !["abstract_without_product_appearance", "verified_product_appearance", "no_named_product"].includes(String(visual))) findings.push(finding("CONSTRAINT_VISUAL_MODE_INVALID", "profile.visualMode", "known mode", visual));
  if (visual === "no_named_product" && namedProduct) findings.push(finding("CONSTRAINT_CONFLICT", "profile.visualMode", "named product cannot erase its authority", visual));
  const bounds = [profile.minShotSeconds, profile.maxShotSeconds, profile.minShots, profile.maxShots];
  if (bounds.some(n => !Number.isFinite(n) || n <= 0) || !Number.isInteger(profile.minShots) || !Number.isInteger(profile.maxShots) || profile.minShotSeconds > profile.maxShotSeconds || profile.minShots > profile.maxShots) fail("CREATIVE_SCHEMA_BOUNDS_INVALID", "invalid actual shot bounds");
  if (shotPlan && (shotPlan.count < profile.minShots || shotPlan.count > profile.maxShots
    || shotPlan.durationSeconds < profile.minShotSeconds || shotPlan.durationSeconds > profile.maxShotSeconds)) {
    findings.push(finding("CONSTRAINT_TIMING_INFEASIBLE", "intent.shotPlan", {
      count: [profile.minShots, profile.maxShots], durationSeconds: [profile.minShotSeconds, profile.maxShotSeconds],
    }, shotPlan));
  }
  if (Math.ceil(profile.contentDuration / profile.maxShotSeconds) > Math.floor(profile.contentDuration / profile.minShotSeconds) || profile.contentDuration < profile.minShots * profile.minShotSeconds || profile.contentDuration > profile.maxShots * profile.maxShotSeconds) findings.push(finding("CONSTRAINT_TIMING_INFEASIBLE", "profile.contentDuration", "duration allocation inside current bounds", profile.contentDuration));
  const facts = input.facts ? structuredClone(input.facts) : null;
  if (facts && (creativeTextHash(facts.content) !== facts.hash || !facts.content.trim() || new Set(facts.claims.map(c => c.id)).size !== facts.claims.length || facts.claims.some(c => !c.id || !c.sourceRef || !c.text) || !sourceContainsClaims(facts.content, facts.claims))) fail("FACT_EVIDENCE_INVALID", "fact bytes or claim provenance differ");
  if (facts?.validUntil && (!Number.isFinite(Date.parse(facts.validUntil)) || Date.parse(facts.validUntil) <= Date.now())) findings.push(finding("FACT_EVIDENCE_EXPIRED", "facts.validUntil", "current rights/source", facts.validUntil));
  const requiredClaimIds = input.requiredClaimIds ?? strings(brief.requiredClaimIds);
  if (new Set(requiredClaimIds).size !== requiredClaimIds.length || (facts && requiredClaimIds.some(id => !facts.claims.some(c => c.id === id)))) fail("FACT_COVERAGE_INVALID", "requested coverage must reference accepted claims");
  const coverage = (facts?.claims ?? []).filter(claim => requiredClaimIds.includes(claim.id)).map(claim => ({ constraintId: `claim.${claim.id}`, ...claim, claimId: claim.id }));
  for (const claim of coverage) {
    add(claim.constraintId, claim.text, "fact", "coverage");
    const constraint = constraints[constraints.length - 1]!;
    constraint.sourceRef = `fact:${facts!.hash};source:${claim.sourceRef}`;
    constraint.verificationMethod = "independent-semantic-review-of-current-shot-and-complete-source";
  }
  const requiredFields = [...(input.requiredFields ?? [])];
  if (new Set(requiredFields).size !== requiredFields.length || requiredFields.some(k => !/^[\p{L}\p{N}_ -]{1,80}$/u.test(k))) fail("CREATIVE_FIELD_SCHEMA_INVALID", "actual required field registry needed");
  const payload = { schemaVersion: CREATIVE_CONTRACT_VERSION, compilerVersion: CREATIVE_COMPILER_VERSION, scope: structuredClone(input.scope), revision, rawIntent: input.rawIntent, rawIntentHash, sourceMetadata, sourceMetadataHash, requiredFields, requestedClaimIds: requiredClaimIds,
    route: input.isMarketing ? "marketing" as const : "narrative" as const, profile, constraints, facts, coverage,
    feasibility: { status: findings.length ? "blocked" as const : (input.isMarketing || requiredClaimIds.length > 0) && !facts ? "needs_input" as const : "feasible" as const, findings } };
  return freeze({ ...payload, hash: creativeHash(payload) });
}

export function assertCreativeContract(contract: CreativeContract, options: { allowNeedsInput?: boolean } = {}): void {
  const { hash, ...payload } = contract;
  if (contract.schemaVersion !== CREATIVE_CONTRACT_VERSION || creativeHash(payload) !== hash) fail("CREATIVE_CONTRACT_STALE", "contract hash mismatch");
  if (contract.feasibility.status === "blocked") throw new CreativeContractError("CONSTRAINT_CONFLICT", "合同不可行", contract.feasibility.findings);
  if (contract.feasibility.status === "needs_input" && !options.allowNeedsInput) fail("FACT_EVIDENCE_MISSING", "营销事实或明确要求的claim尚未绑定；只可继续上游取证，不能开始镜头创作");
  if (contract.facts?.validUntil && Date.parse(contract.facts.validUntil) <= Date.now()) fail("FACT_EVIDENCE_EXPIRED", "current rights expired");
}

/** Project native creative content without inventing dialogue, facts, subjects or actions. */
export function buildCreativeShots(contract: CreativeContract, values: unknown[]): CreativeShot[] {
  assertCreativeContract(contract);
  if (!Array.isArray(values) || values.length === 0) fail("CREATIVE_SHOTS_MISSING", "shots missing");
  return values.map((value, index) => {
    const s = record(value), fields = structuredClone(record(s.fields));
    if (Object.keys(fields).some(k => !/^[\p{L}\p{N}_ -]{1,80}$/u.test(k))) fail("CREATIVE_FIELD_NAME_INVALID", "native field registry label required");
    const id = text(s.shotId ?? s.shot_id ?? s.id);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) fail("CREATIVE_SHOT_ID_INVALID", "stable native shot id required");
    const assigned = contract.coverage.filter((_c, i) => i % values.length === index);
    const prompt = text(s.prompt ?? s.enhanced_prompt);
    return { schemaVersion: "workloom.creative-shot/v1", id, sceneId: text(s.sceneId ?? s.scene_id) || id, revision: 1,
      contractHash: contract.hash, sourceHash: creativeHash(s), parentHash: null, duration: Number(s.duration),
      purpose: text(s.purpose ?? s.intent), informationTask: assigned.map(c => c.constraintId), claimIds: assigned.map(c => c.claimId),
      subject: text(s.subject), action: text(s.action), visual: prompt, sound: text(s.sound ?? s.audio),
      textLayers: strings(s.textLayers), assetRefs: strings(s.assetRefs), constraintIds: contract.constraints.filter(c => c.subject === "film").map(c => c.id).concat(assigned.map(c => c.constraintId)), fields,
      fieldOrder: strings(s.fieldOrder).length ? strings(s.fieldOrder) : Object.keys(fields).sort(), prompt };
  });
}

export function validateCreativeShots(contract: CreativeContract, shots: CreativeShot[]): CreativeFinding[] {
  assertCreativeContract(contract);
  const findings: CreativeFinding[] = [], seen = new Set<string>(), profile = contract.profile;
  if (!Array.isArray(shots) || shots.length < profile.minShots || shots.length > profile.maxShots) return [finding("CREATIVE_SHOT_COUNT_INVALID", "shots", [profile.minShots, profile.maxShots], shots?.length ?? null)];
  const plan = explicitCreativeShotPlan(contract);
  if (plan && shots.length !== plan.count) findings.push(finding("CREATIVE_SHOT_COUNT_INVALID", "shots", plan.count, shots.length));
  for (const shot of shots) {
    if (seen.has(shot.id) || shot.contractHash !== contract.hash) findings.push(finding("CREATIVE_SHOT_STALE", "contractHash", contract.hash, shot.contractHash, [], shot.id));
    seen.add(shot.id);
    if (!Number.isFinite(shot.duration) || shot.duration < profile.minShotSeconds || shot.duration > profile.maxShotSeconds) findings.push(finding("CREATIVE_SHOT_DURATION", "duration", [profile.minShotSeconds, profile.maxShotSeconds], Number.isFinite(shot.duration) ? shot.duration : null, ["duration"], shot.id));
    else if (plan && shot.duration !== plan.durationSeconds) findings.push(finding("CREATIVE_SHOT_DURATION", "duration", plan.durationSeconds, shot.duration, ["duration"], shot.id));
    if (!shot.prompt.trim() || !Object.keys(shot.fields).length) findings.push(finding("CREATIVE_SHOT_CONTENT_MISSING", "prompt", "native prompt and fields", shot.prompt, ["prompt", "fields"], shot.id));
    if (shot.fieldOrder.length !== Object.keys(shot.fields).length || new Set(shot.fieldOrder).size !== shot.fieldOrder.length || shot.fieldOrder.some(k => !Object.hasOwn(shot.fields, k))) findings.push(finding("CREATIVE_FIELD_ORDER_INVALID", "fieldOrder", "each actual field exactly once", shot.fieldOrder, [], shot.id));
    for (const key of contract.requiredFields) {
      const value = shot.fields[key];
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) findings.push(finding("CREATIVE_FIELD_MISSING", `fields.${key}`, "complete required native field", value ?? null, [`fields.${key}`], shot.id));
    }
    if (shot.claimIds.some(id => !contract.coverage.some(c => c.claimId === id))) findings.push(finding("CREATIVE_UNAUTHORIZED_CLAIM", "claimIds", contract.coverage.map(c => c.claimId), shot.claimIds, [], shot.id));
    // claimIds allocate responsibility, not semantic approval. The final authority
    // review must read this exact output and its complete source; paraphrases are
    // not rejected here by a literal substring test and IDs never grant approval.
  }
  const sum = shots.reduce((n, s) => n + s.duration, 0);
  if (!Number.isFinite(sum) || Math.abs(sum - profile.contentDuration) > 0.05) findings.push(finding("CREATIVE_DURATION_SUM", "duration", profile.contentDuration, Number.isFinite(sum) ? sum : null, ["duration"]));
  for (const required of contract.coverage) if (!shots.some(s => s.claimIds.includes(required.claimId))) findings.push(finding("CREATIVE_COVERAGE_MISSING", "claimIds", required.claimId, null, ["claimIds"]));
  return findings;
}

/** Stable structural suffix; all semantic text comes from the selected native shot. */
export function compileCreativePrompt(contract: CreativeContract, shot: CreativeShot): string {
  assertCreativeContract(contract);
  if (shot.contractHash !== contract.hash) fail("CREATIVE_SHOT_STALE", shot.id);
  if (!shot.fieldOrder.length || shot.fieldOrder.length !== Object.keys(shot.fields).length || new Set(shot.fieldOrder).size !== Object.keys(shot.fields).length || shot.fieldOrder.some(k => !Object.hasOwn(shot.fields, k))) fail("CREATIVE_FIELD_ORDER_INVALID", shot.id);
  const body = shot.fieldOrder.map((key, index) => `${String(index + 1).padStart(2, "0")}.【${key}】${typeof shot.fields[key] === "string" ? shot.fields[key] : creativeCanonical(shot.fields[key])}`).join("\n");
  return `${body}\n\n[制作合同 ${contract.hash}]\n${creativeCanonical({ shotId: shot.id, duration: shot.duration, aspectRatio: contract.profile.aspectRatio, frameRate: contract.profile.frameRate, resolution: contract.profile.resolution, subtitleMode: contract.profile.subtitleMode, visualMode: contract.profile.visualMode })}`;
}

/** Compare actual leaves; array expansion, unrelated shots and authority fields cannot slip through. */
export function creativeDiff(before: unknown, after: unknown, prefix = ""): string[] {
  if (creativeCanonical(before) === creativeCanonical(after)) return [];
  if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) !== Array.isArray(after)) return [prefix];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!Object.hasOwn(before, key) || !Object.hasOwn(after, key)) changed.push(p);
    else changed.push(...creativeDiff((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], p));
  }
  return changed.sort();
}
export function validatePatchDelta(before: CreativeShot, after: CreativeShot, allowedChanges: string[]): string[] {
  const changed = creativeDiff(before, after);
  const forbidden = new Set(["id", "sceneId", "schemaVersion", "contractHash", "sourceHash", "parentHash", "revision", "claimIds", "constraintIds", "assetRefs"]);
  if (!changed.length) fail("REPAIR_NO_PROGRESS", "补丁没有实际变化");
  for (const path of changed) if (forbidden.has(path.split(".")[0]!) || !allowedChanges.some(p => path === p || path.startsWith(p + "."))) fail("PATCH_SCOPE_VIOLATION", path);
  return changed;
}

export function creativeCacheKey(input: { scope: CreativeScope; contractHash: string; upstreamHashes: string[]; schemaVersion: string; model: string; promptVersion: string; policyVersion: string; config: unknown }): string {
  if (!/^[a-f0-9]{64}$/.test(input.contractHash) || input.upstreamHashes.some(h => !/^[a-f0-9]{64}$/.test(h)) || !input.model || !input.promptVersion || !input.policyVersion || !input.schemaVersion) fail("CREATIVE_CACHE_KEY_INVALID", "all dependency versions required");
  return creativeHash(input);
}
