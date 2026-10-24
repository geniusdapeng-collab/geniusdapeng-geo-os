import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript-governance";

const source = readFileSync(new URL("../apps/server/src/index.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
let statement;
function visit(node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast).includes("WORKLOOM_STARTUP_THREAD_RESUME")
    && node.thenStatement.getText(ast).includes("resumeApprovedPendingThreads")) statement = node.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(statement, "actual native startup must guard approved-thread resumption");
assert.ok(statement.includes('await import("./runtime/scheduler.js")'), "test exercises the real startup import");
const executable = statement.replace('await import("./runtime/scheduler.js")', "await resumeModule()");

async function execute(flag, fail = false) {
  let resumed = 0, failures = 0;
  const context = createContext({ process: { env: flag === undefined ? {} : { WORKLOOM_STARTUP_THREAD_RESUME: flag } },
    resumeModule: async () => ({ resumeApprovedPendingThreads: async () => { resumed++; if (fail) throw new Error("database unavailable"); return 1; } }),
    console: { log() {}, error() { failures++; } }, Error,
  });
  runInContext(executable, context, { timeout: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  return { resumed, failures };
}
test("opening the target with explicit startup opt-out never executes an old approval", async () => {
  assert.deepEqual(await execute("0"), { resumed: 0, failures: 0 });
});
test("native default and explicit enable retain actual approved-thread recovery", async () => {
  assert.deepEqual(await execute(undefined), { resumed: 1, failures: 0 });
  assert.deepEqual(await execute("1"), { resumed: 1, failures: 0 });
});
test("an enabled startup recovery failure remains visible without breaking startup", async () => {
  assert.deepEqual(await execute("1", true), { resumed: 1, failures: 1 });
});
