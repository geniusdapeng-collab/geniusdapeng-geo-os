import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { JsonStore, verifyEventChain } from "../src/storage/json-store.mjs";
import { loadSeedState } from "../src/services/bootstrap.mjs";
import { GeoOsService } from "../src/services/geo-os-service.mjs";
import { AccountOperationsService } from "../src/services/account-operations.mjs";

// These isolated unit fixtures never contact a platform and never prove a live publication.
const rootDir = resolve(import.meta.dirname, "..");
const clock = () => new Date("2026-10-24T10:00:00.000Z");
const receipt = (overrides = {}) => ({
  url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/999999",
  publishedAt: clock().toISOString(), capturedBy: "unit-test operator", dataMode: "imported",
  verificationMethod: "manual_readback", verifiedAt: clock().toISOString(), verifiedBy: "unit-test reviewer",
  ...overrides,
});

async function withServices(callback) {
  const directory = await mkdtemp(join(tmpdir(), "pengmanager-operations-"));
  const store = new JsonStore({ filePath: join(directory, "state.json"), clock });
  await store.open(() => loadSeedState(join(rootDir, "data", "seed")));
  const service = new GeoOsService({ store, clock });
  const operations = new AccountOperationsService({ service, clock });
  try { return await callback({ store, service, operations, directory }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function scheduled(service) {
  await service.approveClaim("C003", { approvedBy: "Dapeng Li", publicLevel: "private" });
  const content = await service.createContent({
    title: "单元测试中的运营草稿", body: "这段内容只验证运营动作的审批、回执和持久化，不是线上发布。",
    claimIds: ["C003"], platforms: ["GitHub"], owner: "unit-test operator",
  });
  for (const target of ["fact_check", "approved", "scheduled"]) {
    await service.transitionContent(content.id, { target, actor: "Dapeng Li", approvedBy: "Dapeng Li" });
  }
  return content;
}

async function publishOperation(service, operations) {
  const content = await scheduled(service);
  const operation = await operations.create({ accountId: "github", type: "publish", contentId: content.id, executionMode: "browser", actor: "unit-test operator" });
  await operations.approve(operation.id, { approvedBy: "Dapeng Li", authorizationNote: "授权此精确草稿的一次浏览器发布。" });
  await operations.start(operation.id, { actor: "unit-test operator" });
  return operation;
}

async function replyOperation(operations, overrides = {}) {
  return operations.create({
    accountId: "github", type: "reply", replyText: "感谢交流，评测需要保存输入与实际输出。",
    targetUrl: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1",
    executionMode: "browser", actor: "unit-test operator", ...overrides,
  });
}

async function readyReply(operations, overrides = {}) {
  const row = await replyOperation(operations, overrides);
  await operations.approve(row.id, { approvedBy: "Dapeng Li", authorizationNote: "授权此精确回复一次。" });
  await operations.start(row.id, { actor: "unit-test operator" });
  return row;
}

test("old states list no operations and account setup retains the 16 platform profiles", async () => {
  await withServices(async ({ store, operations }) => {
    assert.deepEqual(operations.list(), []);
    const original = store.snapshot().accounts.find((row) => row.id === "zhihu");
    const account = await operations.updateAccount("zhihu", {
      handle: "PengManager", profileUrl: "https://www.zhihu.com/people/pengmanager",
      status: "active", policyStatus: "reviewed", policyCheckedAt: "2026-10-24",
      actor: "Dapeng Li",
    });
    assert.equal(account.status, "active");
    assert.equal(account.policyReviewedBy, "Dapeng Li");
    assert.equal(account.displayName, original.displayName);
    assert.equal(store.snapshot().accounts.length, 16);
    assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  });
});

test("publish goes draft to approved to in_progress to completed and reuses the existing publication gate", async () => {
  await withServices(async ({ store, service, operations }) => {
    const row = await publishOperation(service, operations);
    let calls = 0;
    const original = service.recordPublication.bind(service);
    service.recordPublication = async (input) => { calls += 1; return original(input); };
    const completed = await operations.complete(row.id, { actor: "unit-test operator", receipt: receipt() });
    assert.equal(completed.status, "completed");
    assert.equal(completed.publicationId, store.snapshot().publications[0].id);
    assert.equal(completed.receipt.contentHash, row.contentHash);
    assert.equal(store.snapshot().content.find((item) => item.id === row.contentId).status, "published");
    assert.equal(calls, 1);
    const repeated = await operations.complete(row.id, { actor: "unit-test operator", receipt: receipt() });
    assert.deepEqual(repeated, completed);
    assert.equal(calls, 1);
    assert.equal(store.snapshot().publications.length, 1);
    assert.equal(store.snapshot().events.filter((item) => item.type === "account.operation_completed").length, 1);
    assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  });
});

test("reply stores target, approved text, human authorization and readback receipt without creating a publication", async () => {
  await withServices(async ({ store, operations }) => {
    const row = await readyReply(operations);
    const completed = await operations.complete(row.id, { actor: "unit-test operator", receipt: receipt({ url: `${row.targetUrl}#issuecomment-999999`, dataMode: "real", verificationMethod: "browser_readback" }) });
    assert.equal(completed.status, "completed");
    assert.equal(completed.approval.contentHash, completed.receipt.contentHash);
    assert.equal(completed.receipt.verificationMethod, "browser_readback");
    assert.equal(completed.replyText, row.replyText);
    assert.equal(store.snapshot().publications.length, 0);
  });
});

test("state transitions require explicit actor, per-action authorization and correct order", async () => {
  await withServices(async ({ operations }) => {
    const row = await replyOperation(operations);
    await assert.rejects(operations.start(row.id, { actor: "operator" }), { code: "INVALID_OPERATION_TRANSITION" });
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt() }), { code: "INVALID_OPERATION_TRANSITION" });
    await assert.rejects(operations.approve(row.id, { approvedBy: "Dapeng Li" }), { code: "INVALID_INPUT" });
    await operations.approve(row.id, { approvedBy: "Dapeng Li", authorizationNote: "批准这条回复。" });
    await assert.rejects(operations.start(row.id, {}), { code: "INVALID_INPUT" });
    await operations.start(row.id, { actor: "operator" });
    await assert.rejects(operations.approve(row.id, { approvedBy: "Dapeng Li", authorizationNote: "重复审批" }), { code: "INVALID_OPERATION_TRANSITION" });
  });
});

