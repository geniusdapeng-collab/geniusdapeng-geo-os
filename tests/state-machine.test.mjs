import test from "node:test";
import assert from "node:assert/strict";
import { transitionContent } from "../src/domain/state-machine.mjs";

const now = new Date("2026-10-18T12:00:00.000Z");
const content = {
  id: "CNT-001",
  status: "draft",
  version: 1,
  updatedAt: "2026-10-18T11:00:00.000Z",
};

test("content moves through draft to fact_check with a new version", () => {
  const next = transitionContent(content, "fact_check", { note: "ready for review" }, { now });
  assert.equal(next.status, "fact_check");
  assert.equal(next.version, 2);
  assert.equal(next.updatedAt, now.toISOString());
});

test("approval requires an approver", () => {
  assert.throws(
    () => transitionContent({ ...content, status: "fact_check" }, "approved", {}, { now }),
    (error) => error.code === "APPROVER_REQUIRED",
  );
});

test("published cannot be reached without a real receipt", () => {
  assert.throws(
    () =>
      transitionContent(
        { ...content, status: "scheduled" },
        "published",
        { approvedBy: "Dapeng" },
        { now },
      ),
    (error) => error.code === "PUBLICATION_RECEIPT_REQUIRED",
  );
});

test("illegal transition is rejected", () => {
  assert.throws(
    () => transitionContent(content, "scheduled", { approvedBy: "Dapeng" }, { now }),
    (error) => error.code === "INVALID_TRANSITION",
  );
});
