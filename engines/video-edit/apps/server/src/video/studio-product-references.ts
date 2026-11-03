/** Resolve caller-selected product images at the current Studio tenant/workspace/project boundary. */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ProductVisualAuthority, TrustedProductReference } from "@hyperreality/video-studio";
import { cleanDeliveryRef, inspectDeliveryFile, safeDeliveryPath } from "./delivery-trust.js";
import { scopedQuery, type AppPool, type Scope } from "./gen/db.js";
import { mediaRoot } from "./gen/ingest.js";
import { loadPortraitReuseManifest, type ArchivedPortraitCharacters } from "./portrait-reuse-acceptance.js";

const SHA = /^[a-f0-9]{64}$/;
const ASSET_KINDS = ["upload_image", "reference_image", "product_image"];
type Selection = { assetId: string } | { relativePath: string };
type ReferenceScope = { app: AppPool; scope: Scope; projectId: string };
type SourceIdentity = { projectId: string; workspaceId: string; rawIntentSha256: string };
type SelectedProductReference = {
  productId: string; productName: string; assetId: string; sourceUrl: string; pageUrl: string; sha256: string;
  authorizationBasis: "owner-confirmed-reference-use";
};
type ImageMime = "image/png" | "image/jpeg" | "image/webp";
export interface ProductionProductReference extends SelectedProductReference {
  projectId: string; rawIntentSha256: string; relativePath: string; bytes: number; mimeType: ImageMime; ownerManifestSha256: string;
}
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
function invalid(): never { throw new Error("PORTRAIT_PRODUCT_REFERENCE_INVALID: 商品参考必须来自当前工作区已登记并可核验的同商品图片"); }

function imageMatchesExtension(bytes: Buffer, extension: string): boolean {
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return extension === ".webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

function isCanonicalHttps(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && value === url.href;
  } catch { return false; }
}

/** Only the owner-controlled reuse manifest can select already registered production assets. */
export function selectedProductionProductReferences(manifest: ArchivedPortraitCharacters | undefined, identity: SourceIdentity): SelectedProductReference[] {
  if (manifest?.productReferenceSelection === undefined) return [];
  const selected = object(manifest.productReferenceSelection);
  if (!selected || selected.schemaVersion !== "workloom.product-reference-selection/v1"
    || typeof selected.workspaceId !== "string" || !selected.workspaceId.trim()
    || typeof selected.selectedAt !== "string" || !Number.isFinite(Date.parse(selected.selectedAt))
    || !Array.isArray(selected.products) || selected.products.length < 1 || selected.products.length > 4) return invalid();
  const byProject = typeof selected.projectId === "string" && Boolean(selected.projectId.trim());
  const byIntent = typeof selected.rawIntentSha256 === "string" && SHA.test(selected.rawIntentSha256);
  if (byProject === byIntent || (byProject && selected.rawIntentSha256 !== undefined)
    || (byIntent && selected.projectId !== undefined) || Object.keys(selected).length !== 5) return invalid();
  if (selected.workspaceId !== identity.workspaceId || (byProject ? selected.projectId !== identity.projectId
    : selected.rawIntentSha256 !== identity.rawIntentSha256)) return [];
  const used = new Set<string>();
  const products = selected.products.map(value => {
    const row = object(value);
    const fields = [row?.productId, row?.productName, row?.assetId, row?.sha256];
    if (!row || Object.keys(row).length !== 7
      || fields.some(field => typeof field !== "string" || !field.trim() || field.trim() !== field || field.length > 200)
      || !SHA.test(String(row.sha256)) || used.has(String(row.sha256))
      || !isCanonicalHttps(row.sourceUrl) || !isCanonicalHttps(row.pageUrl)
      || row.authorizationBasis !== "owner-confirmed-reference-use") return invalid();
    used.add(String(row.sha256));
    return row as SelectedProductReference;
  });
  if (new Set(products.map(item => item.productId)).size !== 1 || new Set(products.map(item => item.productName)).size !== 1
    || new Set(products.map(item => item.pageUrl)).size > 2) return invalid();
  return products;
}

