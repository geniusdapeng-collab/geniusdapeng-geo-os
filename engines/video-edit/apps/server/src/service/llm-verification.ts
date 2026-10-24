/** A successful native probe is bound to this process, current configuration and committed audit event. */
import type { LlmEnvironmentConfig, LlmEnvironmentPersistence } from "./llm-environment.js";

interface Scope { tenantId: string; workspaceId: string }
export interface LlmVerificationReceipt {
  eventId: string;
  verifiedAt: string;
  provider: string;
  baseUrl: string;
  model: string;
  persistence: LlmEnvironmentPersistence;
}
const verified = new Map<string, { config: LlmEnvironmentConfig; receipt: LlmVerificationReceipt }>();
const key = (scope: Scope) => `${scope.tenantId}\0${scope.workspaceId}`;

export function clearLlmVerification(scope: Scope): void { verified.delete(key(scope)); }

/** Caller invokes this only after the real probe and its audit transaction both succeed. */
export function recordLlmVerification(scope: Scope, config: LlmEnvironmentConfig,
  receipt: Pick<LlmVerificationReceipt, "eventId" | "persistence">): void {
  if (config.provider === "mock" || !config.baseUrl || !config.model || !/^E-\d+$/.test(receipt.eventId)) {
    throw new Error("模型试调凭据没有绑定有效的真实配置与已提交事件");
  }
  verified.set(key(scope), { config: { ...config }, receipt: { eventId: receipt.eventId, persistence: receipt.persistence,
    provider: config.provider, baseUrl: config.baseUrl, model: config.model, verifiedAt: new Date().toISOString() } });
}

/** Keys stay exclusively in process memory; neither keys nor their digests are persisted as proof. */
export function currentLlmVerification(scope: Scope, env: NodeJS.ProcessEnv = process.env): LlmVerificationReceipt | null {
  const entry = verified.get(key(scope));
  if (!entry || entry.config.provider !== env.LLM_PROVIDER || entry.config.baseUrl !== (env.LLM_BASE_URL ?? "")
    || entry.config.apiKey !== (env.LLM_API_KEY ?? "") || entry.config.model !== (env.LLM_MODEL ?? "")) return null;
  return { ...entry.receipt };
}
