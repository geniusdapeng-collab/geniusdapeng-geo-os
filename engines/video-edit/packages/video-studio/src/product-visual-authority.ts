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
  required: boolean;
  product: string | null;
  images: ProductVisualReference[];
  rule: string;
}

const PRODUCT_VISUAL_AUTHORITY_CODE = "PRODUCT_VISUAL_AUTHORITY_REQUIRED";

export class ProductVisualAuthorityError extends Error {
  readonly code = PRODUCT_VISUAL_AUTHORITY_CODE;

  constructor(message: string) {
    super(`${PRODUCT_VISUAL_AUTHORITY_CODE}: ${message}`);
    this.name = "ProductVisualAuthorityError";
  }
}

const appearanceRule = "商品外观、颜色、涂装、比例、部件和空间形态只能引用本次 G1 A1 已接受图片中的可见内容；"
  + "文字 claims 仅支持其明确写出的名称、参数和用途，不得把描述扩写成未核实外观。";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function productName(value: unknown): string | null {
  const root = object(value), facts = object(root?.facts), metadata = object(root?.requestedMetadata);
  const brief = object(metadata?.brief), product = object(brief?.product);
  const name = product?.name ?? brief?.product;
  return typeof name === "string" && name.trim() ? name.trim() : null;
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
  if (!facts) throw new ProductVisualAuthorityError("G1 原件缺少完整 facts");
  const product = productName(parsed);
  if (!product) return { required: false, product: null, images: [], rule: appearanceRule };
  const images = imageList(facts);
  if (!images.length) throw new ProductVisualAuthorityError(`商品「${product}」缺少本次 G1 A1 已接受真实商品图，不能进入外观创作`);
  return { required: true, product, images, rule: appearanceRule };
}
