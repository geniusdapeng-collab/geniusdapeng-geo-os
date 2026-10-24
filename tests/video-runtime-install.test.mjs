import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {downloadPinnedArchive,runProcess,childEnvironment} from '../engines/video-edit/scripts/ci/ui-auth-bootstrap.mjs';
import {installEngineDependencies,packageManagerInvocation} from '../src/video-runtime/install.mjs';
import {withoutInstallationCredentials} from '../src/video-runtime/environment.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const state=JSON.parse(fs.readFileSync(path.join(root,'engines/video-edit/.workloom-ui.json'),'utf8'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const cancelled=error=>error.code==='UI_BOOTSTRAP_CANCELLED';

test('incomplete engines fail before creating a dependency store without requiring a release credential',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-install-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  await assert.rejects(installEngineDependencies({config:{env:{},engineRoot:path.join(base,'absent-engine'),dataRoot:base}}),{code:'COMPLETE_ENGINE_MISSING'});
  assert.deepEqual(fs.readdirSync(base),[]);
});
test('installation credentials are downloader-only and excluded from operation and pnpm environments',()=>{
  const env={PATH:'/fixture/bin',HOME:'/fixture/home',WORKLOOM_UI_RELEASE_READ_TOKEN:'explicit-install-only',CNB_UI_RELEASE_TOKEN:'explicit-ci-install-only',LLM_API_KEY:'model-only',GITHUB_TOKEN:'not-build-input'};
  assert.deepEqual(withoutInstallationCredentials(env),{PATH:env.PATH,HOME:env.HOME,LLM_API_KEY:env.LLM_API_KEY,GITHUB_TOKEN:env.GITHUB_TOKEN});
  assert.deepEqual(childEnvironment(env),{PATH:env.PATH,HOME:env.HOME,CI:'true'});
  assert.deepEqual(packageManagerInvocation({node:process.execPath,env:{PENGMANAGER_PNPM_BIN:'/explicit/pnpm.cjs'}}),{command:process.execPath,prefix:['/explicit/pnpm.cjs']});
});
test('an already cancelled authenticated download makes no network request',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  await assert.rejects(downloadPinnedArchive({state,releaseReadToken:'synthetic-only',signal:controller.signal,fetchImplementation:async()=>{calls++;throw new Error('unexpected request');}}),cancelled);
  assert.equal(calls,0);
});
for(const mode of ['request','body'])test('authenticated dependency cancellation interrupts a real loopback '+mode+' fixture',async t=>{
  let connectedResolve;const connected=new Promise(resolve=>{connectedResolve=resolve;});let requests=0;
  const server=http.createServer((req,res)=>{requests++;if(mode==='body'){res.writeHead(200,{'content-type':'application/json'});res.write('{"tag_name":');}connectedResolve();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  const controller=new AbortController();
  // This explicit local HTTP fixture verifies cancellation, not a supplier release or entitlement.
  const pending=downloadPinnedArchive({state,releaseReadToken:'synthetic-only',signal:controller.signal,fetchImplementation:(_url,options)=>fetch('http://127.0.0.1:'+server.address().port+'/',options)});
  const result=assert.rejects(pending,cancelled);await connected;controller.abort();await result;assert.equal(requests,1);
});
test('cancelled native dependency child groups leave no owned descendant running',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-install-cancel-')),marker=path.join(base,'owned-child.json');t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
  if(process.platform==='win32'){
    const controller=new AbortController(),pending=runProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal});const result=assert.rejects(pending,cancelled);controller.abort();await result;return;
  }
  const childCode="process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const parentCode="const{spawn}=require('node:child_process'),fs=require('node:fs');const c=spawn(process.execPath,['-e',process.argv[2]],{stdio:'ignore'});fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:c.pid}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)";
  const controller=new AbortController(),pending=runProcess(process.execPath,['-e',parentCode,marker,childCode],{signal:controller.signal,timeoutMs:20000});const result=assert.rejects(pending,cancelled);
  for(let attempt=0;attempt<500&&!fs.existsSync(marker);attempt++)await wait(20);
  assert.equal(fs.existsSync(marker),true,'owned descendant fixture did not start');const pids=JSON.parse(fs.readFileSync(marker,'utf8'));
  t.after(()=>{for(const pid of Object.values(pids))if(alive(pid))process.kill(pid,'SIGKILL');});
  controller.abort();await result;
  for(let attempt=0;attempt<100&&alive(pids.child);attempt++)await wait(20);
  assert.equal(alive(pids.parent),false);assert.equal(alive(pids.child),false);
});