test("inactive accounts and unreviewed platform policies block approval", async () => {
  await withServices(async ({ operations }) => {
    const row = await replyOperation(operations, { accountId: "zhihu", targetUrl: "https://www.zhihu.com/question/123" });
    await assert.rejects(operations.approve(row.id, { approvedBy: "Dapeng Li", authorizationNote: "批准回复。" }), { code: "ACCOUNT_NOT_READY" });
    await assert.rejects(operations.updateAccount("zhihu", { status: "unknown", actor: "operator" }), { code: "INVALID_ACCOUNT_STATUS" });
    await assert.rejects(operations.updateAccount("zhihu", { policyStatus: "unknown", actor: "operator" }), { code: "INVALID_POLICY_STATUS" });
    await assert.rejects(operations.updateAccount("missing", { actor: "operator" }), { code: "ACCOUNT_NOT_FOUND" });
    await assert.rejects(operations.updateAccount("zhihu", { policyCheckedAt: "invalid", actor: "operator" }), { code: "INVALID_TIMESTAMP" });
    await assert.rejects(operations.updateAccount("zhihu", { policyCheckedAt: "2099-01-01", actor: "operator" }), { code: "INVALID_TIMESTAMP" });
  });
});

test("publication approval cannot bypass content scheduling and Claim expiry is rechecked at completion", async () => {
  await withServices(async ({ store, service, operations }) => {
    const row = await publishOperation(service, operations);
    await store.mutate({ type: "unit.claim_expired", actor: "test" }, (state) => {
      state.claims.find((item) => item.id === "C003").expiresAt = "2026-10-23";
    });
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt() }), (error) => error.code === "PUBLICATION_BLOCKED" && error.details.findings.some((item) => item.code === "CLAIM_EXPIRED"));
    assert.equal(store.snapshot().publications.length, 0);
    assert.equal(operations.list()[0].status, "in_progress");
  });
  await withServices(async ({ service, operations }) => {
    const content = await service.createContent({ title: "观点", body: "个人观点用于单测。", opinion: true, platforms: ["GitHub"] });
    const row = await operations.create({ accountId: "github", type: "publish", contentId: content.id, actor: "operator" });
    await assert.rejects(operations.approve(row.id, { approvedBy: "Dapeng Li", authorizationNote: "批准发布。" }), (error) => error.code === "PUBLICATION_BLOCKED" && error.details.findings.some((item) => item.code === "CONTENT_NOT_SCHEDULED"));
  });
});

