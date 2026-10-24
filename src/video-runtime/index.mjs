import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { runtimeConfig, loadCredentials, redactor, acquireLock, requireEngineModule, inside, SCOPE, atomicJson, textModelReadiness, VideoRuntimeError } from './config.mjs';
import { createPostgresManager, installPostgres } from './postgres.mjs';
import { assertActive, portIsOpen, requireFreePort, runCommand, startChild, stopChild, localJson, waitForNativeBackend } from './process.mjs';
import { createWorkbenchServer } from './web.mjs';
import { nativeEnvironment as buildNativeEnvironment, withoutInstallationCredentials } from './environment.mjs';
import { verifyPinnedSnapshot } from './snapshot.mjs';
import { installEngineDependencies, packageManagerInvocation } from './install.mjs';
import { readNativeModelReadiness } from './model-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export { VideoRuntimeError } from './config.mjs';
export function missingManagedTools(status) {
  const rows=Array.isArray(status)?status:Array.isArray(status?.tools)?status.tools:[];
  const result=new Map();
  const add=(id,reasons)=>{if(typeof id!=='string'||!id)return;const current=result.get(id)||new Set();for(const reason of reasons)if(typeof reason==='string'&&reason)current.add(reason);result.set(id,current);};
  for(const item of Array.isArray(status?.missing)?status.missing:[])if(typeof item==='string')add(item,[item]);else if(item)add(item.id,Array.isArray(item.reasons)?item.reasons:[]);
  for(const row of rows){
    const reasons=Array.isArray(row.missing)?[...row.missing]:[];
    if(row.installed!==true)reasons.push('dependency-not-installed');
    if(row.ready!==true)reasons.push(row.running===true?'service-health-not-ready':'service-not-running-or-not-ready');
    if(row.id==='talkcraft'&&row.license?.commercialReady!==true)reasons.push('commercial-license-grant-required');
    if(reasons.length)add(row.id,reasons);
  }
  return [...result].map(([id,reasons])=>({id,reasons:[...reasons]}));
}
export function createVideoRuntime(options = {}) {
  const config = runtimeConfig({ rootDir: ROOT, ...options });
  let state = fs.existsSync(config.pgRoot) ? 'stopped' : 'not-installed', errorSafe = null, ready = false, backendHealth = { ok: false }, dbHealth = { ok: false, owned: false }, inventoryValidation = null;
  let credentials, pg, backend, workbench, tools, toolsResult = { environment: {}, tools: [], missing: [] }, releaseLock;
  let controller, setupPromise, startPromise, stopPromise, generation = 0, stopping = false;
  let safe = redactor(config), desktopKey = '', env;
  const log = message => config.logger(safe(message));
  const endpoint = `http://127.0.0.1:${config.ports.backend}`;
  const workbenchUrl = `http://127.0.0.1:${config.ports.web}`;
  const snapshot = () => ({ ready, state, sourceMain: config.sourceMain, workbenchEnabled:config.serveWorkbench,workbenchUrl: ready&&config.serveWorkbench ? workbenchUrl : null, backendHealth: { ...backendHealth }, dbHealth: { ...dbHealth }, inventoryValidation, errorSafe, version: 1 });
  function enginePath(name) {
    const require = createRequire(path.join(config.engineRoot,'package.json'));
    const file = fs.realpathSync(require.resolve(name));
    if(!inside(config.engineRoot,file))throw new VideoRuntimeError('DEPENDENCY_OUTSIDE_ENGINE','An embedded runtime dependency resolves into another installation.');
    return file;
  }
  function verifyEngineInventory() {
    if(Number(process.versions.node.split('.')[0])<24)throw new VideoRuntimeError('NODE_VERSION_UNSUPPORTED','The complete video engine requires Node.js 24 or higher.');
    for(const file of ['package.json','pnpm-lock.yaml','apps/server/src/index.ts','scripts/migrate.ts','scripts/desktop-bootstrap-db.mjs','packages/base/bundles/assembly.ts','vendor/supermickey/hyperreality-system/index.js','pengmanager-capabilities.json']) {
      if(!fs.existsSync(path.join(config.engineRoot,file)))throw new VideoRuntimeError('COMPLETE_ENGINE_MISSING',`Complete embedded video engine file is missing: ${file}.`);
    }
    const pin=JSON.parse(fs.readFileSync(path.join(config.rootDir,'upstreams','workloom-video-edit.pin.json'),'utf8'));
    if(pin.commit!==config.sourceMain||pin.sourceFileCount!==config.sourceFileCount)throw new VideoRuntimeError('ENGINE_PIN_MISMATCH','The embedded video engine does not match the reviewed complete snapshot.');
    inventoryValidation=verifyPinnedSnapshot({rootDir:config.rootDir,engineRoot:config.engineRoot,commit:config.sourceMain,fileCount:config.sourceFileCount,expectedSha256:pin.snapshotSha256});
  }
  function verifyEngine({inventoryVerified=false}={}) {
    if(!inventoryVerified)verifyEngineInventory();
    requireEngineModule(config,'pg');enginePath('tsx/cli');
    if(!fs.existsSync(path.join(config.engineRoot,'packages/industry-contract/dist/index.js')))throw new VideoRuntimeError('ENGINE_BUILD_REQUIRED','Build the embedded industry-contract package before starting the native service.');
    if(config.serveWorkbench&&!fs.existsSync(path.join(config.webRoot,'index.html')))throw new VideoRuntimeError('WORKBENCH_BUILD_REQUIRED','Build the complete native web workbench before enabling it. Headless CLI/MCP mode does not require this build.');
  }
  function nativeEnvironment(toolEnvironment = {}) {
    const base=buildNativeEnvironment(config,credentials.value,pg.databaseUrls(),desktopKey,toolEnvironment);
    safe.addSecrets(Object.entries(base).filter(([key])=>/KEY|TOKEN|SECRET|PASSWORD/.test(key)).map(([,value])=>value));
    return base;
  }
  async function loadTools(signal) {
    if(tools)return;
    const file=path.join(config.engineRoot,'scripts','pengmanager-tools.mjs');
    if(!fs.existsSync(file))throw new VideoRuntimeError('COMPLETE_TOOLS_MISSING','Complete video tool supervisor is missing from the embedded engine.');
    const module=await import(pathToFileURL(file).href);
    if(typeof module.createToolRuntime!=='function')throw new VideoRuntimeError('TOOL_RUNTIME_INVALID','Complete video tool supervisor has an invalid interface.');
    tools=await module.createToolRuntime({engineRoot:config.engineRoot,dataRoot:config.dataRoot,env:{...withoutInstallationCredentials(config.env),PATH:[path.dirname(config.node),config.env.PATH||''].join(path.delimiter)},ports:config.ports,logger:log,signal,workspaceId:SCOPE.workspaceId});
    for(const method of ['setup','start','stop','status'])if(typeof tools?.[method]!=='function')throw new VideoRuntimeError('TOOL_RUNTIME_INVALID',`Complete video tool supervisor has no ${method} operation.`);
  }
  async function prepare(signal, settings={}) {
    assertActive(signal);state='setting-up';ready=false;errorSafe=null;
    inventoryValidation=null;verifyEngineInventory();
    credentials=loadCredentials(config);desktopKey=randomBytes(32).toString('hex');safe=redactor(config,credentials.value);safe.addSecrets([desktopKey]);
    releaseLock=acquireLock(config);
    const emptyKeys=path.join(config.dataRoot,'process-model-keys-only.env');
    if(!fs.existsSync(emptyKeys))fs.writeFileSync(emptyKeys,'# Model credentials are supplied only through the current process environment.\n',{mode:0o600,flag:'wx'});
    if(settings.installDependencies){
      await installEngineDependencies({config,signal,safe,logger:log});
    }
    if(settings.buildWeb){
      await packageCommand(['-C','packages/industry-contract','build'],{signal,log:'web-build.log',timeoutMs:300000});
      await packageCommand(['-C','apps/web','build'],{signal,log:'web-build.log',timeoutMs:300000});
    }
    verifyEngine({inventoryVerified:true});
    await installPostgres(config,{sourceRoot:settings.postgresSourceRoot,signal,safe});
    assertActive(signal);pg=createPostgresManager(config,credentials,safe);dbHealth=await pg.start({signal});
    env=nativeEnvironment();
    const cli=enginePath('tsx/cli');
    await runCommand(config.node,[cli,path.join(config.engineRoot,'scripts','migrate.ts')],{cwd:config.dataRoot,env,signal,safe,log:path.join(config.logs,'migrate.log'),timeoutMs:180000});
    assertActive(signal);
    await runCommand(config.node,[cli,path.join(config.rootDir,'src','video-runtime','initialize.mjs')],{cwd:config.dataRoot,env,signal,safe,log:path.join(config.logs,'workspace-init.log'),timeoutMs:180000});
    assertActive(signal);await loadTools(signal);
    if(settings.installTools===true){
      const installed=await tools.setup();
      if(!installed||!Array.isArray(installed.steps)||!Array.isArray(installed.tools))throw new VideoRuntimeError('TOOL_SETUP_INVALID','Managed tool supervisor returned an invalid installation receipt.');
      const failed=[...new Set([...installed.steps.filter(item=>!item.ok).map(item=>item.id),...installed.tools.filter(item=>!item.installed||item.missing?.length).map(item=>item.id)])];
      if(failed.length)throw new VideoRuntimeError('TOOLS_INSTALL_INCOMPLETE',`Managed local media installation is incomplete for: ${failed.join(', ')}. Review the private tools installation receipt, then rerun video-setup.`);
    }
    assertActive(signal);
    atomicJson(path.join(config.dataRoot,'setup-receipt.json'),{schemaVersion:'pengmanager.video-setup/v1',sourceMain:config.sourceMain,workspaceId:SCOPE.workspaceId,completeSnapshot:true,inventoryValidation,simulatedBusinessData:false,setupAt:new Date().toISOString()});
  }
  async function packageCommand(args,{signal,log:logName,timeoutMs}){
    const {command,prefix}=packageManagerInvocation(config);
    const packageEnv={...withoutInstallationCredentials(config.env),PATH:[path.dirname(config.node),config.env.PATH||''].join(path.delimiter)};
    const required=JSON.parse(fs.readFileSync(path.join(config.engineRoot,'package.json'),'utf8')).packageManager?.replace(/^pnpm@/,'');
    const version=await runCommand(command,[...prefix,'--version'],{cwd:config.engineRoot,env:packageEnv,signal,safe,timeoutMs:30000});
    if(version.stdout.trim()!==required)throw new VideoRuntimeError('PACKAGE_MANAGER_MISMATCH',`Use the embedded engine's pinned pnpm ${required}; PENGMANAGER_PNPM_BIN may select its executable or JavaScript entry point.`);
    return runCommand(command,[...prefix,...args],{cwd:config.engineRoot,env:packageEnv,signal,safe,log:path.join(config.logs,logName),timeoutMs});
  }
  async function nativeSessionInternal(signal) {
    if(!backend||backend.exitCode!==null||backend.signalCode!==null||!desktopKey)throw new VideoRuntimeError('NATIVE_BACKEND_NOT_READY','The managed native video backend is not running.');
    const envelope=await localJson(endpoint+'/trpc/auth.desktopLogin',{method:'POST',headers:{'x-workloom-desktop-key':desktopKey},body:{},signal});
    const session=envelope.result?.data?.json??envelope.result?.data;
    if(!session||typeof session.token!=='string'||!session.token||session.identity?.workspaceId!==SCOPE.workspaceId||session.identity?.tenantId!==SCOPE.tenantId||session.identity?.memberNo!==SCOPE.memberNo||session.identity?.role!=='owner')throw new VideoRuntimeError('NATIVE_SESSION_SCOPE_MISMATCH','The native service did not establish the expected active PengManager owner session.');
    safe.addSecrets([session.token]);return {token:session.token,identity:session.identity};
  }
  async function cleanup() {
    const errors=[];
    for(const action of [async()=>{await workbench?.stop();workbench=null;},async()=>{await stopChild(backend);backend=null;},async()=>{if(tools){await tools.stop();const stopped=await tools.status();toolsResult={...(Array.isArray(stopped)?{tools:stopped,missing:[]}:stopped),environment:{}};tools=null;}},async()=>{await pg?.stop();pg=null;},async()=>{releaseLock?.();releaseLock=null;}]){
      try{await action();}catch(error){errors.push(error);}
    }
    ready=false;backendHealth={ok:false};dbHealth={ok:false,owned:false};desktopKey='';
    if(errors.length)throw new VideoRuntimeError('RUNTIME_CLEANUP_FAILED',errors.map(safe).join('; '));
  }
  function fail(error) {ready=false;errorSafe=safe(error instanceof AggregateError?`${error.message} ${error.errors.map(item=>safe(item)).join('; ')}`:error);state=error?.code==='RUNTIME_CANCELLED'?'stopped':'error';log(`${error?.code||'VIDEO_RUNTIME_FAILED'}: ${errorSafe}`);return new VideoRuntimeError(error?.code||'VIDEO_RUNTIME_FAILED',errorSafe);}
  async function health() {
    if(state!=='ready')return snapshot();
    dbHealth=await pg.health();
    try{const response=await localJson(endpoint+'/health');backendHealth={ok:response.ok===true};}catch(error){backendHealth={ok:false,errorSafe:safe(error)};}
    ready=backendHealth.ok&&dbHealth.ok;
    if(!ready){state='error';errorSafe='The managed video backend or owned PostgreSQL instance is no longer healthy.';}
    return snapshot();
  }
  const api={
    async doctor(){
      const checks=[];
      const inspect=(key,run)=>{try{run();checks.push({key,ok:true});}catch(error){checks.push({key,ok:false,code:error.code||'INSTALLATION_INVALID',errorSafe:safe(error)});}};
      inspect('complete-engine',verifyEngine);
      inspect('private-data-location',()=>{if(fs.existsSync(config.dataRoot)){const stat=fs.lstatSync(config.dataRoot);if(!stat.isDirectory()||stat.isSymbolicLink()||process.platform!=='win32'&&(stat.mode&0o077))throw new VideoRuntimeError('PRIVATE_DIRECTORY_PERMISSIONS','Private video data must be an ordinary owner-only directory.');}});
      inspect('postgres-tools',()=>{for(const part of ['bin/postgres','bin/pg_ctl','bin/initdb','share'])if(!fs.existsSync(path.join(config.pgRoot,process.platform==='win32'&&part.startsWith('bin/')?part+'.exe':part)))throw new VideoRuntimeError('POSTGRES_INSTALL_REQUIRED','Run video-setup with a PostgreSQL 17 tool installation.');});
      const ports=await Promise.all(Object.entries(config.ports).map(async([service,port])=>({service,port,listening:await portIsOpen(port)})));
      const model=textModelReadiness(config.env);
      return {schemaVersion:'pengmanager.video-doctor/v1',ok:checks.every(check=>check.ok),sourceMain:config.sourceMain,state,workbenchEnabled:config.serveWorkbench,checks,ports,textModel:{configured:model.configured,missing:model.missing},workspaceInitialized:fs.existsSync(path.join(config.dataRoot,'workspace-ready.json')),providerCallsPerformedByDoctor:false};
    },
    async setup(settings={}) {
      if(setupPromise)return setupPromise;if(startPromise)return startPromise;if(ready)return snapshot();if(stopPromise)await stopPromise;
      stopping=false;controller=new AbortController();const signal=controller.signal;
      setupPromise=(async()=>{try{await prepare(signal,{...settings,installTools:settings.installTools??true});await cleanup();state='stopped';return snapshot();}catch(error){try{await cleanup();}catch(clean){error=new AggregateError([error,clean],'Runtime setup and cleanup failed.');}throw fail(error);}})().finally(()=>{setupPromise=null;});
      return setupPromise;
    },
    async start(settings={}) {
      if(ready)return health();if(startPromise)return startPromise;if(stopPromise)await stopPromise;
      const epoch=++generation;stopping=false;
      startPromise=(async()=>{
        if(setupPromise)await setupPromise;
        if(stopping||epoch!==generation)throw new VideoRuntimeError('RUNTIME_CANCELLED','Video runtime startup was cancelled.');
        controller=new AbortController();const signal=controller.signal;
        try{
          await prepare(signal,settings);assertActive(signal);state='starting';
          toolsResult=await tools.start();assertActive(signal);
          if(!toolsResult||typeof toolsResult.environment!=='object'||!Array.isArray(toolsResult.tools)||!Array.isArray(toolsResult.missing))throw new VideoRuntimeError('TOOL_START_INVALID','Managed tool supervisor returned an invalid start receipt.');
          env=nativeEnvironment(toolsResult.environment);
          await requireFreePort(config.ports.backend);if(config.serveWorkbench)await requireFreePort(config.ports.web);assertActive(signal);
          const cli=enginePath('tsx/cli');
          backend=startChild(config.node,[cli,path.join(config.engineRoot,'apps/server/src/index.ts')],{cwd:config.dataRoot,env,safe,log:path.join(config.logs,'backend.log'),onExit:error=>{backendHealth={ok:false};if(!stopping&&state==='ready'){ready=false;state='error';errorSafe=safe(error);}}});
          backendHealth=await waitForNativeBackend({endpoint,child:backend,nativeSession:nativeSessionInternal,signal});
          if(backendHealth.ok!==true)throw new VideoRuntimeError('BACKEND_NOT_READY','Managed native video backend has no verified healthy owner session.');
          assertActive(signal);if(config.serveWorkbench){workbench=createWorkbenchServer({config,nativeSession:()=>nativeSessionInternal(),health,safe,onError:log});await workbench.start();}assertActive(signal);
          if(backendHealth.ok!==true||backend.exitCode!==null||backend.signalCode!==null)throw new VideoRuntimeError('BACKEND_EXITED','Managed native video backend stopped while its workbench was starting.');
          state='ready';ready=true;errorSafe=null;return snapshot();
        }catch(error){try{await cleanup();}catch(clean){error=new AggregateError([error,clean],'Runtime startup and cleanup failed.');}throw fail(error);}
      })().finally(()=>{startPromise=null;});return startPromise;
    },
    async stop(){
      if(stopPromise)return stopPromise;stopping=true;++generation;controller?.abort();ready=false;state='stopping';
      stopPromise=(async()=>{const pending=[setupPromise,startPromise].filter(Boolean);await Promise.allSettled(pending);try{await cleanup();state='stopped';errorSafe=null;return snapshot();}catch(error){throw fail(error);}})().finally(()=>{stopPromise=null;});return stopPromise;
    },
    async status(){if(state==='ready')return health();return snapshot();},health,
    async nativeSession(){if(!ready||stopping)throw new VideoRuntimeError('NATIVE_BACKEND_NOT_READY','The native video workbench is not ready.');return nativeSessionInternal();},
    async capabilities(){
      let catalog=null;try{catalog=JSON.parse(fs.readFileSync(path.join(config.engineRoot,'pengmanager-capabilities.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')log(`CAPABILITY_CATALOG_UNREADABLE: ${safe(error)}`);}
      const actualTools=tools?await tools.status():toolsResult;
      const rows=Array.isArray(actualTools)?actualTools:Array.isArray(actualTools?.tools)?actualTools.tools:[];
      const toolMissing=missingManagedTools(actualTools);
      let modelMissing=[],modelReadiness={source:'unverified-startup-process-configuration',text:{configured:textModelReadiness(config.env).configured},video:{configured:false},image:{configured:false}};
      if(ready){
        try{
          const session=await nativeSessionInternal();
          modelReadiness=await readNativeModelReadiness(async(name,input)=>{const envelope=await localJson(endpoint+'/trpc/'+name+(input===undefined?'':'?input='+encodeURIComponent(JSON.stringify(input))),{headers:{authorization:`Bearer ${session.token}`}});return envelope.result?.data?.json??envelope.result?.data;});
          modelMissing=modelReadiness.missing;
        }catch(error){modelMissing.push('native-model-status-unavailable');log(`NATIVE_MODEL_STATUS_UNVERIFIED: ${safe(error)}`);}
      }else{
        modelMissing.push(...textModelReadiness(config.env).missing);
        if(!String(config.env.VOLCENGINE_ARK_API_KEY||'').trim()&&!String(config.env.ARK_API_KEY||'').trim())modelMissing.push('video-image-model-credentials');
      }
      const category=(id,label,missing,entrypoints)=>({id,label,status:!ready?(state==='starting'||state==='setting-up'?'starting':'unverified'):missing.length?'dependency-missing':'available',missing,entrypoints,validated:'unverified',note:'Ready means configured native entry points; paid generation or media quality is not asserted.'});
      return {schemaVersion:'pengmanager.video-capabilities/v1',scope:'complete-edit',sourceMain:config.sourceMain,ready,state,modelReadiness,
        inventory:{fileCount:config.sourceFileCount,roleCount:catalog?.summary?.runtimeRoles??catalog?.summary?.uniqueRoleKeys??0,sourceUniqueRoleKeys:catalog?.summary?.uniqueRoleKeys??0,skillCount:catalog?.summary?.skills??0,bundledSkillCount:catalog?.summary?.bundledSkills??0,nativeOfficialSkillCount:catalog?.summary?.officialSkills??0,registrySkillCount:catalog?.summary?.registrySkills??0,toolCount:catalog?.summary?.tools??0},
        categories:[category('ai-generation','AI生成',modelMissing,['/ai-video/assets?tab=studio']),category('ai-editing','AI剪辑',toolMissing.filter(item=>/ffmpeg|post|subtitle|color|bgm/i.test(typeof item==='string'?item:JSON.stringify(item))),['/ai-video/assets','scripts/tools/edit-auto.mts']),category('ai-presenter','AI口播',toolMissing.filter(item=>/voice|asr|tts|talkcraft|whiteboard/i.test(typeof item==='string'?item:JSON.stringify(item))),['video.explainer','video.whiteboard','scripts/tools/edit-talk-cut.mts']),category('visual-design','Compositor作图',toolMissing.filter(item=>/compositor|visual/i.test(typeof item==='string'?item:JSON.stringify(item))),['visualwrite.compose','scripts/tools/edit-cover.mts'])],
        tools:rows,catalog,roles:catalog?.roles||[],skills:catalog?.skills||[],declaredTools:catalog?.tools||[],capabilities:catalog?.capabilities||[]};
    },
  };
  return api;
}
