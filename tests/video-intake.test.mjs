import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVideoIntake } from '../src/video-intake.mjs';

const source = path.resolve(import.meta.dirname, '..');
const guide = 'engines/video-edit/docs/ai-video-workbench-guide.md';
const manifest = 'upstreams/workloom-video-edit.snapshot.json';
const input = { intent: '把这个项目做成 20 秒视频。', durationSeconds: 20 };
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'pengmanager-intake-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const files = [
    'AGENTS.md', 'package.json', 'docs/AI-AGENT-GUIDE.md', 'docs/CODEX-VIDEO-QUICKSTART.md', guide,
    'engines/video-edit/product.manifest.json', 'upstreams/workloom-video-edit.pin.json', manifest,
  ];
  for (const file of files) {
    const destination = path.join(rootDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(source, file), destination);
  }
  const git = (...args) => execFileSync('git', ['-C', rootDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
  git('init', '-q');
  git('add', ...files);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'intake fixture');
  return { rootDir, git };
}

test('intake gives a typed handoff for a local owner entry without executing that file', async t => {
  const { rootDir, git } = await fixture(t);
  const blocked = createVideoIntake({ rootDir, input });
  assert.deepEqual(blocked.nativeHandoff.blockers, ['NATIVE_ENTRYPOINT_UNAVAILABLE']);
  const entrypoint = path.join(rootDir, blocked.nativeHandoff.ownerEntrypoint);
  await mkdir(path.dirname(entrypoint));
  await writeFile(entrypoint, 'throw new Error("intake must not execute the owner entrypoint");\n');
  const untracked = createVideoIntake({ rootDir, input });
  assert.deepEqual(untracked.nativeHandoff.blockers, ['NATIVE_ENTRYPOINT_UNVERIFIED']);
  git('add', blocked.nativeHandoff.ownerEntrypoint);
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'owner entry fixture');
  const accepted = createVideoIntake({ rootDir, input });
  assert.equal(accepted.status, 'intake_ready');
  assert.equal(accepted.repository.head, git('rev-parse', 'HEAD'));
  assert.equal(accepted.request.sha256, blocked.request.sha256);
  assert.notEqual(accepted.provenanceSha256, blocked.provenanceSha256);
  assert.match(accepted.nativeHandoff.entrypointSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(accepted.nativeHandoff.blockers, []);
  assert.equal(accepted.nativeHandoff.authorizationGranted, false);
  assert.equal(accepted.providerCallsPerformed, false);
  assert.equal(accepted.productionVerified, false);
});

test('intake rejects a mismatched product, snapshot, or embedded guide even when the request is valid', async t => {
  const { rootDir } = await fixture(t);
  for (const [file, altered] of [
    ['package.json', () => '{"name":"not-pengmanager"}\n'],
    [manifest, bytes => bytes + '\n'],
    [guide, bytes => bytes + '\nUnreviewed guide amendment.\n'],
  ]) {
    const local = path.join(rootDir, file);
    const original = await readFile(local, 'utf8');
    await writeFile(local, altered(original));
    assert.throws(() => createVideoIntake({ rootDir, input }), { code: 'VIDEO_INTAKE_PROVENANCE_INVALID' });
    await writeFile(local, original);
  }
  const localGuide = path.join(rootDir, guide);
  await rename(localGuide, localGuide + '.original');
  await symlink(localGuide + '.original', localGuide);
  assert.throws(() => createVideoIntake({ rootDir, input }), { code: 'VIDEO_INTAKE_PROVENANCE_INVALID' });
});
