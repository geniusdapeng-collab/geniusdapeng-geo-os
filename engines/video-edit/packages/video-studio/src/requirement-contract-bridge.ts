import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import {
  RequirementContractError, bindRequirementContract, renderRequirementContract, requirementCast,
  normalizeRiskResponseShape, requirementHash, requirementRecord, requirementScenes, structuredRiskFeedback, structuredSceneFeedback, structuredSceneInstructions, structuredScenePrompt, structuredSceneSchema,
  validateRequirementSchema, verifiedRequirementContract, type RequirementCast, type RequirementRecord
} from "./requirement-contract.js";
import { acquireVendorRequirementEntry } from "./vendor-requirement-entry.js";
import {
  qualifyRequirementThemeInput, requirementAuthorityFailure, requirementAuthorityPrompt, scopedRequirementEngine,
  type RequirementAuthorityOptions
} from "./requirement-authority.js";
import { policyCoveragePlan } from "./prd-authority-bridge.js";
import { prdDurationContract, type PrdAuthority } from "./prd-authority.js";
import { extractProductVisualAuthority } from "./product-visual-authority.js";

type Method = (this: RequirementRecord, ...args: unknown[]) => unknown;
interface Scope {
  metadata: RequirementRecord;
  cast?: RequirementCast;
  active: boolean;
  fatal?: { error: unknown };
  authority?: PrdAuthority;
  authoritySource?: PrdAuthority;
  authorityHash?: string;
  options?: RequirementAuthorityOptions;
  optionsSource?: RequirementAuthorityOptions;
}
const scopes = new AsyncLocalStorage<Scope>();
const receivers = new WeakMap<object, Scope>();
const UNVERIFIED_PRODUCT_VISUAL = /后视镜|座椅.{0,5}接缝|轮胎接地面|轮胎接地局部|制动卡钳|刹车卡钳|浮动盘|排气口|轮辋|整流罩|配色分区|前\s*\/?\s*后\s*45\s*度/u;
const NEGATIVE_VISUAL_CONSTRAINT = /不得|禁止|不要|不能|无需|省略|不新增|仅引用|只引用/u;

function unsafeProductVisual(text: unknown): boolean {
  return String(text ?? "").split(/[；。\n]/u).some(clause =>
    UNVERIFIED_PRODUCT_VISUAL.test(clause) && !NEGATIVE_VISUAL_CONSTRAINT.test(clause));
}

/** Risk advice may suggest camera language, but it cannot smuggle new product appearance facts downstream. */
export function sanitizeUnverifiedProductRisk(value: RequirementRecord): RequirementRecord {
  const result = structuredClone(value);
  const risk = result.riskAssessment && typeof result.riskAssessment === "object"
    ? requirementRecord(result.riskAssessment, "RiskAssessor result") : null;
  if (!risk) return result;
  let normalized = 0;
  if (Array.isArray(risk.technicalRisks)) {
    risk.technicalRisks = risk.technicalRisks.map(item => {
      const row = requirementRecord(item, "RiskAssessor technical risk");
      if (!unsafeProductVisual(row.risk) && !unsafeProductVisual(row.impact)) return item;
      normalized += 1;
      return {
        risk: "已核实商品参考区域的一致性",
        level: row.level,
        impact: "商品外观只能按本次 G1 已接受图片中明确可见的区域核对",
      };
    });
  }
  if (Array.isArray(risk.mitigationSuggestions)) {
    risk.mitigationSuggestions = risk.mitigationSuggestions.map(item => {
      if (!unsafeProductVisual(item)) return item;
      normalized += 1;
      return "商品特写只使用本次 G1 已接受图片中明确可见的区域，不指定未确认的部件、局部形态或机位角度";
    });
  }
  if (normalized) result.productVisualRiskNormalization = {
    applied: true,
    normalizedEntries: normalized,
    rule: "风险规划不得把未经 G1 claims/图片确认的局部外观写成拍摄清单；已替换为通用复核表述",
  };
  return result;
}

