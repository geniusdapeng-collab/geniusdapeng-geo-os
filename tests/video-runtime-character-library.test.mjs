import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('the default character selected by ordinal has current owner-authorized bytes, without granting production authority', () => {
  const code = `
    import { resolveVideoCharacters } from './engines/video-edit/packages/video-studio/src/video-library.ts';
    const result = resolveVideoCharacters({intent:'用1号模特作为主角'}, {bundleRoot:'./engines/video-edit/bundles'});
    const actor = result.archives[0];
    console.log(JSON.stringify({
      ids: result.builtinIds,
      activeVersion: actor?.activeVersion,
      verification: actor?.verification?.status,
      basis: actor?.ownerDecision?.basis,
      currentBytesVerified: actor?.ownerDecision?.currentBytesVerified,
      views: Object.keys(actor?.views ?? {}),
      productionAuthorityGranted: result.productionAuthorityGranted,
      paidCalls: result.paidCalls,
    }));
  `;
  const result = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH },
  }));
  assert.deepEqual(result.ids, ['young-rider-01']);
  assert.ok(result.activeVersion >= 2);
  assert.equal(result.verification, 'passed');
  assert.equal(result.basis, 'explicit-owner-authorization');
  assert.equal(result.currentBytesVerified, true);
  assert.deepEqual(result.views.sort(), ['actionPose', 'back', 'closeup', 'emotionCloseup', 'front', 'handDetail', 'side', 'threeQuarter']);
  assert.equal(result.productionAuthorityGranted, false);
  assert.equal(result.paidCalls, 0);
});