test("post-approval content changes invalidate execution and mismatched receipt hashes fail closed", async () => {
  await withServices(async ({ store, service, operations }) => {
    const row = await publishOperation(service, operations);
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt({ contentHash: "a".repeat(64) }) }), { code: "RECEIPT_CONTENT_MISMATCH" });
    await store.mutate({ type: "unit.content_changed", actor: "test" }, (state) => {
      state.content.find((item) => item.id === row.contentId).body = "审批后换文";
    });
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt() }), { code: "OPERATION_CONTENT_CHANGED" });
    assert.equal(store.snapshot().publications.length, 0);
  });
});

test("fixture receipts, missing readback, invalid dates and receipt overwrites never complete an operation", async () => {
  await withServices(async ({ operations }) => {
    const row = await readyReply(operations);
    for (const [overrides, code] of [
      [{ dataMode: "fixture" }, "INVALID_RECEIPT_DATA_MODE"],
      [{ dataMode: "draft" }, "INVALID_RECEIPT_DATA_MODE"],
      [{ verificationMethod: "http_200" }, "RECEIPT_VERIFICATION_REQUIRED"],
      [{ verifiedBy: "" }, "INVALID_INPUT"],
      [{ capturedBy: "" }, "INVALID_INPUT"],
      [{ publishedAt: "invalid" }, "INVALID_TIMESTAMP"],
      [{ publishedAt: "2099-01-01" }, "INVALID_TIMESTAMP"],
      [{ verifiedAt: "2026-10-23" }, "RECEIPT_VERIFICATION_BEFORE_PUBLICATION"],
    ]) {
      await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt(overrides) }), { code });
      assert.equal(operations.list()[0].status, "in_progress");
    }
    await operations.complete(row.id, { actor: "operator", receipt: receipt() });
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt({ url: "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/999998" }) }), { code: "RECEIPT_CONFLICT" });
    await assert.rejects(operations.fail(row.id, { actor: "operator", reason: "不能覆盖已完成动作" }), { code: "INVALID_OPERATION_TRANSITION" });
  });
});

test("public URL validation rejects localhost, numeric hosts, examples, credentials and executable links", async () => {
  await withServices(async ({ operations }) => {
    for (const targetUrl of [
      "http://github.com/a/b", "https://127.0.0.1/", "https://[::1]/", "https://localhost/",
      "https://example.com/test", "https://app.internal/", "javascript:alert(1)",
      "https://name:private@github.com/a/b", "https://github.com/a/b?access_token=redacted", "https://github.com:8443/a/b",
    ]) {
      await assert.rejects(replyOperation(operations, { targetUrl }), (error) => ["INVALID_PUBLIC_URL", "OPERATION_CONTAINS_SENSITIVE_CONTENT"].includes(error.code));
    }
    assert.equal(operations.list().length, 0);
  });
});

