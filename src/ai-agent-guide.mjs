import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { modelEnvironmentArgs } from './ai-workbench-paths.mjs';

export const AGENT_GUIDE_ID = 'pengmanager.agent.guide';
export const MCP_INSTRUCTIONS = '先调用 pengmanager_agent_guide 并完整读取返回的文档，再执行任务。用户只需对话：有 shell 的 Codex/Qoder 由 Agent 执行同一 checkout 与私有目录的标准 CLI；MCP 提供指南、发现、计划和登记工具，不提供完整生产执行器。制作先用 pengmanager_video_workflow 保留原话与秒数，再用 pengmanager_video_preflight。计划不是成片；生产沿用 owner 授权、预算与原任务回执，结果未知时先对账，不重派。运行标准 CLI 前，先核查没有活跃本地作业，再用 pengmanager_video_stop 停止本 MCP 拥有的工位并读回状态；活跃作业先沿原任务查询，不抢锁或停止其他进程。';

export const agentGuideDescriptor = {
  id: AGENT_GUIDE_ID, title: '读取鹏经理 AI Agent 完整接入指南',
  description: '首次接入、更新源码或开始任务时先调用。返回本 checkout 的完整指南、SHA-256、绝对 CLI 入口和 CLI/MCP 支持边界；只读，不读取密钥或私有授权，不启动服务。',
  operation: 'read', risk: 'low', dataMode: 'unverified',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const documents = ['AGENTS.md', 'docs/AI-AGENT-GUIDE.md', 'docs/AI-WORKBENCH-SETUP.md', 'docs/CODEX-VIDEO-QUICKSTART.md', '.agents/skills/pengmanager-standard-video/SKILL.md'];

/** Read only the fixed, current checkout instructions, never a caller path. */
export function readAiAgentGuide({ rootDir, dataDir, nodePath = process.execPath, execArgv = process.execArgv,
  runtimeEnvironment = { PENGMANAGER_VIDEO_DATA_DIR: dataDir } }) {
  const root = fs.realpathSync(rootDir);
  const nodeArgs = modelEnvironmentArgs(root, execArgv);
  const docs = documents.map(relativePath => {
    const file = path.join(root, relativePath);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024 || fs.realpathSync(file) !== file) throw new Error('Invalid guide.');
      const bytes = fs.readFileSync(file);
      if (bytes.length > 1024 * 1024) throw new Error('Oversized guide.');
      const markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { path: relativePath, absolutePath: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, markdown };
    } catch {
      const error = new Error('A required checkout guide is missing, redirected, invalid or unreadable: ' + relativePath);
      error.code = 'AGENT_GUIDE_UNAVAILABLE';
      throw error;
    }
  });
  return {
    schemaVersion: 'pengmanager.ai-agent-guide/v1', productId: 'pengmanager-system',
    rootDir: root, dataDir, documents: docs,
    support: { shellRequiredForProduction: true, pureMcpProductionSupported: false,
      mcp: ['guide', 'catalog', 'registered-capabilities', 'workflow-plan', 'preflight'],
      standardCli: ['plan', 'start', 'status', 'resume', 'deliver'] },
    cli: {
      agent: { command: nodePath, argsPrefix: [...nodeArgs, path.join(root, 'scripts/agent.mjs')], env: runtimeEnvironment, dataArgs: ['--data-dir', dataDir] },
      standardVideo: { command: nodePath, argsPrefix: [...nodeArgs, path.join(root, 'scripts/video-standard.mjs')], env: runtimeEnvironment, dataArgs: ['--data-dir', dataDir],
        inputModes: ['plan', 'start', 'resume', 'deliver'], inputArgs: ['--input-file', '-'], statusJobOption: '--job' },
      config: { command: nodePath, env: runtimeEnvironment,
        args: nodeArgs.length > 1 ? null : [path.join(root, 'scripts/ai-workbench.mjs'), 'config', '--data-dir', dataDir,
          ...(nodeArgs.length ? ['--model-env-file', nodeArgs[0].slice('--env-file='.length)] : [])],
        ...(nodeArgs.length > 1 ? { code: 'MULTIPLE_MODEL_ENV_FILES_REQUIRE_EXPLICIT_CONFIG' } : {}) },
    },
    modelEnvironment: { source: nodeArgs.length ? 'explicit-node-env-file-paths' : 'current-process-only',
      nodeArgs, inheritedByHostShell: false,
      requirement: 'Execute the returned Node arguments in order. Without an explicit env-file, provide the current authorized model configuration in the owner CLI process; MCP environment variables do not propagate back to the host shell.' },
    lifecycle: 'Before owner CLI execution, verify no local work is active, stop only this MCP session\'s managed runtime with pengmanager_video_stop and read back its stopped status. Read an active job through its original run first. One supervisor owns a private directory. Never stop another process or remove its lock.',
    authorization: 'Guide availability is not authorization. Preserve existing owner policy, native permissions, budgets, rights, approvals and original receipts. Never fabricate approval evidence or extend the user\'s actual authorization.',
    providerCallsPerformed: false, productionVerified: false,
  };
}
