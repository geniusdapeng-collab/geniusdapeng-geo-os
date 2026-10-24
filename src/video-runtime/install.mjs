import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {atomicJson, privateDirectory, VideoRuntimeError} from './config.mjs';
import {assertActive} from './process.mjs';
import {withoutInstallationCredentials} from './environment.mjs';

export function packageManagerInvocation(config) {
  const executable=config.env.PENGMANAGER_PNPM_BIN||'pnpm';
  return /\.(?:c?js|mjs)$/.test(executable)?{command:config.node,prefix:[executable]}:{command:executable,prefix:[]};
}

/** Preserve the canonical UI bytes/lock boundary using its verified public producer transport. */
export async function installEngineDependencies({config,signal,safe=String,logger=()=>undefined}) {
  assertActive(signal);
  const helper=path.join(config.engineRoot,'scripts/ci/ui-auth-bootstrap.mjs');
  if(!fs.existsSync(helper))throw new VideoRuntimeError('COMPLETE_ENGINE_MISSING','The canonical authenticated UI dependency installer is missing.');
  const {bootstrapInstall}=await import(pathToFileURL(helper).href);
  if(typeof bootstrapInstall!=='function')throw new VideoRuntimeError('DEPENDENCY_INSTALLER_INVALID','The canonical UI installer has no supported bootstrap entry point.');
  const invocation=packageManagerInvocation(config),storeDir=privateDirectory(path.join(config.dataRoot,'tools','dependency-store')),stagingRoot=privateDirectory(path.join(config.dataRoot,'tools','dependency-staging'));
  try{
    const result=await bootstrapInstall({repoRoot:config.engineRoot,storeDir,stagingRoot,pnpmCommand:invocation.command,pnpmPrefixArgs:invocation.prefix,environment:{...withoutInstallationCredentials(config.env),PATH:[path.dirname(config.node),config.env.PATH||''].join(path.delimiter)},signal});
    assertActive(signal);
    if(result.frozenInstallPassed!==true||result.originalLockUnchanged!==true||result.credentialsPassedToPnpm!==false||result.download?.officialSourceVerified!==true)throw new VideoRuntimeError('DEPENDENCY_INSTALL_RECEIPT_INVALID','The official frozen dependency install did not provide its required current verification proof.');
    const receipt={schemaVersion:'pengmanager.engine-dependency-install/v1',sourceMain:config.sourceMain,installedAt:new Date().toISOString(),package:result.installedName,version:result.installedVersion,originalLockSha256:result.originalLockSha256,originalLockUnchanged:true,sourceFiles:result.sourceFiles,sourceFilesUnchanged:result.sourceFilesUnchanged===true,frozenInstallPassed:true,credentialsPassedToPnpm:false,releaseCredentialRequired:false,archivePersisted:false,storeDir,download:result.download,installedClients:result.installedClients};
    atomicJson(path.join(config.dataRoot,'dependency-install-receipt.json'),receipt);
    return receipt;
  }catch(error){
    if(error.processResult?.output)logger(safe(error.processResult.output));
    if(signal?.aborted||error.code==='UI_BOOTSTRAP_CANCELLED')throw new VideoRuntimeError('RUNTIME_CANCELLED','Official dependency installation was cancelled.');
    if(error instanceof VideoRuntimeError)throw error;
    throw new VideoRuntimeError('ENGINE_DEPENDENCY_INSTALL_FAILED',safe(`Official frozen dependency installation failed: ${error.code||error.message||'unknown error'}.`),{cause:error});
  }
}
