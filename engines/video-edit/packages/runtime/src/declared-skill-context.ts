import type pg from "pg";
import { createHash } from "node:crypto";

export interface VerifiedDeclaredSkill {
  id: string;
  name: string;
  version: string;
  body: string;
  bodySha256: string;
}

/** Called inside the assembly transaction after its tenant/workspace RLS scope is set. */
export async function loadDeclaredSkillContext(
  client: Pick<pg.PoolClient, "query">,
  workspaceId: string,
  declared: unknown,
): Promise<VerifiedDeclaredSkill[]> {
  if (!Array.isArray(declared) || declared.some((name) => typeof name !== "string" || !name.trim())) {
    throw new Error("DECLARED_SKILLS_INVALID");
  }
  const names = [...new Set(declared as string[])];
  if (!names.length) return [];
  const result = await client.query<{ id: string; name: string; version: string; installed_version: string; body: string }>(
    `SELECT s.id,s.name,s.version,s.body,i.installed_version
       FROM skill_installs i JOIN skills s ON s.id=i.skill_id
      WHERE i.workspace_id=$1 AND s.name=ANY($2) ORDER BY s.name,s.id`,
    [workspaceId, names],
  );
  return names.map((name) => {
    const matches = result.rows.filter((row) => row.name === name);
    if (matches.length !== 1) throw new Error(`DECLARED_SKILL_INSTALL_AMBIGUOUS_OR_MISSING:${name}`);
    const skill = matches[0]!;
    if (!skill.version || skill.installed_version !== skill.version || !skill.body?.trim()) {
      throw new Error(`DECLARED_SKILL_INSTALL_STALE_OR_EMPTY:${name}`);
    }
    return { id: skill.id, name, version: skill.version, body: skill.body,
      bodySha256: createHash("sha256").update(skill.body).digest("hex") };
  });
}

export function declaredSkillPlanningContext(preset: { prompt: unknown; verifiedSkills?: VerifiedDeclaredSkill[]; essentials?: { archive: Record<string, unknown>; stage: string } }): string {
  if (!preset.verifiedSkills) return "";
  return `当前岗位的职责、目标和限制（不得扩大已装配工具白名单或绕过围栏、审批与回执）：\n${JSON.stringify(preset.prompt)}\n`
    + `本次工作区真实档案和阶段：${JSON.stringify(preset.essentials ?? null)}。经营主体以此档案为准；岗位/技能中的示例企业名称只是方法背景，不得当作本工作区经营主体或已发生的业务事实。\n`
    + `当前岗位声明且在本工作区按当前版本实际安装的技能正文（执行步骤、输出合同和失败路径须纳入本次计划；缺数据先取证，外发/费用承诺按原审批处理）：\n${JSON.stringify(preset.verifiedSkills)}\n`;
}