/** Materialize the scene-policy budget at G3 so the reviewer can verify it before shot cards exist. */
export function renderScenePolicyCoverage(metadata: RequirementRecord, contract: RequirementRecord): string {
  const brief = metadata.brief && typeof metadata.brief === "object" ? requirementRecord(metadata.brief, "Brief") : {};
  if (!brief.scenePolicyRequirements || typeof brief.scenePolicyRequirements !== "object") return "";
  const scenes = Array.isArray(contract.scenes) ? contract.scenes.map(value => requirementRecord(value, "G3 scene")) : [];
  const sceneInputs = scenes.map(scene => ({
    sceneId: String(scene.id), duration: Number(scene.duration), purpose: String(scene.purpose ?? ""),
    visualRequirements: Array.isArray(scene.keyElements) ? scene.keyElements : [],
    audioRequirements: [],
    keyProps: Array.isArray(scene.props) ? scene.props.map(value => {
      const prop = requirementRecord(value, "G3 prop");
      return String(prop.name ?? "");
    }) : [],
    actions: Array.isArray(scene.actions) ? scene.actions : [],
  }));
  const mapping = sceneInputs.map(scene => ({ sceneId: scene.sceneId,
    estimatedShots: Math.max(1, Math.min(6, Math.ceil(scene.duration / 3))) }));
  const plan = policyCoveragePlan(metadata, sceneInputs, mapping);
  if (!plan) return "";
  if (!plan.allShotsTagged || Object.values(plan.feasibility).some(ok => !ok) || !plan.hostWithinMaximum) {
    requirementAuthorityFailure("REQUIREMENT_SCENE_UNVERIFIED", "场景级片型标签无法满足 commerce-seeding 时长配比");
  }
  const tags = plan.requiredTags.join("、");
  const rows = plan.scenes.map(scene =>
    `| ${scene.sequence} | ${scene.sceneId} | ${scene.duration}s | ${scene.policyTags.join("、")} | `
    + `${Object.entries(scene.policyTagSeconds).map(([tag, seconds]) => `${tag}=${seconds}s`).join("；")} |`).join("\n");
  const totals = plan.requiredTags.map(tag =>
    `${tag}: ${plan.plannedSeconds[tag]}s / ${plan.totalDuration}s`).join("；");
  return `\n\n## 七、场景级 policyTags 与配比预算\n\n`
    + `- 必填标签：${tags}\n`
    + `- 配比口径：${plan.accounting}\n`
    + `- 场景预算：${totals}\n`
    + `- 可执行性：${Object.entries(plan.feasibility).map(([tag, ok]) => `${tag}=${ok ? "通过" : "不足"}`).join("；")}`
    + `${plan.hostWithinMaximum ? "；host≤30%=通过" : "；host≤30%=不足"}\n`
    + `- 下游硬约束：${plan.shotCardRule}\n\n`
    + `| 序号 | 场景 | 时长 | policyTags | 各标签时长 |\n|---:|---|---:|---|---|\n${rows}\n`;
}

function fatal(scope: Scope, error: unknown): never {
  if (!scope.authority) throw error;
  scope.fatal ??= { error };
  throw scope.fatal.error;
}
function guard<T>(scope: Scope, operation: () => T): T {
  try {
    if (!scope.active || scopes.getStore() !== scope) requirementAuthorityFailure("REQUIREMENT_SCOPE_CLOSED", "运行结束后不能继续消耗需求合同");
    if (scope.fatal) throw scope.fatal.error;
    if (scope.authoritySource && requirementHash(scope.authoritySource) !== scope.authorityHash) {
      requirementAuthorityFailure("REQUIREMENT_AUTHORITY_CHANGED", "宿主私有需求权威原件在本次运行中发生变化");
    }
    if (scope.optionsSource && (scope.optionsSource.approvedTheme !== scope.options!.approvedTheme
      || scope.optionsSource.validateAuthority !== scope.options!.validateAuthority)) {
      requirementAuthorityFailure("REQUIREMENT_AUTHORITY_CHANGED", "宿主私有校验或批准上下文入口发生变化");
    }
    return operation();
  } catch (error) { return fatal(scope, error); }
}
async function awaited<T>(scope: Scope, operation: () => T | Promise<T>): Promise<T> {
  try {
    guard(scope, () => undefined);
    const result = await operation();
    guard(scope, () => undefined);
    return result;
  } catch (error) { return fatal(scope, error); }
}

/** The immutable authority belongs to this awaited Studio run, including its discovery agents. */
export async function withRequirementContractScope<T>(
  metadata: RequirementRecord, operation: () => T | Promise<T>, options?: RequirementAuthorityOptions
): Promise<T> {
  const scope: Scope = { metadata: structuredClone(metadata), active: true,
    ...(options ? { authority: structuredClone(options.authority), authoritySource: options.authority,
      authorityHash: requirementHash(options.authority), options: Object.freeze({ ...options }), optionsSource: options } : {}) };
  return scopes.run(scope, async () => {
    try {
      if (scope.authority && requirementHash(scope.metadata) !== requirementHash(scope.authority.metadata)) {
        requirementAuthorityFailure("REQUIREMENT_AUTHORITY_CHANGED", "需求清单与宿主私有权威不属于同一输入快照");
      }
      return await awaited(scope, operation);
    }
    finally { scope.active = false; }
  });
}

function currentScope(): Scope | undefined {
  const scope = scopes.getStore();
  if (scope) guard(scope, () => undefined);
  return scope;
}
function receiverScope(receiver: object): Scope | undefined {
  const scope = currentScope(), bound = receivers.get(receiver);
  if (bound && bound !== scope) {
    return fatal(scope ?? bound, new RequirementContractError("REQUIREMENT_SCOPE_CONFLICT", "需求对象不能脱离其原运行作用域调用"));
  }
  return scope;
}
function bindReceiver(scope: Scope, receiver: object): void {
  if (!scope.authority) return;
  const bound = receivers.get(receiver);
  if (bound && bound !== scope) requirementAuthorityFailure("REQUIREMENT_SCOPE_CONFLICT", "需求对象已经属于另一运行");
  receivers.set(receiver, scope);
}
function scopeCast(scope: Scope): RequirementCast {
  return scope.cast ??= requirementCast(scope.metadata);
}
function audience(scope: Scope): unknown {
  return scope.metadata.brief && requirementRecord(scope.metadata.brief, "Brief").audience;
}

