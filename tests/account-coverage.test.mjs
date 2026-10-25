import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAccountCoverage, renderPlatformCoverage, renderUnconfiguredPlatforms } from "../public/account-coverage.js";
import { platformCatalog, LEGACY_PLATFORM_IDS } from "../src/domain/platform-catalog.mjs";
import { mountEditorialWorkbench } from "../public/editorial-workbench.js";

// Synthetic account records only: no real login, account creation or platform call.
const catalog = platformCatalog();
const archivedIds = new Set(["baijiahao", "toutiao", "maimai"]);
const waveAIds = new Set(["wechat-official", "zhihu", "xiaohongshu", "bilibili", "douyin", "wechat-channels", "maimai"]);
function accounts() {
  return Object.entries(LEGACY_PLATFORM_IDS).map(([id, platform]) => ({
    id, platformId: id, platform, status: archivedIds.has(id) ? "archived" : "draft", wave: waveAIds.has(id) ? "A" : "B",
  }));
}

test("current account and A-wave counts exclude archive while the full catalog remains visible", () => {
  const input = accounts();
  const before = structuredClone(input);
  const result = summarizeAccountCoverage(input, catalog);
  assert.equal(result.currentAccounts.length, 13);
  assert.equal(result.archivedAccounts.length, 3);
  assert.equal(result.currentAWaveCount, 6);
  assert.equal(result.registeredPlatforms.length, 13);
  assert.equal(result.archivedPlatforms.length, 3);
  assert.equal(result.unconfiguredPlatforms.length, 11);
  assert.equal(result.ownedSites.length, 1);
  assert.equal(result.currentScopeCount, 25);
  assert.equal(result.externalPlatformCount, 27);
  assert.equal(result.catalogCount, 28);
  assert.deepEqual(input, before, "read-only projection must not alter lifecycle or seed records");
  assert.match(renderPlatformCoverage(result), /当前规划 25 项（含待配置） · 完整目录 28 项/);
  assert.match(renderPlatformCoverage(result), /百家号、今日头条、脉脉/);
});

test("restoring an archived account updates current and wave counts without inventing setup placeholders", () => {
  const input = accounts();
  input.find(row => row.id === "maimai").status = "paused";
  const result = summarizeAccountCoverage(input, catalog);
  assert.equal(result.currentAccounts.length, 14);
  assert.equal(result.archivedAccounts.length, 2);
  assert.equal(result.currentAWaveCount, 7);
  assert.equal(result.registeredPlatforms.length, 14);
  assert.equal(result.unconfiguredPlatforms.length, 11);
  assert.equal(result.currentScopeCount, 26);
  assert.equal(result.archivedPlatforms.some(row => row.id === "maimai"), false);
});

test("registering one real account removes only its catalog placeholder", () => {
  const input = accounts();
  input.push({ id: "synthetic-tiktok", platformId: "tiktok", platform: "TikTok", status: "draft" });
  const result = summarizeAccountCoverage(input, catalog);
  assert.equal(result.currentAccounts.length, 14);
  assert.equal(result.registeredPlatforms.length, 14);
  assert.equal(result.unconfiguredPlatforms.length, 10);
  assert.equal(result.currentScopeCount, 25);
  assert.equal(result.unconfiguredPlatforms.some(row => row.id === "tiktok"), false);
});

test("multiple accounts on one platform do not inflate catalog coverage or archive the current platform", () => {
  const input = accounts();
  input.push({ id: "synthetic-second-github", platformId: "github", platform: "GitHub", status: "active" });
  input.push({ id: "synthetic-old-github", platformId: "github", platform: "GitHub", status: "archived" });
  const result = summarizeAccountCoverage(input, catalog);
  assert.equal(result.currentAccounts.length, 14);
  assert.equal(result.archivedAccounts.length, 4);
  assert.equal(result.registeredPlatforms.length, 13);
  assert.equal(result.archivedPlatforms.length, 3);
  assert.equal(result.unconfiguredPlatforms.length, 11);
  assert.equal(result.currentScopeCount, 25);
  assert.equal(result.archivedPlatforms.some(row => row.id === "github"), false);
});

test("owned-site catalog entries and invalid owned-site account rows never count as external accounts", () => {
  const input = accounts();
  input.push({ id: "synthetic-site", platformId: "official-site", platform: "Personal Website", status: "active", wave: "A" });
  const result = summarizeAccountCoverage(input, catalog);
  assert.equal(result.currentAccounts.length, 13);
  assert.equal(result.currentAWaveCount, 6);
  assert.equal(result.ownedSites.length, 1);
  assert.equal(result.unconfiguredPlatforms.some(row => row.kind === "owned_site"), false);
  assert.doesNotMatch(renderUnconfiguredPlatforms(result), /data-unconfigured-platform="official-site"/);
});

test("unknown legacy identities remain account records and are explicitly outside catalog coverage", () => {
  const input = accounts();
  input.push({ id: "synthetic-custom", platform: "Owner custom platform", status: "paused" });
  input.push({ id: "synthetic-unknown-id", platformId: "not-in-catalog", platform: "TikTok", status: "archived" });
  const result = summarizeAccountCoverage(input, catalog);
  assert.equal(result.currentAccounts.length, 14);
  assert.equal(result.archivedAccounts.length, 4);
  assert.equal(result.unknownCurrentAccounts.length, 1);
  assert.equal(result.unknownArchivedAccounts.length, 1);
  assert.equal(result.registeredPlatforms.length, 13);
  assert.equal(result.unconfiguredPlatforms.length, 11, "a display name must not silently replace an unknown platformId");
  assert.match(renderPlatformCoverage(result), /1 个当前账号、1 个归档账号未匹配目录/);
});

