export const CREATIVE_BUDGET_ENV_KEYS = [
  "VM_CREATIVE_BUDGET_CNY",
  "VM_CREATIVE_MAX_CALLS",
  "VM_CREATIVE_MAX_TOKENS",
  "VM_CREATIVE_MAX_WALL_MS",
  "VM_CREATIVE_MODEL_PRICES",
] as const;

export interface CreativeBudgetConfig {
  maxMicros: number;
  maxCalls: number;
  maxTokens: number;
  maxWallMs: number;
  price: { inputCnyPerMillion: number; outputCnyPerMillion: number };
}

export interface CreativeConfigurationPreflight {
  ready: boolean;
  model: string;
  missing: string[];
  invalid: string[];
  budget?: CreativeBudgetConfig;
}

export function creativeConfigurationPreflight(
  env: NodeJS.ProcessEnv,
  model: string,
): CreativeConfigurationPreflight {
  const missing = CREATIVE_BUDGET_ENV_KEYS.filter(key => !env[key]?.trim());
  const invalid: string[] = [];
  const maxMicros = Math.floor(Number(env.VM_CREATIVE_BUDGET_CNY) * 1_000_000);
  const maxCalls = Number(env.VM_CREATIVE_MAX_CALLS);
  const maxTokens = Number(env.VM_CREATIVE_MAX_TOKENS);
  const maxWallMs = Number(env.VM_CREATIVE_MAX_WALL_MS);
  if (env.VM_CREATIVE_BUDGET_CNY?.trim() && (!Number.isSafeInteger(maxMicros) || maxMicros <= 0)) invalid.push("VM_CREATIVE_BUDGET_CNY");
  if (env.VM_CREATIVE_MAX_CALLS?.trim() && (!Number.isSafeInteger(maxCalls) || maxCalls <= 0)) invalid.push("VM_CREATIVE_MAX_CALLS");
  if (env.VM_CREATIVE_MAX_TOKENS?.trim() && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) invalid.push("VM_CREATIVE_MAX_TOKENS");
  if (env.VM_CREATIVE_MAX_WALL_MS?.trim()
    && (!Number.isSafeInteger(maxWallMs) || maxWallMs <= 0 || maxWallMs > 2_147_483_647)) invalid.push("VM_CREATIVE_MAX_WALL_MS");
  let price: CreativeBudgetConfig["price"] | undefined;
  if (env.VM_CREATIVE_MODEL_PRICES?.trim()) {
    try {
      const parsed = JSON.parse(env.VM_CREATIVE_MODEL_PRICES) as Record<string, unknown>;
      const entry = parsed && Object.hasOwn(parsed, model) ? parsed[model] : undefined;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid.push("VM_CREATIVE_MODEL_PRICES");
      else {
        const candidate = entry as Record<string, unknown>;
        if (typeof candidate.inputCnyPerMillion === "number" && Number.isFinite(candidate.inputCnyPerMillion) && candidate.inputCnyPerMillion > 0
          && typeof candidate.outputCnyPerMillion === "number" && Number.isFinite(candidate.outputCnyPerMillion) && candidate.outputCnyPerMillion > 0) {
          price = {
            inputCnyPerMillion: candidate.inputCnyPerMillion,
            outputCnyPerMillion: candidate.outputCnyPerMillion,
          };
        } else invalid.push("VM_CREATIVE_MODEL_PRICES");
      }
    } catch {
      invalid.push("VM_CREATIVE_MODEL_PRICES");
    }
  }
  const ready = missing.length === 0 && invalid.length === 0 && price !== undefined;
  return {
    ready,
    model,
    missing,
    invalid: [...new Set(invalid)],
    ...(ready ? { budget: { maxMicros, maxCalls, maxTokens, maxWallMs, price: price! } } : {}),
  };
}

export function assertCreativeConfigurationReady(
  env: NodeJS.ProcessEnv,
  model: string,
): CreativeBudgetConfig {
  const result = creativeConfigurationPreflight(env, model);
  if (!result.ready || !result.budget) {
    const detail = [
      result.missing.length ? `missing=${result.missing.join(",")}` : "",
      result.invalid.length ? `invalid=${result.invalid.join(",")}` : "",
    ].filter(Boolean).join(";");
    throw new Error(`CREATIVE_BUDGET_UNCONFIGURED: ${detail || "creative budget preflight failed"}`);
  }
  return result.budget;
}
