import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVideoRuntime } from './video-runtime/index.mjs';
import { privateDirectory, redactor, runtimeConfig } from './video-runtime/config.mjs';
import { publicVideoCapabilities, publicVideoStatus } from './http/video-runtime.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export class AgentError extends Error {
  constructor(code, message) { super(message); this.name = 'AgentError'; this.code = code; }
}
const emptyInput = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new AgentError('INVALID_INPUT', 'This operation accepts an empty object.');
};

/** PengManager reuses the reviewed native CLI/MCP catalog and its server guards. */
export async function createPengManagerAgent({ rootDir = ROOT, dataDir, env = process.env, runtimeFactory = createVideoRuntime, fetchImplementation = fetch } = {}) {
  const config = runtimeConfig({ rootDir, dataDir, env, serveWorkbench: false });
  const runtime = runtimeFactory({ rootDir: config.rootDir, dataDir: config.dataRoot, env: config.env, serveWorkbench: false, logger: () => undefined });
  const native = await import(pathToFileURL(path.join(config.engineRoot, 'scripts/agent-capabilities.mjs')).href);
  const catalog = await native.loadCatalog(config.engineRoot);
  const safe = redactor(config);
  let owned = false, localQueue = Promise.resolve();
  const specials = [
    { id: 'pengmanager.video.status', title: '读取鹏经理视频运行状态', description: '读取本实例的服务、数据库与版本状态，不启动服务或调用供应商。' },
    { id: 'pengmanager.video.capabilities', title: '读取完整视频员工、技能与工具目录', description: '读取完整内置能力与当前依赖状态；目录登记不代表已完成付费生成或媒体验收。' },
  ].map(item => ({ ...item, operation: 'read', risk: 'low', dataMode: 'unverified', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));
  const entries = new Map([...catalog.entries, ...specials.map(item => [item.id, item])]);
  async function localCall(id, input) {
    const pending = localQueue.then(async () => {
      privateDirectory(config.dataRoot);
      const keysFile = path.join(config.dataRoot, 'process-model-keys-only.env');
      if (!fs.existsSync(keysFile)) fs.writeFileSync(keysFile, '# Model credentials are supplied only through the current process environment.\n', { flag: 'wx', mode: 0o600 });
      const stat = fs.lstatSync(keysFile);
      if (!stat.isFile() || stat.isSymbolicLink() || process.platform !== 'win32' && (stat.mode & 0o077)) throw new AgentError('PRIVATE_STATE_PERMISSIONS', 'The local capability key-presence file must be an ordinary owner-only file.');
      const names = ['WORKLOOM_VIDEO_ARTIFACT_ROOT', 'WORKLOOM_KEYS_FILE'];
      const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
      process.env.WORKLOOM_VIDEO_ARTIFACT_ROOT = config.dataRoot;
      process.env.WORKLOOM_KEYS_FILE = keysFile;
      try { return await native.invokeCapability(catalog, id, input); }
      finally { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    });
    localQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }
  return {
    list() { return { schemaVersion: 'pengmanager.agent-capabilities/v1', productId: 'pengmanager-system', embeddedProductId: catalog.product.productId, bundleId: catalog.bundle, capabilities: [...entries.values()] }; },
    describe(id) { const descriptor = entries.get(id); if (!descriptor) throw new AgentError('NOT_FOUND', 'The capability is not registered.'); return descriptor; },
    tools() {
      return [...native.mcpTools(catalog).map(tool => ({ ...tool, name: tool.name.replace(/^workloom_/, 'pengmanager_') })), ...specials.map(item => ({
        name: item.id.replaceAll('.', '_'), title: item.title, description: item.description,
        inputSchema: item.inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }))];
    },
    toolId(name) { return [...entries.values()].find(item => (item.id.startsWith('pengmanager.') ? item.id.replaceAll('.', '_') : 'pengmanager_' + item.id.replace(/[^A-Za-z0-9]/g, '_')) === name)?.id; },
    async invoke(id, input = {}) {
      const descriptor = entries.get(id);
      if (!descriptor) throw new AgentError('NOT_FOUND', 'The capability is not registered.');
      if (id === 'pengmanager.video.status') { emptyInput(input); return publicVideoStatus(await runtime.status()); }
      if (id === 'pengmanager.video.capabilities') { emptyInput(input); return publicVideoCapabilities(await runtime.capabilities()); }
      // Validate and reject disabled capabilities before starting any process.
      native.validateInput(descriptor, input);
      if (descriptor.enabled === false) throw new AgentError('DISABLED', descriptor.disabledReason);
      if (descriptor.transport.kind === 'local') return localCall(id, input);
      let token = config.env.WORKLOOM_ACCESS_TOKEN;
      if (descriptor.transport.kind === 'trpc' && !token) {
        owned = true;
        await runtime.start();
        const session = await runtime.nativeSession();
        token = session.token; safe.addSecrets([token]);
      }
      return native.invokeCapability(catalog, id, input, {
        baseUrl: 'http://127.0.0.1:' + config.ports.backend,
        env: { WORKLOOM_ACCESS_TOKEN: token, WORKLOOM_C_TOKEN: config.env.WORKLOOM_C_TOKEN, WORKLOOM_DEV_AUTO_LOGIN: '0' },
        fetcher: fetchImplementation,
      });
    },
    error(error) { return { code: typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'AGENT_FAILED', message: safe(error) }; },
    async stop() { await localQueue; if (owned) { owned = false; await runtime.stop(); } },
  };
}