test("legacy fallback requires both an exact canonical id and a matching platform name", () => {
  const result = summarizeAccountCoverage([
    { id: "github", platform: "GitHub", status: "active" },
    { id: "tiktok", platform: "Unrelated custom identity", status: "active" },
  ], catalog);
  assert.deepEqual(result.registeredPlatforms.map(row => row.id), ["github"]);
  assert.equal(result.unknownCurrentAccounts.length, 1);
  assert.equal(result.unconfiguredPlatforms.some(row => row.id === "tiktok"), true);
});

test("an unavailable catalog is unknown rather than a zero or a hardcoded full count", () => {
  const result = summarizeAccountCoverage(accounts(), null);
  assert.equal(result.currentAccounts.length, 13);
  assert.equal(result.archivedAccounts.length, 3);
  assert.equal(result.catalogAvailable, false);
  assert.equal(result.catalogCount, null);
  assert.equal(result.currentScopeCount, null);
  assert.match(renderPlatformCoverage(result), /目录尚未读取成功/);
  assert.match(renderUnconfiguredPlatforms(result), /暂不判断哪些平台缺少账号/);
  assert.doesNotMatch(renderPlatformCoverage(result), /完整目录 28|未匹配目录/);
  assert.doesNotMatch(renderUnconfiguredPlatforms(result), /data-unconfigured-platform=/);
});

test("empty and all-archived account collections remain truthful without resurrecting history", () => {
  const empty = summarizeAccountCoverage([], catalog);
  assert.equal(empty.currentAccounts.length, 0);
  assert.equal(empty.unconfiguredPlatforms.length, 27);
  assert.equal(empty.currentScopeCount, 28);
  const input = accounts().map(row => ({ ...row, status: "archived" }));
  const archived = summarizeAccountCoverage(input, catalog);
  assert.equal(archived.currentAccounts.length, 0);
  assert.equal(archived.archivedAccounts.length, 16);
  assert.equal(archived.archivedPlatforms.length, 16);
  assert.equal(archived.unconfiguredPlatforms.length, 11);
  assert.equal(archived.currentScopeCount, 12);
  assert.equal(archived.currentAWaveCount, 0);
});

test("unconfigured cards use catalog names and roles without generated handles, profile URLs or account controls", () => {
  const result = summarizeAccountCoverage(accounts(), catalog);
  const markup = renderUnconfiguredPlatforms(result);
  for (const id of ["huggingface", "modelscope", "tiktok", "instagram", "facebook", "reddit", "discord", "csdn", "devto", "hashnode", "kaggle"]) {
    assert.ok(result.unconfiguredPlatforms.some(row => row.id === id), id);
    assert.ok(markup.includes(`data-unconfigured-platform="${id}"`), id);
  }
  assert.equal((markup.match(/data-unconfigured-platform=/g) || []).length, 11);
  assert.doesNotMatch(markup, /https?:|data-account-id=|<form|class="handle"/);
  assert.match(markup, /href="#editorial"/);
  const custom = summarizeAccountCoverage([], [{ id: "untrusted", name: '<img src=x onerror="bad">', kind: "social", role: "<script>bad</script> & text" }]);
  assert.match(renderUnconfiguredPlatforms(custom), /&lt;img/);
  assert.match(renderUnconfiguredPlatforms(custom), /&lt;script&gt;bad&lt;\/script&gt; &amp; text/);
  assert.doesNotMatch(renderUnconfiguredPlatforms(custom), /<script>|<img/);
});

test("catalog reads become unknown after refresh failure and recover without discarding historical editor data", async () => {
  const previousDocument = globalThis.document;
  const events = new Map();
  const root = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, addEventListener(name, callback) { events.set(name, callback); } };
  globalThis.document = { querySelector: selector => selector === "#editorial-root" ? root : null };
  let fail = false;
  let notifications = 0;
  let overview = "";
  const payload = { stories: [], editions: [], catalog, accounts: accounts(), destinations: [], variants: [], releases: [], routes: [] };
  const requests = [];
  try {
    const workbench = mountEditorialWorkbench({ getData: () => ({ claims: [] }), onCatalogChange: current => {
      notifications += 1;
      overview = renderPlatformCoverage(summarizeAccountCoverage(accounts(), current));
    }, api: async path => {
      requests.push(path);
      if (path === "/api/editorial/bootstrap") {
        if (fail) throw new Error("Synthetic catalog read failure");
        return payload;
      }
      return { items: [] };
    } });
    assert.equal(workbench.getCatalog(), null);
    assert.equal(await workbench.load(), true);
    assert.equal(workbench.getCatalog(), catalog);
    assert.equal(notifications, 1);
    assert.match(overview, /当前规划 25 项/);
    const refresh = () => events.get("click")({ target: { closest: () => ({ dataset: {}, hasAttribute: name => name === "data-editorial-refresh" }) } });
    fail = true;
    refresh();
    assert.equal(await workbench.load(), false);
    assert.equal(workbench.getData(), payload, "editor retains the last read history with its existing error banner");
    assert.equal(workbench.getCatalog(), null, "overview must not silently count from a failed refresh");
    assert.equal(notifications, 2, "the actual editor refresh click must notify the overview on failure");
    assert.match(overview, /目录尚未读取成功/);
    fail = false;
    refresh();
    assert.equal(await workbench.load(), true);
    assert.equal(summarizeAccountCoverage(accounts(), workbench.getCatalog()).unconfiguredPlatforms.length, 11);
    assert.equal(notifications, 3);
    assert.match(overview, /当前规划 25 项/);
    assert.deepEqual([...new Set(requests)].sort(), ["/api/editorial/bootstrap", "/api/media/assets"], "no new API, account writes or platform requests");
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
