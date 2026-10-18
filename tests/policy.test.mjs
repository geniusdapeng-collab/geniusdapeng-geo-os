import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyInteraction,
  isClaimPubliclyExportable,
  scanSensitiveText,
} from "../src/domain/policy.mjs";

test("interaction policy routes high-risk recruiting messages to L0", () => {
  const result = classifyInteraction("你好，我想聊一下 DeepSeek 招聘和面试机会。");
  assert.equal(result.level, "L0");
  assert.equal(result.requiresHuman, true);
});

test("interaction policy sends technical questions to human-confirmed L1", () => {
  const result = classifyInteraction("Harness 的上下文和评测应该怎么设计？");
  assert.equal(result.level, "L1");
  assert.equal(result.action, "draft_then_human_confirm");
});

test("interaction policy only allows L2 when the FAQ is explicitly approved", () => {
  const result = classifyInteraction("请问你的公开演讲在哪里看？", { approvedFaq: true });
  assert.equal(result.level, "L2");
});

test("spam is rejected with L3", () => {
  const result = classifyInteraction("加我微信，内部消息稳赚。");
  assert.equal(result.level, "L3");
});

test("sensitive scan finds secret-shaped text without needing the secret value", () => {
  const findings = scanSensitiveText(
    "联系 test@example.com，或者 token=abcdefghijklmnop。",
  );
  assert.ok(findings.some((item) => item.kind === "email"));
  assert.ok(findings.some((item) => item.kind === "secret_assignment"));
  assert.ok(
    findings.every((item) => !Object.hasOwn(item, "match")),
    "findings must not echo the matched secret",
  );
});

test("public export requires approved_public, approved state and no expiry", () => {
  const base = {
    state: "approved",
    publicLevel: "approved_public",
    expiresAt: null,
    text: "Public project claim.",
  };
  assert.equal(isClaimPubliclyExportable(base, { now: new Date("2026-10-18") }), true);
  assert.equal(
    isClaimPubliclyExportable({ ...base, expiresAt: "2026-01-01" }, { now: new Date("2026-10-18") }),
    false,
  );
  assert.equal(isClaimPubliclyExportable({ ...base, publicLevel: "private" }), false);
});
