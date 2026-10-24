import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { llmEnvironmentPersistence, persistLlmEnvironment } from "./llm-environment.js";
import { llmCall, resetLlmAssembly } from "./llm.js";

const roots: string[] = [];
const servers: Server[] = [];
const original = { ...process.env };
const fixture = { provider: "fixture-provider", baseUrl: "http://127.0.0.1:1/v1", apiKey: "fixture-key-only", model: "fixture-model" };
function temp(): string { const root = mkdtempSync(join(tmpdir(), "pengmanager-model-config-")); roots.push(root); return root; }
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
  Object.assign(process.env, original);
  resetLlmAssembly();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("explicit process-only model configuration", () => {
  it("updates all live fields while leaving an existing environment file byte-identical", () => {
    const cwd = temp(), file = join(cwd, ".env"), before = "LLM_API_KEY=unchanged-fixture\nUNRELATED=keep\n";
    writeFileSync(file, before);
    const env: NodeJS.ProcessEnv = { WORKLOOM_ENV_PERSIST_MODE: "process-only" };
    expect(persistLlmEnvironment(fixture, { cwd, env })).toBe("process-only");
    expect(env).toMatchObject({ LLM_PROVIDER: fixture.provider, LLM_BASE_URL: fixture.baseUrl, LLM_API_KEY: fixture.apiKey, LLM_MODEL: fixture.model });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("does not read, create or locate .env even if that path is an unreadable file type", () => {
    const cwd = temp(); mkdirSync(join(cwd, ".env"));
    expect(() => persistLlmEnvironment(fixture, { cwd, env: { WORKLOOM_ENV_PERSIST_MODE: "process-only" } })).not.toThrow();
    const absent = join(temp(), "does-not-exist");
    expect(() => persistLlmEnvironment(fixture, { cwd: absent, env: { WORKLOOM_ENV_PERSIST_MODE: "process-only" } })).not.toThrow();
    expect(existsSync(absent)).toBe(false);
  });

  it("a fresh process needs configuration supplied again and has no persisted key to reload", () => {
    const cwd = temp(), environment: NodeJS.ProcessEnv = { WORKLOOM_ENV_PERSIST_MODE: "process-only" };
    persistLlmEnvironment(fixture, { cwd, env: environment });
    expect(existsSync(join(cwd, ".env"))).toBe(false);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({configured:!!process.env.LLM_API_KEY,model:process.env.LLM_MODEL??null}))"],
      { cwd, env: { PATH: original.PATH, WORKLOOM_ENV_PERSIST_MODE: "process-only" }, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ configured: false, model: null });
  });

  it("native default still finds the workspace root, persists all four fields and keeps unrelated lines", () => {
    const root = temp(), cwd = join(root, "apps/server"); mkdirSync(cwd, { recursive: true });
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(root, ".env"), "UNRELATED=keep\nLLM_MODEL=old\n");
    const env: NodeJS.ProcessEnv = {};
    expect(persistLlmEnvironment(fixture, { cwd, env })).toBe("file");
    const lines = readFileSync(join(root, ".env"), "utf8");
    expect(lines).toContain("UNRELATED=keep"); expect(lines).toContain("LLM_MODEL=fixture-model");
    for (const [key, value] of Object.entries(env)) expect(lines).toContain(`${key}=${value}`);
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });

  it("a new native environment file is private and only exact explicit mode disables persistence", () => {
    const cwd = temp();
    expect(llmEnvironmentPersistence({ WORKLOOM_ENV_PERSIST_MODE: "process-only" })).toBe("process-only");
    expect(llmEnvironmentPersistence({})).toBe("file");
    expect(persistLlmEnvironment(fixture, { cwd, env: {} })).toBe("file");
    expect(statSync(join(cwd, ".env")).mode & 0o077).toBe(0);
  });

  it("a native persistence failure is visible and leaves live configuration unchanged", () => {
    const cwd = temp(); mkdirSync(join(cwd, ".env"));
    const env: NodeJS.ProcessEnv = { LLM_PROVIDER: "mock", LLM_API_KEY: "old-fixture" };
    expect(() => persistLlmEnvironment(fixture, { cwd, env })).toThrow();
    expect(env).toEqual({ LLM_PROVIDER: "mock", LLM_API_KEY: "old-fixture" });
  });

  it("clearing model assembly replaces a cached compatibility provider and a cached mock result", async () => {
    const endpoint = async (reply: string): Promise<string> => {
      const server = createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(request.url?.endsWith("/models") ? JSON.stringify({ data: [] })
          : JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fixture endpoint unavailable");
      return `http://127.0.0.1:${address.port}/v1`;
    };
    const cwd = temp(); process.env.WORKLOOM_ENV_PERSIST_MODE = "process-only";
    persistLlmEnvironment({ ...fixture, provider: "mock" }, { cwd }); resetLlmAssembly();
    expect(llmCall()).toBeUndefined();
    persistLlmEnvironment({ ...fixture, baseUrl: await endpoint("first-local-fixture") }, { cwd }); resetLlmAssembly();
    expect(await llmCall()!("local fixture only")).toBe("first-local-fixture");
    persistLlmEnvironment({ ...fixture, baseUrl: await endpoint("second-local-fixture") }, { cwd }); resetLlmAssembly();
    expect(await llmCall()!("local fixture only")).toBe("second-local-fixture");
    expect(existsSync(join(cwd, ".env"))).toBe(false);
  });
});
