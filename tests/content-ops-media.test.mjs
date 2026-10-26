import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMediaProcessor } from '../src/content-ops-worker/media.mjs';
import { bytesHash } from '../src/content-ops-worker/protocol.mjs';
import { MP4 } from './fixtures/synthetic-media.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm-source-video-test-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const media = createMediaProcessor({ workRoot: root, maxRenderMs: 30_000, maxTempBytes: 20 * 1024 * 1024,
    async runNativeCall(spec, run) {
      assert.equal(spec.upperBound.nativeProcesses, 1); assert.equal(spec.upperBound.inputTokens, 0);
      calls.push(spec); return await run();
    }, ...options });
  return { root, media, calls };
}

test('fixed native video readiness requires exact local runtime and a per-process dispatch hook', t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm-video-readiness-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(createMediaProcessor({ workRoot: root }).readiness().ready, false);
  const media = createMediaProcessor({ workRoot: root, ffmpegPath: '/missing/native', runNativeCall: async (_, run) => run() });
  assert.equal(media.readiness().ready, false);
});

test('real MP4 inspection decodes the actual supplied bytes and budgets the exact native process', async t => {
  const { media, calls, root } = fixture(t); if (!media.readiness().ready) { t.skip('The fixed darwin-arm64 runtime pins are unavailable on this host.'); return; }
  const before = bytesHash(MP4), result = await media.inspect({ bytes: MP4, sha256: before });
  assert.equal(result.metadata.width, 16); assert.equal(result.metadata.height, 16); assert.equal(result.metadata.frames, 3);
  assert.equal(result.metadata.fullyDecoded, true); assert.equal(result.metadata.hasAudio, false);
  assert.equal(calls.length, 1); assert.equal(calls[0].callKey, 'media.probe.source');
  assert.equal(bytesHash(MP4), before); assert.deepEqual(fs.readdirSync(root), []);
});

test('real source cut/assembly preserves original audio, verifies full output decode and never overwrites sources', async t => {
  const { media, calls, root } = fixture(t); if (!media.readiness().ready) { t.skip('The fixed darwin-arm64 runtime pins are unavailable on this host.'); return; }
  const source = path.join(root, 'fixture-source.mp4');
  const generated = spawnSync(path.join(os.homedir(), '.local/bin/ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:d=0.4:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source],
  { encoding: 'utf8', timeout: 20_000, maxBuffer: 100_000 });
  assert.equal(generated.status, 0, generated.stderr);
  const bytes = fs.readFileSync(source), sha = bytesHash(bytes);
  const result = await media.renderVideo({ segments: [{ bytes, sha256: sha, startMs: 0, endMs: 300 }], width: 160, height: 120, fps: 30, audioPolicy: 'preserve_original' });
  assert.equal(result.mime, 'video/mp4'); assert.equal(result.metadata.hasAudio, true); assert.equal(result.metadata.originalAudioPresent, true);
  assert.equal(result.metadata.fullyDecoded, true); assert.equal(result.metadata.width, 160); assert.equal(result.metadata.height, 120);
  assert.equal(result.metadata.artisticQuality, 'unverified'); assert.ok(Math.abs(result.metadata.durationMs - 300) <= 150);
  assert.deepEqual(calls.map(call => call.callKey), ['media.probe.source.0', 'media.render.video', 'media.probe.output', 'media.decode.output']);
  assert.equal(bytesHash(fs.readFileSync(source)), sha); assert.deepEqual(fs.readdirSync(root), ['fixture-source.mp4']);
  const assembled = await media.renderVideo({ segments: [{ bytes, sha256: sha, startMs: 0, endMs: 100 }, { bytes, sha256: sha, startMs: 200, endMs: 400 }],
    width: 160, height: 120, fps: 30, audioPolicy: 'preserve_original' });
  assert.equal(assembled.metadata.sourceSegments.length, 2); assert.equal(assembled.metadata.hasAudio, true);
});

test('native video denies injected options, false source hashes, source-less output and voice replacement', async t => {
  const { media, calls } = fixture(t);
  await assert.rejects(media.renderVideo({ segments: [], width: 160, height: 120, audioPolicy: 'preserve_original' }), { code: 'LOCAL_SOURCE_MISSING' });
  await assert.rejects(media.renderVideo({ segments: [{ bytes: MP4, sha256: '0'.repeat(64), endMs: 100 }], width: 160, height: 120,
    audioPolicy: 'preserve_original' }), { code: 'ARTIFACT_HASH_MISMATCH' });
  await assert.rejects(media.renderVideo({ segments: [{ bytes: MP4, sha256: bytesHash(MP4), endMs: 100 }], width: 160, height: 120,
    audioPolicy: 'explicit_approved_profile' }), { code: 'VOICE_PERMISSION_REQUIRED' });
  await assert.rejects(media.renderVideo({ segments: [{ bytes: MP4, sha256: bytesHash(MP4), endMs: 100 }], width: 160, height: 120,
    audioPolicy: 'preserve_original', argv: ['-i', '/private/source'] }), { code: 'UNKNOWN_FIELD' });
  assert.equal(calls.length, 0);
});

test('an aborted or forged native dispatcher cannot turn an unexecuted process into a video', async t => {
  const forged = fixture(t, { runNativeCall: async () => ({ stdout: Buffer.from('{}'), executed: true, dryRun: false, exitCode: 0 }) });
  if (!forged.media.readiness().ready) { t.skip('The fixed darwin-arm64 runtime pins are unavailable on this host.'); return; }
  await assert.rejects(forged.media.inspect({ bytes: MP4, sha256: bytesHash(MP4) }), { code: 'EXECUTION_NOT_VERIFIED' });
  const controller = new AbortController(); controller.abort(); const stopped = fixture(t, { signal: controller.signal });
  await assert.rejects(stopped.media.inspect({ bytes: MP4, sha256: bytesHash(MP4) }), { code: 'WORKER_CANCELLED' });
  assert.equal(stopped.calls.length, 0);
});
