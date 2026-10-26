import test from "node:test";
import assert from "node:assert/strict";
import bundledProfiles from "../data/content-operators.json" with { type: "json" };
import {
  formatBudgetValue, contentOpsError, renderOperatorProfiles, renderBudgetLedger,
  renderSourceDifference, renderArtifactPreview, renderQualityReports,
  renderNativeCandidate, createContentOpsRequester,
  candidateReviewReady, renderContentOpsJob, renderWorkers, mountContentOps,
  renderValidation,
} from "../public/content-ops.js";

// These are isolated rendering/request fixtures, not model, rights or publication evidence.
const h = "a".repeat(64);
const candidate = (extra = {}) => ({ id: "CAN-test", targetKey: "target-test", etag: '"candidate-one"', status: "ready_for_review", packageHash: h, reviewSnapshotHash: "b".repeat(64), qualityReportHashes: ["c".repeat(64)], package: { title: "完整标题 <img src=x onerror=alert(1)>", body: "首段\n完整第二段\n完整尾部", locale: "zh-CN", platformId: "x", nativeForm: "thread", orderedBlocks: [{ key: "one", type: "paragraph", text: "第一项" }, { key: "two", type: "paragraph", text: "第二项" }], nativeManifest: { kind: "thread", orderedSegmentKeys: ["one", "two"], settings: { visibility: "public" } }, artifactRefs: [] }, ...extra });
const report = (extra = {}) => ({ id: "QC-test", candidateId: "CAN-test", checkedPackageHash: h, reportHash: "c".repeat(64), checkerVersion: "independent-checker-test", checkContextHash: "d".repeat(64), status: "passed", coverage: { deterministic: { status: "passed", description: "实际合同检查" }, semantic: { status: "passed" }, media: { status: "unverified", description: "尚未覆盖全片" }, artistic: { status: "unverified" } }, semanticFindings: [{ severity: "major", message: "未覆盖的真实附件" }], ...extra });

test("all 28 profiles remain visible independently of missing accounts and archived destinations", () => {
  const profiles = Array.from({ length: 28 }, (_, n) => ({ platformId: `platform-${n}`, nameZh: `岗位 ${n}`, version: 1, supportedNativeForms: [n % 2 ? "video" : "article"], boundaries: ["不得外发"] }));
  const output = renderOperatorProfiles(profiles, { accounts: [], destinations: [{ platformId: "platform-1", status: "archived" }] });
  assert.equal((output.match(/data-operator-platform=/g) || []).length, 28);
  assert.match(output, /28 \/ 28 个岗位/);
  assert.match(output, /0 \/ 1 个启用目的地/);
  assert.doesNotMatch(output, /已连接|自动发布/);
  assert.equal((renderOperatorProfiles(profiles, { query: "不存在" }).match(/data-operator-platform=/g) || []).length, 0);
});