function sceneAuthority(scope: Scope, fallbackDuration: unknown) {
  if (!scope.authority) return undefined;
  const fallback = Number(fallbackDuration);
  const duration = prdDurationContract(
    scope.authority.profile,
    Number.isFinite(fallback) && fallback > 0 ? fallback : undefined,
  );
  const targetContentDurationSeconds = duration.contentDurationSeconds
    ?? (Number.isFinite(fallback) && fallback > 0 ? fallback : undefined);
  if (targetContentDurationSeconds === undefined) {
    requirementAuthorityFailure("REQUIREMENT_SCENE_UNVERIFIED", "本次内容时间线目标时长缺失");
  }
  const toleranceSeconds = duration.toleranceSeconds
    ?? (scope.authority.profile.durationToleranceFrames === undefined ? 5 : 0);
  const productVisualAuthority = extractProductVisualAuthority(scope.authority.marketing.g1Artifact.content);
  const brief = scope.authority.metadata.brief && typeof scope.authority.metadata.brief === "object"
    ? requirementRecord(scope.authority.metadata.brief, "需求 Brief") : {};
  const narrative = brief.narrativeDisclosure && typeof brief.narrativeDisclosure === "object"
    ? requirementRecord(brief.narrativeDisclosure, "narrativeDisclosure") : {};
  const production = brief.productionRequirements && typeof brief.productionRequirements === "object"
    ? requirementRecord(brief.productionRequirements, "productionRequirements") : {};
  return {
    targetContentDurationSeconds,
    finalDurationSeconds: duration.finalDurationSeconds ?? targetContentDurationSeconds + duration.coverIntroSeconds,
    coverIntroSeconds: duration.coverIntroSeconds,
    toleranceSeconds,
    narrativeDisclosure: typeof narrative.statement === "string" ? narrative.statement : undefined,
    persistentSubtitleText: typeof production.persistentSubtitleText === "string" ? production.persistentSubtitleText : undefined,
    productVisualAuthority,
  };
}

function sceneValidationOptions(scope: Scope, fallbackDuration: unknown) {
  const authority = sceneAuthority(scope, fallbackDuration);
  const fallback = Number(fallbackDuration);
  return {
    targetDuration: authority?.targetContentDurationSeconds
      ?? (Number.isFinite(fallback) && fallback > 0 ? fallback : undefined),
    options: {
      ...(authority ? { toleranceSeconds: authority.toleranceSeconds,
        productVisualAuthority: authority.productVisualAuthority } : {}),
    },
  };
}

function presentationSection(scope: Scope, fallbackDuration: number): string {
  const authority = sceneAuthority(scope, fallbackDuration);
  if (!authority) return "";
  const brief = scope.authority!.metadata.brief && typeof scope.authority!.metadata.brief === "object"
    ? requirementRecord(scope.authority!.metadata.brief, "需求 Brief") : {};
  const production = brief.productionRequirements && typeof brief.productionRequirements === "object"
    ? requirementRecord(brief.productionRequirements, "productionRequirements") : {};
  const restrictions = Array.isArray(brief.restrictions) ? brief.restrictions.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  return `\n\n## 六、宿主权威交付与事实边界（不可被模型改写）\n\n`
    + `- 内容时间线：${authority.targetContentDurationSeconds}s ±${authority.toleranceSeconds}s；`
    + `静音封面片头：${authority.coverIntroSeconds}s；最终成片：${authority.finalDurationSeconds}s ±${authority.toleranceSeconds}s。`
    + `封面片头是最终成片的一部分，不占内容节点合计，也不能在正文重复计算。\n`
    + `- 平台/画幅/分辨率/帧率：${JSON.stringify({
      platform: scope.authority!.profile.targetPlatform ?? brief.platform ?? null,
      aspectRatio: scope.authority!.profile.aspectRatio ?? brief.aspectRatio ?? null,
      resolution: scope.authority!.profile.resolution ?? null,
      frameRate: scope.authority!.profile.frameRate ?? null,
    })}\n`
    + `- 叙事披露原文（仅元数据/发布边界，不改成画面文字）：${JSON.stringify(authority.narrativeDisclosure ?? null)}\n`
    + `- 常驻字幕原文：${JSON.stringify(authority.persistentSubtitleText ?? null)}。它覆盖内容时间线0秒至内容末帧；插入封面后对应最终成片${authority.coverIntroSeconds}秒至末帧，封面段不承载正片常驻字幕。\n`
    + `- 客户限制：${JSON.stringify(restrictions)}\n`
    + `- 商品视觉授权：${JSON.stringify(authority.productVisualAuthority)}。`
    + `商品外观只能使用整车型号、车身整体、动作结果或授权图片明确可见锚点；`
    + `不得把“连续超车”“夺冠”等虚构叙事写成产品卖点、性能证据、竞品对比或真实赛事成绩；`
    + `不得新增卡钳、排气口、轮辋、整流罩、配色分区、特定 45 度机位或轮胎接地局部等未经逐项确认的外观。\n`
    + `- 客户 CTA 仅为账号互动元数据，未明确要求时不得写成画面文字、字幕、道具或台词。\n`;
}

