import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadDeclaredSkillContext, declaredSkillPlanningContext } from "./declared-skill-context.js";
import { planQuestSmart } from "./loop.js";
import type { AssembledPreset } from "./assembly.js";

const root = path.resolve(import.meta.dirname, "../../..");
const official = (name: string) => fs.readFileSync(path.join(root, "skills/official", name, "SKILL.md"), "utf8");
const row = (name = "deal-flow") => ({ id: `skill-${name}`, name, version: "1.0", installed_version: "1.0", body: official(name) });
const fake = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as unknown as Parameters<typeof loadDeclaredSkillContext>[0];

describe("embedded declared skill planning context", () => {
  it("loads exact installed versions and full original official SOPs in declaration order", async () => {
    const skills = await loadDeclaredSkillContext(fake([row("cross-platform-review"), row()]), "ws-explicit-fixture", ["deal-flow", "cross-platform-review", "deal-flow"]);
    expect(skills.map((skill) => skill.name)).toEqual(["deal-flow", "cross-platform-review"]);
    expect(skills[0]!.body).toBe(official("deal-flow")); expect(skills[1]!.body).toContain("单平台样本 <5 条或周期 <7 天");
    expect(skills[0]!.bodySha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    [[], "AMBIGUOUS_OR_MISSING"], [[row(), row()], "AMBIGUOUS_OR_MISSING"],
    [[{ ...row(), installed_version: "old" }], "STALE_OR_EMPTY"], [[{ ...row(), body: "  " }], "STALE_OR_EMPTY"],
  ])("refuses missing, duplicate, stale or empty installed skill body", async (rows, error) => {
    await expect(loadDeclaredSkillContext(fake(rows as unknown[]), "ws-explicit-fixture", ["deal-flow"])).rejects.toThrow(error as string);
  });
  it("checks declaration shape and does not query unrelated installed skills", async () => {
    await expect(loadDeclaredSkillContext(fake([]), "ws-explicit-fixture", [null])).rejects.toThrow("DECLARED_SKILLS_INVALID");
    let calls = 0; const client = { query: async (_sql: string, args: unknown[]) => { calls++; expect(args).toEqual(["ws-explicit-fixture", ["deal-flow"]]); return { rows: [row()] }; } };
    await loadDeclaredSkillContext(client as never, "ws-explicit-fixture", ["deal-flow"]); expect(calls).toBe(1);
    expect(await loadDeclaredSkillContext(client as never, "ws-explicit-fixture", [])).toEqual([]); expect(calls).toBe(1);
  });
  it("actual planner consumes role responsibilities and original SOP but rejects an invented tool", async () => {
    const verifiedSkills = await loadDeclaredSkillContext(fake([row()]), "ws-explicit-fixture", ["deal-flow"]);
    const preset: AssembledPreset = { agentId: "fixture", presetKey: "deal-manager", version: "v1", highRisk: true, fenceBindings: ["G15"],
      tools: [{ name: "deal.quote.draft", access: "write", desc: "报价草稿" }], prompt: { role: "商单经理", constraints: ["对外文件先过 G15"] }, verifiedSkills,
      essentials: { archive: { dataMode: "real" }, stage: "operate", goal: "生成商单报价草稿" } };
    let received = "";
    const planned = await planQuestSmart("生成商单报价草稿", preset, async (prompt) => { received = prompt; return JSON.stringify([{ action: "deal.quote.draft", objectType: "deal_quote", tool: "deal.quote.draft", params: { draft: true }, label: "生成报价草稿" }]); });
    expect(planned[0]!.tool).toBe("deal.quote.draft"); expect(received).toContain("商单经理"); expect(received).toContain("对外文件先过 G15");
    expect(received).toContain("报价/合同/结案报告等对外文件必过 G15"); expect(received).toContain(verifiedSkills[0]!.bodySha256);
    const forbidden = await planQuestSmart("生成商单报价草稿", preset, async () => JSON.stringify([{ action: "send.money", objectType: "money", tool: "send.money", params: {}, label: "forbidden" }]));
    expect(forbidden.every((step) => step.tool === "deal.quote.draft")).toBe(true); expect(forbidden[0]!.context?.params_incomplete).toBe(true);
  });
  it("legacy assembled presets retain their existing planning context", () => {
    expect(declaredSkillPlanningContext({ prompt: { role: "legacy" } })).toBe("");
  });
});
