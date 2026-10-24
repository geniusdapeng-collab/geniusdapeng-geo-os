import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { VideoRuntimeError } from './config.mjs';

export function assertActive(signal) { if (signal?.aborted) throw new VideoRuntimeError('RUNTIME_CANCELLED', 'Video runtime startup was cancelled.'); }
export function wait(ms, signal) { return new Promise((resolve, reject) => { assertActive(signal); const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); }; const abort = () => { done(); reject(new VideoRuntimeError('RUNTIME_CANCELLED', 'Video runtime startup was cancelled.')); }; const timer = setTimeout(() => { done(); resolve(); }, ms); signal?.addEventListener('abort', abort, { once: true }); }); }
export async function portIsOpen(port) { return new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port }); const finish = value => { socket.destroy(); resolve(value); }; socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(false)); }); }
export async function requireFreePort(port) { if (await portIsOpen(port)) throw new VideoRuntimeError('PORT_IN_USE', `Managed video port ${port} is occupied; no existing service was reused or stopped.`); }
function safeOutput(safe,write) {
  const decoder=new StringDecoder('utf8');let pending='';
  const consume=()=>{let index;while((index=pending.indexOf('\n'))!==-1){const line=pending.slice(0,index+1);pending=pending.slice(index+1);if(line.length>1024*1024)throw new VideoRuntimeError('PROCESS_LOG_INVALID','Managed process emitted an oversized log line.');write(safe(line));}if(pending.length>1024*1024)throw new VideoRuntimeError('PROCESS_LOG_INVALID','Managed process emitted an oversized log line.');};
  return {append(chunk){pending+=decoder.write(chunk);consume();},flush(){pending+=decoder.end();consume();if(pending){write(safe(pending));pending='';}}};
}
export function runCommand(command, args, { cwd, env, signal, timeoutMs = 120000, safe = String, log, daemon = false } = {}) {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    let fd;
    if (daemon && log) fd = fs.openSync(log, 'a', 0o600);
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: daemon && fd !== undefined ? ['ignore', fd, fd] : ['ignore', 'pipe', 'pipe'] });
    if (fd !== undefined) fs.closeSync(fd);
    let stdout = '', stderr = '', settled = false, expired = false, ioFailure;
    const abort = () => { expired = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000); };
    let killTimer;
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const sinks={out:safeOutput(safe,text=>{stdout=(stdout+text).slice(-128000);if(log)fs.appendFileSync(log,text,{mode:0o600});}),err:safeOutput(safe,text=>{stderr=(stderr+text).slice(-128000);if(log)fs.appendFileSync(log,text,{mode:0o600});})};
    const capture = (chunk, kind) => {
      if(ioFailure)return;
      try{sinks[kind].append(chunk);}
      catch(error){ioFailure=error;child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),2000);}
    };
    child.stdout?.on('data', chunk => capture(chunk, 'out')); child.stderr?.on('data', chunk => capture(chunk, 'err'));
    const clean = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { if (settled) return; settled = true; clean(); reject(new VideoRuntimeError('PROCESS_START_FAILED', safe(error))); });
    child.once('close', code => { if (settled) return;try{if(!ioFailure){sinks.out.flush();sinks.err.flush();}}catch(error){ioFailure=error;}settled = true; clean(); if(ioFailure)return reject(new VideoRuntimeError('PROCESS_LOG_FAILED',safe(ioFailure)));if (expired || signal?.aborted) return reject(new VideoRuntimeError(signal?.aborted ? 'RUNTIME_CANCELLED' : 'PROCESS_TIMEOUT', 'Managed video command did not complete before its deadline.')); if (code !== 0) return reject(new VideoRuntimeError('PROCESS_FAILED', safe(stderr || stdout || `Managed command exited ${code}.`))); resolve({ stdout, stderr, code }); });
  });
}
export function startChild(command, args, { cwd, env, safe, log, onExit } = {}) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logFailed=false;
  const sinks=[safeOutput(safe,text=>fs.appendFileSync(log,text,{mode:0o600})),safeOutput(safe,text=>fs.appendFileSync(log,text,{mode:0o600}))];
  const logFailure=error=>{logFailed=true;onExit?.(new VideoRuntimeError('PROCESS_LOG_FAILED',safe(error)));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);timer.unref();};
  const capture = (chunk,index) => {
    if(logFailed)return;
    try{sinks[index].append(chunk);}catch(error){logFailure(error);}
  };
  child.stdout.on('data',chunk=>capture(chunk,0)); child.stderr.on('data',chunk=>capture(chunk,1));
  child.once('close',()=>{if(!logFailed)try{for(const sink of sinks)sink.flush();}catch(error){logFailure(error);}});
  child.once('error', error => onExit?.(new VideoRuntimeError('BACKEND_START_FAILED', safe(error))));
  child.once('exit', (code, signal) => onExit?.(new VideoRuntimeError('BACKEND_EXITED', `Managed video backend stopped (${code ?? signal}).`)));
  return child;
}
export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (!child.kill('SIGKILL')) reject(new VideoRuntimeError('PROCESS_STOP_FAILED', 'Managed backend could not be stopped.')); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (!child.kill('SIGTERM')) { clearTimeout(timer); resolve(); }
  });
}
export async function localJson(url, { method = 'GET', body, headers = {}, signal, timeoutMs = 10000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) throw new VideoRuntimeError('LOCAL_ENDPOINT_REQUIRED', 'Runtime transport accepts only its explicit loopback endpoint.');
  const response = await fetch(target, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (text.length > 2000000) throw new VideoRuntimeError('LOCAL_RESPONSE_INVALID', 'Managed service response exceeded its bounded response size.');
  let data; try { data = JSON.parse(text); } catch { throw new VideoRuntimeError('LOCAL_RESPONSE_INVALID', 'Managed service returned invalid JSON.'); }
  if (!response.ok || data.error) throw new VideoRuntimeError('LOCAL_SERVICE_REJECTED', `Managed service rejected the request (HTTP ${response.status}).`);
  return data;
}
export async function waitForNativeBackend({endpoint,child,nativeSession,signal,attempts=90,delayMs=500}) {
  let lastError;
  for(let attempt=0;attempt<attempts;attempt++){
    assertActive(signal);
    if(child.exitCode!==null||child.signalCode!==null)throw new VideoRuntimeError('BACKEND_EXITED','Managed native video backend exited during startup; inspect its private redacted log.');
    try{
      const result=await localJson(endpoint+'/health',{signal,timeoutMs:1000});
      if(result.ok===true){await nativeSession(signal);return{ok:true};}
    }catch(error){
      if(signal?.aborted)assertActive(signal);
      if(error.code==='NATIVE_SESSION_SCOPE_MISMATCH')throw error;
      lastError=error;
    }
    if(attempt+1<attempts)await wait(delayMs,signal);
  }
  throw new VideoRuntimeError('BACKEND_NOT_READY','Managed native video backend did not become healthy and authenticate the expected owner session.',{cause:lastError});
}