function applyRequirementProductionAuthority(value: unknown, scope: Scope): RequirementRecord {
  const source = requirementRecord(value, "G3 实际需求清单");
  if (!scope.authority) return source;
  const result = structuredClone(source);
  const brief = scope.authority.metadata.brief && typeof scope.authority.metadata.brief === "object"
    ? requirementRecord(scope.authority.metadata.brief, "需求 Brief") : {};
  const production = brief.productionRequirements && typeof brief.productionRequirements === "object"
    ? requirementRecord(brief.productionRequirements, "productionRequirements") : {};
  const authority = sceneAuthority(scope, brief.duration);
  if (!authority) return result;
  const final = authority.finalDurationSeconds;
  const tolerance = authority.toleranceSeconds;
  result.targetDuration = final;
  result.contentDuration = authority.targetContentDurationSeconds;
  result.durationRange = [Number((final - tolerance).toFixed(6)), Number((final + tolerance).toFixed(6))];
  if (typeof brief.aspectRatio === "string") result.aspectRatio = brief.aspectRatio;
  if (typeof brief.platform === "string") result.platform = brief.platform;
  result.narrativeDisclosure = structuredClone(brief.narrativeDisclosure ?? null);
  result.productionRequirements = structuredClone(production);
  result.persistentSubtitleText = authority.persistentSubtitleText ?? null;
  result.restrictions = Array.isArray(brief.restrictions) ? structuredClone(brief.restrictions) : [];
  const profile = result.productionProfile && typeof result.productionProfile === "object"
    ? requirementRecord(result.productionProfile, "G3 productionProfile") : null;
  if (profile) {
    profile.duration_target = final;
    profile.content_duration = authority.targetContentDurationSeconds;
    if (typeof brief.aspectRatio === "string") profile.aspect_ratio = brief.aspectRatio;
    if (typeof brief.platform === "string") profile.platform = brief.platform;
    if (typeof brief.audience === "string") profile.audience = brief.audience;
    if (typeof brief.voice === "string" && /无对白|no dialogue/iu.test(brief.voice)) profile.dialogue_density = "none";
  }
  const keyPoints = Array.isArray(result.keyPoints) ? result.keyPoints : [];
  keyPoints.push(`[本次宿主权威时长与交付边界] ${JSON.stringify({
    contentDurationSeconds: authority.targetContentDurationSeconds,
    coverIntroSeconds: authority.coverIntroSeconds,
    finalDurationSeconds: final,
    toleranceSeconds: tolerance,
    narrativeDisclosure: authority.narrativeDisclosure ?? null,
    persistentSubtitleText: authority.persistentSubtitleText ?? null,
  })}`);
  result.keyPoints = keyPoints;
  return result;
}
function method(owner: RequirementRecord, key: string): Method {
  const value = owner[key];
  if (typeof value !== "function") throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", `vendor 缺少 ${key}`);
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (descriptor && descriptor.writable === false && !descriptor.set) {
    throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", `vendor ${key} 不可安装兼容桥`);
  }
  return value as Method;
}

interface Change { owner: RequirementRecord; key: string; original: PropertyDescriptor; patched: Method }
interface Installed { changes: Change[] }
const active = new WeakMap<object, Installed>();
const nativeIdentities = new WeakMap<object, Array<{ owner: RequirementRecord; key: string; original: PropertyDescriptor }>>();
function sameDescriptor(a: PropertyDescriptor | undefined, b: PropertyDescriptor): boolean {
  return Boolean(a && a.value === b.value && a.writable === b.writable && a.configurable === b.configurable
    && a.enumerable === b.enumerable && a.get === b.get && a.set === b.set);
}

export function assertRequirementContractBridge(vendorPrototype: object): void {
  const state = active.get(vendorPrototype);
  if (!state || state.changes.some(change => !sameDescriptor(Object.getOwnPropertyDescriptor(change.owner, change.key),
    { ...change.original, value: change.patched }))) {
    throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "需求合同桥身份发生变化");
  }
}