test("target and receipt URL fragments reject credentials while preserving platform comment anchors", async () => {
  await withServices(async ({ operations }) => {
    const prefix = "https://github.com/geniusdapeng-collab/geniusdapeng-geo-os/issues/1";
    for (const fragment of [
      "#access_token=placeholder", "#access%5Ftoken%3Dplaceholder", "#/callback?session_id=placeholder",
      "#%2561ccess_token%253Dplaceholder", "#signature=placeholder", "#api_key=placeholder",
      "#id_token=placeholder", "#refresh_token=placeholder", "#app_session_id=placeholder",
    ]) {
      await assert.rejects(replyOperation(operations, { targetUrl: `${prefix}${fragment}` }), (error) => ["INVALID_PUBLIC_URL", "OPERATION_CONTAINS_SENSITIVE_CONTENT"].includes(error.code));
    }
    const row = await readyReply(operations, { targetUrl: `${prefix}#issuecomment-123` });
    for (const fragment of ["#access_token=placeholder", "#/callback?session=placeholder", "#access%5Ftoken%3Dplaceholder"]) {
      await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt({ url: `${prefix}${fragment}` }) }), { code: "INVALID_PUBLIC_URL" });
    }
    const completed = await operations.complete(row.id, { actor: "operator", receipt: receipt({ url: `${prefix}#issuecomment-456` }) });
    assert.equal(completed.receipt.url, `${prefix}#issuecomment-456`);
  });
});

test("legacy manual publication ingress rejects unsafe URLs without requiring new operation-only fields", async () => {
  await withServices(async ({ store, service }) => {
    const content = await scheduled(service);
    const revision = store.snapshot().revision;
    for (const url of [
      "http://127.0.0.1/private", "https://example.com/fixture", "https://example.com./fixture",
      "https://app.internal/private", "https://app.internal./private",
      "https://name:private@github.com/owner/repo/issues/1",
      "https://github.com/owner/repo/issues/1#access_token=placeholder",
      "https://github.com/owner/repo/issues/1?id_token=placeholder",
    ]) {
      await assert.rejects(service.recordPublication({
        contentId: content.id, accountId: "github", actor: "unit-test operator",
        receipt: { url, publishedAt: clock().toISOString(), capturedBy: "unit-test operator", dataMode: "imported" },
      }), { code: "INVALID_PUBLIC_URL" });
    }
    await assert.rejects(service.recordPublication({
      contentId: content.id, accountId: "github", actor: "unit-test operator",
      receipt: { url: "https://github.com/owner/repo/issues/1", publishedAt: clock().toISOString(), capturedBy: "private@example.com", dataMode: "imported" },
    }), { code: "PUBLICATION_CONTAINS_SENSITIVE_CONTENT" });
    for (const invalid of [[], "not-an-object", { capturedBy: {} }, { publishedAt: 123 }, { url: {} }]) {
      await assert.rejects(service.recordPublication({
        contentId: content.id, accountId: "github", actor: "unit-test operator", receipt: invalid,
      }), { code: "INVALID_INPUT" });
    }
    assert.equal(store.snapshot().revision, revision);
    assert.equal(store.snapshot().publications.length, 0);
    const publication = await service.recordPublication({
      contentId: content.id, accountId: "github", actor: "unit-test operator",
      receipt: { url: "http://github.com/owner/repo/issues/1#issuecomment-123", publishedAt: clock().toISOString(), capturedBy: "unit-test operator", dataMode: "imported" },
    });
    assert.equal(publication.url, "http://github.com/owner/repo/issues/1#issuecomment-123");
    assert.equal(store.snapshot().content.find((row) => row.id === content.id).status, "published");
    assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  });
});

