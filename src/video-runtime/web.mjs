import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { equalSecret, inside, VideoRuntimeError } from './config.mjs';
import { requireFreePort } from './process.mjs';

const RPC_ROOTS = new Set(['system','access','onboarding','auth','accounts','members','threads','approvals','inspection','skills','workspace','nightShift','fence','roster','im','bundles','video','captain','service','credits','modelFeedback','memory','evolution','acquisition','collaboration','overlay']);
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf','.otf':'font/otf','.wasm':'application/wasm','.mp4':'video/mp4','.mp3':'audio/mpeg','.wav':'audio/wav'};
function parseCookies(raw='') { return Object.fromEntries(raw.split(';').map(row=>row.trim().split(/=(.*)/s).slice(0,2)).filter(row=>row.length===2)); }
export function allowedProxyPath(pathname) {
  if (pathname === '/health' || pathname === '/api/voice/status' || pathname === '/api/voice/speech' || pathname.startsWith('/media/')) return true;
  if (!pathname.startsWith('/trpc/')) return false;
  let names; try { names=decodeURIComponent(pathname.slice(6)).split(','); } catch { return false; }
  return names.length>0 && names.length<=100 && names.every(name=>/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/.test(name) && RPC_ROOTS.has(name.split('.')[0]) && !['auth.desktopLogin','auth.loginAs'].includes(name));
}
export function createWorkbenchServer({ config, nativeSession, health, safe, onError }) {
  const origin=`http://127.0.0.1:${config.ports.web}`;
  const csrf=randomBytes(32).toString('hex'), browserSession=randomBytes(32).toString('hex');
  const cookieName=`pengmanager_video_session_${config.ports.web}`;
  let server=null;
  const json=(res,status,value)=>{ res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value)); };
  const authorizedBrowser=req=>equalSecret(parseCookies(req.headers.cookie)[cookieName],browserSession);
  const sameOrigin=req=>req.headers.origin===origin && (!req.headers['sec-fetch-site'] || req.headers['sec-fetch-site']==='same-origin');
  async function handle(req,res) {
    if(req.headers.host!==`127.0.0.1:${config.ports.web}`) return json(res,421,{error:'HOST_REJECTED'});
    if(req.headers.origin && req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site') return json(res,403,{error:'ORIGIN_REJECTED'});
    res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('permissions-policy','camera=(), microphone=(), geolocation=()');
    let target;try{target=new URL(req.url,origin);}catch{return json(res,400,{error:'PATH_INVALID'});}
    if(target.origin!==origin) return json(res,400,{error:'PATH_INVALID'});
    const pathname=target.pathname;
    if(pathname==='/_pengmanager/video/session') {
      if(req.method!=='POST') return json(res,405,{error:'METHOD_NOT_ALLOWED'});
      if(!authorizedBrowser(req)||!sameOrigin(req)||!equalSecret(req.headers['x-pengmanager-video-csrf'],csrf)) return json(res,403,{error:'SESSION_REQUEST_REJECTED'});
      let count=0;for await(const chunk of req){count+=chunk.length;if(count>1024)return json(res,413,{error:'BODY_TOO_LARGE'});}
      const session=await nativeSession();
      return json(res,200,session);
    }
    if(pathname==='/_pengmanager/video/health') {
      if(req.method!=='GET'||!authorizedBrowser(req))return json(res,403,{error:'SESSION_REQUIRED'});
      return json(res,200,await health());
    }
    if(allowedProxyPath(pathname)) {
      if(!['GET','HEAD','POST'].includes(req.method))return json(res,405,{error:'METHOD_NOT_ALLOWED'});
      if(!authorizedBrowser(req))return json(res,403,{error:'SESSION_REQUIRED'});
      if(req.method==='POST'&&!sameOrigin(req))return json(res,403,{error:'ORIGIN_REQUIRED'});
      const limit=pathname==='/media/upload'?300*1024*1024:8*1024*1024;
      if(Number(req.headers['content-length']||0)>limit)return json(res,413,{error:'BODY_TOO_LARGE'});
      return new Promise(resolve=>{
        const headers={...req.headers,host:`127.0.0.1:${config.ports.backend}`};
        delete headers.cookie;delete headers['x-pengmanager-video-csrf'];delete headers['x-workloom-desktop-key'];delete headers.connection;
        const upstream=http.request({host:'127.0.0.1',port:config.ports.backend,path:target.pathname+target.search,method:req.method,headers,timeout:240000},reply=>{
          for(const [key,value]of Object.entries(reply.headers))if(value!==undefined&&!['connection','set-cookie','access-control-allow-origin','access-control-allow-credentials'].includes(key))res.setHeader(key,value);
          res.statusCode=reply.statusCode||502;reply.pipe(res);reply.once('end',resolve);
          reply.once('error',()=>{if(!res.writableEnded)res.destroy();resolve();});
        });
        let bytes=0;
        req.on('data',chunk=>{bytes+=chunk.length;if(bytes>limit){upstream.destroy();if(!res.headersSent)json(res,413,{error:'BODY_TOO_LARGE'});}});
        upstream.once('timeout',()=>upstream.destroy(new Error('managed-backend-timeout')));
        upstream.once('error',()=>{if(!res.headersSent)json(res,502,{error:'MANAGED_BACKEND_UNAVAILABLE'});else if(!res.writableEnded)res.destroy();resolve();});
        req.once('aborted',()=>upstream.destroy());res.once('close',()=>{if(!res.writableEnded)upstream.destroy();});req.pipe(upstream);
      });
    }
    if(pathname.startsWith('/trpc/')||pathname.startsWith('/_pengmanager/')||pathname.startsWith('/sync/')||pathname.startsWith('/api/')||pathname.startsWith('/media/'))return json(res,404,{error:'ROUTE_NOT_EXPOSED'});
    if(!['GET','HEAD'].includes(req.method))return json(res,405,{error:'METHOD_NOT_ALLOWED'});
    let decoded;try{decoded=decodeURIComponent(pathname);}catch{return json(res,400,{error:'PATH_INVALID'});}
    if(decoded.includes('\0')||decoded.includes('\\'))return json(res,400,{error:'PATH_INVALID'});
    let file=path.resolve(config.webRoot,'.'+decoded);
    if(!inside(config.webRoot,file))return json(res,400,{error:'PATH_INVALID'});
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()) {
      if(path.extname(file))return json(res,404,{error:'ASSET_NOT_FOUND'});
      file=path.join(config.webRoot,'index.html');
    }
    if(!inside(fs.realpathSync(config.webRoot),fs.realpathSync(file)))return json(res,403,{error:'ASSET_PATH_REJECTED'});
    const extension=path.extname(file).toLowerCase();
    if(extension==='.html'){
      const nonce=randomBytes(18).toString('base64');
      const script=`Object.defineProperty(window,'workloomDesktop',{value:Object.freeze({login:async()=>{const r=await fetch('/_pengmanager/video/session',{method:'POST',headers:{'x-pengmanager-video-csrf':${JSON.stringify(csrf)}},credentials:'same-origin'});if(!r.ok)throw new Error('鹏经理本机视频登录未就绪');return r.json();}}),configurable:false,writable:false});`;
      let html=await fsp.readFile(file,'utf8');
      if(!/<head(?:\s[^>]*)?>/i.test(html))throw new VideoRuntimeError('WORKBENCH_HTML_INVALID','Native workbench HTML has no valid head.');
      html=html.replace(/<head(?:\s[^>]*)?>/i,tag=>`${tag}<script nonce="${nonce}">${script}</script>`);
      res.setHeader('content-security-policy',`default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`);
      res.setHeader('set-cookie',`${cookieName}=${browserSession}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200,{'content-type':MIME[extension],'cache-control':'no-store'});return res.end(req.method==='HEAD'?undefined:html);
    }
    res.writeHead(200,{'content-type':MIME[extension]||'application/octet-stream','cache-control':pathname.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache'});
    if(req.method==='HEAD')return res.end();
    await new Promise((resolve,reject)=>{const stream=fs.createReadStream(file);stream.once('error',reject);res.once('finish',resolve);res.once('close',resolve);stream.pipe(res);});
  }
  return {
    origin,
    async start(){if(server?.listening)return;await requireFreePort(config.ports.web);server=http.createServer((req,res)=>{void handle(req,res).catch(error=>{onError?.(safe(error));if(!res.headersSent)json(res,500,{error:'WORKBENCH_REQUEST_FAILED'});else res.destroy();});});server.requestTimeout=300000;await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.ports.web,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});},
    async stop(){if(!server)return;const current=server;server=null;await new Promise((resolve,reject)=>{current.close(error=>error?reject(error):resolve());current.closeIdleConnections?.();const timer=setTimeout(()=>current.closeAllConnections?.(),3000);timer.unref?.();});},
  };
}
