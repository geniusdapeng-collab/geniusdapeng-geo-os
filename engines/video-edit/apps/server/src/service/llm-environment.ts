/**
 * Native model configuration has an explicit embedded mode. The host injects
 * process-only when credentials must last for this server process only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LlmEnvironmentConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export type LlmEnvironmentPersistence = "file" | "process-only";

export function llmEnvironmentPersistence(env: NodeJS.ProcessEnv = process.env): LlmEnvironmentPersistence {
  return env.WORKLOOM_ENV_PERSIST_MODE === "process-only" ? "process-only" : "file";
}

function locateEnvFile(cwd: string): string {
  let directory = cwd;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return join(directory, ".env");
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return join(cwd, ".env");
}

/** No paths, keys or configuration values are returned to a client or logger. */
export function persistLlmEnvironment(
  config: LlmEnvironmentConfig,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): LlmEnvironmentPersistence {
  const env = options.env ?? process.env;
  const mode = llmEnvironmentPersistence(env);
  const entries = [
    ["LLM_PROVIDER", config.provider], ["LLM_BASE_URL", config.baseUrl],
    ["LLM_API_KEY", config.apiKey], ["LLM_MODEL", config.model],
  ] as const;
  if (mode === "file") {
    const file = locateEnvFile(options.cwd ?? process.cwd());
    const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
    for (const [key, value] of entries) {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`));
      if (index >= 0) lines[index] = `${key}=${value}`;
      else lines.push(`${key}=${value}`);
    }
    // A failed native persistence must not partially switch the live process.
    writeFileSync(file, lines.filter((line, index) => line !== "" || index < lines.length - 1).join("\n"), { mode: 0o600 });
  }
  for (const [key, value] of entries) env[key] = value;
  return mode;
}
