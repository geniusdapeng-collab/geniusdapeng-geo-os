#!/usr/bin/env tsx
/** Import previously reviewed local research. No scraping, model calls, G1 grant, or publication. */
import { resolve } from "node:path";
import { importProductResearchArchive } from "../../packages/video-studio/src/product-research-archive.js";

try {
  const values = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--research", "--selection", "--metadata", "--root"].includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error(`参数无效、重复或缺少值：${key}`);
    values.set(key, value);
  }
  for (const key of ["--research", "--selection", "--metadata", "--root"]) if (!values.has(key)) throw new Error(`需要 ${key} <路径>`);
  const result = importProductResearchArchive({ researchFile: resolve(values.get("--research")!), selectionFile: resolve(values.get("--selection")!),
    metadataFile: resolve(values.get("--metadata")!), root: resolve(values.get("--root")!) });
  process.stdout.write(`${JSON.stringify({ directory: result.directory, sourceKind: result.archive.source.kind,
    reviewStatus: result.archive.source.reviewStatus, photos: result.archive.photos.length, summary: result.summary })}\n`);
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
