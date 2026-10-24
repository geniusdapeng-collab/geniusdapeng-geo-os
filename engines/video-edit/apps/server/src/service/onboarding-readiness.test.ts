import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { bindVerifiedActiveBundle } from "./active-bundle.js";
import { clearLlmVerification, currentLlmVerification, recordLlmVerification } from "./llm-verification.js";
import { collectNativeOnboardingReadinessOn } from "./onboarding-readiness.js";

const scope = { tenantId: "fixture-tenant", workspaceId: "fixture-workspace" };
const config = { provider: "fixture-only", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key-only", model: "fixture-model" };
const env = { LLM_PROVIDER: config.provider, LLM_BASE_URL: config.baseUrl, LLM_API_KEY: config.apiKey, LLM_MODEL: config.model };
afterEach(() => clearLlmVerification(scope));
function verified(): void { recordLlmVerification(scope, config, { eventId: "E-1", persistence: "process-only" }); }

function fixture() {
  const state = {
    workspace: { id: scope.workspaceId, tenant_id: scope.tenantId, bundle_id: "ai-video", is_example: false },
    archive: { dataMode: "real", business: { name: "隔离测试主体", industry: "测试", note: "非真实经营资料", configuredAt: "2026-10-24T00:00:00Z", source: "user" } },
    installs: [{ id: "install-1", workspace_id: scope.workspaceId, bundle_id: "ai-video", status: "active", installed_at: "2026-10-24T00:00:00Z",
      assets: { preset_ids: ["agent-1"], fence_rule_ids: ["fence-1"], skill_ids: ["skill-1"] },
      draft_id: null as string | null, assembly_version: null as number | null, assembly_hash: null as string | null, qualified_exam_id: null as string | null }],
    agents: [{ id: "agent-1", status: "ready", skills: ["skill-1"], meta: {} as Record<string, unknown> }],
    fences: [{ id: "fence-1", status: "active", created_by: "MEM-FIXTURE" }], skills: [{ skill_id: "skill-1" }],
    probe: { provider: config.provider, base_url: config.baseUrl, model: config.model, probe_verified: true, persistence: "process-only" },
    activation: {} as Record<string, unknown>,
    draft: { id: "draft-1", status: "active", confirmed_by: "MEM-FIXTURE" },
    exam: { id: "exam-1", status: "done", verdict: "pass", assessment_kind: "candidate-role", target_install_id: "install-1",
      target_draft_id: "draft-1", target_version: 1, target_hash: "a".repeat(64) },
    candidates: [{ agent_id: "agent-1", install_id: "install-1", draft_id: "draft-1", assembly_version: 1,
      assembly_hash: "a".repeat(64), passed: true, red_line_hit: false }],
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = { query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    let rows: unknown[];
    if (sql.includes("FROM workspaces")) rows = [state.workspace];
    else if (sql.includes("FROM profiles")) rows = [{ archive: state.archive }];
    else if (sql.includes("FROM bundle_installs")) rows = state.installs;
    else if (sql.includes("FROM agents")) rows = state.agents;
    else if (sql.includes("FROM fence_rules")) rows = state.fences;
    else if (sql.includes("FROM skill_installs")) rows = state.skills;
    else if (sql.includes("FROM biz_events") && sql.includes("onboarding.llm_configured")) {
      expect(params).toEqual([scope.tenantId, scope.workspaceId, "E-1"]); rows = [{ params: state.probe }];
    } else if (sql.includes("FROM biz_events") && sql.includes("onboarding.real_mode_activated")) rows = [{ after: state.activation }];
    else if (sql.includes("FROM wizard_staffing_drafts")) rows = [state.draft];
    else if (sql.includes("FROM eval_exams")) rows = [state.exam];
    else if (sql.includes("FROM eval_candidate_results")) rows = state.candidates;
    else throw new Error(`Unhandled fixture query: ${sql}`);
    return { rows, rowCount: rows.length };
  } } as unknown as pg.PoolClient;
  const options = { role: "owner", env, bindBundle: ((facts) => ({ state: "ready", bundleId: facts.activeInstalls[0]?.bundleId ?? null,
    installId: facts.activeInstalls[0]?.id ?? null, projection: null, reason: "explicit synthetic fixture; no provider or real installation claimed" })) as typeof bindVerifiedActiveBundle };
  const read = (extra: Partial<Parameters<typeof collectNativeOnboardingReadinessOn>[2]> = {}) => collectNativeOnboardingReadinessOn(client, scope, { ...options, ...extra });
  return { state, client, queries, read };
}

describe("native real-mode facts and current verification", () => {
  it("a legacy real label is insufficient without an actual current-process model probe and activation receipt", async () => {
    const { read } = fixture(), result = await read();
    expect(result.persistedDataMode).toBe("real"); expect(result.dataMode).toBe("simulated");
    expect(result.activationGate.checks.find((check) => check.key === "llm")?.ok).toBe(false);
    expect(result.formalActivationRecorded).toBe(false);
  });
  it("all real facts allow activation, then a matching committed activation is projected as real", async () => {
    verified(); const { state, read } = fixture(), before = await read();
    expect(before.activationGate.canActivate).toBe(true); expect(before.dataMode).toBe("simulated");
    state.activation = { activationFingerprint: before.activationFingerprint };
    expect(await read()).toMatchObject({ dataMode: "real", formalActivationRecorded: true });
  });
  it("a read-only observer can see real operation while remaining unable to activate it", async () => {
    verified(); const { state, read } = fixture(), before = await read();
    state.activation = { activationFingerprint: before.activationFingerprint };
    const result = await read({ role: "readonly" });
    expect(result.dataMode).toBe("real"); expect(result.activationGate.canActivate).toBe(false);
    expect(result.activationGate.checks.find((check) => check.key === "owner")?.ok).toBe(false);
  });
  it("same URLs with a changed key have no current probe; receipt output never contains key material", async () => {
    verified(); expect(JSON.stringify(currentLlmVerification(scope, env))).not.toContain(config.apiKey);
    const { read } = fixture();
    expect((await read({ env: { ...env, LLM_API_KEY: "different-fixture-key" } })).facts.llmReal).toBe(false);
    clearLlmVerification(scope); expect((await read()).facts.llmReal).toBe(false);
  });
  it.each(["provider", "base_url", "model", "probe_verified", "persistence"])("%s in the committed probe event must match", async (field) => {
    verified(); const { state, read } = fixture(); Object.assign(state.probe, { [field]: "changed-fixture" });
    expect((await read()).facts.llmReal).toBe(false);
  });
  it.each(["business-source", "business-confirmation", "example", "no-install", "duplicate-install", "bundle-pointer", "disabled-agent", "inactive-fence", "missing-skill", "fence-owner", "duplicate-asset-id"])("%s blocks real mode from actual collected facts", async (kind) => {
    verified(); const { state, read } = fixture();
    if (kind === "business-source") state.archive.business.source = "seed";
    if (kind === "business-confirmation") state.archive.business.configuredAt = "";
    if (kind === "example") state.workspace.is_example = true;
    if (kind === "no-install") state.installs = [];
    if (kind === "duplicate-install") state.installs.push({ ...state.installs[0]!, id: "other-install" });
    if (kind === "bundle-pointer") state.workspace.bundle_id = "another-bundle";
    if (kind === "disabled-agent") state.agents[0]!.status = "disabled";
    if (kind === "inactive-fence") state.fences[0]!.status = "draft";
    if (kind === "missing-skill") state.skills = [];
    if (kind === "fence-owner") state.fences[0]!.created_by = "";
    if (kind === "duplicate-asset-id") state.installs[0]!.assets.preset_ids.push("agent-1");
    expect((await read()).activationGate.canActivate).toBe(false);
  });
  it("an invalid physical bundle projection fails closed without a fallback", async () => {
    verified(); const { read } = fixture();
    const invalid = (() => ({ state: "projection-invalid", bundleId: "ai-video", installId: "install-1", projection: null, reason: "fixture tamper" })) as typeof bindVerifiedActiveBundle;
    expect((await read({ bindBundle: invalid })).facts.activeInstall).toBe(false);
  });
  it("a change in confirmed business data invalidates an old activation fingerprint", async () => {
    verified(); const { state, read } = fixture(); state.activation.activationFingerprint = (await read()).activationFingerprint;
    state.archive.business.name = "变更后的隔离测试主体";
    expect(await read()).toMatchObject({ dataMode: "simulated", formalActivationRecorded: false });
  });
  it("a foreign tenant fails before returning any workspace truth", async () => {
    const { state, read } = fixture(); state.workspace.tenant_id = "other-tenant";
    await expect(read()).rejects.toThrow(/租户/);
  });
  it("activation collection locks workspace/profile/install and all mutable qualification rows", async () => {
    verified(); const { read, queries } = fixture(); await read({ lock: true });
    expect(queries.filter((query) => /FROM (workspaces|profiles|bundle_installs)/.test(query.sql)).every((query) => query.sql.endsWith("FOR UPDATE"))).toBe(true);
    expect(queries.filter((query) => /FROM (agents|fence_rules|skill_installs)/.test(query.sql)).every((query) => query.sql.endsWith("FOR SHARE"))).toBe(true);
    expect(queries.every((query) => !/^\s*(?:UPDATE|INSERT|DELETE)/.test(query.sql))).toBe(true);
  });
});

describe("custom candidate assembly stays bound to native materialization and exam", () => {
  function custom() {
    const data = fixture(); data.state.workspace.bundle_id = "custom";
    Object.assign(data.state.installs[0]!, { bundle_id: "custom", draft_id: "draft-1", assembly_version: 1, assembly_hash: "a".repeat(64), qualified_exam_id: "exam-1" });
    return data;
  }
  const verifiedMaterialization = async () => { return undefined; };
  it("only the exact current candidate set, binding and passing results allow activation", async () => {
    verified(); const { read } = custom();
    expect((await read({ verifyCustom: verifiedMaterialization })).activationGate.canActivate).toBe(true);
  });
  it.each(["exam-hash", "candidate-hash", "missing-candidate", "failed-candidate", "red-line", "different-candidate", "draft-state", "fence-confirmer", "false-capability"])("%s blocks candidate formal mode", async (kind) => {
    verified(); const { state, read } = custom();
    if (kind === "exam-hash") state.exam.target_hash = "b".repeat(64);
    if (kind === "candidate-hash") state.candidates[0]!.assembly_hash = "b".repeat(64);
    if (kind === "missing-candidate") state.candidates = [];
    if (kind === "failed-candidate") state.candidates[0]!.passed = false;
    if (kind === "red-line") state.candidates[0]!.red_line_hit = true;
    if (kind === "different-candidate") state.candidates[0]!.agent_id = "another-agent";
    if (kind === "draft-state") state.draft.status = "retired";
    if (kind === "fence-confirmer") state.draft.confirmed_by = "OTHER";
    if (kind === "false-capability") state.agents[0]!.meta.capability_declarations = [{ kind: "tool", name: "uninstalled-tool", status: "installed" }];
    expect((await read({ verifyCustom: verifiedMaterialization })).activationGate.canActivate).toBe(false);
  });
  it("a deterministic materialization mismatch blocks; a database error remains a visible failure", async () => {
    verified(); const { read } = custom();
    expect((await read({ verifyCustom: async () => { throw new Error("candidate bytes changed"); } })).facts.activeInstall).toBe(false);
    await expect(read({ verifyCustom: async () => { throw Object.assign(new Error("database disconnected"), { code: "08006" }); } })).rejects.toThrow("database disconnected");
  });
});
