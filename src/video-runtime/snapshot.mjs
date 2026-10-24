import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inside, VideoRuntimeError } from './config.mjs';

/** Byte inventory verification is mechanical evidence; it does not imply semantic review. */
export function verifyPinnedSnapshot({rootDir,engineRoot,commit,fileCount,expectedSha256}) {
  rootDir=fs.realpathSync(rootDir);engineRoot=fs.realpathSync(engineRoot);
  if(!inside(rootDir,engineRoot)||rootDir===engineRoot)throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The embedded engine inventory must remain inside this product.');
  const raw=fs.readFileSync(path.join(rootDir,'upstreams','workloom-video-edit.snapshot.json'));
  if(!(/^[a-f0-9]{64}$/).test(expectedSha256||'')||createHash('sha256').update(raw).digest('hex')!==expectedSha256)throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The embedded engine inventory does not match its reviewed pin digest.');
  let snapshot;try{snapshot=JSON.parse(raw.toString('utf8'));}catch(error){throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The embedded engine inventory is not valid JSON.',{cause:error});}
  if(snapshot.schemaVersion!=='pengmanager.edit-snapshot/v1'||snapshot.source?.commit!==commit||snapshot.sourceFileCount!==fileCount||!Array.isArray(snapshot.files)||snapshot.files.length!==fileCount||!Array.isArray(snapshot.targetOwnedFiles))throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The complete embedded engine inventory is missing or has the wrong source identity.');
  const names=new Set();let bytes=0;
  for(const item of [...snapshot.files,...snapshot.targetOwnedFiles]){
    if(!item||typeof item.path!=='string'||!item.path||item.path.includes('\\')||item.path.includes('\0')||path.isAbsolute(item.path)||path.posix.normalize(item.path)!==item.path||names.has(item.path)||!['100644','100755'].includes(item.mode)||!(/^[a-f0-9]{64}$/).test(item.targetSha256||''))throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The complete embedded engine inventory has an invalid or duplicate path.');
    names.add(item.path);const file=path.resolve(engineRoot,item.path);
    if(!inside(engineRoot,file)||file===engineRoot)throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The complete embedded engine inventory escaped the product.');
    let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')throw new VideoRuntimeError('COMPLETE_ENGINE_MISSING',`An embedded engine inventory file is missing: ${item.path}.`);throw error;}
    if(!stat.isFile()||stat.isSymbolicLink()||!inside(engineRoot,fs.realpathSync(file)))throw new VideoRuntimeError('ENGINE_SNAPSHOT_INVALID','The embedded engine inventory contains an external or non-regular file.');
    const content=fs.readFileSync(file);bytes+=content.length;
    if(createHash('sha256').update(content).digest('hex')!==item.targetSha256)throw new VideoRuntimeError('ENGINE_SNAPSHOT_MISMATCH',`An embedded engine file differs from its reviewed target inventory: ${item.path}.`);
  }
  return {fileCount:snapshot.files.length,targetOwnedFileCount:snapshot.targetOwnedFiles.length,totalFiles:names.size,bytes,sourceMain:commit,snapshotSha256:expectedSha256,evidence:'B',semanticReview:false};
}