/** Pure dependency seam for isolated fixtures; production supplies the exact cached vendor prototypes. */
export function installRequirementContractBridge(
  vendorPrototype: RequirementRecord, discoveryPrototype: RequirementRecord, themePrototype?: RequirementRecord
): () => void {
  if (active.has(vendorPrototype)) throw new RequirementContractError("REQUIREMENT_BRIDGE_ACTIVE", "需求合同桥应通过共享引用计数安装");
  const previous = nativeIdentities.get(vendorPrototype);
  if (previous?.some(change => !sameDescriptor(Object.getOwnPropertyDescriptor(change.owner, change.key), change.original))) {
    throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "原始 vendor 方法与首次受控身份不一致");
  }
  const convert = method(vendorPrototype, "_convertDiscoveryToRequirementList");
  const render = method(vendorPrototype, "_renderRequirementContract");
  const discover = method(discoveryPrototype, "discover");
  const fast = method(discoveryPrototype, "_fastMode");
  const markdown = method(discoveryPrototype, "generateMarkdown");
  const themeInput = themePrototype ? method(vendorPrototype, "_buildThemeInput") : undefined;
  const themeGenerate = themePrototype ? method(themePrototype, "generate") : undefined;
  const changes: Change[] = [];
  const check = (scope: Scope) => guard(scope, () => assertRequirementContractBridge(vendorPrototype));
  const protectModel = <T>(scope: Scope, operation: () => T): T => guard(scope, () => {
    check(scope);
    scope.options?.validateAuthority();
    return operation();
  });
  const promptContext = (scope: Scope): string => guard(scope, () => {
    if (!scope.authority) requirementAuthorityFailure("REQUIREMENT_AUTHORITY_REQUIRED", "缺少宿主私有需求权威");
    return requirementAuthorityPrompt(scope.authority, scope.options?.approvedTheme());
  });

  const qualifiedInput: Method = function (...args) {
    const scope = receiverScope(this);
    if (!scope?.authority) return Reflect.apply(themeInput!, this, args);
    return guard(scope, () => {
      check(scope); bindReceiver(scope, this);
      return qualifyRequirementThemeInput(Reflect.apply(themeInput!, this, args), args[0], args[1] ?? {});
    });
  };
  const themed: Method = async function (...args) {
    const scope = receiverScope(this);
    if (!scope?.authority) return Reflect.apply(themeGenerate!, this, args);
    return awaited(scope, async () => {
      check(scope); bindReceiver(scope, this);
      const view = Object.create(this) as RequirementRecord;
      const protect = <T>(operation: () => T) => protectModel(scope, operation);
      view.llmEngine = protect(() => scopedRequirementEngine(this.llmEngine, protect, () => promptContext(scope)));
      const extract = method(this, "_extractFieldsWithLLM");
      view._extractFieldsWithLLM = function (this: RequirementRecord, ...input: unknown[]) {
        // The native extraction/JSON retry remains in place. A swallowed failure is sticky.
        return awaited(scope, () => Reflect.apply(extract, this, input));
      };
      const resolver = requirementRecord(this.typeResolver, "原始主题动态类型解析器");
      const resolve = method(resolver, "resolve");
      method(resolver, "_fallbackConfig");
      const resolverView = Object.create(resolver) as RequirementRecord;
      resolverView.llmEngine = protect(() => scopedRequirementEngine(resolver.llmEngine, protect, () => promptContext(scope)));
      // This cache contains themes, input-specific descriptions/notes and audience,
      // keyed only by type. A private run cannot reuse a different run's creative input.
      // Only a dynamic type that would have hit that cache adds at most one dispatch.
      resolverView.cacheEnabled = false;
      resolverView.resolve = function (this: RequirementRecord, ...input: unknown[]) {
        return awaited(scope, () => Reflect.apply(resolve, this, input));
      };
      resolverView._fallbackConfig = function () {
        return guard(scope, () => requirementAuthorityFailure("REQUIREMENT_THEME_UNVERIFIED", "本次主题动态类型失败，拒绝规则主题回填"));
      };
      view.typeResolver = resolverView;
      const result = requirementRecord(await Reflect.apply(themeGenerate!, view, args), "真实主题生成结果");
      check(scope);
      if (!Array.isArray(result.tasks) || result.tasks.some(task => requirementRecord(task, "真实主题 task")._degraded)) {
        requirementAuthorityFailure("REQUIREMENT_THEME_UNVERIFIED", "本次主题生成失败或降级，不能用规则主题继续");
      }
      return result;
    });
  };

  const converted: Method = async function (discovery, upstream, metadata) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(convert, this, [discovery, upstream]);
    return awaited(scope, async () => {
      const expectedCast = scope ? scopeCast(scope).hash : undefined;
      const ownerAudience = scope ? audience(scope) : undefined;
      if (scope && requirementCast(requirementRecord(metadata, "转换 metadata")).hash !== expectedCast) {
        throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "转换前人物合同与本次宿主选择不一致");
      }
      // The controlled caller really awaits this result; original profile generation is not replaced.
      const original = await Reflect.apply(convert, this, [discovery, upstream]);
      if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "转换结束时运行作用域已经关闭");
      const bound = bindRequirementContract(original, discovery, upstream, metadata, expectedCast!,
        typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null);
      return applyRequirementProductionAuthority(bound, scope);
    });
  };
  const rendered: Method = function (intent, metadata, list, discovery) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(render, this, [intent, metadata, list, discovery]);
    return guard(scope, () => {
      const contract = verifiedRequirementContract(list, metadata, discovery);
      if (contract.cast.hash !== scopeCast(scope).hash) throw new RequirementContractError("REQUIREMENT_CAST_CHANGED", "G3 使用了另一运行的人物合同");
      const ownerAudience = audience(scope);
      if (contract.ownerAudience !== (typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : null)) {
        throw new RequirementContractError("REQUIREMENT_AUDIENCE_CHANGED", "G3 与本次宿主冻结的客户受众口径不一致");
      }
      return renderRequirementContract(contract, requirementRecord(metadata, "G3 metadata"))
        + renderScenePolicyCoverage(scope.authority!.metadata, contract as unknown as RequirementRecord)
        + presentationSection(scope, contract.scenes.reduce((sum, scene) => sum + scene.duration, 0));
    });
  };
  const discovered: Method = async function (input) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(discover, this, [input]);
    return awaited(scope, async () => {
      check(scope); bindReceiver(scope, this);
      const cast = scopeCast(scope);
      const agents = requirementRecord(this.agents, "需求洞察 agents");
      const inputHash = scope.authority ? requirementHash(input) : undefined;
      const originalEngine = this;
      const requireActiveScope = () => {
        guard(scope, () => {
          check(scope);
          if (scope.authority && (originalEngine.agents !== agents || requirementHash(input) !== inputHash)) {
            requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "需求输入或原始 agents 在本次调用中发生变化");
          }
        });
      };
      const guardedAgents = Object.fromEntries(Object.entries(agents).map(([name, value]) => {
        const agent = requirementRecord(value, `洞察 agent ${name}`);
        const call = method(agent, "_callLLM"), fallback = method(agent, "_fallback");
        const view = Object.create(agent) as RequirementRecord;
        if (scope.authority) {
          const protect = <T>(operation: () => T) => protectModel(scope, () => { requireActiveScope(); return operation(); });
          view.llmEngine = protect(() => scopedRequirementEngine(agent.llmEngine, protect, () => promptContext(scope), () => {
            const upstream = requirementRecord(input, "原始洞察来源");
            const story = upstream._originalStoryText || upstream.original_story_text || "";
            if (typeof story !== "string") requirementAuthorityFailure("REQUIREMENT_DISCOVERY_CHANGED", "本次原始故事不是完整文本");
            return story;
          }));
          view._validateAndFill = function (this: RequirementRecord, value: unknown, schema: unknown) {
            requireActiveScope();
            validateRequirementSchema(value, schema);
            return structuredClone(value);
          };
        }
        view._callLLM = function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          return Reflect.apply(call, this, args);
        };
        view._fallback = function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          if (scope.authority) return guard(scope, () => requirementAuthorityFailure("REQUIREMENT_DISCOVERY_UNVERIFIED", "本次需求模型失败，拒绝规则洞察回填"));
          return Reflect.apply(fallback, this, args);
        };
        return [name, view];
      }));
      if (scope.authority) {
        const risk = requirementRecord(guardedAgents.risk, "RiskAssessor");
        const runRisk = method(risk, "run"), callRisk = method(risk, "_callLLM"), buildRisk = method(risk, "_buildPrompt");
        const riskView = Object.create(risk) as RequirementRecord;
        let finalRiskFailure: { error: unknown } | undefined;
        const unverifiedRisk = () => new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", "RiskAssessor 未提供完整真实响应，拒绝规则洞察回填");
        riskView.run = async function (this: RequirementRecord, value: unknown, schema: unknown) {
          requireActiveScope();
          finalRiskFailure = undefined;
          const responseSchema = requirementRecord(schema, "RiskAssessor response schema");
          const allowedRiskFields = Object.keys(requirementRecord(responseSchema.properties, "RiskAssessor response properties"));
          const runView = Object.create(this) as RequirementRecord;
          let pendingFeedback = "", attemptFeedback = "";
          let currentFailure: { error: unknown } | undefined;
          runView._callLLM = async function (this: RequirementRecord, ...args: unknown[]) {
            requireActiveScope();
            attemptFeedback = pendingFeedback;
            pendingFeedback = "";
            // The second transport/parser failure must replace the first schema
            // failure. Authority/engine failures remain sticky in requireActiveScope.
            currentFailure = undefined;
            try {
              const response = await Reflect.apply(callRisk, this, args);
              const normalized = normalizeRiskResponseShape(response);
              if (normalized.normalization) console.log(`   [RiskAssessor] 结构化响应兼容规范化: ${normalized.normalization}`);
              return normalized.value;
            }
            catch (error) { currentFailure = { error }; throw error; }
            finally { attemptFeedback = ""; }
          };
          runView._buildPrompt = function (this: RequirementRecord, input: unknown) {
            requireActiveScope();
            const original = Reflect.apply(buildRisk, this, [input]);
            if (typeof original !== "string") requirementAuthorityFailure("REQUIREMENT_VENDOR_UNAVAILABLE", "RiskAssessor 原始 prompt 不是文本");
            return original + `\n\n## 宿主原始响应结构约束（不可扩展）\n`
              + `RiskAssessor response 顶层必须且只能包含 ${JSON.stringify(allowedRiskFields)}。`
              + `不得增加解释、外层包装、补充字段或其他同义字段；三个数组均须遵守响应 schema 的 1–5 项边界。`
              + attemptFeedback;
          };
          runView._validateAndFill = function (this: RequirementRecord, response: unknown, responseSchema: unknown) {
            requireActiveScope();
            // Semantic response rejection is retryable inside the native loop;
            // throwing it inside guard/protect would make attempt one fatal.
            try { validateRequirementSchema(response, responseSchema, "RiskAssessor response"); }
            catch (error) {
              currentFailure = { error };
              pendingFeedback = structuredRiskFeedback(error);
              throw error;
            }
            pendingFeedback = "";
            currentFailure = undefined;
            return structuredClone(response);
          };
          runView._fallback = function () {
            requireActiveScope();
            finalRiskFailure = currentFailure ?? { error: unverifiedRisk() };
            throw finalRiskFailure.error;
          };
          try { return await Reflect.apply(runRisk, runView, [value, schema]); }
          finally { pendingFeedback = ""; attemptFeedback = ""; currentFailure = undefined; }
        };
        riskView._fallback = function () {
          requireActiveScope();
          // The native discover catch invokes the agent fallback a second time.
          throw (finalRiskFailure ?? { error: unverifiedRisk() }).error;
        };
        guardedAgents.risk = riskView;
      }
      const scene = requirementRecord(guardedAgents.scene, "SceneArchitect");
      const build = method(scene, "_buildPrompt"), run = method(scene, "run");
      const callScene = method(scene, "_callLLM");
      method(scene, "_validateAndFill");
      // Each run gets its own engine/agent view. No global or shared agent carries project metadata.
      const sceneView = Object.create(scene) as RequirementRecord;
      let finalSceneFailure: RequirementContractError | undefined;
      const unverifiedScene = () => new RequirementContractError("REQUIREMENT_SCENE_UNVERIFIED", "SceneArchitect 未提供完整真实结构，拒绝规则道具或动作回填");
      sceneView.run = async function (this: RequirementRecord, value: unknown, schema: unknown) {
        requireActiveScope();
        finalSceneFailure = undefined;
        const effectiveSchema = structuredSceneSchema(schema);
        const runView = Object.create(this) as RequirementRecord;
        let pendingFeedback = "", attemptFeedback = "";
        let currentValidationFailure: RequirementContractError | undefined;
        runView._callLLM = async function (this: RequirementRecord, ...args: unknown[]) {
          requireActiveScope();
          // Feedback belongs to the previous completed validation. The current
          // failure must be cleared independently before transport/JSON parsing.
          attemptFeedback = pendingFeedback;
          pendingFeedback = "";
          currentValidationFailure = undefined;
          try { return await Reflect.apply(callScene, this, args); }
          finally { attemptFeedback = ""; }
        };
        runView._buildPrompt = function (this: RequirementRecord, input: unknown) {
          requireActiveScope();
          const original = Reflect.apply(build, this, [input]);
          const upstream = requirementRecord(input, "SceneArchitect 上游输入");
          const target = sceneValidationOptions(scope, upstream.duration_sec);
          return structuredScenePrompt(original, input, effectiveSchema, target.targetDuration,
            target.options.toleranceSeconds)
            + structuredSceneInstructions(cast, audience(scope), sceneAuthority(scope, upstream.duration_sec))
            + attemptFeedback;
        };
        runView._validateAndFill = function (this: RequirementRecord, response: unknown, responseSchema: unknown) {
          requireActiveScope();
          // Validate the real response before vendor fallback can invent fields.
          const upstream = requirementRecord(input, "SceneArchitect 上游输入");
          try {
            validateRequirementSchema(response, responseSchema);
            const target = sceneValidationOptions(scope, upstream.duration_sec);
            requirementScenes(response, cast, target.targetDuration, target.options);
          } catch (error) {
            const feedback = structuredSceneFeedback(error);
            if (feedback && error instanceof RequirementContractError) {
              currentValidationFailure = error;
              pendingFeedback = feedback;
            }
            throw error;
          }
          pendingFeedback = "";
          currentValidationFailure = undefined;
          // The native defaults bridge eagerly evaluates _fallback, even for a
          // complete object. Strict responses never enter that invented path.
          return structuredClone(response);
        };
        runView._fallback = function () {
          requireActiveScope();
          finalSceneFailure = currentValidationFailure ?? unverifiedScene();
          throw finalSceneFailure;
        };
        try { return await Reflect.apply(run, runView, [value, effectiveSchema]); }
        finally {
          pendingFeedback = "";
          attemptFeedback = "";
          currentValidationFailure = undefined;
        }
      };
      sceneView._fallback = function () {
        requireActiveScope();
        // The native discover catch calls this again after the runView fallback.
        throw finalSceneFailure ?? unverifiedScene();
      };
      const engineView = Object.create(this) as RequirementRecord;
      engineView.agents = { ...guardedAgents, scene: sceneView };
      const result = await awaited(scope, () => Reflect.apply(discover, engineView, [input]));
      if (currentScope() !== scope) throw new RequirementContractError("REQUIREMENT_SCOPE_CLOSED", "需求洞察结束时运行作用域已经关闭");
      const record = requirementRecord(result, "实际需求洞察结果");
      const upstream = requirementRecord(input, "上游输入");
      const productVisualAuthority = scope.authority
        ? extractProductVisualAuthority(scope.authority.marketing.g1Artifact.content) : null;
      const safeRecord = productVisualAuthority?.required ? sanitizeUnverifiedProductRisk(record) : record;
      const target = sceneValidationOptions(scope, upstream.duration_sec);
      requirementScenes(safeRecord.sceneStructure, cast, target.targetDuration, target.options);
      return { ...safeRecord, audienceAuthority: audience(scope) ?? null, audienceProfileStatus: "model-hypothesis" };
    });
  };
  const noFastFallback: Method = function (...args) {
    const scope = receiverScope(this);
    if (!scope) return Reflect.apply(fast, this, args);
    return guard(scope, () => { throw new RequirementContractError("REQUIREMENT_DISCOVERY_UNVERIFIED", "本次需求洞察失败，不能用规则兜底冒充完整合同"); });
  };
  const renderedDiscovery: Method = function (...args) {
    const scope = receiverScope(this);
    const original = Reflect.apply(markdown, this, args);
    if (!scope) return original;
    if (typeof original !== "string" || original.split("### 2.1 目标受众画像").length !== 2
      || original.split("**主要受众**").length !== 2) {
      throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "需求洞察的受众渲染口径发生变化");
    }
    const ownerAudience = audience(scope);
    const output = original.replace("### 2.1 目标受众画像", "### 2.1 模型受众细分假设（待审核）")
      .replace("**主要受众**", `**客户 Brief 权威受众原文**\n${typeof ownerAudience === "string" && ownerAudience.trim() ? ownerAudience : "客户未显式指定"}\n\n**模型细分推测（不覆盖客户口径，不是已核实人群事实）**`);
    const discoveryResult = args[0] && typeof args[0] === "object" ? requirementRecord(args[0], "洞察渲染输入") : {};
    const normalization = discoveryResult.productVisualRiskNormalization;
    return output + (normalization && typeof normalization === "object"
      ? `\n\n> 商品外观风险归并：${requirementRecord(normalization, "商品外观归并").rule}`
      : "");
  };
  const patches: Array<[RequirementRecord, string, Method]> = [
    [vendorPrototype, "_convertDiscoveryToRequirementList", converted], [vendorPrototype, "_renderRequirementContract", rendered],
    [discoveryPrototype, "discover", discovered], [discoveryPrototype, "_fastMode", noFastFallback],
    [discoveryPrototype, "generateMarkdown", renderedDiscovery]
  ];
  if (themePrototype) patches.push([vendorPrototype, "_buildThemeInput", qualifiedInput], [themePrototype, "generate", themed]);
  for (const [owner, key, patched] of patches) {
    const original = Object.getOwnPropertyDescriptor(owner, key);
    if (!original || typeof original.value !== "function" || original.writable !== true || original.configurable !== true) {
      throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", `${key} 不是可恢复的原始自有方法`);
    }
    changes.push({ owner, key, original, patched });
  }
  const installed: Change[] = [];
  try {
    for (const change of changes) {
      Object.defineProperty(change.owner, change.key, { ...change.original, value: change.patched });
      installed.push(change);
    }
  } catch (error) {
    for (const change of installed.reverse()) Object.defineProperty(change.owner, change.key, change.original);
    throw error;
  }
  nativeIdentities.set(vendorPrototype, changes.map(({ owner, key, original }) => ({ owner, key, original })));
  active.set(vendorPrototype, { changes });
  let disposed = false;
  return () => {
    if (disposed) return;
    assertRequirementContractBridge(vendorPrototype);
    for (const change of [...changes].reverse()) Object.defineProperty(change.owner, change.key, change.original);
    active.delete(vendorPrototype);
    disposed = true;
  };
}

