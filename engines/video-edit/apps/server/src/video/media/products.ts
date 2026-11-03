/**
 * media/products.ts —— 商品档案 PG 投影（T-2026-0926-0007）
 *
 * 口径（决策 D8）：**dossier 文件仍是本体**（`.vm-work/dossiers/<ws>/<productId>/`），
 * 本表只是"发现面"：给媒资库一个可查询/可筛选的商品档案视图，并用 dossier_sha256 做漂移对账。
 * 因此：
 *  - 投影永不成为第二事实源（刷新即按文件重算 sha256，文件变了就更新，文件没变就原样）；
 *  - 摘要字段只做**忠实映射**：读不到的字段留 null，绝不用模型或默认值补编；
 *  - 档案主图（manifest 首图）登记进媒资库 kind=product_image，回填 hero_asset_id。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type pg from "pg";
import { newId } from "@workloom/shared";
import { scopedQuery, type AppPool, type Scope } from "../gen/db.js";
import { registerLocalAsset } from "./register-local.js";
import { inspectDeliveryFile } from "../delivery-trust.js";
import { fetchPublicMarketingImage } from "../marketing-source-fetcher.js";
import { safeSegment } from "./paths.js";

export type ProductProfileRow = {
  id: string;
  product_name: string;
  /** dossier 目录名（稳定身份；商品改名不再新建行） */
  dossier_product_id: string | null;
  dossier_path: string;
  dossier_sha256: string;
  summary: Record<string, unknown>;
  hero_asset_id: string | null;
  status: "active" | "stale" | "archived";
  created_at: string;
  updated_at: string;
};

export interface ProductProfileView {
  id: string;
  productName: string;
  /** 供 UI「重新扫描」用的稳定标识（目录名），不再用商品名冒充 */
  dossierProductId: string | null;
  dossierPath: string;
  dossierSha256: string;
  summary: Record<string, unknown>;
  heroAssetId: string | null;
  heroUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  /** 文件本体是否还在（漂移对账的即时提示） */
  dossierExists: boolean;
}

function toView(row: ProductProfileRow, heroUrlByAsset: Map<string, string> = new Map()): ProductProfileView {
  const localPath = row.hero_asset_id ? heroUrlByAsset.get(row.hero_asset_id) ?? null : null;
  return {
    id: row.id,
    productName: row.product_name,
    dossierProductId: row.dossier_product_id,
    dossierPath: row.dossier_path,
    dossierSha256: row.dossier_sha256,
    summary: row.summary ?? {},
    heroAssetId: row.hero_asset_id,
    heroUrl: localPath,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dossierExists: existsSync(row.dossier_path),
  };
}

export async function listProductProfiles(app: AppPool, scope: Scope): Promise<ProductProfileView[]> {
  const rows = await scopedQuery<ProductProfileRow>(app, scope,
    `SELECT * FROM media_product_profiles WHERE workspace_id = $1 ORDER BY updated_at DESC, id DESC`,
    [scope.workspaceId]);
  const heroMap = await heroUrlMap(app, scope, rows.map((r) => r.hero_asset_id).filter((id): id is string => Boolean(id)));
  return rows.map((row) => toView(row, heroMap));
}

