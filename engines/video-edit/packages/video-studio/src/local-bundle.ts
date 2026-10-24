/** Local embedded-engine asset integrity. This is not WorkLoom bundle activation or a production signature. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
export interface LocalVideoBundle extends Json {
  schemaVersion: string;
  workloom: Json & { industry: string; provides: Record<string, string | string[]> };
  integrity: { algorithm: "sha256"; digest: string; assets: Record<string, string> };
}
const object = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
  : object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : value;

export function bundlesRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../bundles");
}

/** Same manifest-and-asset payload convention as the frozen upstream contract; no integrity self-reference. */
export function localBundleDigest(input: LocalVideoBundle): string {
  const { integrity, ...payload } = input;
  return hash(`${JSON.stringify(ordered(payload))}\n${JSON.stringify(ordered(integrity.assets))}`);
}

export function localBundleAssetPath(bundleDir: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\")
    || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("LOCAL_VIDEO_ASSET_INVALID: 资产路径越界");
  const root = path.resolve(bundleDir), file = path.resolve(root, relative);
  if (realpathSync(root) !== root || realpathSync(file) !== file) throw new Error("LOCAL_VIDEO_ASSET_INVALID: 资产或父目录使用符号链接");
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 100_000_000) throw new Error("LOCAL_VIDEO_ASSET_INVALID: 资产不是有效普通文件");
  return file;
}

/** Verify the exact declared local closure on every read; missing or changed assets never become a passed flag. */
export function loadVerifiedBundleManifest(slug: string, root = bundlesRoot()): LocalVideoBundle {
  if (slug !== "ai-video") throw new Error("LOCAL_VIDEO_BUNDLE_INVALID: 只支持内置视频引擎");
  const bundleDir = path.resolve(root, slug);
  const file = localBundleAssetPath(bundleDir, "bundle.json");
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!object(value) || typeof value.schemaVersion !== "string" || !object(value.workloom)
    || value.workloom.industry !== slug || !object(value.workloom.provides) || !object(value.integrity)
    || value.integrity.algorithm !== "sha256" || !digest(value.integrity.digest) || !object(value.integrity.assets)) {
    throw new Error("LOCAL_VIDEO_BUNDLE_INVALID: 本地引擎清单缺少完整性合同");
  }
  const manifest = value as LocalVideoBundle;
  const declared: string[] = [];
  for (const group of Object.values(manifest.workloom.provides)) {
    if (typeof group === "string") declared.push(group);
    else if (Array.isArray(group) && group.every(item => typeof item === "string")) declared.push(...group);
    else throw new Error("LOCAL_VIDEO_BUNDLE_INVALID: provides必须是路径或路径数组");
  }
  const indexed = Object.keys(manifest.integrity.assets).sort();
  if (new Set(declared).size !== declared.length || indexed.length !== declared.length
    || [...declared].sort().some((entry, index) => indexed[index] !== entry)
    || localBundleDigest(manifest) !== manifest.integrity.digest) throw new Error("LOCAL_VIDEO_BUNDLE_CHANGED: 清单摘要或资产集合不符");
  for (const asset of indexed) {
    if (!digest(manifest.integrity.assets[asset])) throw new Error("LOCAL_VIDEO_BUNDLE_CHANGED: 资产摘要无效");
    const assetFile = localBundleAssetPath(bundleDir, asset), before = lstatSync(assetFile), bytes = readFileSync(assetFile), after = lstatSync(assetFile);
    if (bytes.length !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || hash(bytes) !== manifest.integrity.assets[asset]) throw new Error(`LOCAL_VIDEO_BUNDLE_CHANGED: 资产字节不符：${asset}`);
  }
  return manifest;
}
