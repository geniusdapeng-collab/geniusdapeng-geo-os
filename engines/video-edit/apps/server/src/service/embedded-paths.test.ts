import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { locateHotelBundleDir, locatePrimaryBundle } from "./embedded-paths.js";
const roots: string[] = [];
function root(): string { const value = realpathSync(mkdtempSync(join(tmpdir(), "pengmanager-embedded-paths-"))); roots.push(value); return value; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("native onboarding resolves explicit contained bundle and product roots from an unrelated private cwd", () => {
  const engine = root(), cwd = root(), hotel = join(engine, "bundles/hotel");
  mkdirSync(hotel, { recursive: true }); writeFileSync(join(hotel, "bundle.json"), "{}");
  writeFileSync(join(engine, "product.manifest.json"), JSON.stringify({ defaultBundle: "geo-growth" }));
  expect(locateHotelBundleDir({ BUNDLES_ROOT: join(engine, "bundles") }, cwd)).toBe(hotel);
  expect(locatePrimaryBundle({ PENGMANAGER_ENGINE_ROOT: engine }, cwd)).toBe("geo-growth");
});
it("native unconfigured cwd traversal and fallback retain their original behavior", () => {
  const engine = root(), cwd = join(engine, "apps/server"); mkdirSync(cwd, { recursive: true });
  writeFileSync(join(engine, "pnpm-workspace.yaml"), "packages: []");
  writeFileSync(join(engine, "product.manifest.json"), JSON.stringify({ defaultBundle: "ai-video" }));
  expect(locateHotelBundleDir({}, cwd)).toBe(join(engine, "bundles/hotel"));
  expect(locatePrimaryBundle({}, cwd)).toBe("ai-video");
  expect(locatePrimaryBundle({}, root())).toBe("hotel");
});
it("an explicitly broken root fails without silently reading a cwd product", () => {
  const cwd = root(); writeFileSync(join(cwd, "product.manifest.json"), JSON.stringify({ defaultBundle: "hotel" }));
  expect(() => locatePrimaryBundle({ PENGMANAGER_ENGINE_ROOT: "relative" }, cwd)).toThrow();
  expect(() => locatePrimaryBundle({ PENGMANAGER_ENGINE_ROOT: join(root(), "missing") }, cwd)).toThrow();
  expect(() => locateHotelBundleDir({ BUNDLES_ROOT: root() }, cwd)).toThrow();
});
it("explicit product and hotel roots reject symlinks that escape their configured root", () => {
  const engine = root(), outside = root(); writeFileSync(join(outside, "manifest.json"), JSON.stringify({ defaultBundle: "hotel" }));
  symlinkSync(join(outside, "manifest.json"), join(engine, "product.manifest.json"));
  expect(() => locatePrimaryBundle({ PENGMANAGER_ENGINE_ROOT: engine }, root())).toThrow(/越出/);
  const bundles = root(); mkdirSync(join(outside, "hotel")); writeFileSync(join(outside, "hotel/bundle.json"), "{}");
  symlinkSync(join(outside, "hotel"), join(bundles, "hotel"));
  expect(() => locateHotelBundleDir({ BUNDLES_ROOT: bundles }, root())).toThrow(/越出/);
});
