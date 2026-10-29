import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { runtimeConfig, loadCredentials, redactor, acquireLock, equalSecret, textModelReadiness } from '../src/video-runtime/config.mjs';
import { runCommand, requireFreePort, portIsOpen, localJson, waitForNativeBackend } from '../src/video-runtime/process.mjs';
import { parseVideoArgs } from '../scripts/video-cli.mjs';
import { nativeEnvironment } from '../src/video-runtime/environment.mjs';
import { databaseUrls, installPostgres } from '../src/video-runtime/postgres.mjs';
import { missingManagedTools } from '../src/video-runtime/index.mjs';

function fixture(t){const base=fs.mkdtempSync(path.join(os.tmpdir(),'pengmanager-runtime-test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const root=path.join(base,'product');fs.mkdirSync(path.join(root,'engines','video-edit'),{recursive:true});return{base,root,data:path.join(base,'private'),config:extra=>runtimeConfig({rootDir:root,dataDir:path.join(base,'private'),...extra})};}
test('private state cannot resolve into the product or use a shared data directory',t=>{
  const f=fixture(t);
  assert.throws(()=>f.config({dataDir:path.join(f.root,'var')}),{code:'PRIVATE_DATA_REQUIRED'});
  fs.symlinkSync(f.root,path.join(f.base,'redirect'));
  assert.throws(()=>f.config({dataDir:path.join(f.base,'redirect','data')}),{code:'PRIVATE_DATA_REQUIRED'});
  fs.mkdirSync(f.data,{mode:0o755});
  assert.throws(()=>loadCredentials(f.config()),{code:'PRIVATE_DIRECTORY_PERMISSIONS'});
  assert.equal(fs.existsSync(path.join(f.data,'private-state.json')),false);
});
test('isolated credentials persist with owner-only permissions and reject replacement or tampering',t=>{
  const f=fixture(t),config=f.config(),first=loadCredentials(config),again=loadCredentials(config);
  assert.deepEqual(first.value,again.value);assert.equal(new Set(Object.values(first.value.credentials)).size,8);
  assert.equal(fs.statSync(first.file).mode&0o077,0);
  for(const child of ['logs','work','media','tools'])assert.equal(fs.statSync(path.join(f.data,child)).mode&0o077,0);
  fs.chmodSync(first.file,0o644);assert.throws(()=>loadCredentials(config),{code:'PRIVATE_STATE_PERMISSIONS'});fs.chmodSync(first.file,0o600);
  fs.unlinkSync(first.file);fs.mkdirSync(config.pgData,{mode:0o700});fs.writeFileSync(path.join(config.pgData,'PG_VERSION'),'17');
  assert.throws(()=>loadCredentials(config),{code:'CREDENTIALS_MISSING'});
});
test('supervisor lock preserves an existing live owner and detects ownership changes',t=>{
  const f=fixture(t),config=f.config();loadCredentials(config);const release=acquireLock(config);
  assert.throws(()=>acquireLock(config),{code:'RUNTIME_BUSY'});release();release();
  const releaseSecond=acquireLock(config),file=path.join(f.data,'.supervisor-lock','owner.json');
  const owner=JSON.parse(fs.readFileSync(file));owner.token=randomBytes(24).toString('hex');fs.writeFileSync(file,JSON.stringify(owner));
  assert.throws(releaseSecond,{code:'LOCK_OWNERSHIP_CHANGED'});
});
test('redaction removes dynamic credentials, database URLs and authorization values',t=>{
  const f=fixture(t),secret=randomBytes(32).toString('hex'),config=f.config({env:{PENGMANAGER_TEST_API_KEY:secret}}),state=loadCredentials(config).value;
  const safe=redactor(config,state),next=randomBytes(24).toString('hex');safe.addSecrets([next]);
  const result=safe(`${secret} ${next} ${state.credentials.jwt} postgres://owner:password@127.0.0.1/data Bearer ${secret}`);
  for(const value of [secret,next,state.credentials.jwt,'owner:password'])assert.equal(result.includes(value),false);
  assert.equal(equalSecret('a','é'),false);assert.equal(equalSecret(null,'a'),false);assert.equal(equalSecret('abc','abc'),true);
});
test('text readiness follows the native provider contract rather than vendor-only keys',()=>{
  assert.equal(textModelReadiness({DEEPSEEK_API_KEY:'present'}).configured,false);
  assert.equal(textModelReadiness({LLM_PROVIDER:'mock',LLM_API_KEY:'present',LLM_BASE_URL:'http://127.0.0.1',LLM_MODEL:'fixture'}).configured,false);
  assert.equal(textModelReadiness({LLM_PROVIDER:'openai',LLM_API_KEY:'present',LLM_BASE_URL:'http://127.0.0.1',LLM_MODEL:'deepseek-flash'}).configured,false);
  assert.equal(textModelReadiness({LLM_PROVIDER:'deepseek',LLM_API_KEY:'present',LLM_BASE_URL:'http://127.0.0.1',LLM_MODEL:'deepseek-chat'}).configured,false);
  assert.equal(textModelReadiness({LLM_PROVIDER:'deepseek',LLM_API_KEY:'present',LLM_BASE_URL:'http://127.0.0.1',LLM_MODEL:'deepseek-flash'}).configured,true);
});
test('Codex CLI and MCP mode is headless by default with an explicit future workbench opt-in',t=>{
  const f=fixture(t);assert.equal(f.config({env:{PENGMANAGER_VIDEO_WORKBENCH:'0'}}).serveWorkbench,false);
  assert.equal(f.config({serveWorkbench:true}).serveWorkbench,true);assert.equal(f.config({env:{PENGMANAGER_VIDEO_WORKBENCH:'1'}}).serveWorkbench,true);
  assert.equal(f.config({serveWorkbench:false,env:{PENGMANAGER_VIDEO_WORKBENCH:'1'}}).serveWorkbench,false);
  assert.throws(()=>f.config({serveWorkbench:'true'}),{code:'WORKBENCH_OPTION_INVALID'});
});
test('native environment owns identity and storage without inheriting old Edit paths',t=>{
  const f=fixture(t),config=f.config({env:{HR_PORTRAIT_REUSE_MANIFEST:'/old/manifest.json',HR_WORK_DIR:'/old/work',WORKLOOM_MEDIA_DIR:'/old/media',WORKLOOM_DESKTOP_LOGIN_KEY:'old',WORKLOOM_RENDER_AUTO:'1',WORKLOOM_UI_RELEASE_READ_TOKEN:'installer-only-token',CNB_UI_RELEASE_TOKEN:'ci-installer-only-token'}}),state=loadCredentials(config).value,desktop=randomBytes(32).toString('hex');
  const urls=databaseUrls(config,state),built=nativeEnvironment(config,state,urls,desktop,{WORKLOOM_POST_BRIDGE_URL:'http://127.0.0.1:19777'});
  assert.equal(built.WORKLOOM_DESKTOP_LOGIN_KEY,desktop);assert.equal(built.HR_PORTRAIT_REUSE_MANIFEST,'');
  assert.equal(built.HR_WORK_DIR,path.join(config.dataRoot,'work'));assert.equal(built.WORKLOOM_MEDIA_DIR,path.join(config.dataRoot,'media'));assert.equal(built.WORKLOOM_DELIVERY_DIR,path.join(config.dataRoot,'delivery'));
  assert.equal(built.WORKLOOM_SCHEDULER_MS,'0');assert.equal(built.ARCHIVE_AUTO_RESUME,'0');assert.equal(built.WORKLOOM_RENDER_AUTO,'0');assert.equal(built.WORKLOOM_ENV_PERSIST_MODE,'process-only');
  assert.equal(built.WORKLOOM_DECLARED_SKILLS_REQUIRED,'1');assert.equal(built.WORKLOOM_PRESERVE_SHADOWED_ROLES,'1');
  assert.equal(built.WORKLOOM_UI_RELEASE_READ_TOKEN,undefined);assert.equal(built.CNB_UI_RELEASE_TOKEN,undefined);
  assert.notEqual(built.WORKLOOM_DELIVERY_SIGNING_SECRET,state.credentials.render);assert.equal(built.WORKLOOM_DELIVERY_SIGNING_SECRET,nativeEnvironment(config,state,urls,desktop).WORKLOOM_DELIVERY_SIGNING_SECRET);
  for(const key of ['DATABASE_URL','JWT_SECRET','WORKLOOM_DESKTOP_LOGIN_KEY','WORKLOOM_ENV_PERSIST_MODE','WORKLOOM_RENDER_AUTO','WORKLOOM_DECLARED_SKILLS_REQUIRED','WORKLOOM_PRESERVE_SHADOWED_ROLES','WORKLOOM_UI_RELEASE_READ_TOKEN','CNB_UI_RELEASE_TOKEN'])assert.throws(()=>nativeEnvironment(config,state,urls,desktop,{[key]:'replacement'}),{code:'TOOL_ENV_INVALID'});
});
test('an occupied foreign port and linked PostgreSQL installation are rejected without reuse',async t=>{
  const f=fixture(t),config=f.config();loadCredentials(config);
  const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const occupied=server.address().port;await assert.rejects(requireFreePort(occupied),{code:'PORT_IN_USE'});assert.equal(await portIsOpen(occupied),true);
  const prefix=path.join(f.base,'foreign-tool'),bin=path.join(prefix,'bin');fs.mkdirSync(bin,{recursive:true});
  for(const name of ['postgres','pg_ctl','initdb','pg_config'])fs.writeFileSync(path.join(bin,name),'unchanged public executable');
  fs.symlinkSync(prefix,config.pgRoot);await assert.rejects(installPostgres(config),{code:'POSTGRES_SOURCE_INVALID'});
  assert.equal(fs.readFileSync(path.join(bin,'postgres'),'utf8'),'unchanged public executable');
});
test('the supported Ark key alias reaches the native model catalog through its canonical key',t=>{
  const f=fixture(t),config=f.config({env:{VOLCENGINE_ARK_API_KEY:'  ',ARK_API_KEY:'fixture-ark-alias'}}),state=loadCredentials(config).value;
  const built=nativeEnvironment(config,state,databaseUrls(config,state),'fixture-desktop-bootstrap');
  assert.equal(built.VOLCENGINE_ARK_API_KEY,'fixture-ark-alias');
});
test('HTTP 200 with an unhealthy native backend never authenticates or becomes ready',async t=>{
  let requests=0,sessions=0;
  const server=http.createServer((req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:false}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  await assert.rejects(waitForNativeBackend({endpoint:'http://127.0.0.1:'+server.address().port,child:{exitCode:null,signalCode:null},nativeSession:async()=>{sessions++;},attempts:4,delayMs:1}),{code:'BACKEND_NOT_READY'});
  assert.equal(requests,4);assert.equal(sessions,0);
  const controller=new AbortController(),cancelled=waitForNativeBackend({endpoint:'http://127.0.0.1:'+server.address().port,child:{exitCode:null,signalCode:null},nativeSession:async()=>{sessions++;},signal:controller.signal,attempts:4,delayMs:50});
  controller.abort();await assert.rejects(cancelled,{code:'RUNTIME_CANCELLED'});assert.equal(sessions,0);
});
test('current bridge health failure and TalkCraft commercial license remain visible as missing',async t=>{
  let healthy=true;
  const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:healthy}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections?.();}));
  const current=async()=>({tools:[{id:'post',installed:true,running:true,ready:(await localJson('http://127.0.0.1:'+server.address().port+'/health')).ok,missing:[]}],missing:[]});
  assert.deepEqual(missingManagedTools(await current()),[]);healthy=false;
  const missing=missingManagedTools(await current());assert.equal(missing.length,1);assert.equal(missing[0].id,'post');assert.equal(missing[0].reasons.includes('service-health-not-ready'),true);
  const license=missingManagedTools({tools:[{id:'talkcraft',installed:true,ready:true,running:false,missing:[],license:{commercialReady:false}}],missing:[]});
  assert.equal(license[0].reasons.includes('commercial-license-grant-required'),true);
});
test('managed commands redact output and terminate on timeout or cancellation',async t=>{
  const f=fixture(t),secret=randomBytes(32).toString('hex'),safe=redactor(f.config({env:{TEST_API_KEY:secret}})),log=path.join(f.base,'command.log');
  const output=await runCommand(process.execPath,['-e','process.stdout.write(process.env.TEST_API_KEY)'],{env:{...process.env,TEST_API_KEY:secret},safe,log});
  assert.equal(output.stdout,'[redacted]');assert.equal(fs.readFileSync(log,'utf8').includes(secret),false);
  const split=await runCommand(process.execPath,['-e','const s=process.env.TEST_API_KEY;process.stdout.write(s.slice(0,16));setTimeout(()=>process.stdout.write(s.slice(16)+"\\n"),20)'],{env:{...process.env,TEST_API_KEY:secret},safe,log});
  assert.equal(split.stdout,'[redacted]\n');assert.equal(fs.readFileSync(log,'utf8').includes(secret.slice(0,16)),false);
  await assert.rejects(runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:30,safe}),{code:'PROCESS_TIMEOUT'});
  const controller=new AbortController(),pending=runCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{signal:controller.signal,safe});
  controller.abort();await assert.rejects(pending,{code:'RUNTIME_CANCELLED'});
  await assert.rejects(runCommand(process.execPath,['-e','console.log("output");setInterval(()=>{},1000)'],{safe,log:f.base}),{code:'PROCESS_LOG_FAILED'});
});
test('CLI arguments reject unsupported or missing options',()=>{
  assert.deepEqual(parseVideoArgs(['--install','--build']).settings,{installDependencies:true,buildWeb:true});
  assert.throws(()=>parseVideoArgs(['--data-dir']),{code:'ARGUMENT_INVALID'});
  assert.throws(()=>parseVideoArgs(['--unknown']),{code:'ARGUMENT_INVALID'});
});
