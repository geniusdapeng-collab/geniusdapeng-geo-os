#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeConfig, VideoRuntimeError } from '../src/video-runtime/config.mjs';
import { standardVideoExecutor, standardVideoIntent } from '../src/video-runtime/standard-workflow.mjs';

const usage = 'node scripts/video-standard.mjs plan|start --input-file <JSON or -> [--data-dir DIR]\nnode scripts/video-standard.mjs status --job <SHA256> [--data-dir DIR]';
function parse(args) {
  const [mode, ...rest] = args;
  if (!['plan', 'start', 'status'].includes(mode)) throw new VideoRuntimeError('USAGE', usage);
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [key, value] = rest.slice(i, i + 2);
    if (!['--input-file', '--data-dir', '--job'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(values, key)) throw new VideoRuntimeError('USAGE', usage);
    values[key] = value;
  }
  if (mode === 'status' ? !values['--job'] || values['--input-file'] : !values['--input-file'] || values['--job']) throw new VideoRuntimeError('USAGE', usage);
  return { mode, ...values };
}
async function inputFrom(file) {
  const source = file === '-' ? process.stdin : (await fs.open(file, 'r')).createReadStream();
  const chunks = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > 16_384) throw new VideoRuntimeError('STANDARD_VIDEO_INTENT_INVALID', '视频输入超过 16 KiB。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new VideoRuntimeError('STANDARD_VIDEO_INTENT_INVALID', '视频输入必须是 JSON。'); }
}
try {
  const options = parse(process.argv.slice(2));
  const value = options.mode === 'status' ? undefined : await inputFrom(options['--input-file']);
  let result;
  if (options.mode === 'plan') result = standardVideoIntent(value);
  else {
    const config = runtimeConfig({ rootDir: path.resolve(import.meta.dirname, '..'), dataDir: options['--data-dir'], serveWorkbench: false });
    const executor = standardVideoExecutor(config);
    result = options.mode === 'start' ? await executor.start(value) : await executor.status(options['--job']);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  const safe = error instanceof VideoRuntimeError ? { code: error.code, message: error.message } : { code: 'STANDARD_VIDEO_FAILED', message: '视频作业或私有回执不可读取。' };
  process.stderr.write(JSON.stringify({ error: safe }) + '\n');
  process.exitCode = 1;
}
