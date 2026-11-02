import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebSearch, FIXTURE_PROVIDER, searchCacheKey } from "./data-mining-executor.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MC-007 fixture-only marketing research isolation", () => {
  it.each(["missing", "empty", "expired", "irrelevant"])("never calls an online provider when the booked fixture is %s", async state => {
    const root = mkdtempSync(path.join(os.tmpdir(), "marketing-search-isolation-"));
    roots.push(root);
    const cacheFile = path.join(root, "search.json"), query = "核实产品 参数";
    if (state !== "missing") writeFileSync(cacheFile, JSON.stringify({ version: 1, entries: {
      [searchCacheKey(FIXTURE_PROVIDER, query)]: {
        at: state === "expired" ? "2000-01-01T00:00:00Z" : new Date().toISOString(),
        hits: state === "empty" ? [] : [{ title: "其他商品", snippet: "不同商品来源", url: "https://example.com/source" }],
      },
    } }));
    const fetch = vi.fn(async () => { throw new Error("External network forbidden by this regression"); });
    vi.stubGlobal("fetch", fetch);
    const search = createWebSearch({ fixtureOnly: true, cacheFile, paceMs: 0, providers: ["api", "bing"],
      api: { provider: "generic", apiUrl: "https://example.com/search", apiKey: "test-only" } });
    expect(await search(query, 5)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns only a relevant booked source without filling the requested limit online", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "marketing-search-isolation-"));
    roots.push(root);
    const cacheFile = path.join(root, "search.json"), query = "核实产品 参数";
    const hit = { title: "核实产品官方规格", snippet: "真实来源", url: "https://example.com/product" };
    writeFileSync(cacheFile, JSON.stringify({ version: 1, entries: {
      [searchCacheKey(FIXTURE_PROVIDER, query)]: { at: new Date().toISOString(), hits: [hit] },
    } }));
    const fetch = vi.fn(async () => { throw new Error("External network forbidden by this regression"); });
    vi.stubGlobal("fetch", fetch);
    expect(await createWebSearch({ fixtureOnly: true, cacheFile, paceMs: 0, providers: ["bing"] })(query, 5)).toEqual([hit]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