test("actual bundled 28 role profiles display platform-specific reader task, adaptation and prerequisites", () => {
  assert.equal(bundledProfiles.profiles.length, 28);
  const output = renderOperatorProfiles(bundledProfiles.profiles);
  for (const row of bundledProfiles.profiles) {
    assert.match(output, new RegExp(`data-operator-platform="${row.platformId}"`));
    assert.ok(output.includes(row.readerTask.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")));
    assert.ok(output.includes(row.strategy.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")));
  }
  assert.match(output, /公众号|wechat-official/);
  assert.match(output, /真实notebook|notebook|Notebook/);
});

test("unknown actual costs are never rendered as zero and pending unknown reservations survive cancellation", () => {
  assert.equal(formatBudgetValue(null, { currency: "CNY", micros: true }), "未知 / 未配置");
  assert.equal(formatBudgetValue(0, { currency: "CNY", micros: true }), "0 CNY");
  const output = renderBudgetLedger({ status: "cancelled", budget: { currency: "CNY", maxCostMicros: 1_000_000 }, reservations: [{ id: "request-one", status: "unknown_usage", reservedInputTokens: 100, reservedOutputTokens: 200, reservedCostMicros: 250_000, actualCostMicros: null }] });
  assert.match(output, /0\.25 CNY/);
  assert.match(output, /未知 \/ 未配置/);
  assert.match(output, /取消、到期和重启不释放原预留/);
  assert.match(output, /用量未知/);
});

test("full candidate retains tail, ordered native items and complete source difference with escaped markup", () => {
  const output = renderNativeCandidate(candidate(), { reports: [report()], source: { id: "ED-original", title: "原版", body: "首段\n旧段落\n原版末尾" } });
  assert.match(output, /完整尾部/);
  assert.match(output, /第一项[\s\S]*第二项/);
  assert.match(output, /旧段落/);
  assert.match(output, /原版末尾/);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(output, /<img src=x|<script|<iframe|checkbox[^>]*checked/);
});

test("stale reports and unverified dimensions remain visible without being upgraded by overall passed", () => {
  const output = renderQualityReports([report(), report({ id: "old", checkedPackageHash: "e".repeat(64) })], candidate());
  assert.match(output, /实际合同检查/);
  assert.match(output, /尚未覆盖全片/);
  assert.match(output, /报告对应的最终包不同/);
  assert.match(output, /未覆盖的真实附件/);
  assert.match(output, /data-status="unverified"/);
  assert.match(output, /independent-checker-test/);
});

test("attachments use authenticated opaque paths; notebook/pdf/zip never execute in a same-origin frame", () => {
  for (const mime of ["application/pdf", "application/zip", "application/x-ipynb+json"]) {
    const output = renderArtifactPreview({ id: "ART/../one", mime, sha256: h, bytes: 50, preview: "<script>unsafe notebook output</script>", url: "javascript:alert(1)" });
    assert.match(output, /\/api\/content-ops\/artifacts\/ART%2F\.\.%2Fone\/bytes/);
    assert.match(output, /&lt;script&gt;unsafe notebook output&lt;\/script&gt;/);
    assert.doesNotMatch(output, /<iframe|<object|<embed|javascript:|<script>/);
  }
  const image = renderArtifactPreview({ id: "ART-one", mime: "image/png", bytes: 50, sha256: h });
  assert.match(image, /<img src="\/api\/content-ops\/artifacts\/ART-one\/bytes"/);
  const video = renderArtifactPreview({ id: "ART-video", mime: "video/mp4", bytes: 50, sha256: h });
  assert.match(video, /<video controls playsinline/);
});

test("rights confirmations are never preselected and absent exact ETag disables review", () => {
  const output = renderArtifactPreview({ id: "ART-one", mime: "image/png", sha256: h }, { review: true });
  for (const key of ["rightsConfirmed", "privacyConfirmed", "licenseConfirmed"]) assert.match(output, new RegExp(`name="${key}" required`));
  assert.doesNotMatch(output, /checkbox[^>]*checked/);
  assert.match(output, /type="submit" disabled/);
  const candidateOutput = renderNativeCandidate(candidate({ etag: null }), { reports: [report()] });
  assert.match(candidateOutput, /type="submit" disabled>转为编辑出版待核草稿/);
});

test("source absence is explicit and text diff preserves every original and candidate line", () => {
  const missing = renderSourceDifference({}, { body: "真实候选末尾" });
  assert.match(missing, /未读取到准确母版，差异未验证/);
  assert.match(missing, /真实候选末尾/);
  const full = renderSourceDifference({ id: "ED-one", body: "共同\n旧行\n结束" }, { body: "共同\n新行\n结束" });
  assert.match(full, /旧行/);
  assert.match(full, /新行/);
  assert.match(full, /删除 \/ 改写前（1 行）/);
  assert.match(full, /新增 \/ 改写后（1 行）/);
});

test("unknown network result retains the exact request body, original ETag and idempotency key", async () => {
  const calls = [];
  let number = 0;
  const send = createContentOpsRequester({ createKey: () => `fixture-key-${++number}`, api: async (path, options) => {
    calls.push({ path, options });
    if (calls.length === 1) throw new TypeError("request outcome unknown");
    return { id: "result" };
  } });
  await assert.rejects(send("/api/content-ops/candidates/CAN-test/materialize", { packageHash: h }, { etag: '"one"', needsEtag: true }));
  await send("/api/content-ops/candidates/CAN-test/materialize", { packageHash: h }, { etag: '"two"', needsEtag: true });
  assert.deepEqual(calls[1], calls[0]);
  assert.equal(number, 1);
  assert.match(contentOpsError(new TypeError("lost")), /网络结果未确认/);
  assert.doesNotMatch(contentOpsError(new Error("请先完整核对本地输入。")), /网络结果未确认/);
});

test("definite version conflict renews key only after refreshed version; raw JSON duplicate keys are preserved", async () => {
  const calls = [];
  let number = 0;
  const send = createContentOpsRequester({ createKey: () => `fixture-key-${++number}`, api: async (path, options) => {
    calls.push(options);
    if (calls.length === 1) throw Object.assign(new Error("stale"), { status: 412 });
    return {};
  } });
  await assert.rejects(send("/job", { mode: "prepare" }, { etag: '"one"', needsEtag: true }));
  await send("/job", { mode: "prepare" }, { etag: '"two"', needsEtag: true });
  assert.notEqual(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[1].headers["If-Match"], '"two"');
  await assert.rejects(send("/job", {}, { needsEtag: true }), /缺少准确版本/);
  const raw = '{"plan":{"goal":"one","goal":"two"}}';
  await send("/validate", raw, { raw: true });
  assert.equal(calls.at(-1).body, raw);
});

test("only exact final reports with all four dimensions passed permit materialization", () => {
  assert.equal(candidateReviewReady(candidate(), [report()]), false);
  const exact = report({ coverage: Object.fromEntries(["deterministic", "semantic", "media", "artistic"].map(key => [key, { status: "passed" }])), semanticFindings: [] });
  assert.equal(candidateReviewReady(candidate(), [exact]), true);
  for (const changed of [candidate({ packageHash: "e".repeat(64) }), candidate({ reviewSnapshotHash: null }), candidate({ etag: null }), candidate({ status: "polishing" })]) assert.equal(candidateReviewReady(changed, [exact]), false);
  assert.equal(candidateReviewReady(candidate(), [{ ...exact, semanticFindings: [{ severity: "major", message: "still open" }] }]), false);
});

test("mixed target outcomes and worker readiness keep their independent denominators", () => {
  const output = renderContentOpsJob({ id: "JOB-fixture", etag: '"job"', status: "running", targets: [{ targetKey: "one", platformId: "x", status: "ready_for_review", candidateId: "CAN-test" }, { targetKey: "two", platformId: "youtube", status: "needs_input", blockingReasons: ["缺真实视频"] }, { targetKey: "three", platformId: "kaggle", status: "skipped" }], reservations: [] });
  assert.match(output, /缺真实视频/);
  assert.match(output, /本次实际目标<\/span><strong>3/);
  assert.match(output, /完整成品待审 \/ 已转稿<\/span><strong>1/);
  assert.match(output, /明确跳过<\/span><strong>1/);
  assert.match(output, /data-co-candidate="CAN-test"/);
  assert.doesNotMatch(output, /自动发布|全部已完成/);
  const workers = renderWorkers([{ id: "W-fixture", status: "active", adapters: [{ id: "text", declared: true, codePresent: true, ready: false, productionVerified: false }] }]);
  assert.match(workers, /目录已声明 · 代码在场 · 尚未 ready · 尚无真实生产验证/);
});

function fakeRoot() {
  const events = new Map();
  return { innerHTML: "", attributes: new Map(), events, querySelectorAll: () => [], querySelector: () => null,
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, listener) { events.set(name, listener); },
  };
}

test("workspace starts in loading state, deduplicates reads and shows explicit schema migration errors", async () => {
  const root = fakeRoot();
  const previous = globalThis.document;
  globalThis.document = { querySelector: () => root };
  const calls = [];
  let resolveRead;
  try {
    const ui = mountContentOps({ api: (path, options) => {
      calls.push({ path, options });
      if (path === "/api/content-ops/source-artifacts") return Promise.resolve({ items: [], roles: { source_image: ["image/png"] }, maxArtifactBytes: 1000 });
      return new Promise(resolve => { resolveRead = resolve; });
    } });
    assert.match(root.innerHTML, /正在读取岗位、来源与准备工单/);
    const first = ui.load(), second = ui.load();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, "/api/content-ops/bootstrap");
    assert.equal(calls[0].options, undefined);
    resolveRead({ profiles: [{ platformId: "x", nameZh: "X 岗位", supportedNativeForms: ["thread"] }], jobs: [], workers: [], budgets: [], sources: { accounts: [], destinations: [{ id: "DEST-fixture", name: "实际目的地", platformId: "x", status: "active" }], editions: [], stories: [{ id: "ST-fixture", workingTitle: "来源选题", etag: '"story"', ref: { id: "ST-fixture", revision: 1, sha256: h } }] } });
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.match(root.innerHTML, /X 岗位/);
    root.events.get("click")({ target: { closest: () => ({ dataset: { coTab: "prepare" } }) } });
    assert.match(root.innerHTML, /来源选题/);
    assert.match(root.innerHTML, /实际目的地/);
    root.events.get("click")({ target: { closest: () => ({ dataset: { coTab: "budgets" } }) } });
    assert.match(root.innerHTML, /已核实价格快照 JSON/);
    assert.doesNotMatch(root.innerHTML, /checkbox[^>]*checked/);
    const denied = mountContentOps({ api: async () => { throw Object.assign(new Error("migration required"), { code: "SCHEMA_MIGRATION_REQUIRED", status: 503 }); } });
    assert.equal(await denied.load(), false);
    assert.match(root.innerHTML, /尚未完成 v3 迁移/);
    assert.match(root.innerHTML, /当前没有可执行操作/);
    assert.doesNotMatch(root.innerHTML, /data-co-form="create-job"/);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("validated targets join their frozen plan identity into human-readable destination, language and native form", () => {
  const output = renderValidation({ planHash: h, targets: [{ targetKey: h, decision: "prepare", effectivePolicy: { allowedAiActions: ["draft"] } }], normalizedPlan: { targets: [{ targetKey: h, platformId: "x", destinationRef: { id: "DEST-one" }, locale: "en-US", nativeForm: "thread" }] } }, { profiles: [{ platformId: "x", nameZh: "X 内容运营师" }], destinations: [{ id: "DEST-one", name: "实际账号内容流" }] });
  assert.match(output, /<strong>X 内容运营师 · 实际账号内容流<\/strong>/);
  assert.match(output, /en-US · 有序串文/);
  assert.doesNotMatch(output, /<strong>目标 · [a-f0-9]{64}<\/strong>/);
  assert.match(output, new RegExp(`&quot;targetKey&quot;: &quot;${h}&quot;`));
});

// A small event/form harness exercises controller lifecycle only. Real layout,
// browser file permissions and media decoding are checked in Chrome separately.
function controllerField(name, value = "", type = "text") {
  return { name, value, type, tagName: type === "select" ? "SELECT" : "INPUT", disabled: false, checked: false, isConnected: true, files: [], options: [],
    set innerHTML(markup) { this.options = [...markup.matchAll(/value="([^"]*)"/g)].map(match => ({ value: match[1] })); },
    hasAttribute(attribute) { return this.attributes?.includes(attribute) || false; },
  };
}

function controllerForm(action, entries, id = "") {
  const elements = entries;
  for (const field of elements) elements[field.name] = field;
  const error = { hidden: true, textContent: "", focus() {} }, status = { textContent: "" };
  return { dataset: { coForm: action, id, etag: '"artifact-version"' }, elements, reportValidity: () => true,
    setAttribute() {}, removeAttribute() {},
    querySelector: selector => selector === "[data-co-error]" ? error : selector === "[data-co-status]" ? status : null,
    querySelectorAll: () => [], closest() { return this; },
  };
}

function sourceControllerRoot() {
  const events = new Map();
  let output = "", forms = [];
  const root = { events,
    get innerHTML() { return output; },
    set innerHTML(markup) {
      for (const row of forms) for (const field of row.elements) field.isConnected = false;
      output = markup;
      forms = markup.includes('data-co-form="source-upload"') ? [controllerForm("source-upload", [controllerField("storyId", "", "select"), controllerField("role", "", "select"), controllerField("sourceFile", "", "file"), controllerField("mime", "", "select")])] : [];
      if (markup.includes('data-co-form="artifact-review"')) forms.push(controllerForm("artifact-review", [controllerField("rightsConfirmed", "on", "checkbox"), controllerField("privacyConfirmed", "on", "checkbox"), controllerField("licenseConfirmed", "on", "checkbox"), controllerField("note")], "ART-source"));
      if (markup.includes('data-co-form="rule-create"')) forms.push(controllerForm("rule-create", [controllerField("requiresAuthorContribution", "on", "checkbox"), controllerField("allowedAiActions", "copyedit", "checkbox"), controllerField("confirmed", "on", "checkbox"), controllerField("note")]));
      if (markup.includes('data-co-form="worker-pair"')) forms.push(controllerForm("worker-pair", [controllerField("checker", "on", "checkbox"), controllerField("adapterIds", "quality.final", "checkbox"), controllerField("confirmed", "on", "checkbox")]));
      for (const row of forms) {
        if (row.elements.storyId) row.elements.storyId.options = [{ value: "" }, { value: "ST-source" }];
        if (row.elements.role) row.elements.role.options = [{ value: "" }, { value: "transcript" }];
      }
    },
    querySelectorAll: selector => selector === "form[data-co-form]" ? forms : [],
    querySelector: selector => {
      const action = /\[data-co-form="([^"]+)"\]/.exec(selector)?.[1];
      return action ? forms.find(row => row.dataset.coForm === action) || null : null;
    },
    setAttribute() {}, addEventListener(name, listener) { events.set(name, listener); },
  };
  return root;
}

class ControllerFormData {
  constructor(element) { this.entries = element.elements.filter(field => field.name && !field.disabled && (field.type !== "checkbox" || field.checked)).map(field => [field.name, field.value]); }
  get(name) { return this.entries.find(row => row[0] === name)?.[1] ?? null; }
  getAll(name) { return this.entries.filter(row => row[0] === name).map(row => row[1]); }
}

test("controller preserves source selection, exact file and entered note across redraw while resetting rights declarations", async () => {
  const root = sourceControllerRoot(), previousDocument = globalThis.document, previousFormData = globalThis.FormData;
  globalThis.document = { querySelector: () => root };
  globalThis.FormData = ControllerFormData;
  const calls = [];
  const file = new File(["# Complete isolated upload bytes\n"], "source.md", { type: "text/markdown" });
  const source = { id: "ART-source", storyId: "ST-source", role: "transcript", mime: "text/markdown", size: file.size, bytes: file.size, sha256: h, etag: '"artifact-version"', status: "committed" };
  const bootstrap = { profiles: [], jobs: [], adapterBindings: [{ adapterId: "quality.final", version: "1.0.0" }], sources: { stories: [{ id: "ST-source", workingTitle: "Accurate source story", etag: '"original-story"' }], editions: [], destinations: [] } };
  let postSignal;
  let posted = new Promise(resolve => { postSignal = resolve; });
  try {
    const ui = mountContentOps({ api: async (path, options) => {
      if (path === "/api/content-ops/bootstrap") return bootstrap;
      if (!options) return { items: [source], roles: { transcript: ["text/markdown", "text/plain"] }, maxArtifactBytes: 100_000 };
      calls.push({ path, options });
      postSignal();
      if (calls.length === 1) throw new TypeError("isolated lost upload response");
      return { ...source, id: "ART-uploaded" };
    } });
    await ui.load();
    root.events.get("click")({ target: { closest: () => ({ dataset: { coTab: "sources" } }) } });
    const upload = root.querySelector('[data-co-form="source-upload"]');
    upload.elements.storyId.value = "ST-source";
    upload.elements.role.value = "transcript";
    upload.elements.sourceFile.files = [file];
    upload.elements.sourceFile.attributes = ["data-co-source-file"];
    root.events.get("change")({ target: upload.elements.sourceFile });
    assert.equal(upload.elements.mime.value, "text/markdown");
    const review = root.querySelector('[data-co-form="artifact-review"]');
    review.elements.note.value = "Entered source rights review with complete original context.";
    review.elements.rightsConfirmed.checked = true;
    review.elements.privacyConfirmed.checked = true;
    review.elements.licenseConfirmed.checked = true;
    const rule = root.querySelector('[data-co-form="rule-create"]');
    rule.elements.requiresAuthorContribution.checked = true;
    rule.elements.allowedAiActions.checked = true;
    rule.elements.confirmed.checked = true;
    rule.elements.note.value = "An actual author contribution requirement is part of this policy data.";
    root.events.get("submit")({ target: upload, preventDefault() {} });
    await posted;
    await new Promise(resolve => setImmediate(resolve));
    assert.match(upload.querySelector("[data-co-error]").textContent, /网络结果未确认/);
    assert.equal(upload.elements.storyId.disabled, false);
    ui.render();
    const retried = root.querySelector('[data-co-form="source-upload"]');
    assert.equal(retried.elements.storyId.value, "ST-source");
    assert.equal(retried.elements.role.value, "transcript");
    assert.equal(retried.elements.mime.value, "text/markdown");
    assert.equal(retried.elements.sourceFile.files.length, 0);
    assert.match(root.innerHTML, /已选 source\.md/);
    const restoredReview = root.querySelector('[data-co-form="artifact-review"]');
    assert.equal(restoredReview.elements.note.value, review.elements.note.value);
    for (const name of ["rightsConfirmed", "privacyConfirmed", "licenseConfirmed"]) assert.equal(restoredReview.elements[name].checked, false);
    const restoredRule = root.querySelector('[data-co-form="rule-create"]');
    assert.equal(restoredRule.elements.requiresAuthorContribution.checked, true);
    assert.equal(restoredRule.elements.allowedAiActions.checked, true);
    assert.equal(restoredRule.elements.confirmed.checked, false);
    assert.equal(restoredRule.elements.note.value, rule.elements.note.value);
    posted = new Promise(resolve => { postSignal = resolve; });
    root.events.get("submit")({ target: retried, preventDefault() {} });
    await posted;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.body, file);
    assert.deepEqual(calls[1], calls[0]);
    assert.equal(calls[1].options.headers["If-Match"], '"original-story"');
    assert.doesNotMatch(root.innerHTML, /已选 source\.md/);
    assert.match(root.innerHTML, /真实源文件已提交为私有未审核附件/);
    root.events.get("click")({ target: { closest: () => ({ dataset: { coTab: "workers" } }) } });
    const worker = root.querySelector('[data-co-form="worker-pair"]');
    worker.elements.checker.checked = true;
    worker.elements.adapterIds.checked = true;
    worker.elements.confirmed.checked = true;
    ui.render();
    const restoredWorker = root.querySelector('[data-co-form="worker-pair"]');
    assert.equal(restoredWorker.elements.checker.checked, true);
    assert.equal(restoredWorker.elements.adapterIds.checked, true);
    assert.equal(restoredWorker.elements.confirmed.checked, false);
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
    globalThis.FormData = previousFormData;
  }
});