async function readSelectedProductReference(input: ReferenceScope & {
  selected: SelectedProductReference; ownerManifestSha256: string; rawIntentSha256: string; productVisualAuthority?: ProductVisualAuthority;
}): Promise<{ reference: ProductionProductReference; content: Buffer; path: string }> {
  const { selected, productVisualAuthority } = input;
  if (productVisualAuthority && (productVisualAuthority.mode !== "verified_product_appearance" || productVisualAuthority.product !== selected.productName
    || !productVisualAuthority.images.some(image => image.url === selected.sourceUrl && image.pageUrl === selected.pageUrl))) return invalid();
  const root = path.resolve(mediaRoot());
  const [row] = await scopedQuery<{ id: string; sha256: string; relativePath: string }>(input.app, input.scope,
    `SELECT a.id,a.sha256,a.meta->>'localPath' AS "relativePath" FROM video_assets a JOIN workspaces w ON w.id=a.workspace_id
     WHERE w.tenant_id=$1 AND a.workspace_id=$2 AND (a.project_id IS NULL OR a.project_id=$3) AND a.status='registered'
       AND a.kind=ANY($4::text[]) AND a.license_risk<>'high' AND a.id=$5 AND a.sha256=$6
       AND (a.source_type='uploaded' OR (a.source_type='imported' AND a.license_risk='none'))`,
    [input.scope.tenantId, input.scope.workspaceId, input.projectId, ASSET_KINDS, selected.assetId, selected.sha256]);
  if (!row) return invalid();
  const location = selectLocal(row.relativePath, root, root, input.scope.workspaceId);
  if (!("relativePath" in location) || location.relativePath !== row.relativePath
    || path.posix.basename(row.relativePath, path.posix.extname(row.relativePath)) !== row.sha256) return invalid();
  try {
    const file = inspectDeliveryFile(root, row.relativePath, { read: true, maxBytes: 8_000_000 });
    const extension = path.posix.extname(row.relativePath);
    if (!file.content || file.sha256 !== selected.sha256 || file.bytes < 1024 || !imageMatchesExtension(file.content, extension)) return invalid();
    const mimeType = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
    return { reference: { ...selected, projectId: input.projectId, rawIntentSha256: input.rawIntentSha256,
      relativePath: row.relativePath, bytes: file.bytes, mimeType, ownerManifestSha256: input.ownerManifestSha256 },
      content: file.content, path: file.path };
  } catch { return invalid(); }
}

/** After the current G1 approves the exact page/image pair, freeze the verified registered file. */
export async function resolveProductionProductReferences(input: ReferenceScope & {
  manifest: ArchivedPortraitCharacters; rawIntentSha256: string; productVisualAuthority?: ProductVisualAuthority;
}): Promise<ProductionProductReference[]> {
  const manifest = loadPortraitReuseManifest(input.manifest.manifestPath, input.manifest.manifestSha256);
  const selected = selectedProductionProductReferences(manifest, { ...input, workspaceId: input.scope.workspaceId });
  const references = await Promise.all(selected.map(item => readSelectedProductReference({ ...input,
    selected: item, ownerManifestSha256: manifest.manifestSha256 })));
  return references.map(item => item.reference);
}

/** Qualification and dispatch must each revalidate owner selection, G1 and the original registered bytes. */
export async function readProductionProductReference(input: ReferenceScope & {
  productVisualAuthority: ProductVisualAuthority; reference: unknown;
}): Promise<{ reference: ProductionProductReference; content: Buffer; path: string }> {
  const receipt = object(input.reference);
  const manifestPath = process.env.HR_PORTRAIT_REUSE_MANIFEST?.trim();
  if (!manifestPath || !receipt || receipt.projectId !== input.projectId || typeof receipt.ownerManifestSha256 !== "string"
    || !SHA.test(receipt.ownerManifestSha256) || typeof receipt.rawIntentSha256 !== "string" || !SHA.test(receipt.rawIntentSha256)) return invalid();
  const manifest = loadPortraitReuseManifest(manifestPath, receipt.ownerManifestSha256);
  const selected = selectedProductionProductReferences(manifest, { ...input, workspaceId: input.scope.workspaceId,
    rawIntentSha256: receipt.rawIntentSha256 }).find(item => item.sha256 === receipt.sha256);
  if (!selected) return invalid();
  const current = await readSelectedProductReference({ ...input, selected, ownerManifestSha256: manifest.manifestSha256,
    rawIntentSha256: receipt.rawIntentSha256 });
  if (!isDeepStrictEqual(current.reference, receipt)) return invalid();
  return current;
}

