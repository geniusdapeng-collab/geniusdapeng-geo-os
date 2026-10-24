import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVideoRuntime } from '../src/video-runtime/index.mjs';

test('failed or immediately cancelled startup releases its private lock and remains stopped',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-lifecycle-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const product=path.join(base,'product'),engine=path.join(product,'engines','video-edit');fs.mkdirSync(engine,{recursive:true});
  const runtime=createVideoRuntime({rootDir:product,dataDir:path.join(base,'private')});
  const pending=runtime.start();const stopped=runtime.stop();
  await assert.rejects(pending);const result=await stopped;
  assert.equal(result.ready,false);assert.equal(result.state,'stopped');assert.equal(fs.existsSync(path.join(base,'private','.supervisor-lock')),false);
  assert.equal((await runtime.stop()).state,'stopped');
  await assert.rejects(runtime.setup());assert.equal((await runtime.status()).ready,false);
  assert.equal(fs.existsSync(path.join(base,'private','.supervisor-lock')),false);
  const capabilities=await runtime.capabilities();assert.equal(capabilities.ready,false);assert.equal(capabilities.categories.every(row=>row.validated==='unverified'),true);
  await runtime.stop();
});
