/**
 * Product appearance authority derived only from the G1 facts bundle.
 *
 * Text claims authorize names, parameters and usage restrictions. Visual
 * appearance is separately constrained to real product images selected from
 * the source pages that G1 actually accepted. A model cannot self-report an
 * image or derive a new product detail from prose.
 */

export interface ProductVisualReference {
  url: string;
  pageUrl: string;
  source?: string;
  angle?: string;
  licenseRisk?: string;
}

export interface ProductVisualAuthority {
  mode: ProductVisualMode;
  modeEvidence: { source: string; value: string } | null;
  /** Compatibility projection: whether real images are required, not whether there is a visual contract. */
  required: boolean;
  product: string | null;
  images: ProductVisualReference[];
  rule: string;
}

export type ProductVisualMode = "verified_product_appearance" | "abstract_without_product_appearance" | "no_named_product";
export type DeclaredProductVisualMode = Exclude<ProductVisualMode, "no_named_product">;
export const ABSTRACT_PRODUCT_VISUAL_MODE = "abstract_without_product_appearance" as const;
export const VERIFIED_PRODUCT_VISUAL_MODE = "verified_product_appearance" as const;

export class ProductVisualAuthorityError extends Error {
  constructor(message: string, readonly code = "PRODUCT_VISUAL_AUTHORITY_REQUIRED") {
    super(`${code}: ${message}`);
    this.name = "ProductVisualAuthorityError";
  }
}

const appearanceRule = "商品外观、颜色、涂装、比例、部件和空间形态只能引用本次 G1 A1 已接受图片中的可见内容；"
  + "文字 claims 仅支持其明确写出的名称、参数和用途，不得把描述扩写成未核实外观。";
export const ABSTRACT_PRODUCT_RENDER_RULE = "不得生成或展示产品外观、实物、包装、真实界面、产品图片或产品操作演示。";
const abstractRule = "本次产品只可通过非写实的抽象图形、代码与示意画面表达；" + ABSTRACT_PRODUCT_RENDER_RULE
  + "商品名和已核实主张仍可按客户用途限制作为文字或旁白；抽象隐喻不能冒充实际操作、性能或效果，不改变配色、人物、旁白或音乐要求。";
