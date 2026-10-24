/** Seal/check the actual embedded asset closure. This does not activate or sign a WorkLoom industry package. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { localBundleDigest, loadVerifiedBundleManifest } from "../engines/video-edit/packages/video-studio/src/local-bundle.ts";

const root = resolve(import.meta.dirname, ".."), bundles = join(root, "engines/video-edit/bundles"), dir = join(bundles, "ai-video");
const file = join(dir, "bundle.json");
const args = process.argv.slice(2);
if (args.some(arg => arg !== "--write") || args.length > 1) throw new Error("Use --write to refresh local asset bytes, or no arguments to verify.");
if (args.includes("--write")) {
  const document = JSON.parse(readFileSync(file, "utf8"));
  const removed = [];
  for (const [group, provided] of Object.entries(document.workloom.provides)) {
    const keep = entry => {
      if (typeof entry !== "string" || !entry || entry.includes("\\") || entry.startsWith("/") || entry.split("/").some(part => part === "." || part === "..")) throw new Error("Invalid declared asset path");
      const present = existsSync(join(dir, entry)) && lstatSync(join(dir, entry)).isFile();
      if (!present) removed.push(entry);
      return present;
    };
    if (Array.isArray(provided)) document.workloom.provides[group] = provided.filter(keep);
    else if (!keep(provided)) delete document.workloom.provides[group];
  }
  const library = new Set(document.workloom.provides.library ?? []);
  for (const prefix of ["library/characters", "library/products", "library/fonts"]) {
    const walk = folder => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("Embedded library assets must not be symlinks");
        const absolute = join(folder, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (entry.isFile()) library.add(relative(dir, absolute).split(sep).join("/"));
      }
    };
    walk(join(dir, prefix));
  }
  document.workloom.provides.library = [...library].sort((a, b) => a.localeCompare(b));
  const paths = Object.values(document.workloom.provides).flatMap(value => typeof value === "string" ? [value] : value);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate declared asset");
  const assets = Object.fromEntries(paths.sort((a, b) => a.localeCompare(b)).map(asset => [asset, createHash("sha256").update(readFileSync(join(dir, asset))).digest("hex")]));
  document.integrity = { algorithm: "sha256", digest: "0".repeat(64), assets };
  document.integrity.digest = localBundleDigest(document);
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(root, "upstreams/video-edit-local-assets.json"), `${JSON.stringify({ schemaVersion: "pengmanager.video-local-assets/v1",
    sourceRepository: "geniusdapeng-collab/WorkLoom-video-edit", sourceCommit: "f5fed51e419e954a2204684e8a1914be91201114",
    scope: "local-embedded-asset-integrity-only", workloomActivationGranted: false,
    assetCount: paths.length, digest: document.integrity.digest, omittedUpstreamAssets: removed.sort() }, null, 2)}\n`);
}
const manifest = loadVerifiedBundleManifest("ai-video", bundles);
console.log(JSON.stringify({ ok: true, scope: "current-local-asset-bytes", assets: Object.keys(manifest.integrity.assets).length, digest: manifest.integrity.digest, paidCalls: 0 }));
