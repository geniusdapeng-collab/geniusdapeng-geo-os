/** Explicit embedded roots let the native server keep its writable cwd private. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function realDirectory(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} 必须是绝对目录`);
  const root = realpathSync(value);
  if (!statSync(root).isDirectory()) throw new Error(`${label} 不是有效目录`);
  return root;
}
function realFileWithin(root: string, file: string): string {
  const actual = realpathSync(file), rel = relative(root, actual);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel) || !statSync(actual).isFile()) {
    throw new Error("嵌入产品清单越出已配置的引擎目录或不是文件");
  }
  return actual;
}

export function locateHotelBundleDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  if (env.BUNDLES_ROOT?.trim()) {
    const root = realDirectory(env.BUNDLES_ROOT.trim(), "BUNDLES_ROOT");
    const hotel = realDirectory(join(root, "hotel"), "酒店行业包");
    const rel = relative(root, hotel);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("酒店行业包越出 BUNDLES_ROOT");
    realFileWithin(hotel, join(hotel, "bundle.json"));
    return hotel;
  }
  let directory = resolve(cwd);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return join(directory, "bundles/hotel");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return join(cwd, "bundles/hotel");
}

export function locatePrimaryBundle(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  if (env.PENGMANAGER_ENGINE_ROOT?.trim()) {
    const root = realDirectory(env.PENGMANAGER_ENGINE_ROOT.trim(), "PENGMANAGER_ENGINE_ROOT");
    const file = realFileWithin(root, join(root, "product.manifest.json"));
    const data = JSON.parse(readFileSync(file, "utf8")) as { defaultBundle?: unknown };
    if (typeof data.defaultBundle !== "string" || !/^[a-z0-9][a-z0-9-]{1,31}$/.test(data.defaultBundle)) {
      throw new Error("嵌入产品没有有效的主行业包声明");
    }
    return data.defaultBundle;
  }
  let directory = resolve(cwd);
  for (let i = 0; i < 6; i++) {
    const file = join(directory, "product.manifest.json");
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as { defaultBundle?: unknown };
        if (typeof data.defaultBundle === "string" && data.defaultBundle.trim()) return data.defaultBundle.trim();
      } catch { /* Native compatibility: the unconfigured source falls back to hotel. */ }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "hotel";
}