export async function getProductProfile(app: AppPool, scope: Scope, id: string): Promise<ProductProfileView | null> {
  const rows = await scopedQuery<ProductProfileRow>(app, scope,
    `SELECT * FROM media_product_profiles WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, id]);
  const row = rows[0];
  if (!row) return null;
  const heroMap = await heroUrlMap(app, scope, row.hero_asset_id ? [row.hero_asset_id] : []);
  return toView(row, heroMap);
}

async function heroUrlMap(app: AppPool, scope: Scope, assetIds: string[]): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();
  const { mediaUrl } = await import("../gen/ingest.js");
  const rows = await scopedQuery<{ id: string; local_path: string | null }>(app, scope,
    `SELECT id, meta->>'localPath' AS local_path FROM video_assets
      WHERE workspace_id = $1 AND id = ANY($2::text[])`,
    [scope.workspaceId, assetIds]);
  const map = new Map<string, string>();
  for (const row of rows) if (row.local_path) map.set(row.id, mediaUrl(row.local_path));
  return map;
}

/* ================= dossier 读取与摘要（只做忠实映射） ================= */

export interface DossierImageEntry {
  id?: string;
  url?: string;
  angle?: string;
  source?: string;
  license_risk?: string;
}

interface DossierLike {
  product_id?: string;
  identity?: Record<string, unknown>;
  visual_assets?: { hero_image_id?: string; images?: DossierImageEntry[]; needs_more_reference?: boolean };
  insights?: Record<string, unknown>;
  selling_points?: unknown;
  confidence?: unknown;
  verdict?: Record<string, unknown>;
  cross_verification?: Record<string, unknown>;
  provenance?: unknown;
  gaps?: unknown;
}

function firstStringArray(candidates: unknown[]): string[] {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const strings = candidate
        .map((item) => (typeof item === "string" ? item : (item && typeof item === "object" ? (item as { text?: unknown; claim?: unknown }).text ?? (item as { claim?: unknown }).claim : null)))
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

export function summarizeDossier(dossier: DossierLike): Record<string, unknown> {
  const identity = dossier.identity ?? {};
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = (identity as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  const confidence = dossier.confidence
    ?? dossier.verdict?.confidence
    ?? dossier.cross_verification?.confidence
    ?? null;
  return {
    productId: dossier.product_id ?? null,
    name: pick("name", "title", "product_name"),
    brand: pick("brand", "brand_name"),
    category: pick("category", "category_path"),
    priceBand: pick("price_band"),
    sellingPoints: firstStringArray([
      dossier.selling_points,
      dossier.insights?.selling_points,
      dossier.insights?.strengths,
      dossier.verdict?.selling_points,
    ]),
    confidence: typeof confidence === "number" || typeof confidence === "string" ? confidence : null,
    evidenceCount: Array.isArray(dossier.provenance) ? dossier.provenance.length : null,
    gaps: Array.isArray(dossier.gaps) ? dossier.gaps.length : null,
    needsMoreReference: dossier.visual_assets?.needs_more_reference ?? null,
  };
}

export interface UpsertProductProfileResult {
  profile: ProductProfileView;
  changed: boolean;
  heroIngested: boolean;
  heroError: string | null;
  errors: string[];
}

/**
 * 读 `dossier.json` → 计算 sha256 → UPSERT 投影 → 主图入库并回填 hero_asset_id。
 * 幂等：正文和当前主图均相同才视为无实质变化（changed=false）。
 */
export async function upsertProductProfileFromDossier(
  app: AppPool,
  gateway: pg.Pool,
  scope: Scope,
  input: { dossierRoot: string; productId: string; by: string; fetchHero?: boolean; heroMaxBytes?: number },
): Promise<UpsertProductProfileResult> {
  const errors: string[] = [];
  // productId 只接受单段目录名（深审实测："../../../etc" 曾把 dossier 探测到根外）
  const dossierProductId = safeSegment(input.productId, "productId");
  const dir = join(input.dossierRoot, dossierProductId);
  const dossierPath = join(dir, "dossier.json");
  if (!existsSync(dossierPath)) {
    throw new Error(`商品档案不存在：${dossierPath}（情报环节未产出该 product_id）`);
  }
  const dossierFile = inspectDeliveryFile(input.dossierRoot, `${dossierProductId}/dossier.json`, { read: true, maxBytes: 8_000_000 });
  const dossierSha = dossierFile.sha256;
  let dossier: DossierLike;
  try {
    dossier = JSON.parse(dossierFile.content!.toString("utf8")) as DossierLike;
  } catch (err) {
    throw new Error(`dossier.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  const summary = summarizeDossier(dossier);
  const productName = String(
    (summary.name as string | null)
    ?? dossier.product_id
    ?? input.productId,
  );

  // 稳定身份优先：同一 dossier 目录名 → 同一行（改名只改 product_name，不新建行）
  const existing = await scopedQuery<ProductProfileRow>(app, scope,
    `SELECT * FROM media_product_profiles
      WHERE workspace_id = $1 AND (dossier_product_id = $2 OR dossier_product_id IS NULL AND product_name = $3)
      ORDER BY (dossier_product_id = $2) DESC NULLS LAST
      LIMIT 1`,
    [scope.workspaceId, dossierProductId, productName]);
  const prev = existing[0] ?? null;
  const id = prev?.id ?? newId("MP");

  // 主图：优先本地已落盘文件（portrait 运行时会下载参考图），否则按 manifest url 下载（可关）
  let heroAssetId: string | null = null;
  let heroIngested = false;
  let heroError: string | null = null;
  const manifestRef = `${dossierProductId}/images/manifest.json`;
  const manifestPath = join(input.dossierRoot, manifestRef);
  let manifestSha: string | undefined;
  try {
    if (existsSync(manifestPath)) {
      const manifestFile = inspectDeliveryFile(input.dossierRoot, manifestRef, { read: true, maxBytes: 1_000_000 });
      manifestSha = manifestFile.sha256;
      const manifest = JSON.parse(manifestFile.content!.toString("utf8")) as {
        hero_image_id?: string; reference_images?: DossierImageEntry[];
      };
      const images = manifest.reference_images ?? [];
      const selected = manifest.hero_image_id ? images.filter(img => img.id === manifest.hero_image_id) : images.slice(0, 1);
      const [heroEntry] = selected;
      if (selected.length > 1) throw new Error("主图标识重复，无法核实当前主图");
      if (manifest.hero_image_id && !heroEntry) throw new Error("找不到清单指定的主图");
      if (heroEntry) {
        const localDir = join(dir, "images");
        const imageNames = readdirSync(localDir, { withFileTypes: true }).filter(file => file.isFile() && /\.(png|jpe?g|webp)$/i.test(file.name)).map(file => file.name);
        const matches = imageNames.filter(name => heroEntry.id && (basename(name, extname(name)) === heroEntry.id
          || name.startsWith(`${heroEntry.id}-`) || name.startsWith(`${heroEntry.id}_`)));
        // Single-image historical dossiers used the canonical hero.<ext> name.
        const candidates = !matches.length && images.length === 1 ? imageNames.filter(name => basename(name, extname(name)) === "hero") : matches;
        if (candidates.length > 1) throw new Error("当前主图对应多个本地文件，无法核实唯一来源");
        const [local] = candidates;
        if (local) {
          const file = inspectDeliveryFile(input.dossierRoot, `${dossierProductId}/images/${local}`, { maxBytes: 15 * 1024 * 1024 });
          const reg = await registerLocalAsset(app, gateway, scope, {
            absPath: file.path, expectedSha256: file.sha256, expectedRealPath: realpathSync(file.path),
            kind: "product_image",
            title: `${productName} · 主图`,
            tags: [productName, "商品图"],
            prompt: null,
            sourceType: "imported",
            licenseRisk: "unknown",
            provenance: { source: "dossier", dossierPath, imageId: heroEntry.id ?? null, angle: heroEntry.angle ?? null },
            by: input.by,
          });
          heroAssetId = reg.assetId;
          heroIngested = !reg.deduped;
        } else if (heroEntry.url && (input.fetchHero ?? true)) {
          const { bytes, extension, finalUrl } = await fetchPublicMarketingImage(heroEntry.url, input.heroMaxBytes);
          const source = new URL(finalUrl); source.search = "";
          const temporary = await mkdtemp(join(tmpdir(), "workloom-product-hero-"));
          try {
            const file = join(temporary, `hero.${extension}`);
            await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
            const reg = await registerLocalAsset(app, gateway, scope, {
              absPath: file, expectedSha256: createHash("sha256").update(bytes).digest("hex"), expectedRealPath: realpathSync(file),
              kind: "product_image", title: `${productName} · 主图`, tags: [productName, "商品图"], sourceType: "imported", licenseRisk: "unknown",
              provenance: { source: "dossier", dossierPath, sourceUrl: source.href,
                sourceUrlSha256: createHash("sha256").update(finalUrl).digest("hex"), imageId: heroEntry.id ?? null }, by: input.by,
            });
            heroAssetId = reg.assetId;
            heroIngested = !reg.deduped;
          } finally { await rm(temporary, { recursive: true, force: true }); }
        }
      }
    }
  } catch (err) {
    heroError = err instanceof Error ? err.message : String(err);
  }
  if (heroError) errors.push(heroError);

  if (inspectDeliveryFile(input.dossierRoot, `${dossierProductId}/dossier.json`, { maxBytes: 8_000_000 }).sha256 !== dossierSha
    || (manifestSha !== undefined && inspectDeliveryFile(input.dossierRoot, manifestRef, { maxBytes: 1_000_000 }).sha256 !== manifestSha)) {
    throw new Error("商品档案在投影期间变化，请重扫当前版本");
  }
  const [projected] = await scopedQuery<{ id: string }>(app, scope,
    `INSERT INTO media_product_profiles
       (id, workspace_id, product_name, dossier_product_id, dossier_path, dossier_sha256, summary, hero_asset_id, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active', now())
     ON CONFLICT (workspace_id, dossier_product_id) WHERE dossier_product_id IS NOT NULL DO UPDATE
       SET product_name = EXCLUDED.product_name,
           dossier_path = EXCLUDED.dossier_path,
           dossier_sha256 = EXCLUDED.dossier_sha256,
           summary = EXCLUDED.summary,
           hero_asset_id = EXCLUDED.hero_asset_id,
           status = 'active',
           updated_at = now() RETURNING id`,
    [id, scope.workspaceId, productName, dossierProductId, dossierPath, dossierSha, JSON.stringify(summary), heroAssetId]);

  const saved = projected && await getProductProfile(app, scope, projected.id);
  if (!saved) throw new Error("商品档案投影保存后无法回读");
  return {
    profile: saved,
    changed: !prev || prev.dossier_sha256 !== dossierSha || prev.hero_asset_id !== heroAssetId,
    heroIngested,
    heroError,
    errors,
  };
}

/** 列出 dossier 根下的全部 product_id（"全部重扫"的数据源） */
export function listDossierProductIds(dossierRoot: string): string[] {
  if (!existsSync(dossierRoot)) return [];
  return readdirSync(dossierRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    .filter((name) => existsSync(join(dossierRoot, name, "dossier.json")))
    .sort();
}
