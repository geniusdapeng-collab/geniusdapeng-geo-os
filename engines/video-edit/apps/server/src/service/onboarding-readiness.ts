/** Collect native onboarding truth on the caller's scoped transaction; no business data is fabricated. */
import type pg from "pg";
import { bindVerifiedActiveBundle, type WorkspaceBundleFacts } from "./active-bundle.js";
import { assertMaterializedAssembly } from "./bundle.js";
import { currentLlmVerification, type LlmVerificationReceipt } from "./llm-verification.js";
import { evaluateRealModeReadiness, sha256Canonical, type ActivationGateResult, type RealModeFacts } from "./onboarding-truth.js";

interface Scope { tenantId: string; workspaceId: string }
export interface NativeOnboardingBusiness { name: string; industry: string; note: string; configuredAt: string; source: string }
type ActiveInstall = Parameters<typeof assertMaterializedAssembly>[2];
interface AgentRow { id: string; status: string; skills: string[]; meta: Record<string, unknown> }
interface FenceRow { id: string; status: string; created_by: string }
interface ExamRow { id: string; status: string; verdict: string; assessment_kind: string;
  target_install_id: string; target_draft_id: string; target_version: number; target_hash: string }
interface CandidateRow { agent_id: string; install_id: string; draft_id: string; assembly_version: number;
  assembly_hash: string; passed: boolean; red_line_hit: boolean }
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function ids(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    && new Set(value).size === value.length ? [...value] : null;
}
function businessOf(value: unknown): NativeOnboardingBusiness | null {
  const data = object(value);
  if (!Object.keys(data).length) return null;
  return { name: text(data.name), industry: text(data.industry), note: text(data.note),
    configuredAt: text(data.configuredAt), source: text(data.source) };
}

export interface NativeOnboardingReadiness {
  facts: RealModeFacts;
  activationGate: ActivationGateResult;
  operationalGate: ActivationGateResult;
  business: NativeOnboardingBusiness | null;
  persistedDataMode: "real" | "simulated";
  dataMode: "real" | "simulated";
  formalActivationRecorded: boolean;
  activationFingerprint: string;
  modelVerification: LlmVerificationReceipt | null;
  installId: string | null;
}

