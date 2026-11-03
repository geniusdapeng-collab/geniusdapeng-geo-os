import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVideoRuntime, VideoRuntimeError } from '../src/video-runtime/index.mjs';

export function parseVideoArgs(args,mode) {
  const result={settings:{}};
  for(let index=0;index<args.length;index++){
    const name=args[index];
    if(name==='--core-only'){result.coreOnly=true;continue;}
    if(name==='--install'){result.settings.installDependencies=true;continue;}
    if(name==='--build'){result.settings.buildWeb=true;continue;}
    if(name==='--with-workbench'){result.serveWorkbench=true;continue;}
    if(name==='--help'){result.help=true;continue;}
    if(!['--data-dir','--postgres-root'].includes(name)||!args[index+1]||args[index+1].startsWith('--'))throw new VideoRuntimeError('ARGUMENT_INVALID',`Invalid video runtime argument: ${name}.`);
    const value=path.resolve(args[++index]);
    if(name==='--data-dir')result.dataDir=value;else result.settings.postgresSourceRoot=value;
  }
  if(result.coreOnly&&!result.help){
    if(mode!=='setup'||!result.settings.installDependencies||!result.settings.postgresSourceRoot||result.settings.buildWeb||result.serveWorkbench){
      throw new VideoRuntimeError('ARGUMENT_INVALID','Use --core-only with video-setup --install --postgres-root <installation>. It cannot be combined with --build or --with-workbench.');
    }
    result.serveWorkbench=false;
    result.settings.buildIndustryContract=true;
    result.settings.installTools=false;
  }
  return result;
}
export async function runVideoCli(mode,args=process.argv.slice(2)) {
  const parsed=parseVideoArgs(args,mode);
  const coreUsage=mode==='setup'?'\nCore setup: node scripts/video-setup.mjs --core-only --install --postgres-root <PostgreSQL-17-prefix> [--data-dir <private-directory>]':'';
  if(parsed.help){console.log(`Usage: node scripts/video-${mode}.mjs [--data-dir <private-directory>] [--postgres-root <PostgreSQL-17-prefix>] [--install] [--build] [--with-workbench]${coreUsage}\nCLI/MCP mode is the default. Model credentials are read only from this process environment. Runtime state uses a private directory outside the repository.`);return;}
  const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const runtime=createVideoRuntime({rootDir,dataDir:parsed.dataDir,serveWorkbench:parsed.serveWorkbench,logger:message=>console.error(`[video] ${message}`)});
  if(mode==='doctor'){const result=await runtime.doctor();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return;}
  if(!['start','setup'].includes(mode))throw new VideoRuntimeError('CLI_MODE_INVALID','Unknown video runtime command.');
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;try{await runtime.stop();}catch(error){console.error(`${error.code||'VIDEO_STOP_FAILED'}: ${error.message}`);process.exitCode=1;}};
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  try{
    const runtimeResult=await runtime[mode](parsed.settings);
    if(parsed.coreOnly){
      const diagnosis=await runtime.doctor();
      console.log(JSON.stringify(diagnosis,null,2));
      if(!diagnosis.ok||!diagnosis.workspaceInitialized)process.exitCode=1;
    }else console.log(JSON.stringify(runtimeResult,null,2));
  }
  catch(error){await close();throw error;}
}