test("authorization remains bound to the exact account identity after handle and profile changes", async () => {
  await withServices(async ({ operations }) => {
    const draft = await replyOperation(operations);
    const originalHandle = draft.accountSnapshot.handle;
    await operations.updateAccount("github", { handle: "changed-account", actor: "owner" });
    await assert.rejects(operations.approve(draft.id, { approvedBy: "owner", authorizationNote: "Authorize original account only." }), { code: "ACCOUNT_IDENTITY_CHANGED" });
    assert.equal(operations.list().find((row) => row.id === draft.id).accountSnapshot.handle, originalHandle);

    const approved = await replyOperation(operations);
    await operations.approve(approved.id, { approvedBy: "owner", authorizationNote: "Authorize exact account." });
    await operations.updateAccount("github", { profileUrl: "https://github.com/changed-account", actor: "owner" });
    await assert.rejects(operations.start(approved.id, { actor: "operator" }), { code: "ACCOUNT_IDENTITY_CHANGED" });

    const running = await readyReply(operations);
    await operations.updateAccount("github", { handle: "another-account", actor: "owner" });
    await assert.rejects(operations.complete(running.id, { actor: "operator", receipt: receipt() }), { code: "ACCOUNT_IDENTITY_CHANGED" });
    assert.equal(operations.list().find((row) => row.id === running.id).status, "in_progress");
    assert.equal(operations.list().find((row) => row.id === running.id).receipt, null);
  });
});

test("credentials and sensitive text are rejected before any write, including nested receipt fields", async () => {
  await withServices(async ({ store, operations }) => {
    const revision = store.snapshot().revision;
    await assert.rejects(replyOperation(operations, { cookies: "browser-session" }), { code: "CREDENTIALS_NOT_ALLOWED" });
    await assert.rejects(replyOperation(operations, { replyText: "请联系 private@example.com" }), { code: "OPERATION_CONTAINS_SENSITIVE_CONTENT" });
    assert.equal(store.snapshot().revision, revision);
    const row = await readyReply(operations);
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt({ headers: { Cookie: "browser-session" } }) }), { code: "CREDENTIALS_NOT_ALLOWED" });
    const raw = await readFile(store.filePath, "utf8");
    assert.doesNotMatch(raw, /browser-session|private@example/);
  });
});

test("high-risk replies remain human-only and spam never enters execution", async () => {
  await withServices(async ({ operations }) => {
    const risky = await replyOperation(operations, { replyText: "关于合同和法律问题，请由本人进一步沟通。" });
    await assert.rejects(operations.approve(risky.id, { approvedBy: "Dapeng Li", authorizationNote: "批准回复" }), { code: "HUMAN_ONLY_INTERACTION" });
    const manual = await readyReply(operations, { replyText: risky.replyText, executionMode: "manual" });
    assert.equal(manual.classification.level, "L0");
    await operations.complete(manual.id, { actor: "Dapeng Li", receipt: receipt() });
    const spam = await replyOperation(operations, { replyText: "加我微信，内部消息稳赚。", executionMode: "manual" });
    await assert.rejects(operations.approve(spam.id, { approvedBy: "Dapeng Li", authorizationNote: "批准回复" }), { code: "REPLY_BLOCKED" });
  });
});

test("original interaction risk is preserved when linking an otherwise harmless reply", async () => {
  await withServices(async ({ service, operations }) => {
    const interaction = await service.createInteraction({ text: "请处理我的退款投诉。", actor: "test" });
    const row = await replyOperation(operations, { interactionId: interaction.id, replyText: "已收到，将由本人处理。" });
    assert.equal(row.classification.level, "L0");
    await assert.rejects(operations.approve(row.id, { approvedBy: "Dapeng Li", authorizationNote: "批准回复" }), { code: "HUMAN_ONLY_INTERACTION" });
    await assert.rejects(replyOperation(operations, { interactionId: "missing" }), { code: "INTERACTION_NOT_FOUND" });
  });
});

