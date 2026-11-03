#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { runtimeConfig, VideoRuntimeError } from '../src/video-runtime/config.mjs';
import { runOwnerVideoMake } from '../src/video-runtime/owner-video-runner.mjs';
import { legacyStandardVideoJobId, standardVideoExecutor, standardVideoIntent } from '../src/video-runtime/standard-workflow.mjs';
import { identifyVideoMake } from '../src/video-runtime/video-make.mjs';

const usage = 'node scripts/video-standard.mjs plan|start|resume|deliver --input-file <JSON or -> [--data-dir DIR]\nnode scripts/video-standard.mjs status --job <SHA256> [--data-dir DIR]';
function parse(args) {
  const [mode, ...rest] = args;
  if (!['plan', 'start', 'resume', 'deliver', 'status'].includes(mode)) throw new VideoRuntimeError('USAGE', usage);
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
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new VideoRuntimeError('STANDARD_VIDEO_INTENT_INVALID', '视频输入必须是 JSON。'); }
}

async function execute(mode, plan, id, config) {
  const legacy = standardVideoExecutor(config);
  const earlier = legacy.lookup(id ?? legacyStandardVideoJobId(plan));
  if (earlier) {
    if (mode === 'status') return legacy.status(id);
    if (mode === 'start') return earlier;
    return { ...earlier, previousState: earlier.state, state: 'blocked', code: 'STANDARD_VIDEO_LEGACY_PROJECT_READBACK_REQUIRED',
      next: 'status', complete: false };
  }

  const request = plan && { system: 'pengmanager', intent: plan.input.intent, durationSeconds: plan.requestedDurationSec };
  const jobId = id ?? identifyVideoMake(request).id;
  const base = { schemaVersion: 'pengmanager.standard-video-production/v1', jobId };
  try {
    const result = await runOwnerVideoMake({ action: mode, id, request, rootDir: config.rootDir, dataDir: config.dataRoot });
    return { ...result, ...base, complete: result.state === 'delivered' };
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(error.code) ? error.code : 'NATIVE_VIDEO_MAKE_FAILED';
    return { ...base, state: 'blocked', code, complete: false };
  }
}

try {
  const options = parse(process.argv.slice(2));
  const value = options.mode === 'status' ? undefined : await inputFrom(options['--input-file']);
  const plan = value === undefined && options.mode === 'status' ? null : standardVideoIntent(value);
  let result;
  if (options.mode === 'plan') result = plan;
  else {
    const config = runtimeConfig({ rootDir: path.resolve(import.meta.dirname, '..'), dataDir: options['--data-dir'], serveWorkbench: false });
    if (config.env.WORKLOOM_ACCESS_TOKEN?.length >= 8 && plan?.input.intent.includes(config.env.WORKLOOM_ACCESS_TOKEN)) {
      throw new VideoRuntimeError('STANDARD_VIDEO_CREDENTIAL_IN_INPUT', '原话不得包含会话令牌。');
    }
    result = await execute(options.mode, plan, options['--job'], config);
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.state === 'blocked') process.exitCode = 2;
} catch (error) {
  const safe = error instanceof VideoRuntimeError ? { code: error.code, message: error.message } : { code: 'STANDARD_VIDEO_FAILED', message: '视频作业或私有回执不可读取。' };
  process.stderr.write(JSON.stringify({ error: safe }) + '\n');
  process.exitCode = 1;
}