export async function collectNativeOnboardingReadinessOn(
  client: pg.PoolClient,
  scope: Scope,
  options: { role: string; lock?: boolean; env?: NodeJS.ProcessEnv;
    bindBundle?: typeof bindVerifiedActiveBundle;
    verifyCustom?: typeof assertMaterializedAssembly } = { role: "readonly" },
): Promise<NativeOnboardingReadiness> {
  const lock = options.lock ? " FOR UPDATE" : "";
  const sharedLock = options.lock ? " FOR SHARE" : "";
  const workspaceRows = await client.query<{ id: string; tenant_id: string; bundle_id: string | null; is_example: boolean }>(
    `SELECT id, tenant_id, bundle_id, is_example FROM workspaces WHERE id=$1${lock}`, [scope.workspaceId],
  );
  const workspace = workspaceRows.rows[0];
  if (!workspace || workspace.tenant_id !== scope.tenantId) throw new Error("当前工作区不存在或不属于当前租户");
  const profileRows = await client.query<{ archive: Record<string, unknown> }>(
    `SELECT archive FROM profiles WHERE workspace_id=$1${lock}`, [scope.workspaceId],
  );
  const archive = object(profileRows.rows[0]?.archive), business = businessOf(archive.business);
  const installs = await client.query<ActiveInstall>(
    `SELECT * FROM bundle_installs WHERE workspace_id=$1 AND status='active' ORDER BY installed_at DESC${lock}`, [scope.workspaceId],
  );
  const install = installs.rows.length === 1 ? installs.rows[0]! : null;
  const assets = object(install?.assets), agentIds = ids(assets.preset_ids), fenceIds = ids(assets.fence_rule_ids), skillIds = ids(assets.skill_ids ?? []);
  const validAssets = agentIds !== null && fenceIds !== null && skillIds !== null;
  const agents = await client.query<AgentRow>(
    `SELECT id, status, skills, meta FROM agents WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id${sharedLock}`, [scope.workspaceId, agentIds ?? []],
  );
  const fences = await client.query<FenceRow>(
    `SELECT id, status, created_by FROM fence_rules WHERE workspace_id=$1 AND id=ANY($2) ORDER BY id${sharedLock}`, [scope.workspaceId, fenceIds ?? []],
  );
  const skills = await client.query<{ skill_id: string }>(
    `SELECT skill_id FROM skill_installs WHERE workspace_id=$1 AND skill_id=ANY($2) ORDER BY skill_id${sharedLock}`, [scope.workspaceId, skillIds ?? []],
  );
  const verification = currentLlmVerification(scope, options.env);
  const verificationEvent = verification ? await client.query<{ params: Record<string, unknown> }>(
    `SELECT payload->'decision'->'params' AS params FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND event_id=$3
       AND payload->'decision'->>'action'='onboarding.llm_configured'
       AND payload->'who'->>'type'='human'`, [scope.tenantId, scope.workspaceId, verification.eventId],
  ) : null;
  const eventParams = object(verificationEvent?.rows[0]?.params);
  const llmVerified = Boolean(verification && eventParams.provider === verification.provider
    && eventParams.base_url === verification.baseUrl && eventParams.model === verification.model
    && eventParams.probe_verified === true && eventParams.persistence === verification.persistence);

  let customAssembly: RealModeFacts["customAssembly"] = null;
  let assemblyVerified = false, fenceResponsibilityReady = fences.rows.every((fence) => Boolean(text(fence.created_by)));
  let capabilityClaimsSafe = validAssets, pendingCapabilities = 0;
  if (install?.bundle_id === "custom") {
    const drafts = await client.query<{ id: string; status: string; confirmed_by: string }>(
      `SELECT id, status, confirmed_by FROM wizard_staffing_drafts WHERE workspace_id=$1 AND id=$2${sharedLock}`, [scope.workspaceId, install.draft_id],
    );
    const draft = drafts.rows[0];
    const exams = await client.query<ExamRow>(
      `SELECT id, status, verdict, assessment_kind, target_install_id, target_draft_id, target_version, target_hash
       FROM eval_exams WHERE workspace_id=$1 AND id=$2${sharedLock}`, [scope.workspaceId, install.qualified_exam_id],
    );
    const exam = exams.rows[0];
    const results = await client.query<CandidateRow>(
      `SELECT agent_id, install_id, draft_id, assembly_version, assembly_hash, passed, red_line_hit
       FROM eval_candidate_results WHERE workspace_id=$1 AND exam_id=$2 ORDER BY agent_id${sharedLock}`, [scope.workspaceId, exam?.id ?? ""],
    );
    try { await (options.verifyCustom ?? assertMaterializedAssembly)(client, scope.workspaceId, install, "active"); assemblyVerified = true; }
    catch (error) {
      // SQL failures must remain visible; a deterministic materialization mismatch becomes a blocked gate.
      if ((error as { code?: unknown })?.code) throw error;
      assemblyVerified = false;
    }
    const expected = [...(agentIds ?? [])].sort();
    const resultIdsMatch = JSON.stringify(results.rows.map((row) => row.agent_id).sort()) === JSON.stringify(expected);
    const resultsBound = results.rows.every((row) => row.install_id === install.id && row.draft_id === install.draft_id
      && row.assembly_version === install.assembly_version && row.assembly_hash === install.assembly_hash);
    fenceResponsibilityReady &&= Boolean(draft?.confirmed_by && fences.rows.every((fence) => fence.created_by === draft.confirmed_by));
    for (const agent of agents.rows) {
      const declarations = object(agent.meta).capability_declarations;
      if (Array.isArray(declarations)) for (const item of declarations) {
        const declaration = object(item);
        if (declaration.status === "pending_approval") pendingCapabilities++;
        else if (declaration.status === "installed") {
          // Candidate assembly v1 installs no suggested tools/skills implicitly. Actual materialization/exam are authoritative.
          capabilityClaimsSafe &&= declaration.kind === "skill" && Array.isArray(agent.skills) && agent.skills.includes(text(declaration.name));
        } else capabilityClaimsSafe = false;
      }
    }
    customAssembly = { required: true, installStatus: install.status, draftStatus: draft?.status,
      examStatus: exam?.status, examVerdict: resultIdsMatch && resultsBound ? exam?.verdict : null,
      examAssessmentKind: exam?.assessment_kind, candidateExpected: expected.length, candidateTotal: results.rows.length,
      candidatePassed: results.rows.filter((row) => row.passed && !row.red_line_hit).length,
      installBinding: install.draft_id && install.assembly_version !== null && install.assembly_hash
        ? { installId: install.id, draftId: install.draft_id, version: install.assembly_version, hash: install.assembly_hash } : null,
      examBinding: exam ? { installId: exam.target_install_id, draftId: exam.target_draft_id, version: exam.target_version, hash: exam.target_hash } : null };
  } else if (install) {
    const binding = (options.bindBundle ?? bindVerifiedActiveBundle)({ workspaceBundleId: workspace.bundle_id,
      activeInstalls: installs.rows.map((row) => ({ id: row.id, bundleId: row.bundle_id })) } satisfies WorkspaceBundleFacts);
    assemblyVerified = binding.state === "ready" && binding.installId === install.id;
  }
  const facts: RealModeFacts = {
    activationOwner: options.role === "owner", llmReal: llmVerified, workspaceIsExample: workspace.is_example,
    business, activeInstall: Boolean(install && validAssets && assemblyVerified && workspace.bundle_id === install.bundle_id),
    expectedAgents: agentIds?.length ?? 0, readyInstalledAgents: agents.rows.filter((row) => row.status === "ready").length,
    expectedFences: fenceIds?.length ?? 0, activeInstalledFences: fences.rows.filter((row) => row.status === "active").length,
    expectedSkills: skillIds?.length ?? 0, installedSkills: skills.rows.length,
    fenceResponsibilityReady, capabilityClaimsSafe, pendingCapabilities, customAssembly,
  };
  const activationGate = evaluateRealModeReadiness(facts);
  // A read-only member may observe an already activated workspace without gaining activation authority.
  const operationalGate = evaluateRealModeReadiness({ ...facts, activationOwner: true });
  const activationFingerprint = sha256Canonical({ schema: "workloom.native-real-mode/v1", scope, business,
    install: install ? { id: install.id, bundleId: install.bundle_id, assets: install.assets, version: install.assembly_version, hash: install.assembly_hash } : null,
    modelConfigEventId: llmVerified ? verification?.eventId : null });
  const activation = await client.query<{ after: Record<string, unknown> }>(
    `SELECT payload->'decision'->'after' AS after FROM biz_events
     WHERE tenant_id=$1 AND workspace_id=$2 AND payload->'decision'->>'action'='onboarding.real_mode_activated'
       AND payload->'who'->>'type'='human' ORDER BY seq DESC LIMIT 1`, [scope.tenantId, scope.workspaceId],
  );
  const formalActivationRecorded = object(activation.rows[0]?.after).activationFingerprint === activationFingerprint;
  const persistedDataMode = archive.dataMode === "real" ? "real" : "simulated";
  return { facts, activationGate, operationalGate, business, persistedDataMode,
    dataMode: persistedDataMode === "real" && formalActivationRecorded && operationalGate.canActivate ? "real" : "simulated",
    formalActivationRecorded, activationFingerprint, modelVerification: llmVerified ? verification : null, installId: install?.id ?? null };
}