test("duplicate operations and platform receipts are blocked, failed drafts preserve a reason", async () => {
  await withServices(async ({ service, operations }) => {
    const row = await publishOperation(service, operations);
    await assert.rejects(operations.create({ accountId: "github", type: "publish", contentId: row.contentId, actor: "operator" }), { code: "PUBLICATION_OPERATION_EXISTS" });
    const failed = await operations.fail(row.id, { actor: "operator", reason: "浏览器会话已过期，未发生外部发布。" });
    assert.equal(failed.status, "failed");
    assert.match(failed.failure.reason, /会话已过期/);
    await assert.rejects(operations.start(row.id, { actor: "operator" }), { code: "INVALID_OPERATION_TRANSITION" });
    const replacement = await operations.create({ accountId: "github", type: "publish", contentId: row.contentId, actor: "operator" });
    assert.equal(replacement.status, "draft");
    const first = await readyReply(operations);
    await operations.complete(first.id, { actor: "operator", receipt: receipt() });
    const duplicate = await readyReply(operations);
    await assert.rejects(operations.complete(duplicate.id, { actor: "operator", receipt: receipt() }), { code: "DUPLICATE_PLATFORM_RECEIPT" });
  });
});

test("concurrent completion across service instances is idempotent with one publication and one event", async () => {
  await withServices(async ({ store, service, operations }) => {
    const row = await publishOperation(service, operations);
    const second = new AccountOperationsService({ service, clock });
    const [a, b] = await Promise.all([
      operations.complete(row.id, { actor: "operator", receipt: receipt() }),
      second.complete(row.id, { actor: "operator", receipt: receipt() }),
    ]);
    assert.deepEqual(a, b);
    assert.equal(store.snapshot().publications.length, 1);
    assert.equal(store.snapshot().events.filter((event) => event.type === "account.operation_completed").length, 1);
  });
});

test("retry recovers a persisted publication when the second ledger write failed", async () => {
  await withServices(async ({ store, service, operations }) => {
    const row = await publishOperation(service, operations);
    const originalMutate = store.mutate.bind(store);
    let failOnce = true;
    store.mutate = async (event, mutator) => {
      if (event.type === "account.operation_completed" && failOnce) {
        failOnce = false;
        throw Object.assign(new Error("unit simulated disk failure"), { code: "EIO" });
      }
      return originalMutate(event, mutator);
    };
    await assert.rejects(operations.complete(row.id, { actor: "operator", receipt: receipt() }), { code: "EIO" });
    assert.equal(store.snapshot().publications.length, 1);
    assert.equal(operations.list()[0].status, "in_progress");
    await assert.rejects(operations.fail(row.id, { actor: "operator", reason: "不得标记已发布失败" }), { code: "PUBLICATION_ALREADY_RECORDED" });
    const completed = await operations.complete(row.id, { actor: "operator", receipt: receipt() });
    assert.equal(completed.status, "completed");
    assert.equal(store.snapshot().publications.length, 1);
    assert.equal(verifyEventChain(store.snapshot().events).valid, true);
  });
});

test("input boundaries and missing objects return structured client errors without mutations", async () => {
  await withServices(async ({ operations }) => {
    for (const [input, code] of [
      [null, "INVALID_INPUT"], [{ accountId: "github", type: "publish", actor: "a", contentId: "missing" }, "CONTENT_NOT_FOUND"],
      [{ accountId: "missing", type: "reply", actor: "a" }, "ACCOUNT_NOT_FOUND"],
      [{ accountId: "github", type: "delete", actor: "a" }, "INVALID_OPERATION_TYPE"],
      [{ accountId: "github", type: "reply", actor: "a", executionMode: "unattended" }, "INVALID_EXECUTION_MODE"],
    ]) await assert.rejects(operations.create(input), { code });
    await assert.rejects(replyOperation(operations, { replyText: " ".repeat(100) }), { code: "INVALID_INPUT" });
    await assert.rejects(replyOperation(operations, { replyText: "x".repeat(10_001) }), { code: "INVALID_INPUT" });
    await assert.rejects(operations.approve("missing", { approvedBy: "a", authorizationNote: "yes" }), { code: "OPERATION_NOT_FOUND" });
    const maximum = await replyOperation(operations, { replyText: "x".repeat(10_000) });
    assert.equal(maximum.replyText.length, 10_000);
    const row = await replyOperation(operations, { replyText: "特殊字符 <script> 与引号 \" 保留为普通数据。" });
    assert.match(row.replyText, /<script>/);
  });
});
