/** Resolve caller-selected product images at the current Studio tenant/workspace/project boundary. */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { TrustedProductReference } from "@hyperreality/video-studio";
import { cleanDeliveryRef, inspectDeliveryFile, safeDeliveryPath } from "./delivery-trust.js";
import { scopedQuery, type AppPool, type Scope } from "./gen/db.js";
import { mediaRoot } from "./gen/ingest.js";

const SHA = /^[a-f0-9]{64}$/;
const ASSET_KINDS = ["upload_image", "reference_image", "product_image"];
type Selection = { assetId: string } | { relativePath: string };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
function invalid(): never { throw new Error("PORTRAIT_PRODUCT_REFERENCE_INVALID: 商品参考必须来自当前工作区已登记并可核验的同商品图片"); }

function imageMatchesExtension(bytes: Buffer, extension: string): boolean {
  if (extension === ".png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return extension === ".webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
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
