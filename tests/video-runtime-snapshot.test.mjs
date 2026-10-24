import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { verifyPinnedSnapshot } from '../src/video-runtime/snapshot.mjs';

test('pinned engine inventory rejects tampering, missing files, external links and stale counts',t=>{
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-snapshot-test-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  const engineRoot=path.join(rootDir,'engine');fs.mkdirSync(engineRoot);fs.mkdirSync(path.join(rootDir,'upstreams'));const commit='a'.repeat(40);
  const item={path:'entry.mjs',mode:'100644',targetSha256:createHash('sha256').update('original').digest('hex')};
  const snapshot={schemaVersion:'pengmanager.edit-snapshot/v1',source:{commit},sourceFileCount:1,files:[item],targetOwnedFiles:[]};
  let expectedSha256;
  const save=()=>{const raw=JSON.stringify(snapshot);fs.writeFileSync(path.join(rootDir,'upstreams','workloom-video-edit.snapshot.json'),raw);expectedSha256=createHash('sha256').update(raw).digest('hex');};
  const verify=()=>verifyPinnedSnapshot({rootDir,engineRoot,commit,fileCount:1,expectedSha256});
  save();fs.writeFileSync(path.join(engineRoot,item.path),'original');assert.equal(verify().fileCount,1);
  fs.writeFileSync(path.join(engineRoot,item.path),'changed');assert.throws(verify,{code:'ENGINE_SNAPSHOT_MISMATCH'});
  fs.unlinkSync(path.join(engineRoot,item.path));assert.throws(verify,{code:'COMPLETE_ENGINE_MISSING'});
  fs.writeFileSync(path.join(rootDir,'external'),'original');fs.symlinkSync(path.join(rootDir,'external'),path.join(engineRoot,item.path));assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
  fs.unlinkSync(path.join(engineRoot,item.path));fs.writeFileSync(path.join(engineRoot,item.path),'original');snapshot.sourceFileCount=2;save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
  snapshot.sourceFileCount=1;snapshot.files[0].path='../external';save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
  snapshot.files[0].path='entry.mjs';snapshot.targetOwnedFiles=[{path:'managed.mjs',mode:'100644',targetSha256:createHash('sha256').update('managed').digest('hex')}];fs.writeFileSync(path.join(engineRoot,'managed.mjs'),'managed');save();assert.equal(verify().targetOwnedFileCount,1);
  fs.writeFileSync(path.join(engineRoot,'managed.mjs'),'tampered');assert.throws(verify,{code:'ENGINE_SNAPSHOT_MISMATCH'});fs.writeFileSync(path.join(engineRoot,'managed.mjs'),'managed');
  snapshot.targetOwnedFiles.push({...item});save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});snapshot.targetOwnedFiles.pop();
  snapshot.targetOwnedFiles[0].path='./managed.mjs';save();assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});snapshot.targetOwnedFiles[0].path='managed.mjs';save();
  fs.appendFileSync(path.join(rootDir,'upstreams','workloom-video-edit.snapshot.json'),' ');assert.throws(verify,{code:'ENGINE_SNAPSHOT_INVALID'});
});