const modeSource = "requestedMetadata.brief.productionRequirements.visualMode";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function productName(root: Record<string, unknown>, facts: Record<string, unknown>): string | null {
  const metadata = object(root.requestedMetadata), brief = object(metadata?.brief), product = object(brief?.product);
  // dataMining-only customers still request a named product; omitting Brief.product cannot waive A1.
  for (const name of [object(facts.productQuery)?.name, object(metadata?.dataMining)?.name, product?.name, brief?.product]) {
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return null;
}

export function isDeclaredProductVisualMode(value: unknown): value is DeclaredProductVisualMode {
  return value === ABSTRACT_PRODUCT_VISUAL_MODE || value === VERIFIED_PRODUCT_VISUAL_MODE;
}

const NO_APPEARANCE_DECLARATION = /^(?:全片|全程|本片)?\s*(?:(?:不|不得|不要|禁止)(?:展示|呈现|生成|出现|拍摄|还原)(?:任何|真实|实际|具体)?(?:产品|商品)(?:的)?(?:外观|实物|形态)|(?:无|不含)(?:任何|真实)?(?:产品|商品)(?:外观|实物)|(?:do not|never|must not)\s+(?:show|depict|generate|render)\s+(?:any\s+)?(?:the\s+)?(?:actual\s+|real\s+)?product\s+(?:appearance|exterior)|no\s+(?:actual\s+|real\s+)?product\s+(?:appearance|exterior))/iu;
const VISUAL_TARGET = /(?:实物(?:特写|镜头|画面|照片|演示)|产品实物|商品实物|(?:产品|商品|实物)\s*(?:的)?\s*(?:外观|包装|图片|照片|原图|造型|形态|渲染图|模型|定妆照|三视图|演示|上手|实操|操作(?:演示|流程|效果)|真实运行)|真实(?:产品|商品|软件|应用)?\s*(?:界面|截图|硬件|设备|运行效果)|实际(?:产品|商品|软件|应用)?\s*(?:界面|截图|运行效果)|(?:近拍|特写|俯拍|展示|打开|拆开|转动|握持|取出|操作|使用)(?:[^。；，,\n]{0,7})(?:产品|商品|实物|包装盒)(?![名文])|(?:real|actual|physical)\s+(?:product|hardware|app|software)\s+(?:shot|ui|interface|screenshot|demo|appearance|exterior)|(?:product|retail)\s+(?:packaging|appearance|exterior|render|photograph|screenshot|demo|close[- ]?up)|\b(?:unboxing|live demo|actual ui)\b)/iu;
const REAL_APPEARANCE_REQUEST = /(?:(?:需要|要求|务必|一定要|请|可以|仍要|要|拍摄|展示|呈现|生成|还原|保留|给|加入|拍|放)[^，,。；;\n]{0,32}(?:产品|商品|软件|真实|实物|包装|硬件|外观|界面|截图)[^，,。；;\n]{0,12}(?:特写|实物|外观|包装|真实界面|真实截图|实拍|演示|开箱)|(?:拍摄|展示|呈现|生成|还原|使用|保留|加入|拍|放)\s*(?:真实|实际|具体的)?\s*(?:产品|商品)(?![名文])(?:[。；，,;\s]|$)|(?:真实界面|实物特写|产品演示|包装盒)(?:仍要拍|必须出现)|\b(?:show|depict|render|film|include|demonstrate)\b.{0,50}\b(?:physical product|actual product|actual ui|real interface|product packaging|product demo)\b)/iu;
const NEGATED_VISUAL_PREFIX = /^(?:[-*>#\s]+)?(?:(?:全片|全程|本片|画面|镜头|背景|道具)\s*)?(?:(?:不(?:得|要|可|允许|会)?|无需|禁止|禁用|避免|省略)\s*(?:生成或展示|展示|呈现|生成|出现|拍摄|还原|使用|包含|加入|引用|保留|涉及|绘制|描绘|制作|提供)|(?:无(?:任何)?|没有|禁止|避免|省略)\s*(?=产品|商品|实物|包装|真实|实际)|(?:no|do not|never|avoid|exclude)\b\s*(?:show|depict|generate|render|use|include)?\s*)/iu;
const IN_CLAUSE_REVERSAL = /除非|不妨|还是要|仍然要|以外|但|并(?:要|需|应|允许|展示|呈现|生成|拍摄|使用|操作|打开)|\b(?:unless|except|but|then|and (?:show|depict|generate|render|use|include))\b/iu;

function negatedVisualClause(value: string): boolean {
  const prefix = NEGATED_VISUAL_PREFIX.exec(value)?.[0];
  if (!prefix || IN_CLAUSE_REVERSAL.test(value)) return false;
  const target = value.slice(prefix.length).trim();
  return /^(?:任何|真实|实际|实体|具体的|未经核实|未授权|未核实|获准的|授权的|the\s+|any\s+|real\s+|actual\s+|physical\s+)*(?:产品|商品|实物|包装|硬件|界面|截图|软件界面|产品|product\b|packaging\b|ui\b|interface\b|hardware\b|screenshot\b|unboxing\b|live demo\b)/iu.test(target);
}

function clauses(value: string): string[] {
  return value.split(/[，,。；;！!？?\r\n]+|(?:但是|不过|然而|但|然后|随后|接着|反而|instead\b|\bbut\b|\bhowever\b|\bthen\b)/iu)
    .map(part => part.trim()).filter(Boolean);
}

/** Compile only a bounded direct customer declaration; absence/uncertainty cannot relax the image gate. */
export function explicitProductVisualMode(intent: unknown, metadataValue: unknown): ProductVisualAuthority["modeEvidence"] {
  const brief = object(object(metadataValue)?.brief), production = object(brief?.productionRequirements);
  const structured = production?.visualMode;
  if (production && Object.hasOwn(production, "visualMode") && !isDeclaredProductVisualMode(structured)) {
    throw new ProductVisualAuthorityError("客户结构化 visualMode 非法", "PRODUCT_VISUAL_MODE_CONFLICT");
  }
  const original = typeof intent === "string" ? intent : "";
  // Quoted examples and the positive mention of a mode name are not declarations.
  const rawClauses = clauses(original.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"|`[^`\n]*`/gu, ""));
  const direct = rawClauses.find(part => NO_APPEARANCE_DECLARATION.test(part));
  const evidence = direct && NO_APPEARANCE_DECLARATION.exec(direct)?.[0];
  const asksForAppearance = [original, brief?.description].some(value => typeof value === "string"
    && clauses(value.normalize("NFKC")).some(part => !negatedVisualClause(part) && REAL_APPEARANCE_REQUEST.test(part)));
  if ((structured === VERIFIED_PRODUCT_VISUAL_MODE && evidence)
    || (direct && IN_CLAUSE_REVERSAL.test(direct))
    || ((structured === ABSTRACT_PRODUCT_VISUAL_MODE || evidence) && asksForAppearance)) {
    throw new ProductVisualAuthorityError("客户的无产品外观声明与实际产品展示要求冲突", "PRODUCT_VISUAL_MODE_CONFLICT");
  }
  if (isDeclaredProductVisualMode(structured)) return { source: modeSource, value: structured };
  return evidence ? { source: "requestedIntent", value: evidence } : null;
}

/** Check deterministic positive conflicts only; independent G3/G4/G6/final reviews still judge full semantics. */
export function assertProductVisualContent(authority: ProductVisualAuthority, value: unknown, phase: string): void {
  if (authority.mode !== ABSTRACT_PRODUCT_VISUAL_MODE) return;
  const fail = (field: string) => {
    throw new ProductVisualAuthorityError(`${phase}/${field} 与本次禁止产品外观、包装、真实界面或操作演示的合同冲突`, "PRODUCT_VISUAL_CONTENT_CONFLICT");
  };
  const active = new Set<object>();
  const visit = (item: unknown, field: string): void => {
    if (typeof item === "string") {
      const clean = item.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
      if (/^[{[]/u.test(clean)) {
        let parsed: unknown;
        try { parsed = JSON.parse(clean); } catch { /* Non-JSON Markdown is still checked as text. */ }
        if (parsed !== undefined) { visit(parsed, field); return; }
      }
      for (const part of clauses(clean.normalize("NFKC"))) {
        if (part === "$product") fail(field);
        // A negated rule cannot cover a later affirmative instruction after a clause boundary.
        const clause = part.replace(/^[\s*#>-]*(?:\d{1,3}\.\s*)?(?:【)?(?:负面约束|负面清单|负面提示(?:词)?|负向提示(?:词)?|negative(?: prompt)?)(?:】)?\*{0,2}[:：]?\s*/iu, "");
        const normalizedProduct = authority.product?.normalize("NFKC").toLowerCase();
        const namedDepiction = normalizedProduct && ["展示", "实拍", "近拍", "特写", "操作", "打开", "show ", "film ", "demonstrate "]
          .some(verb => clause.toLowerCase().includes(`${verb}${normalizedProduct}`));
        if (!negatedVisualClause(clause) && (VISUAL_TARGET.test(clause) || namedDepiction)) fail(field);
      }
    } else if (item && typeof item === "object") {
      if (active.has(item)) fail(field);
      active.add(item);
      try {
        if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${field}[${index}]`));
        else for (const [key, entry] of Object.entries(item)) {
          if (key === "visualMode" && entry !== ABSTRACT_PRODUCT_VISUAL_MODE) fail(`${field}.${key}`);
          if (/^(?:productReferences?|productImages?|productPortraits?|productReferenceImages?|商品图|商品定妆照|商品参考图)$/iu.test(key)
            && entry !== undefined && entry !== null && entry !== "" && !(Array.isArray(entry) && !entry.length)) fail(`${field}.${key}`);
          visit(entry, `${field}.${key}`);
        }
      } finally { active.delete(item); }
    }
  };
  visit(value, "content");
}

export function assertProductVisualRenderPrompt(authority: ProductVisualAuthority, prompt: string, phase: string): void {
  assertProductVisualContent(authority, prompt, phase);
  if (authority.mode === ABSTRACT_PRODUCT_VISUAL_MODE && !prompt.includes(ABSTRACT_PRODUCT_RENDER_RULE)) {
    throw new ProductVisualAuthorityError(`${phase} 的实际供应商提示词缺少宿主冻结的无外观规则`, "PRODUCT_VISUAL_CONTENT_CONFLICT");
  }
}

function imageList(facts: Record<string, unknown>): ProductVisualReference[] {
  const stages = Array.isArray(facts.stages) ? facts.stages : [];
  const a1 = stages.map(object).find(stage => stage?.stage === "A1");
  const stageFacts = object(a1?.facts);
  const payload = object(stageFacts?.payload);
  const images = Array.isArray(payload?.images) ? payload.images : [];
  const cards = object(facts.cards);
  const portraitManifest = object(cards?.portrait_manifest);
  const referenceImages = Array.isArray(portraitManifest?.reference_images) ? portraitManifest.reference_images : [];
  const referencesByUrl = new Map<string, Record<string, unknown>>();
  for (const value of referenceImages) {
    const reference = object(value);
    if (reference && typeof reference.url === "string") referencesByUrl.set(reference.url, reference);
  }
  const unique = new Map<string, ProductVisualReference>();
  for (const value of images) {
    const image = object(value);
    if (!image || typeof image.url !== "string" || typeof image.page_url !== "string") continue;
    try {
      const url = new URL(image.url), page = new URL(image.page_url);
      if (!["http:", "https:"].includes(url.protocol) || !["http:", "https:"].includes(page.protocol)
        || url.username || url.password || page.username || page.password) continue;
      const reference = referencesByUrl.get(url.toString()) ?? {};
      const angle = image.angle ?? reference.angle;
      const licenseRisk = image.license_risk ?? reference.license_risk;
      unique.set(url.toString(), {
        url: url.toString(),
        pageUrl: page.toString(),
        ...(typeof image.source === "string" && image.source ? { source: image.source } : {}),
        ...(typeof angle === "string" && angle ? { angle } : {}),
        ...(typeof licenseRisk === "string" && licenseRisk ? { licenseRisk } : {}),
      });
    } catch {
      continue;
    }
  }
  return [...unique.values()];
}

/**
 * Returns a stable visual-authority snapshot. For a marketing project with an
 * explicit product, missing A1 images fail closed before G2/G3/PRD.
 */
export function extractProductVisualAuthority(g1Content: string): ProductVisualAuthority {
  let parsed: unknown;
  try {
    parsed = JSON.parse(g1Content);
  } catch {
    throw new ProductVisualAuthorityError("G1 原件不是合法 JSON，无法建立商品视觉授权");
  }
  const root = object(parsed), facts = object(root?.facts);
  if (!root || !facts) throw new ProductVisualAuthorityError("G1 原件缺少完整 facts");
  const product = productName(root, facts);
  const modeEvidence = explicitProductVisualMode(root.requestedIntent, root.requestedMetadata);
  if (modeEvidence && modeEvidence.value !== VERIFIED_PRODUCT_VISUAL_MODE) {
    return { mode: ABSTRACT_PRODUCT_VISUAL_MODE, modeEvidence, required: false, product, images: [], rule: abstractRule };
  }
  if (!product && !modeEvidence) return { mode: "no_named_product", modeEvidence: null, required: false, product: null, images: [], rule: appearanceRule };
  if (!product) throw new ProductVisualAuthorityError("真实外观模式缺少明确商品名");
  const images = imageList(facts);
  if (!images.length) throw new ProductVisualAuthorityError(`商品「${product}」缺少本次 G1 A1 已接受真实商品图，不能进入外观创作`);
  return { mode: VERIFIED_PRODUCT_VISUAL_MODE, modeEvidence, required: true, product, images, rule: appearanceRule };
}
