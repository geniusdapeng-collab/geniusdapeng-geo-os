/** Read-only local consumer for the embedded video library. No generation, approval writes, or network calls. */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { bundlesRoot, loadVerifiedBundleManifest, localBundleAssetPath } from "./local-bundle.js";
import { loadCharacterEntry, type CharacterEntry } from "./character-archive.js";
import { assessPortraitDecision, selectPortraitDecisionRecord, type PortraitDecisionRecord } from "./portrait-decision.js";
import { hasExplicitPortraitAuthorization, verifyPortraitOwnerAuthorization } from "./portrait-owner-authorization.js";
import { appendBuiltinCharacterGuidance, resolveBuiltinCharacters } from "./builtin-character-selection.js";
import { loadProductArchive, selectProductArchive, type LoadedProductArchive } from "./product-archive.js";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => Boolean(value && typeof value === "object" && !Array.isArray(value));
export class VideoLibraryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "VideoLibraryError"; }
}
function rootFor(options: { bundleRoot?: string }) { return path.resolve(options.bundleRoot ?? bundlesRoot(), "ai-video"); }
function characterDetails(entry: CharacterEntry, bundleDir: string) {
  if (entry.verification.status !== "passed" || !entry.activeSet) throw new Error(`角色当前版本未核实：${entry.id} ${entry.verification.issues.join("；")}`);
  const ledger = path.join(entry.dir, "gates.jsonl");
  const records = existsSync(ledger) ? readFileSync(ledger, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as PortraitDecisionRecord) : [];
  const selected = selectPortraitDecisionRecord(records, `portrait:${entry.id}:v${entry.activeSet.version}`);
  const decision = assessPortraitDecision(selected);
  const authorization = selected && hasExplicitPortraitAuthorization(selected)
    ? verifyPortraitOwnerAuthorization(selected, { dir: entry.dir, characterId: entry.id, version: entry.activeSet.version, files: entry.files }) : null;
  if (authorization && !authorization.ok) throw new Error(`角色用途授权字节无效：${authorization.issues.join("；")}`);
  return {
    profile: JSON.parse(readFileSync(path.join(entry.dir, "profile.json"), "utf8")) as Json,
    activeVersion: entry.activeSet.version,
    views: Object.fromEntries(Object.entries(entry.verification.assets).map(([angle, receipt]) => [angle,
      { path: path.relative(bundleDir, receipt.path).split(path.sep).join("/"), sha256: receipt.sha256, bytes: receipt.bytes }])),
    verification: { status: entry.verification.status, scope: entry.verification.scope, issues: entry.verification.issues },
    ownerDecision: { ...decision, basis: selected?.evidence?.basis ?? null, currentBytesVerified: authorization?.ok ?? false,
      authorization: authorization?.authorization ?? null, humanVisualReviewClaimed: selected?.evidence?.basis === "human-review" },
  };
}

function registeredProducts(bundleDir: string, assets: Record<string, string>): LoadedProductArchive[] {
  return Object.keys(assets).filter(file => /^library\/products\/[^/]+\/profile\.json$/.test(file)).sort().map(file => {
    const profile = localBundleAssetPath(bundleDir, file), loaded = loadProductArchive(path.dirname(profile));
    if (!loaded || loaded.issues.some(issue => issue.hard)) throw new Error(`商品当前档案未核实：${file} ${loaded?.issues.map(issue => issue.code).join(",") ?? "missing"}`);
    return loaded;
  });
}

export function readVideoLibrary(kind: "all" | "characters" | "products" = "all", options: { bundleRoot?: string } = {}) {
  if (!["all", "characters", "products"].includes(kind)) throw new VideoLibraryError("VIDEO_LIBRARY_KIND_INVALID", "kind只接受all、characters或products");
  const manifest = loadVerifiedBundleManifest("ai-video", options.bundleRoot ?? bundlesRoot()), bundleDir = rootFor(options);
  const registryFile = localBundleAssetPath(bundleDir, "library/characters/registry.json");
  if (!manifest.integrity.assets["library/characters/registry.json"]) throw new Error("角色registry未登记完整性摘要");
  const registry: unknown = JSON.parse(readFileSync(registryFile, "utf8"));
  if (!object(registry) || registry.schemaVersion !== "workloom.character-registry/v1" || !Array.isArray(registry.models)) throw new Error("角色registry结构无效");
  const characters = kind === "products" ? [] : registry.models.map(raw => {
    if (!object(raw) || typeof raw.id !== "string" || typeof raw.archive !== "string") throw new Error("角色registry身份无效");
    const relative = `${raw.archive.replace(/^bundles\/ai-video\//, "")}/profile.json`;
    if (!manifest.integrity.assets[relative]) throw new Error("角色profile未登记完整性摘要");
    const entry = loadCharacterEntry(path.dirname(localBundleAssetPath(bundleDir, relative)));
    if (!entry || entry.id !== raw.id) throw new Error("角色profile与registry身份不符");
    return characterDetails(entry, bundleDir);
  });
  const products = kind === "characters" ? [] : registeredProducts(bundleDir, manifest.integrity.assets).map(entry => ({
    profile: entry.archive,
    issues: entry.issues,
    photos: entry.archive.photos.map(photo => ({ ...photo, path: path.relative(bundleDir, path.resolve(entry.dir, photo.file)).split(path.sep).join("/") })),
    productionAuthorityGranted: false,
  }));
  return { schemaVersion: "pengmanager.video-library/v1", kind, defaultModel: registry.defaultModel,
    bundleDigest: manifest.integrity.digest, assetVerification: "current-local-sha256", paidCalls: 0,
    productionAuthorityGranted: false, characters, products };
}

export function resolveVideoCharacters(input: { intent: string; metadata?: Json }, options: { bundleRoot?: string } = {}) {
  if (!object(input) || typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > 8000
    || Object.keys(input).some(key => !["intent", "metadata"].includes(key))
    || input.metadata !== undefined && !object(input.metadata)) throw new VideoLibraryError("VIDEO_CHARACTER_REQUEST_INVALID", "需要8000字以内intent与可选metadata对象");
  const resolution = resolveBuiltinCharacters(input.intent, input.metadata, options);
  const library = readVideoLibrary("characters", options);
  return { ...resolution, guidance: appendBuiltinCharacterGuidance(input.intent, resolution),
    archives: library.characters.filter(item => resolution.builtinIds.includes(String(item.profile.id))),
    assetVerification: library.assetVerification, bundleDigest: library.bundleDigest,
    paidCalls: 0, productionAuthorityGranted: false };
}

export function resolveVideoProduct(selector: string, options: { bundleRoot?: string } = {}) {
  if (typeof selector !== "string" || !selector.trim() || selector.length > 240) throw new VideoLibraryError("VIDEO_PRODUCT_REQUEST_INVALID", "selector需要1到240字的商品ID、名称、型号或品牌");
  const manifest = loadVerifiedBundleManifest("ai-video", options.bundleRoot ?? bundlesRoot()), bundleDir = rootFor(options);
  const result = selectProductArchive(registeredProducts(bundleDir, manifest.integrity.assets), selector);
  if (!result.archive) throw new VideoLibraryError(result.candidates.length > 1 && result.reason.includes("歧义") ? "VIDEO_PRODUCT_AMBIGUOUS" : "VIDEO_PRODUCT_NOT_FOUND", result.reason, result.reason.includes("歧义") ? 409 : 404);
  return { ...result, dir: path.relative(bundleDir, result.dir!).split(path.sep).join("/"),
    assetVerification: "current-local-sha256", bundleDigest: manifest.integrity.digest, paidCalls: 0, productionAuthorityGranted: false };
}
