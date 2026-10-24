import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GeoStore } from "../engines/geo-evidence/lib/store.mjs";
import { GeoEvidenceService } from "../engines/geo-evidence/lib/service.mjs";
import { PersonalGeoEngine } from "../src/engines/geo-evidence.mjs";
import {
  PERSONAL_GEO_CASE,
  PERSONAL_ARTICLE_TOPICS,
  buildPersonalArticleDraft,
  buildPersonalQueries,
} from "../engines/geo-evidence/personal-case.mjs";
import { MAIN_PROFILE } from "../src/domain/identity.mjs";
import { analyzeAnswer } from "../engines/geo-evidence/lib/core.mjs";

const root = new URL("../", import.meta.url);
const legacyQueries = JSON.parse(await readFile(
  new URL("engines/geo-evidence/personal-case-v1-queries.json", root), "utf8",
));
const legacyControl = JSON.parse(await readFile(
  new URL("data/migrations/identity-v1.json", root), "utf8",
)).queries;
const controlQueries = JSON.parse(await readFile(
  new URL("data/seed/queries.json", root), "utf8",
));

async function temporaryDatabase(t) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-geo-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "geo.sqlite") };
}

function snapshotHistory(store) {
  return Object.fromEntries(["samples", "runs", "articles", "publications", "incidents"]
    .map((table) => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

test("all platform profiles carry the requested bilingual identity and retain platform handles", async () => {
  const accounts = JSON.parse(await readFile(new URL("data/seed/accounts.json", root), "utf8"));
  assert.equal(accounts.length, 16);
  assert.equal(MAIN_PROFILE.displayNameZh, "李大鹏｜用AI搞经营的产品经理");
  assert.equal(MAIN_PROFILE.displayNameEn, "Dapeng Li · PengManager");
  const englishPlatforms = new Set(["github", "linkedin", "x", "youtube", "medium"]);
  for (const account of accounts) {
    const english = englishPlatforms.has(account.id);
    assert.equal(account.language, english ? "en-US" : "zh-CN");
    assert.equal(account.name, english ? "PengManager" : "李大鹏");
    assert.equal(account.nameZh, "李大鹏");
    assert.equal(account.nameEn, "PengManager");
    assert.equal(account.displayNameZh, MAIN_PROFILE.displayNameZh);
    assert.equal(account.displayNameEn, MAIN_PROFILE.displayNameEn);
    assert.equal(account.displayName, english ? MAIN_PROFILE.displayNameEn : MAIN_PROFILE.displayNameZh);
    assert.equal(account.bioZh, MAIN_PROFILE.bioZh);
    assert.equal(account.bioEn, MAIN_PROFILE.bioEn);
    assert.equal(account.bio, english ? MAIN_PROFILE.bioEn : MAIN_PROFILE.bioZh);
    assert.equal(account.handle, account.id === "maimai" ? "本人实名" : "dapengstack");
  }
});

test("personal query IDs and provenance remain stable while current text and article drafts use PengManager", () => {
  const queries = buildPersonalQueries();
  assert.equal(queries.length, 100);
  assert.equal(new Set(queries.map((query) => query.id)).size, 100);
  assert.deepEqual(queries.map((query) => query.id), legacyQueries.map((query) => query.id));
  assert.deepEqual(queries.map((query) => query.source), legacyQueries.map((query) => query.source));
  assert.equal(PERSONAL_GEO_CASE.id, "pengstack-personal-geo");
  assert.equal(PERSONAL_GEO_CASE.version, "pengmanager-personal-geo/v2");
  assert.ok(PERSONAL_GEO_CASE.brand.aliases.includes("PengManager"));
  assert.ok(PERSONAL_GEO_CASE.brand.legacyAliases.includes("PengStack"));
  assert.equal(analyzeAnswer(queries[0], "PengManager", PERSONAL_GEO_CASE).brandMentioned, true);
  assert.equal(analyzeAnswer(queries[0], "鹏栈", PERSONAL_GEO_CASE).brandMentioned, false);
  assert.doesNotMatch(queries.map((query) => query.text).join("\n"), /鹏栈|PengStack/);
  const article = buildPersonalArticleDraft(PERSONAL_ARTICLE_TOPICS[0], queries);
  assert.ok(article.includes(MAIN_PROFILE.displayNameZh));
  assert.ok(article.includes(MAIN_PROFILE.headline));
  assert.doesNotMatch(article, /鹏栈|PengStack/);
});

test("legacy SQLite migration refreshes defaults, preserves custom fields and leaves historical evidence byte-for-byte intact", async (t) => {
  const { path } = await temporaryDatabase(t);
  let store = new GeoStore(path, {
    caseConfig: { ...PERSONAL_GEO_CASE, version: "pengstack-personal-geo/v1" },
    queries: legacyQueries,
  });
  const unchanged = legacyQueries[0];
  const customized = legacyQueries[2];
  const foreign = legacyQueries[5];
  store.db.prepare("UPDATE queries SET text=?, priority=?, status=?, source=? WHERE id=?")
    .run("用户自己的专业领域查询", "P2", "paused", "user-custom", customized.id);
  store.db.prepare("UPDATE queries SET priority=? WHERE id=?").run("P2", unchanged.id);
  store.db.prepare("UPDATE queries SET case_id=?, text=? WHERE id=?")
    .run("another-case", "另一个案例自己的内容", foreign.id);
  const createdAt = store.db.prepare("SELECT created_at FROM queries WHERE id=?").get(unchanged.id).created_at;
  const runId = store.createRun({ provider: "manual-import", dataMode: "imported", platform: "manual", model: "manual", requestedLimit: 1, plannedSamples: 1 });
  store.insertSample({
    runId, query: unchanged, platform: "manual", provider: "manual-import", dataMode: "imported",
    prompt: unchanged.text, answer: "历史答案必须保留", citations: [],
    analysis: { query: unchanged.text, brandNegative: true, evidenceHash: "original-evidence-hash" },
    status: "success",
  });
  store.finishRun(runId, { status: "completed", successful: 1, failed: 0 });
  const articleId = store.createArticle({ topicId: "historical", title: "旧文章", slug: "historical", markdown: "旧品牌文章原文", queryIds: [unchanged.id], dataMode: "draft" });
  const publicationId = store.createPublication({ articleId, channel: "manual", receipt: { receipt: "original" } });
  store.completePublication(publicationId, { url: "https://example.com/historical", receipt: { published: true } });
  // Pre-upgrade databases do not contain a seed baseline.
  store.db.prepare("DELETE FROM meta WHERE key=?").run(`query_seed_baseline:${PERSONAL_GEO_CASE.id}`);
  const history = snapshotHistory(store);
  store.close();

  store = new GeoStore(path);
  const byId = new Map(store.listQueries().map((query) => [query.id, query]));
  const nextDefault = buildPersonalQueries().find((query) => query.id === unchanged.id);
  assert.equal(byId.get(unchanged.id).text, nextDefault.text);
  assert.equal(byId.get(unchanged.id).priority, "P2");
  assert.equal(byId.get(unchanged.id).created_at, createdAt);
  assert.equal(byId.get(unchanged.id).case_version, PERSONAL_GEO_CASE.version);
  assert.equal(byId.get(customized.id).text, "用户自己的专业领域查询");
  assert.equal(byId.get(customized.id).priority, "P2");
  assert.equal(byId.get(customized.id).status, "paused");
  assert.equal(byId.get(customized.id).source, "user-custom");
  assert.equal(byId.get(foreign.id).case_id, "another-case");
  assert.equal(byId.get(foreign.id).text, "另一个案例自己的内容");
  assert.deepEqual(snapshotHistory(store), history);
  assert.equal(store.listSamples({ runId })[0].query_text, unchanged.text);
  assert.equal(store.listIncidents()[0].query_text, unchanged.text);
  const migratedQueries = store.listQueries();
  const baseline = store.getMeta(`query_seed_baseline:${PERSONAL_GEO_CASE.id}`);
  store.close();
  store = new GeoStore(path);
  assert.deepEqual(store.listQueries(), migratedQueries);
  assert.equal(store.getMeta(`query_seed_baseline:${PERSONAL_GEO_CASE.id}`), baseline);
  assert.deepEqual(snapshotHistory(store), history);
  const reanalysis = new GeoEvidenceService(store).reanalyzeRun(runId);
  assert.equal(reanalysis.updated, 1);
  const reanalyzedSample = store.listSamples({ runId })[0];
  assert.equal(reanalyzedSample.analysis.query, unchanged.text);
  assert.equal(reanalyzedSample.query_text, unchanged.text);
  assert.equal(reanalyzedSample.prompt, unchanged.text);
  assert.equal(reanalyzedSample.evidenceHash, "original-evidence-hash");
  store.close();
});

test("integrated engine startup migrates control defaults without overwriting user queries and explicit edits still apply", async (t) => {
  const { directory, path } = await temporaryDatabase(t);
  let engine = new PersonalGeoEngine({ rootDir: directory, databasePath: path, controlQueries: legacyControl });
  engine.store.db.prepare("DELETE FROM meta WHERE key=?").run(`query_seed_baseline:${PERSONAL_GEO_CASE.id}`);
  engine.store.db.prepare("UPDATE queries SET text=?, priority=? WHERE id=?")
    .run("自定义招聘问题", "P2", "Q002");
  engine.close();
  engine = new PersonalGeoEngine({ rootDir: directory, databasePath: path, controlQueries });
  const find = (id) => engine.listQueries().find((query) => query.id === id);
  assert.equal(find("Q001").text, controlQueries.find((query) => query.id === "Q001").text);
  assert.equal(find("Q011").text, controlQueries.find((query) => query.id === "Q011").text);
  assert.equal(find("Q002").text, "自定义招聘问题");
  assert.equal(find("Q002").priority, "P2");
  const edited = { ...controlQueries[0], text: "用户通过接口明确更新的查询", priority: "P2" };
  engine.upsertControlQueries([edited]);
  assert.equal(find("Q001").text, edited.text);
  assert.equal(find("Q001").priority, edited.priority);
  engine.close();
  engine = new PersonalGeoEngine({ rootDir: directory, databasePath: path, controlQueries });
  assert.equal(find("Q001").text, edited.text);
  assert.equal(find("Q001").priority, edited.priority);
  assert.equal(find("Q002").text, "自定义招聘问题");
  engine.close();
});

test("migration failures roll back query updates and the stored baseline together", async (t) => {
  const { path } = await temporaryDatabase(t);
  const store = new GeoStore(path, { queries: legacyQueries });
  const before = store.listQueries();
  const key = `query_seed_baseline:${PERSONAL_GEO_CASE.id}`;
  const previous = store.getMeta(key);
  store.querySeed = [
    { ...legacyQueries[0], text: "此更新必须回滚" },
    { ...legacyQueries[1], text: undefined },
  ];
  assert.throws(() => store.seedPersonalQueries());
  assert.deepEqual(store.listQueries(), before);
  assert.equal(store.getMeta(key), previous);
  store.close();
});

test("a non-personal GEO case keeps its existing startup refresh behavior", async (t) => {
  const { path } = await temporaryDatabase(t);
  const caseConfig = { ...PERSONAL_GEO_CASE, id: "separate-generic-case", version: "generic/v1" };
  const query = { ...legacyQueries[0], id: "generic-001", text: "原始模板" };
  let store = new GeoStore(path, { caseConfig, queries: [query] });
  store.close();
  store = new GeoStore(path, { caseConfig, queries: [{ ...query, text: "更新的模板" }] });
  assert.equal(store.listQueries()[0].text, "更新的模板");
  assert.equal(store.getMeta(`query_seed_baseline:${caseConfig.id}`), null);
  store.close();
});