/** Called only after the pinned entry has been installed in the shared CJS cache. */
export function installVendorRequirementContractBridge(
  constructor: { prototype: object }, entryPath: string
): () => void {
  const lease = acquireVendorRequirementEntry(entryPath);
  try {
    if (lease.exports.HyperrealitySystem !== (constructor as unknown)) {
      throw new RequirementContractError("REQUIREMENT_BRIDGE_CHANGED", "需求合同桥与受控入口的 constructor 不一致");
    }
    const require = createRequire(lease.identity.entryPath);
    const mod = require(path.join(path.dirname(lease.identity.entryPath), "engines/requirement-discovery-engine.js")) as {
      RequirementDiscoveryEngine?: { prototype?: RequirementRecord };
    };
    if (!mod.RequirementDiscoveryEngine?.prototype) {
      throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "缺少实际需求洞察引擎");
    }
    const theme = require(path.join(path.dirname(lease.identity.entryPath), "skills/creative-theme-generator")) as {
      CreativeThemeGenerator?: { prototype?: RequirementRecord };
    };
    if (!theme.CreativeThemeGenerator?.prototype) throw new RequirementContractError("REQUIREMENT_VENDOR_UNAVAILABLE", "缺少实际主题生成器");
    return installRequirementContractBridge(requirementRecord(constructor.prototype, "受控 vendor prototype"), mod.RequirementDiscoveryEngine.prototype,
      theme.CreativeThemeGenerator.prototype);
  } finally {
    lease.release();
  }
}
