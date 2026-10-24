import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseWorkforcePresets } from "@workloom/industry-contract";
import { bundlesRoot, composeWorkforce, loadComposedAssets, provisionComposedWorkforce, type ProvisionExecutor } from "./assembly.js";

const previous = process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES;
afterEach(() => { if (previous === undefined) delete process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES; else process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES = previous; });
const aliases = [
  ["ai-video", "ads-optimizer"], ["ai-video", "publish-operator"], ["ai-video", "review-analyst"], ["geo-growth", "company-ceo"],
] as const;
// Independent expected contracts read the original small YAML files; no repeated hashing of the entire media/font library in one test.
const sourcePreset = (bundleId: string, key: string) => parseWorkforcePresets([YAML.parse(fs.readFileSync(path.join(bundlesRoot(), bundleId, "presets", `${key}.yml`), "utf8"))])[0]!;
const declarations = () => ["hotel", "ai-video", "video-edit", "geo-growth"].flatMap((bundleId) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(bundlesRoot(), bundleId, "bundle.json"), "utf8"));
  return manifest.workloom.provides.presets.flatMap((relative: string) => parseWorkforcePresets([YAML.parse(fs.readFileSync(path.join(bundlesRoot(), bundleId, relative), "utf8"))]).map((preset) => ({ bundleId, preset })));
});

describe("PengManager complete independent role preservation", () => {
  it("default composition keeps its original 97 keys and original four owner contracts", () => {
    delete process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES;
    const original = composeWorkforce("geo-growth"); expect(original.presets.size).toBe(97); expect(original.shadowed).toHaveLength(4);
    for (const key of ["ads-optimizer", "publish-operator", "review-analyst"]) expect(original.presets.get(key)!.preset).toEqual(sourcePreset("geo-growth", key));
    expect(original.presets.get("company-ceo")!.preset).toEqual(sourcePreset("hotel", "company-ceo"));
    expect([...original.presets.keys()].some((key) => key.includes("--"))).toBe(false);
  });
  it("explicit mode retains all 101 declarations while preserving the 97 compatibility owner contracts", () => {
    process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES = "1";
    const complete = composeWorkforce("geo-growth"); expect(complete.presets.size).toBe(101); expect(complete.shadowed).toHaveLength(4);
    const originals = declarations(); expect(originals).toHaveLength(101);
    for (const original of originals) {
      const shadowed = aliases.some(([bundleId, key]) => bundleId === original.bundleId && key === original.preset.preset_key);
      const key = shadowed ? `${original.bundleId}--${original.preset.preset_key}` : original.preset.preset_key;
      const entry = complete.presets.get(key)!; expect(entry).toBeDefined(); expect(entry.bundleId).toBe(original.bundleId);
      expect({ ...entry.preset, name: original.preset.name, preset_key: original.preset.preset_key }).toEqual(original.preset);
    }
  });
  it("the native composed asset view uses the same 101 role contract", () => {
    process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES = "1";
    const assets = loadComposedAssets("geo-growth"); expect(assets.presets).toHaveLength(101);
    expect(new Set(assets.presets.map((preset) => preset.preset_key)).size).toBe(101);
  });
  it.each(aliases)("retains complete %s/%s definition, distinct risk/retry semantics and original skill references", (bundleId, key) => {
    process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES = "1";
    const complete = composeWorkforce("geo-growth"), entry = complete.presets.get(`${bundleId}--${key}`)!;
    const original = sourcePreset(bundleId, key);
    expect(entry).toBeDefined(); expect(entry.bundleId).toBe(bundleId); expect(entry.originalPresetKey).toBe(key);
    expect({ ...entry.preset, name: original.name, preset_key: original.preset_key }).toEqual(original);
    expect(entry.effectiveFenceBindings).toEqual(complete.presets.get(key)!.effectiveFenceBindings);
    for (const fence of original.fence_bindings ?? []) expect(entry.effectiveFenceBindings).toContain(fence);
    expect(entry.preset.tools).toEqual(original.tools); expect(entry.preset.prompt).toEqual(original.prompt);
    expect(entry.preset.skills).toEqual(original.skills); expect(entry.preset.high_risk).toBe(original.high_risk);
  });
  it("native provision writes 101 independent role contracts and alias provenance", async () => {
    process.env.WORKLOOM_PRESERVE_SHADOWED_ROLES = "1";
    const writes = new Map<string, { meta: Record<string, unknown>; skills: unknown; fences: unknown }>();
    const explicitFixture: ProvisionExecutor = { query: async (sql, args = []) => {
      if (sql.startsWith("UPDATE agents")) writes.set(String(args[1]), { meta: JSON.parse(String(args[8])), skills: JSON.parse(String(args[7])), fences: JSON.parse(String(args[6])) });
      return { rows: [], rowCount: sql.startsWith("UPDATE agents") ? 1 : 0 };
    } };
    const result = await provisionComposedWorkforce(explicitFixture, { tenantId: "fixture", workspaceId: "ws-explicit-fixture" }, "geo-growth", "fixture", undefined, { manageTransaction: false });
    expect(result.rosterSize).toBe(101); expect(writes.size).toBe(101);
    for (const [bundleId, key] of aliases) {
      const written = writes.get(`${bundleId}--${key}`)!;
      expect(written.meta.originalPresetKey).toBe(key); expect(written.meta.runtimeAlias).toBe(true); expect(written.meta.sourceBundleId).toBe(bundleId);
      expect(written.meta.preset_key).toBe(`${bundleId}--${key}`);
      expect(written.skills).toEqual(sourcePreset(bundleId, key).skills ?? []);
    }
  });
});