function selectLocal(value: unknown, root: string, repositoryRoot: string, workspaceId: string): Selection {
  const item = object(value);
  if (typeof item?.assetId === "string" && item.assetId.trim() === item.assetId && item.assetId.length > 0 && item.assetId.length <= 200) {
    return { assetId: item.assetId };
  }
  const raw = typeof value === "string" ? value : item?.localPath ?? item?.path ?? item?.url;
  if (typeof raw !== "string" || raw.trim() !== raw || /[\\\x00-\x1f]/.test(raw) || raw.split("/").some(part => part === ".." || part === ".")) return invalid();
  let relativePath: string;
  try {
    relativePath = cleanDeliveryRef(/^(upload|image)\//.test(raw) ? raw : path.relative(root, path.resolve(repositoryRoot, raw)).split(path.sep).join("/"));
  } catch { return invalid(); }
  const [bucket, owner, file, ...extra] = relativePath.split("/");
  if (extra.length || owner !== workspaceId || !["upload", "image"].includes(bucket!) || !/^[a-f0-9]{64}\.(png|jpe?g|webp)$/.test(file ?? "")) return invalid();
  return { relativePath };
}

export async function resolveStudioProductReferences(input: {
  app: AppPool; scope: Scope; projectId: string; metadata?: Record<string, unknown>; repositoryRoot: string;
}): Promise<TrustedProductReference[]> {
  const root = path.resolve(mediaRoot());
  const selected = new Map<string, { productName: string; selections: Selection[] }>();
  for (const value of Array.isArray(input.metadata?.products) ? input.metadata.products : []) {
    const product = object(value);
    const manifest = object(product?.referenceManifest ?? product?.reference_manifest);
    const images = manifest?.reference_images ?? manifest?.referenceImages;
    if (!Array.isArray(images) || images.length === 0) continue;
    if (images.length > 32) return invalid();
    // Remote research URLs remain citations. They convey no authority to read a local file or fetch pixels.
    const selectors = images.filter(image => {
      const entry = object(image);
      return !(entry && entry.assetId === undefined && entry.path === undefined && entry.localPath == null
        && typeof entry.url === "string" && /^https?:\/\//i.test(entry.url));
    });
    if (!selectors.length) continue;
    const name = product?.name ?? product?.id ?? product?.productId;
    const id = product?.id ?? product?.productId ?? product?.name;
    if (typeof id !== "string" || !id.trim() || typeof name !== "string" || !name.trim() || selected.has(id)) return invalid();
    selected.set(id, { productName: name, selections: selectors.map(image => selectLocal(image, root, input.repositoryRoot, input.scope.workspaceId)) });
  }
  if (selected.size === 0) return [];
  const all = [...selected.values()].flatMap(item => item.selections);
  if (all.length > 64) return invalid();
  const ids = all.flatMap(item => "assetId" in item ? [item.assetId] : []);
  const paths = all.flatMap(item => "relativePath" in item ? [item.relativePath] : []);
  const rows = await scopedQuery<{ id: string; sha256: string; path: string }>(input.app, input.scope,
    `SELECT a.id,a.sha256,a.meta->>'localPath' AS path FROM video_assets a JOIN workspaces w ON w.id=a.workspace_id
     WHERE w.tenant_id=$1 AND a.workspace_id=$2 AND (a.project_id IS NULL OR a.project_id=$3) AND a.status='registered'
       AND a.kind=ANY($4::text[]) AND a.license_risk<>'high'
       AND (a.source_type='uploaded' OR (a.source_type='imported' AND a.license_risk='none'))
       AND (a.id=ANY($5::text[]) OR a.meta->>'localPath'=ANY($6::text[]))`,
    [input.scope.tenantId, input.scope.workspaceId, input.projectId, ASSET_KINDS, ids, paths]);
  return [...selected].map(([productId, { productName, selections }]) => {
    const files = selections.map(selector => {
      const matches = rows.filter(row => "assetId" in selector ? row.id === selector.assetId : row.path === selector.relativePath);
      const [row] = matches;
      if (matches.length !== 1 || !row || !SHA.test(row.sha256)) return invalid();
      const checked = selectLocal(row.path, root, input.repositoryRoot, input.scope.workspaceId);
      if (!("relativePath" in checked) || path.posix.basename(checked.relativePath, path.posix.extname(checked.relativePath)) !== row.sha256) return invalid();
      try {
        if (!lstatSync(safeDeliveryPath(root, checked.relativePath)).isFile()) return invalid();
        const file = inspectDeliveryFile(root, checked.relativePath, { read: true, maxBytes: 8_000_000 });
        if (file.bytes < 1024 || file.sha256 !== row.sha256 || !file.content
          || !imageMatchesExtension(file.content, path.posix.extname(checked.relativePath))) return invalid();
        return { path: file.path, realPath: realpathSync(file.path), sha256: file.sha256, bytes: file.bytes };
      } catch { return invalid(); }
    });
    return { productId, productName, files: files.filter((file, index) => files.findIndex(item => item.path === file.path) === index) };
  });
}
