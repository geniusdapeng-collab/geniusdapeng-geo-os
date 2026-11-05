#!/usr/bin/env node
import path from 'node:path';
import { buildAiWorkbenchConfig } from '../src/ai-workbench-config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const USAGE = 'node scripts/ai-workbench.mjs config [--client all|codex|qoder|generic] [--data-dir ABSOLUTE_PRIVATE_DIR] [--model-env-file ABSOLUTE_PRIVATE_ENV_FILE]';
function usage() { const error = new Error(USAGE); error.code = 'USAGE'; throw error; }
export function parseAiWorkbenchArgs(args) {
  const [command, ...rest] = args;
  if (command !== 'config') usage();
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index], value = rest[index + 1];
    if (!['--client', '--data-dir', '--model-env-file'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) usage();
    options[key] = value;
  }
  const client = options['--client'] ?? 'all';
  if (!['all', 'codex', 'qoder', 'generic'].includes(client)) usage();
  return { client, dataDir: options['--data-dir'], modelEnvFile: options['--model-env-file'] };
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { process.stdout.write(USAGE + '\n'); return; }
  try {
    const { client, ...options } = parseAiWorkbenchArgs(args);
    const config = buildAiWorkbenchConfig({ rootDir: ROOT, ...options });
    const output = client === 'codex' ? config.codexToml : JSON.stringify(client === 'qoder' ? config.qoderConfig : client === 'generic' ? config.genericConfig : config, null, 2);
    process.stdout.write(output + (output.endsWith('\n') ? '' : '\n'));
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'AI_WORKBENCH_CONFIG_FAILED';
    const message = code === 'AI_WORKBENCH_CONFIG_FAILED' ? 'AI workbench configuration could not be generated.' : error.message;
    process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n');
    process.exitCode = 1;
  }
}
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) main();
