#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { AgentError, createPengManagerAgent } from '../src/agent.mjs';

export function parseAgentArgs(args) {
  const [command, ...rest] = args;
  if (!['list', 'describe', 'invoke', 'status', 'capabilities'].includes(command)) throw new AgentError('USAGE', 'Usage: node scripts/agent.mjs list|status|capabilities|describe <id>|invoke <id> [--input-file <JSON file or ->] [--data-dir <private directory>]');
  const values = {}, id = ['describe', 'invoke'].includes(command) ? rest.shift() : undefined;
  if (['describe', 'invoke'].includes(command) && (!id || id.startsWith('--'))) throw new AgentError('USAGE', 'A registered capability ID is required.');
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index], value = rest[index + 1];
    if (!['--input-file', '--data-dir'].includes(name) || !value || value.startsWith('--') || values[name]) throw new AgentError('USAGE', 'Invalid or repeated argument.');
    values[name] = value;
  }
  if (values['--input-file'] && command !== 'invoke') throw new AgentError('USAGE', '--input-file is only valid with invoke.');
  return { command, id, dataDir: values['--data-dir'] ? path.resolve(values['--data-dir']) : undefined, inputFile: values['--input-file'] };
}
async function inputFrom(file) {
  if (!file) return {};
  let bytes;
  if (file === '-') {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new AgentError('INPUT_TOO_LARGE', 'Input exceeds 8 MiB.'); chunks.push(chunk); }
    bytes = Buffer.concat(chunks);
  } else {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new AgentError('INPUT_TOO_LARGE', 'Input must be a JSON file no larger than 8 MiB.');
    bytes = await fs.readFile(file);
    if (bytes.length > 8 * 1024 * 1024) throw new AgentError('INPUT_TOO_LARGE', 'Input exceeds 8 MiB.');
  }
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new AgentError('INVALID_INPUT', 'Input is not valid JSON.'); }
}
export async function main(args = process.argv.slice(2)) {
  const parsed = parseAgentArgs(args), agent = await createPengManagerAgent({ dataDir: parsed.dataDir });
  const stop = () => { void agent.stop().catch(error => { process.stderr.write(JSON.stringify({ error: agent.error(error) }) + '\n'); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const output = parsed.command === 'list' ? agent.list() : parsed.command === 'describe' ? agent.describe(parsed.id)
      : await agent.invoke(parsed.command === 'status' ? 'pengmanager.video.status' : parsed.command === 'capabilities' ? 'pengmanager.video.capabilities' : parsed.id, await inputFrom(parsed.inputFile));
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ error: agent.error(error) }) + '\n'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await agent.stop(); }
}
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) main().catch(() => { process.stderr.write('{"error":{"code":"AGENT_FAILED","message":"Agent initialization or shutdown failed."}}\n'); process.exitCode = 1; });
