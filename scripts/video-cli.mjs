import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVideoRuntime, VideoRuntimeError } from '../src/video-runtime/index.mjs';

export function parseVideoArgs(args) {
  const result={settings:{}};
  for(let index=0;index<args.length;index++){
    const name=args[index];
    if(name==='--install'){result.settings.installDependencies=true;continue;}
    if(name==='--build'){result.settings.buildWeb=true;continue;}
    if(name==='--with-workbench'){result.serveWorkbench=true;continue;}
    if(name==='--help'){result.help=true;continue;}
    if(!['--data-dir','--postgres-root'].includes(name)||!args[index+1]||args[index+1].startsWith('--'))throw new VideoRuntimeError('ARGUMENT_INVALID',`Invalid video runtime argument: ${name}.`);
    const value=path.resolve(args[++index]);
    if(name==='--data-dir')result.dataDir=value;else result.settings.postgresSourceRoot=value;
  }
  return result;
}
export async function runVideoCli(mode,args=process.argv.slice(2)) {
  const parsed=parseVideoArgs(args);
  if(parsed.help){console.log(`Usage: node scripts/video-${mode}.mjs [--data-dir <private-directory>] [--postgres-root <PostgreSQL-17-prefix>] [--install] [--build] [--with-workbench]\nCLI/MCP mode is the default. Model credentials are read only from this process environment. Runtime state uses a private directory outside the repository.`);return;}
  const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const runtime=createVideoRuntime({rootDir,dataDir:parsed.dataDir,serveWorkbench:parsed.serveWorkbench,logger:message=>console.error(`[video] ${message}`)});
  if(mode==='doctor'){const result=await runtime.doctor();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;return;}
  if(!['start','setup'].includes(mode))throw new VideoRuntimeError('CLI_MODE_INVALID','Unknown video runtime command.');
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;try{await runtime.stop();}catch(error){console.error(`${error.code||'VIDEO_STOP_FAILED'}: ${error.message}`);process.exitCode=1;}};
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
  try{console.log(JSON.stringify(await runtime[mode](parsed.settings),null,2));}
  catch(error){await close();throw error;}
}
