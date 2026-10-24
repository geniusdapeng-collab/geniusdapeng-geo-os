#!/usr/bin/env node
import { createPengManagerAgent } from '../src/agent.mjs';

const versions = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const agent = await createPengManagerAgent();
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const failure = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
let pending = Promise.resolve(), closing = false, buffer = '';
async function handle(request) {
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') { failure(request?.id ?? null, -32600, 'Invalid request.'); return; }
  if (request.id === undefined) return;
  const { id, method, params } = request;
  if (method === 'initialize') { reply(id, { protocolVersion: versions.has(params?.protocolVersion) ? params.protocolVersion : '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'pengmanager-system', version: '1.0.0' } }); return; }
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: agent.tools() }); return; }
  if (method !== 'tools/call') { failure(id, -32601, 'Method not found.'); return; }
  try {
    const capability = agent.toolId(params?.name);
    if (!capability) { reply(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'The tool is not registered.' } }) }] }); return; }
    reply(id, { isError: false, content: [{ type: 'text', text: JSON.stringify(await agent.invoke(capability, params?.arguments ?? {})) }] });
  } catch (error) { reply(id, { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: agent.error(error) }) }] }); }
}
function close() {
  if (closing) return;
  closing = true; process.stdin.pause();
  void pending.finally(() => agent.stop()).catch(() => { process.stderr.write('PengManager shutdown failed.\n'); process.exitCode = 1; });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (closing) return;
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 9 * 1024 * 1024) { failure(null, -32600, 'Input frame exceeds 9 MiB.'); process.exitCode = 2; close(); return; }
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let request;
    try { request = JSON.parse(line); } catch { failure(null, -32700, 'Parse error.'); continue; }
    pending = pending.then(() => handle(request)).catch(error => failure(request?.id ?? null, -32000, agent.error(error).message));
  }
});
process.stdin.on('end', () => { if (buffer.trim()) failure(null, -32700, 'Incomplete JSON-RPC frame.'); close(); });
process.once('SIGINT', close); process.once('SIGTERM', close);
process.stderr.write('PengManager MCP ready (stdio).\n');
