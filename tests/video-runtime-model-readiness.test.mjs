import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomBytes} from 'node:crypto';
import {readNativeModelReadiness} from '../src/video-runtime/model-readiness.mjs';
import {localJson} from '../src/video-runtime/process.mjs';
import {createVideoRuntime} from '../src/video-runtime/index.mjs';
const text=(configured=true)=>({llm:{real:configured,model:configured?'current-native-fixture':''},activationGate:{checks:[{key:'llm',ok:configured}]}});
const wired=(kind,modes,available=true)=>({kind,modes,availability:'wired',available});

test('current authenticated native catalog observes model configuration changes without startup-key guesses or secret export',async t=>{
  let mediaReady=false,requests=0;const secret=randomBytes(32).toString('hex'),token=randomBytes(32).toString('hex');
  const server=http.createServer((req,res)=>{requests++;assert.equal(req.headers.authorization,'Bearer '+token);res.writeHead(200,{'content-type':'application/json'});const name=new URL(req.url,'http://localhost').pathname.slice('/trpc/'.length);let value;if(name==='onboarding.status')value=text(true);else{assert.equal(name,'video.gen.catalog');assert.deepEqual(JSON.parse(new URL(req.url,'http://localhost').searchParams.get('input')),{includeUnavailable:true,limit:200});value={models:[{...wired('video',['t2v'],mediaReady),apiKey:secret},wired('image',['t2i'],mediaReady)]};}res.end(JSON.stringify({result:{data:value}}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  const query=async(name,input)=>{const envelope=await localJson('http://127.0.0.1:'+server.address().port+'/trpc/'+name+(input===undefined?'':'?input='+encodeURIComponent(JSON.stringify(input))),{headers:{authorization:'Bearer '+token}});return envelope.result.data;};
  const before=await readNativeModelReadiness(query);assert.equal(before.video.configured,false);assert.equal(before.image.configured,false);
  mediaReady=true;const after=await readNativeModelReadiness(query);assert.deepEqual(after.missing,[]);assert.equal(after.text.currentProcessProbeVerified,true);assert.equal(after.video.availableModels,1);assert.equal(after.image.availableModels,1);assert.equal(requests,4);
  assert.equal(JSON.stringify(after).includes(secret),false);assert.equal(JSON.stringify(after).includes(token),false);
});
test('local render or declared/unavailable entries never stand in for a configured image/video generation model',async()=>{
  const result=await readNativeModelReadiness(async name=>name==='onboarding.status'?text(true):{models:[wired('video',['render']),{...wired('video',['t2v']),availability:'catalog-only'},{...wired('video',['t2v']),available:'true'},wired('image',['t2i'],false)]});
  assert.equal(result.video.configured,false);assert.equal(result.image.configured,false);assert.deepEqual(result.missing,['native-video-generation-model-not-configured','native-image-generation-model-not-configured']);
});
test('unavailable native model reads remain explicit and do not discard the other current result',async()=>{
  const result=await readNativeModelReadiness(name=>{if(name==='onboarding.status')throw new Error('fixture-key-must-not-export');return{models:[wired('video',['r2v']),wired('image',['i2i'])]};});
  assert.equal(result.video.configured,true);assert.equal(result.image.configured,true);assert.deepEqual(result.missing,['native-text-model-status-unavailable']);assert.equal(JSON.stringify(result).includes('fixture-key-must-not-export'),false);
  const malformed=await readNativeModelReadiness(async name=>name==='onboarding.status'?{llm:{real:false,model:''},activationGate:{checks:{}}}:{models:null});
  assert.deepEqual(malformed.missing,['native-text-model-not-configured','native-media-model-status-unavailable']);assert.equal(malformed.text.currentProcessProbeVerified,false);
});
test('doctor scopes its no-provider-call statement to this diagnostic invocation',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-model-doctor-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const rootDir=path.join(base,'product');fs.mkdirSync(path.join(rootDir,'engines/video-edit'),{recursive:true});const runtime=createVideoRuntime({rootDir,dataDir:path.join(base,'private')});const result=await runtime.doctor();assert.equal(result.providerCallsPerformedByDoctor,false);assert.equal(Object.hasOwn(result,'paidCallsSubmitted'),false);
});
